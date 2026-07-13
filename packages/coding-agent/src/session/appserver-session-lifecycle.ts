import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type SessionId, sessionId } from "@oh-my-pi/app-wire";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { acquireSessionLock, type SessionLockHandle } from "./session-lock";

const FILE_VERSION = 1;
const TOMBSTONE_PREFIX = ".omp-appserver-delete-";
const MANIFEST_FILE = "manifest.json";

interface ArchivedSession {
	sessionId: SessionId;
	archivedAt: string;
}

interface PendingDelete {
	sessionId: SessionId;
	tombstone: string;
}

interface LifecycleState {
	archived: Map<SessionId, string>;
	pendingDeletes: Map<SessionId, string>;
}

interface TombstoneManifest {
	version: 1;
	sessionId: SessionId;
	transcriptName: string;
	artifactsName: string;
}

interface LifecycleFile {
	version: 1;
	archived: ArchivedSession[];
	pendingDeletes: PendingDelete[];
}

export interface AppserverSessionLifecycleStoreOptions {
	acquireLock?: (sessionPath: string) => SessionLockHandle;
}

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateLeafName(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && value !== "." && value !== ".." && path.basename(value) === value
	);
}

function within(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function exists(candidate: string): Promise<boolean> {
	try {
		await fs.lstat(candidate);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function renameDurably(source: string, destination: string, renamed?: () => void): Promise<void> {
	await fs.rename(source, destination);
	renamed?.();
	const sourceDirectory = path.dirname(source);
	const destinationDirectory = path.dirname(destination);
	await syncDirectory(sourceDirectory);
	if (destinationDirectory !== sourceDirectory) await syncDirectory(destinationDirectory);
}

async function readManifest(tombstone: string): Promise<TombstoneManifest> {
	const raw: unknown = JSON.parse(await fs.readFile(path.join(tombstone, MANIFEST_FILE), "utf8"));
	if (!isRecord(raw) || raw.version !== FILE_VERSION) throw new Error("invalid session deletion tombstone manifest");
	const id = sessionId(raw.sessionId, "manifest.sessionId");
	if (!validateLeafName(raw.transcriptName) || !raw.transcriptName.endsWith(".jsonl"))
		throw new Error("invalid tombstone transcript name");
	if (!validateLeafName(raw.artifactsName)) throw new Error("invalid tombstone artifacts name");
	return {
		version: FILE_VERSION,
		sessionId: id,
		transcriptName: raw.transcriptName,
		artifactsName: raw.artifactsName,
	};
}

async function writePrivateFile(target: string, value: string): Promise<void> {
	const directory = path.dirname(target);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await fs.chmod(directory, 0o700);
	const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
	let committed = false;
	try {
		const handle = await fs.open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(value, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.chmod(temporary, 0o600);
		await fs.rename(temporary, target);
		await syncDirectory(directory);
		committed = true;
	} finally {
		if (!committed) await fs.rm(temporary, { force: true }).catch(() => undefined);
	}
}

function decodeLifecycleFile(value: unknown): LifecycleState {
	if (!isRecord(value) || value.version !== FILE_VERSION)
		throw new Error("invalid appserver lifecycle metadata version");
	if (!Array.isArray(value.archived) || !Array.isArray(value.pendingDeletes))
		throw new Error("invalid appserver lifecycle metadata");
	const archived = new Map<SessionId, string>();
	for (const item of value.archived) {
		if (!isRecord(item) || !isIsoTimestamp(item.archivedAt)) throw new Error("invalid archived session metadata");
		const id = sessionId(item.sessionId, "lifecycle.archived.sessionId");
		if (archived.has(id)) throw new Error("duplicate archived session metadata");
		archived.set(id, item.archivedAt);
	}
	const pendingDeletes = new Map<SessionId, string>();
	for (const item of value.pendingDeletes) {
		if (!isRecord(item) || typeof item.tombstone !== "string" || path.isAbsolute(item.tombstone))
			throw new Error("invalid pending session deletion metadata");
		const id = sessionId(item.sessionId, "lifecycle.pendingDeletes.sessionId");
		if (pendingDeletes.has(id)) throw new Error("duplicate pending session deletion metadata");
		pendingDeletes.set(id, item.tombstone);
	}
	return { archived, pendingDeletes };
}

export class AppserverSessionLifecycleStore {
	readonly #metadataPath: string;
	readonly #sessionsRoot: string;
	readonly #acquireLock: (sessionPath: string) => SessionLockHandle;
	#tail: Promise<void> = Promise.resolve();

	constructor(metadataPath: string, sessionsRoot: string, options: AppserverSessionLifecycleStoreOptions = {}) {
		this.#metadataPath = path.resolve(metadataPath);
		this.#sessionsRoot = path.resolve(sessionsRoot);
		this.#acquireLock = options.acquireLock ?? acquireSessionLock;
	}

	async archivedSessions(): Promise<Map<SessionId, string>> {
		await this.#tail;
		return new Map((await this.#read()).archived);
	}

	archive(id: SessionId, archivedAt: string): Promise<void> {
		if (!isIsoTimestamp(archivedAt)) throw new Error("archivedAt must be a canonical ISO timestamp");
		return this.#mutate(state => {
			state.archived.set(id, archivedAt);
		});
	}

	restore(id: SessionId): Promise<void> {
		return this.#mutate(state => {
			state.archived.delete(id);
		});
	}

	async archiveSession(id: SessionId, archivedAt: string, sessionPath: string): Promise<void> {
		const { transcript } = await this.#canonicalSessionPath(sessionPath);
		const lock = this.#acquireLock(transcript);
		let committed = false;
		let failed = false;
		let failure: unknown;
		try {
			await this.archive(id, archivedAt);
			committed = true;
		} catch (error) {
			failed = true;
			failure = error;
		}
		try {
			lock.release();
		} catch (error) {
			if (committed)
				logger.warn("Session archive committed before lock release failed", {
					sessionId: id,
					error: String(error),
				});
			else {
				failure = failed ? new AggregateError([failure, error], "session archive and lock release failed") : error;
				failed = true;
			}
		}
		if (failed) throw failure;
	}

	async deleteSession(id: SessionId, sessionPath: string): Promise<void> {
		const { root, transcript } = await this.#canonicalSessionPath(sessionPath);
		const lock = this.#acquireLock(transcript);
		const parent = path.dirname(transcript);
		const transcriptName = path.basename(transcript);
		const artifactsName = transcriptName.slice(0, -6);
		const artifacts = path.join(parent, artifactsName);
		const tombstone = path.join(parent, `${TOMBSTONE_PREFIX}${randomUUID()}`);
		const relativeTombstone = path.relative(root, tombstone);
		const stagedTranscript = path.join(tombstone, transcriptName);
		const stagedArtifacts = path.join(tombstone, artifactsName);
		let artifactsStaged = false;
		let transcriptStaged = false;
		let committed = false;
		let failed = false;
		let failure: unknown;
		try {
			const transcriptStat = await fs.lstat(transcript);
			if (!transcriptStat.isFile() || transcriptStat.isSymbolicLink())
				throw new Error("session transcript is not a regular file");
			await fs.mkdir(tombstone, { mode: 0o700 });
			await syncDirectory(parent);
			await writePrivateFile(
				path.join(tombstone, MANIFEST_FILE),
				`${JSON.stringify({ version: FILE_VERSION, sessionId: id, transcriptName, artifactsName })}\n`,
			);
			if (await exists(artifacts)) {
				const artifactStat = await fs.lstat(artifacts);
				if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink())
					throw new Error("session artifacts path is not a directory");
				await renameDurably(artifacts, stagedArtifacts, () => {
					artifactsStaged = true;
				});
			}
			await renameDurably(transcript, stagedTranscript, () => {
				transcriptStaged = true;
			});
			await this.#mutate(state => {
				state.archived.delete(id);
				state.pendingDeletes.set(id, relativeTombstone);
			});
			committed = true;
		} catch (error) {
			const rollbackErrors: unknown[] = [];
			if (transcriptStaged)
				await renameDurably(stagedTranscript, transcript).catch(rollbackError =>
					rollbackErrors.push(rollbackError),
				);
			if (artifactsStaged)
				await renameDurably(stagedArtifacts, artifacts).catch(rollbackError => rollbackErrors.push(rollbackError));
			failure =
				rollbackErrors.length > 0
					? new AggregateError([error, ...rollbackErrors], "session deletion failed and rollback was incomplete")
					: error;
			failed = true;
			if (rollbackErrors.length === 0)
				await fs.rm(tombstone, { recursive: true, force: true }).catch(() => undefined);
		}
		try {
			lock.release();
		} catch (error) {
			if (committed)
				logger.warn("Session deletion committed before lock release failed", {
					sessionId: id,
					error: String(error),
				});
			else {
				failure = failed ? new AggregateError([failure, error], "session deletion and lock release failed") : error;
				failed = true;
			}
		}
		if (failed) throw failure;
		if (!committed) return;
		try {
			await fs.rm(tombstone, { recursive: true, force: true });
			await syncDirectory(parent);
			await this.#mutate(state => {
				state.pendingDeletes.delete(id);
			});
		} catch (error) {
			logger.warn("Deferred appserver session tombstone cleanup", {
				sessionId: id,
				tombstone,
				error: String(error),
			});
		}
	}

	async recoverDeletes(): Promise<void> {
		await this.#tail;
		let root: string;
		try {
			root = await fs.realpath(this.#sessionsRoot);
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		const state = await this.#read();
		const referenced = new Set<string>();
		for (const [id, relative] of state.pendingDeletes) {
			const tombstone = path.resolve(root, relative);
			if (!within(root, tombstone) || !path.basename(tombstone).startsWith(TOMBSTONE_PREFIX))
				throw new Error("pending deletion tombstone escapes the sessions root");
			referenced.add(tombstone);
			try {
				if (await exists(tombstone)) {
					const tombstoneStat = await fs.lstat(tombstone);
					if (!tombstoneStat.isDirectory() || tombstoneStat.isSymbolicLink())
						throw new Error("pending deletion tombstone is not a directory");
					const canonicalTombstone = await fs.realpath(tombstone);
					if (!within(root, canonicalTombstone) || canonicalTombstone !== tombstone)
						throw new Error("pending deletion tombstone traverses a symlink");
					const manifest = await readManifest(tombstone);
					if (manifest.sessionId !== id) throw new Error("pending deletion tombstone session id mismatch");
					await fs.rm(tombstone, { recursive: true, force: true });
					await syncDirectory(path.dirname(tombstone));
				}
				await this.#mutate(current => {
					current.pendingDeletes.delete(id);
				});
			} catch (error) {
				logger.warn("Appserver session tombstone cleanup remains pending", {
					sessionId: id,
					tombstone,
					error: String(error),
				});
			}
		}
		await this.#recoverUncommitted(root, referenced);
	}

	async #canonicalSessionPath(sessionPath: string): Promise<{ root: string; transcript: string }> {
		const requested = path.resolve(sessionPath);
		if (!within(this.#sessionsRoot, requested) || !requested.endsWith(".jsonl"))
			throw new Error("session lifecycle path is outside the profile sessions root");
		const root = await fs.realpath(this.#sessionsRoot);
		const transcript = await fs.realpath(requested);
		const requestedRelative = path.relative(this.#sessionsRoot, requested);
		const canonicalRelative = path.relative(root, transcript);
		if (!within(root, transcript) || requestedRelative !== canonicalRelative)
			throw new Error("session lifecycle path traverses a symlink or escapes the profile sessions root");
		const transcriptStat = await fs.lstat(requested);
		if (!transcriptStat.isFile() || transcriptStat.isSymbolicLink())
			throw new Error("session transcript is not a regular file");
		return { root, transcript };
	}

	async #recoverUncommitted(directory: string, referenced: ReadonlySet<string>): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			const candidate = path.join(directory, entry.name);
			if (entry.name.startsWith(TOMBSTONE_PREFIX)) {
				if (!referenced.has(candidate)) await this.#rollbackTombstone(candidate);
				continue;
			}
			await this.#recoverUncommitted(candidate, referenced);
		}
	}

	async #rollbackTombstone(tombstone: string): Promise<void> {
		try {
			const manifest = await readManifest(tombstone);
			const parent = path.dirname(tombstone);
			const stagedTranscript = path.join(tombstone, manifest.transcriptName);
			const stagedArtifacts = path.join(tombstone, manifest.artifactsName);
			const transcript = path.join(parent, manifest.transcriptName);
			const artifacts = path.join(parent, manifest.artifactsName);
			if ((await exists(stagedTranscript)) && (await exists(transcript)))
				throw new Error("cannot recover staged transcript over an existing session");
			if ((await exists(stagedArtifacts)) && (await exists(artifacts)))
				throw new Error("cannot recover staged artifacts over an existing directory");
			if (await exists(stagedTranscript)) await renameDurably(stagedTranscript, transcript);
			if (await exists(stagedArtifacts)) await renameDurably(stagedArtifacts, artifacts);
			await fs.rm(tombstone, { recursive: true, force: true });
			await syncDirectory(parent);
		} catch (error) {
			logger.warn("Preserving unrecovered appserver session tombstone", { tombstone, error: String(error) });
		}
	}

	#mutate(update: (state: LifecycleState) => void): Promise<void> {
		const operation = this.#tail.then(async () => {
			const state = await this.#read();
			update(state);
			await this.#write(state);
		});
		this.#tail = operation.catch(() => undefined);
		return operation;
	}

	async #read(): Promise<LifecycleState> {
		try {
			return decodeLifecycleFile(JSON.parse(await fs.readFile(this.#metadataPath, "utf8")) as unknown);
		} catch (error) {
			if (isEnoent(error)) return { archived: new Map(), pendingDeletes: new Map() };
			throw error;
		}
	}

	#write(state: LifecycleState): Promise<void> {
		const archived = [...state.archived]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([id, archivedAt]) => ({ sessionId: id, archivedAt }));
		const pendingDeletes = [...state.pendingDeletes]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([id, tombstone]) => ({ sessionId: id, tombstone }));
		const value: LifecycleFile = { version: FILE_VERSION, archived, pendingDeletes };
		return writePrivateFile(this.#metadataPath, `${JSON.stringify(value, null, 2)}\n`);
	}
}
