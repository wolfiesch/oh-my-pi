import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, discoverSkills } from "../sdk";
import { createAppserverBrokerStatus } from "./appserver-broker";
import { AppserverSessionLifecycleStore } from "./appserver-session-lifecycle";
import { createAppserverUsageAuthority, type UsageReadResult } from "./appserver-usage";
import { createDesktopConfigAuthority } from "./desktop-config-authority";
import {
	CodingAgentDesktopAuthority,
	type DesktopReviewApplyRequest,
	type DesktopReviewReadRequest,
	type DesktopTerminalRequest,
	type OperationContextLike,
} from "./desktop-operations-authority";
import type { CustomEntry } from "./session-entries";
import type { SessionInfo } from "./session-listing";
import { loadEntriesFromFile } from "./session-loader";
import { acquireSessionLock, inspectSessionLock } from "./session-lock";
import { SessionManager } from "./session-manager";

export interface BridgeSessionRecord {
	readonly sessionId: string;
	readonly path: string;
	readonly cwd: string;
	readonly projectId: string;
	readonly projectName?: string;
	readonly title: string;
	readonly updatedAt: string;
	readonly status: "idle";
	readonly archivedAt?: string;
	readonly entriesLoaded: boolean;
	readonly entries: readonly unknown[];
}

export interface BridgeOperationContext extends OperationContextLike {
	readonly hostId: string;
	readonly deviceId: string;
	readonly connectionId: string;
	readonly capabilities: ReadonlySet<string>;
	readonly abortSignal: AbortSignal;
	readonly emitTerminalOutput?: (frame: unknown) => void;
}

type OperationHandler = (args: Record<string, unknown>, context: BridgeOperationContext) => Promise<unknown>;
type TerminalHandler = (frame: Record<string, unknown>, context: BridgeOperationContext) => Promise<void>;
export interface BridgeOperationsAuthority {
	readonly filesRead: OperationHandler;
	readonly filesList: OperationHandler;
	readonly filesDiff: OperationHandler;
	readonly filesWrite: OperationHandler;
	readonly filesPatch: OperationHandler;
	readonly reviewRead: OperationHandler;
	readonly reviewApply: OperationHandler;
	readonly bashRun: OperationHandler;
	readonly termOpen: OperationHandler;
	readonly catalogGet: OperationHandler;
	readonly settingsRead: OperationHandler;
	readonly brokerStatus: OperationHandler;
	readonly settingsWrite: OperationHandler;
	readonly configWrite: OperationHandler;
	readonly terminalInput: TerminalHandler;
	readonly terminalResize: TerminalHandler;
	readonly terminalClose: TerminalHandler;
}

