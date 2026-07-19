import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { sessionId } from "@oh-my-pi/app-wire";
import type {
	AppserverTestControl,
	AppserverTestControlStatus,
	SessionAuthority,
	SessionRecord,
} from "@oh-my-pi/appserver";
import { getProfileRootDir } from "@oh-my-pi/pi-utils";
import { acquireSessionLock, inspectSessionLock } from "./session-lock";
import { SessionManager } from "./session-manager";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function runTitlePrefix(runId: string): string {
	return `[t4-test:${runId}]`;
}

interface TestRunSession {
	readonly sessionId: string;
	readonly path: string;
}

interface TestRunManifest {
	readonly v: 1;
	readonly runId: string;
	readonly projectRoot: string;
	readonly state: "seeding" | "seeded";
	readonly sessions: readonly TestRunSession[];
}

function isEnoent(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function exists(candidate: string): Promise<boolean> {
	try {
		await stat(candidate);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

function artifactsPath(sessionPath: string): string {
	return sessionPath.endsWith(".jsonl") ? sessionPath.slice(0, -".jsonl".length) : `${sessionPath}.artifacts`;
}

function parseManifest(text: string, expectedRunId: string): TestRunManifest {
	const value = JSON.parse(text) as Partial<TestRunManifest>;
	if (
		value.v !== 1 ||
		value.runId !== expectedRunId ||
		typeof value.projectRoot !== "string" ||
		(value.state !== "seeding" && value.state !== "seeded") ||
		!Array.isArray(value.sessions) ||
		value.sessions.some(
			session =>
				typeof session !== "object" ||
				session === null ||
				typeof session.sessionId !== "string" ||
				typeof session.path !== "string",
		)
	) {
		throw new Error("invalid test run manifest");
	}
	return value as TestRunManifest;
}

function sameSession(record: SessionRecord, session: TestRunSession, projectRoot: string): boolean {
	return (
		record.sessionId === session.sessionId &&
		path.resolve(record.path) === session.path &&
		path.resolve(record.cwd) === projectRoot
	);
}

function inside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function createAppserverTestControl(options: {
	token: string;
	allowedProjectRoot: string;
	profile: string;
	sessionAuthority: SessionAuthority;
}): AppserverTestControl {
	const allowedRoot = path.resolve(options.allowedProjectRoot);
	const resolvedAllowedRoot = realpath(allowedRoot);
	const profile = options.profile;
	const profileRoot = getProfileRootDir(profile);
	const profileAgentDir = path.join(profileRoot, "agent");
	const manifestRoot = path.join(profileRoot, "state", "appserver-test-runs");
	const queues = new Map<string, Promise<void>>();
	const manifestPath = (runId: string): string => path.join(manifestRoot, `${runId}.json`);
	const loadManifest = async (runId: string): Promise<TestRunManifest | undefined> => {
		try {
			return parseManifest(await readFile(manifestPath(runId), "utf8"), runId);
		} catch (error) {
			if (isEnoent(error)) return undefined;
			throw error;
		}
	};
	const saveManifest = async (manifest: TestRunManifest): Promise<void> => {
		await mkdir(manifestRoot, { recursive: true, mode: 0o700 });
		const destination = manifestPath(manifest.runId);
		const temporary = `${destination}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
			await rename(temporary, destination);
		} finally {
			await rm(temporary, { force: true });
		}
	};
	const withRun = async <T>(runId: string, operation: () => Promise<T>): Promise<T> => {
		const previous = queues.get(runId) ?? Promise.resolve();
		const gate = Promise.withResolvers<void>();
		const current = previous.catch(() => undefined).then(() => gate.promise);
		queues.set(runId, current);
		await previous.catch(() => undefined);
		try {
			return await operation();
		} finally {
			gate.resolve();
			if (queues.get(runId) === current) queues.delete(runId);
		}
	};
	const validateManifestRoot = async (manifest: TestRunManifest): Promise<void> => {
		const root = await resolvedAllowedRoot;
		const projectRoot = await realpath(manifest.projectRoot);
		if (!inside(root, projectRoot) || projectRoot !== manifest.projectRoot) {
			throw new Error("test run manifest is outside the allow-root");
		}
	};
	const statusUnlocked = async (runId: string): Promise<AppserverTestControlStatus> => {
		const manifest = await loadManifest(runId);
		if (!manifest) {
			return {
				v: 1,
				runId,
				profile,
				state: "clean",
				sessions: { seeded: 0, indexed: 0 },
				locks: { live: 0, suspect: 0, stale: 0, malformed: 0 },
				workers: { supervisors: 0, starting: 0, pendingRpc: 0 },
				remainingFiles: 0,
				errors: [],
			};
		}
		await validateManifestRoot(manifest);
		const records = await options.sessionAuthority.list();
		const locks = { live: 0, suspect: 0, stale: 0, malformed: 0 };
		const errors: string[] = [];
		let indexed = 0;
		let remainingFiles = 0;
		for (const session of manifest.sessions) {
			const exact = records.find(record => sameSession(record, session, manifest.projectRoot));
			if (exact) indexed += 1;
			else errors.push(`missing indexed test session ${session.sessionId}`);
			const lock = inspectSessionLock(session.path).status;
			if (lock !== "missing") locks[lock] += 1;
			for (const candidate of [session.path, artifactsPath(session.path)]) {
				if (await exists(candidate)) remainingFiles += 1;
			}
		}
		return {
			v: 1,
			runId,
			profile,
			state: "seeded",
			sessions: { seeded: manifest.sessions.length, indexed },
			locks,
			workers: { supervisors: 0, starting: 0, pendingRpc: 0 },
			remainingFiles,
			errors,
		};
	};
	return {
		token: options.token,
		async seed(request) {
			if (!RUN_ID_PATTERN.test(request.runId)) throw new Error("invalid test run id");
			return withRun(request.runId, async () => {
				if (await loadManifest(request.runId)) throw new Error("test run already exists");
				const [root, projectRoot] = await Promise.all([
					resolvedAllowedRoot,
					realpath(path.resolve(request.projectRoot)),
				]);
				if (!inside(root, projectRoot)) throw new Error("test project is outside the allow-root");
				let manifest: TestRunManifest = {
					v: 1,
					runId: request.runId,
					projectRoot,
					state: "seeding",
					sessions: [],
				};
				await saveManifest(manifest);
				for (let sessionIndex = 0; sessionIndex < request.sessionCount; sessionIndex += 1) {
					const sessionDir = SessionManager.getDefaultSessionDir(projectRoot, profileAgentDir);
					const manager = SessionManager.create(projectRoot, sessionDir);
					try {
						const sessionPath = manager.getSessionFile();
						if (!sessionPath) throw new Error("test session has no persistence path");
						manifest = {
							...manifest,
							sessions: [
								...manifest.sessions,
								{ sessionId: manager.getSessionId(), path: path.resolve(sessionPath) },
							],
						};
						await saveManifest(manifest);
						await manager.setSessionName(
							`${runTitlePrefix(request.runId)} Session ${String(sessionIndex + 1).padStart(2, "0")}`,
							"user",
						);
						manager.appendModelChange("openai/gpt-5-mini");
						const entryCount = sessionIndex === 0 ? request.historyEntries : Math.min(request.historyEntries, 2);
						for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
							manager.appendMessage({
								role: "user",
								content: `T4 continuity ${request.runId} session ${sessionIndex + 1} entry ${entryIndex + 1}`,
								timestamp: Date.now(),
							});
						}
						await manager.ensureOnDisk();
						await manager.flush();
					} finally {
						await manager.dispose();
					}
				}
				manifest = { ...manifest, state: "seeded" };
				await saveManifest(manifest);
				return statusUnlocked(request.runId);
			});
		},
		async sessionIds(runId) {
			if (!RUN_ID_PATTERN.test(runId)) throw new Error("invalid test run id");
			const manifest = await loadManifest(runId);
			return manifest?.sessions.map(session => sessionId(session.sessionId)) ?? [];
		},
		async status(runId) {
			if (!RUN_ID_PATTERN.test(runId)) throw new Error("invalid test run id");
			return withRun(runId, () => statusUnlocked(runId));
		},
		async cleanup(runId) {
			if (!RUN_ID_PATTERN.test(runId)) throw new Error("invalid test run id");
			return withRun(runId, async () => {
				const manifest = await loadManifest(runId);
				if (!manifest) return statusUnlocked(runId);
				await validateManifestRoot(manifest);
				const records = await options.sessionAuthority.list();
				for (const session of manifest.sessions) {
					const sameId = records.find(record => record.sessionId === session.sessionId);
					if (sameId && !sameSession(sameId, session, manifest.projectRoot)) {
						throw new Error("test session identity no longer matches its manifest");
					}
					const inspection = inspectSessionLock(session.path);
					if (inspection.status !== "missing") {
						if (!inspection.stealable) throw new Error("test session is still owned");
						acquireSessionLock(session.path).release();
					}
					if (sameId) await options.sessionAuthority.delete(sameId);
					await Promise.all([
						rm(session.path, { force: true }),
						rm(artifactsPath(session.path), { recursive: true, force: true }),
						rm(`${session.path}.lock`, { force: true }),
						rm(`${session.path}.lock.steal`, { force: true }),
					]);
				}
				const beforeManifestRemoval = await statusUnlocked(runId);
				if (
					beforeManifestRemoval.sessions.indexed !== 0 ||
					beforeManifestRemoval.remainingFiles !== 0 ||
					Object.values(beforeManifestRemoval.locks).some(count => count !== 0)
				) {
					throw new Error("test cleanup left owned resources");
				}
				await rm(manifestPath(runId), { force: true });
				return statusUnlocked(runId);
			});
		},
	};
}