export interface OmpAuthorityBridgeAuthority {
	create(cwd: string, title: string | undefined, signal: AbortSignal): Promise<BridgeSessionRecord>;
	fork(source: BridgeSessionRecord, cwd: string | undefined, signal: AbortSignal): Promise<BridgeSessionRecord>;
	list(signal: AbortSignal): Promise<readonly BridgeSessionRecord[]>;
	archive(session: BridgeSessionRecord, archivedAt: string, signal: AbortSignal): Promise<void>;
	restore(session: BridgeSessionRecord, signal: AbortSignal): Promise<void>;
	delete(session: BridgeSessionRecord, signal: AbortSignal): Promise<void>;
	load(session: BridgeSessionRecord, signal: AbortSignal): Promise<BridgeSessionRecord>;
	page(
		session: BridgeSessionRecord,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<Record<string, unknown>>;
	rootForProject(projectId: string, signal: AbortSignal): Promise<string>;
	rootForSession(sessionId: string, signal: AbortSignal): Promise<string>;
	lockCheck(session: BridgeSessionRecord, signal: AbortSignal): Promise<void>;
	lockStatus(session: BridgeSessionRecord, signal: AbortSignal): Promise<string>;
	readonly operations: BridgeOperationsAuthority;
	usageRead(signal: AbortSignal): Promise<UsageReadResult>;
	flush(): Promise<void>;
	quiesce(options: { readonly interrupt: boolean }): Promise<void>;
	shutdown?(): Promise<void>;
}

const MAX_PAGE_ENTRIES = 128;
const MAX_PAGE_BYTES = 512 * 1024;
const REVIEW_ENTRY_TYPE = "desktop-review";
const REVIEW_APPLIED_TYPE = "desktop-review-applied";

function projectName(cwd: string): string {
	return path.basename(cwd) || path.parse(cwd).root || "Project";
}
function stableProjectId(cwd: string): string {
	let canonical = path.resolve(cwd);
	try {
		canonical = fs.realpathSync.native(canonical);
	} catch {}
	return `project-${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}
function checkCancelled(signal: AbortSignal): void {
	if (signal.aborted) throw Object.assign(new Error("operation was cancelled"), { code: "ABORTED" });
}
function sessionRecord(info: SessionInfo, archivedAt?: string): BridgeSessionRecord {
	return {
		sessionId: info.id,
		path: info.path,
		cwd: info.cwd,
		projectId: stableProjectId(info.cwd),
		projectName: projectName(info.cwd),
		title: info.title || "Untitled",
		updatedAt: info.modified.toISOString(),
		status: "idle",
		...(archivedAt ? { archivedAt } : {}),
		entriesLoaded: false,
		entries: [],
	};
}
function durableEntries(entries: readonly Record<string, unknown>[], sessionId: string): Record<string, unknown>[] {
	return entries.map((entry, index) => {
		const { id, parentId, timestamp, type, ...data } = entry;
		return {
			id: typeof id === "string" && id ? id : `entry-${index}`,
			parentId: typeof parentId === "string" ? parentId : null,
			hostId: "omp-authority",
			sessionId,
			kind: typeof type === "string" && type ? type : "unknown",
			timestamp: typeof timestamp === "string" ? timestamp : new Date(0).toISOString(),
			data,
		};
	});
}
function boundedPage(
	entries: readonly Record<string, unknown>[],
	args: Record<string, unknown>,
): Record<string, unknown> {
	for (const key of Object.keys(args))
		if (!["before", "limit", "maxBytes"].includes(key)) throw new Error("invalid transcript page arguments");
	const limit = args.limit ?? MAX_PAGE_ENTRIES;
	const maxBytes = args.maxBytes ?? MAX_PAGE_BYTES;
	if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_PAGE_ENTRIES)
		throw Object.assign(new Error("invalid transcript page limit"), { code: "BOUNDS" });
	if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 1024 || (maxBytes as number) > MAX_PAGE_BYTES)
		throw Object.assign(new Error("invalid transcript page byte limit"), { code: "BOUNDS" });
	let end = entries.length;
	if (args.before !== undefined) {
		if (typeof args.before !== "string" || !/^entry:\d+$/u.test(args.before))
			throw new Error("invalid transcript cursor");
		end = Number(args.before.slice(6));
		if (!Number.isSafeInteger(end) || end < 0 || end > entries.length) throw new Error("stale transcript cursor");
	}
	const selected: Record<string, unknown>[] = [];
	let bytes = 0;
	for (let index = end - 1; index >= 0 && selected.length < (limit as number); index--) {
		const candidate = entries[index];
		const size = Buffer.byteLength(JSON.stringify(candidate), "utf8");
		if (selected.length > 0 && bytes + size > (maxBytes as number)) break;
		if (size > (maxBytes as number))
			throw Object.assign(new Error("transcript entry exceeds page limit"), { code: "BOUNDS" });
		selected.unshift(candidate);
		bytes += size;
	}
	const start = end - selected.length;
	return {
		entries: selected,
		...(start > 0 ? { nextCursor: `entry:${start}` } : {}),
		hasMore: start > 0,
		generation: createHash("sha256")
			.update(JSON.stringify(entries.map(entry => entry.id)))
			.digest("hex")
			.slice(0, 32),
	};
}

export async function createDefaultOmpAuthorityBridgeAuthority(): Promise<OmpAuthorityBridgeAuthority> {
	const sessionsRoot = path.resolve(getSessionsDir());
	const lifecycle = new AppserverSessionLifecycleStore(
		path.join(getAgentDir(), "appserver", "session-lifecycle.json"),
		sessionsRoot,
	);
	await lifecycle.recoverDeletes();
	const settings = await Settings.loadIsolated({ cwd: process.cwd() });
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	const usage = createAppserverUsageAuthority(authStorage, modelRegistry);
	const records = new Map<string, BridgeSessionRecord>();
	const dirtyManagers = new Set<SessionManager>();
	const terminalOwners = new Map<string, string>();
	let quiesced = false;

	const refresh = async (signal: AbortSignal): Promise<BridgeSessionRecord[]> => {
		checkCancelled(signal);
		const archived = await lifecycle.archivedSessions();
		const all = await SessionManager.listAll();
		checkCancelled(signal);
		const result = all.map(info => sessionRecord(info, archived.get(info.id)));
		records.clear();
		for (const item of result) records.set(item.sessionId, item);
		return result;
	};
	const authoritativeSession = async (
		session: BridgeSessionRecord,
		signal: AbortSignal,
	): Promise<BridgeSessionRecord> => {
		const current = (await refresh(signal)).find(item => item.sessionId === session.sessionId);
		if (!current || path.resolve(current.path) !== path.resolve(session.path))
			throw Object.assign(new Error("session reference changed"), { code: "CONFLICT" });
		return current;
	};
	const rootFor = (sessionId: string): string => {
		const record = records.get(sessionId);
		if (!record) throw Object.assign(new Error("unknown session"), { code: "NOT_FOUND" });
		return record.cwd;
	};
	const reviewStore = {
		async read(request: DesktopReviewReadRequest, context?: OperationContextLike): Promise<Record<string, unknown>> {
			const sessionId = context?.sessionId;
			if (!sessionId) throw Object.assign(new Error("review session is required"), { code: "NOT_FOUND" });
			const record = records.get(sessionId);
			if (!record) throw Object.assign(new Error("unknown session"), { code: "NOT_FOUND" });
			const entries = await loadEntriesFromFile(record.path);
			const found = entries.find(
				(entry): entry is CustomEntry<Record<string, unknown>> & { data: Record<string, unknown> } =>
					entry.type === "custom" &&
					entry.customType === REVIEW_ENTRY_TYPE &&
					entry.data !== null &&
					typeof entry.data === "object" &&
					!Array.isArray(entry.data) &&
					"reviewId" in entry.data &&
					entry.data.reviewId === request.reviewId,
			);
			if (!found) throw Object.assign(new Error("review was not found"), { code: "NOT_FOUND" });
			return structuredClone(found.data);
		},
		async apply(
			request: DesktopReviewApplyRequest,
			context?: OperationContextLike,
		): Promise<Record<string, unknown>> {
			const current = await this.read({ reviewId: request.reviewId }, context);
			if (request.expectedRevision !== undefined && current.revision !== request.expectedRevision)
				throw Object.assign(new Error("review revision is stale"), { code: "STALE_REVISION" });
			const sessionId = context?.sessionId;
			const record = sessionId ? records.get(sessionId) : undefined;
			if (!record) throw Object.assign(new Error("unknown session"), { code: "NOT_FOUND" });
			const manager = await SessionManager.open(record.path);
			dirtyManagers.add(manager);
			manager.appendCustomEntry(REVIEW_APPLIED_TYPE, {
				reviewId: request.reviewId,
				revision: current.revision,
				appliedAt: new Date().toISOString(),
			});
			await manager.flush();
			dirtyManagers.delete(manager);
			await manager.close();
			return { ...current, status: "applied" };
		},
	};
	const coding = new CodingAgentDesktopAuthority(
		{
			sessionManager: {
				getSessionId: () => records.keys().next().value ?? "",
				getCwd: () => records.values().next().value?.cwd ?? process.cwd(),
			},
			projectRootForSession: rootFor,
			reviewStore,
		},
		`bridge-${randomUUID()}`,
	);
	const config = createDesktopConfigAuthority({
		settings: {
			get: settingPath => settings.get(settingPath),
			isConfigured: settingPath => settings.isConfigured(settingPath),
			set: (settingPath, value) => settings.set(settingPath, value as never),
			override: (settingPath, value) => settings.override(settingPath, value as never),
			clearOverride: settingPath => settings.clearOverride(settingPath),
			flush: () => settings.flush(),
			getDesktopSnapshot: settingPath => settings.getDesktopSnapshot(settingPath),
			restoreDesktopSnapshot: snapshot => settings.restoreDesktopSnapshot(snapshot),
			clearGlobal: settingPath => settings.clearGlobal(settingPath),
		},
		modelRegistry,
		skillsLoader: async () => (await discoverSkills(process.cwd())).skills,
	});
	const broker = createAppserverBrokerStatus({ authStorage, configuredUrl: settings.get("auth.broker.url") });
	const operations: BridgeOperationsAuthority = {
		filesRead: (args, context) => coding.filesRead(args as never, context),
		filesList: (args, context) => coding.filesList(args as never, context),
		filesDiff: (args, context) => coding.filesDiff(args as never, context),
		filesWrite: (args, context) => coding.filesWrite(args as never, context),
		filesPatch: (args, context) => coding.filesPatch(args as never, context),
		reviewRead: (args, context) => coding.reviewRead(args as never, context),
		reviewApply: (args, context) => coding.reviewApply(args as never, context),
		bashRun: (args, context) => coding.runBash(args as never, context),
		termOpen: async (args, context) => {
			let terminalId: string | undefined;
			let sequence = 0;
			const pending: unknown[] = [];
			let active = true;
			const emit = (payload: unknown): void => {
				if (!active) return;
				if (!terminalId) pending.push(payload);
				else context.emitTerminalOutput?.(payload);
			};
			const onAbort = (): void => {
				active = false;
				pending.length = 0;
				if (terminalId) {
					try {
						coding.closeTerminal(terminalId);
					} catch {}
					terminalOwners.delete(terminalId);
				}
			};
			context.abortSignal.addEventListener("abort", onAbort, { once: true });
			try {
				const request = args as DesktopTerminalRequest;
				const result = await coding.openTerminal(
					{
						...request,
						onOutput: (stream, data) =>
							emit({
								v: "omp-app/1",
								type: "terminal.output",
								hostId: context.hostId,
								sessionId: context.sessionId,
								terminalId,
								cursor: { epoch: "terminal", seq: ++sequence },
								stream,
								data,
							}),
						onExit: exit => {
							emit({
								v: "omp-app/1",
								type: "terminal.exit",
								hostId: context.hostId,
								sessionId: context.sessionId,
								terminalId,
								cursor: { epoch: "terminal", seq: ++sequence },
								exitCode: exit.exitCode ?? -1,
							});
							if (terminalId) terminalOwners.delete(terminalId);
						},
					},
					context,
				);
				terminalId = result.terminalId;
				terminalOwners.set(terminalId, context.connectionId);
				for (const payload of pending.splice(0)) context.emitTerminalOutput?.(payload);
				return result;
			} finally {
				context.abortSignal.removeEventListener("abort", onAbort);
			}
		},
		catalogGet: (args, context) => config.catalogGet(args, context),
		settingsRead: async (args, context) => config.settingsRead(args, context),
		brokerStatus: async (_args, context) => broker(context.abortSignal),
		settingsWrite: (args, context) => config.settingsWrite(args, context),
		configWrite: (args, context) => config.configWrite(args, context),
		terminalInput: async (frame, context) => {
			checkCancelled(context.abortSignal);
			if (terminalOwners.get(String(frame.terminalId)) !== context.connectionId)
				throw Object.assign(new Error("terminal is not owned by this connection"), { code: "FORBIDDEN" });
			coding.inputTerminal(String(frame.terminalId), String(frame.data));
		},
		terminalResize: async (frame, context) => {
			checkCancelled(context.abortSignal);
			if (terminalOwners.get(String(frame.terminalId)) !== context.connectionId)
				throw Object.assign(new Error("terminal is not owned by this connection"), { code: "FORBIDDEN" });
			coding.resizeTerminal(String(frame.terminalId), Number(frame.cols), Number(frame.rows));
		},
		terminalClose: async (frame, context) => {
			checkCancelled(context.abortSignal);
			const terminalId = String(frame.terminalId);
			if (terminalOwners.get(terminalId) !== context.connectionId)
				throw Object.assign(new Error("terminal is not owned by this connection"), { code: "FORBIDDEN" });
			coding.closeTerminal(terminalId);
			terminalOwners.delete(terminalId);
		},
	};

	const authority: OmpAuthorityBridgeAuthority = {
		async create(cwd, title, signal) {
			checkCancelled(signal);
			const manager = SessionManager.create(cwd);
			dirtyManagers.add(manager);
			try {
				if (title !== undefined) await manager.setSessionName(title, "user");
				await manager.ensureOnDisk();
				const file = manager.getSessionFile();
				if (!file) throw new Error("session file was not created");
				const info = (await SessionManager.listAll()).find(item => item.id === manager.getSessionId());
				if (!info) throw new Error("created session was not discovered");
				const result = sessionRecord(info);
				records.set(result.sessionId, result);
				return result;
			} finally {
				dirtyManagers.delete(manager);
				await manager.close();
			}
		},
		async fork(source, cwd, signal) {
			checkCancelled(signal);
			const available = (await refresh(signal)).find(item => item.sessionId === source.sessionId);
			if (!available) throw Object.assign(new Error("unknown session"), { code: "NOT_FOUND" });
			const manager = await SessionManager.forkFrom(available.path, cwd ?? available.cwd);
			dirtyManagers.add(manager);
			try {
				const file = manager.getSessionFile();
				if (!file) throw new Error("forked session was not written");
				const result: BridgeSessionRecord = {
					sessionId: manager.getSessionId(),
					path: file,
					cwd: manager.getCwd(),
					projectId: stableProjectId(manager.getCwd()),
					projectName: projectName(manager.getCwd()),
					title: manager.getSessionName() || "Untitled",
					updatedAt: new Date().toISOString(),
					status: "idle",
					entriesLoaded: false,
					entries: [],
				};
				records.set(result.sessionId, result);
				return result;
			} finally {
				dirtyManagers.delete(manager);
				await manager.close();
			}
		},
		list: refresh,
		async archive(session, archivedAt, signal) {
			const current = await authoritativeSession(session, signal);
			await lifecycle.archiveSession(session.sessionId, archivedAt, current.path);
		},
		async restore(session, signal) {
			checkCancelled(signal);
			await authoritativeSession(session, signal);
			await lifecycle.restore(session.sessionId);
		},
		async delete(session, signal) {
			const current = await authoritativeSession(session, signal);
			await lifecycle.deleteSession(session.sessionId, current.path);
			records.delete(session.sessionId);
		},
		async load(session, signal) {
			checkCancelled(signal);
			const current = (await refresh(signal)).find(item => item.sessionId === session.sessionId);
			if (!current || path.resolve(current.path) !== path.resolve(session.path))
				throw Object.assign(new Error("unknown session"), { code: "NOT_FOUND" });
			const raw = (await loadEntriesFromFile(current.path)) as unknown as Record<string, unknown>[];
			const entries = durableEntries(raw.slice(1), current.sessionId);
			return { ...current, entriesLoaded: true, entries };
		},
		async page(session, args, signal) {
			const loaded = await authority.load(session, signal);
			return boundedPage(loaded.entries as Record<string, unknown>[], args);
		},
		async rootForProject(projectId, signal) {
			const match = (await refresh(signal)).find(item => item.projectId === projectId);
			if (!match) throw Object.assign(new Error("unknown project"), { code: "NOT_FOUND" });
			return match.cwd;
		},
		async rootForSession(sessionId, signal) {
			await refresh(signal);
			return rootFor(sessionId);
		},
		async lockCheck(session, signal) {
			const current = await authoritativeSession(session, signal);
			const inspection = inspectSessionLock(current.path);
			if (inspection.status === "missing") return;
			if (inspection.status === "stale" && inspection.stealable) {
				acquireSessionLock(current.path).release();
				return;
			}
			throw Object.assign(new Error(`session lock is ${inspection.status}`), { code: "CONFLICT" });
		},
		async lockStatus(session, signal) {
			const current = await authoritativeSession(session, signal);
			return inspectSessionLock(current.path).status;
		},
		operations,
		usageRead: signal => usage.read(signal),
		async flush() {
			await Promise.all([...dirtyManagers].map(manager => manager.flush()));
			await settings.flush();
			await lifecycle.flush();
		},
		async quiesce({ interrupt }) {
			quiesced = true;
			if (interrupt) coding.disconnect();
			await authority.flush();
			if (!quiesced) throw new Error("authority quiesce failed");
		},
		async shutdown() {
			coding.disconnect();
			await authority.flush();
		},
	};
	return authority;
}
