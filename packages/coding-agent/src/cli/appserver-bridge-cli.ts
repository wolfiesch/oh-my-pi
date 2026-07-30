import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	decodeOmpAuthorityBridgeClientFrame,
	decodeOmpAuthorityBridgeServerFrame,
	encodeOmpAuthorityBridgeFrame,
	OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES,
	OMP_AUTHORITY_BRIDGE_PROTOCOL,
	type OmpAuthorityBridgeClientFrame,
	type OmpAuthorityBridgeMethod,
} from "../../../appserver/src/omp-authority-bridge-contract";
import { getBlobsDir, VERSION } from "@oh-my-pi/pi-utils/dirs";
import type { SessionInfo } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";

const MAX_SESSION_RECORDS = 1_000;
const MAX_SESSION_LIST_SNAPSHOTS = 4;
const SESSION_LIST_SNAPSHOT_TTL_MS = 30_000;
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 10_000;
const MAX_LIFECYCLE_TIMEOUT_MS = 30_000;
const METHODS = [
	"host.info",
	"authority.flush",
	"authority.quiesce",
	"session.create",
	"session.fork",
	"session.list",
] as const satisfies readonly OmpAuthorityBridgeMethod[];
const MUTATING_METHODS: Partial<Record<OmpAuthorityBridgeMethod, true>> = {
	"session.create": true,
	"session.fork": true,
};

export interface BridgeSessionRecord {
	readonly sessionId: string;
	readonly path: string;
	readonly cwd: string;
	readonly projectId: string;
	readonly projectName?: string;
	readonly title: string;
	readonly updatedAt: string;
	readonly status: "idle";
	readonly entriesLoaded: false;
	readonly entries: readonly [];
}

export interface OmpAuthorityBridgeAuthority {
	create(cwd: string, title: string | undefined, signal: AbortSignal): Promise<BridgeSessionRecord>;
	fork(source: BridgeSessionRecord, cwd: string | undefined, signal: AbortSignal): Promise<BridgeSessionRecord>;
	list(signal: AbortSignal): Promise<readonly BridgeSessionRecord[]>;
	flush(): Promise<void>;
	quiesce(options: { readonly interrupt: boolean }): Promise<void>;
}

interface SessionListSnapshot {
	readonly references: readonly BridgeSessionRecord[];
	readonly offset: number;
	readonly expiresAt: number;
	readonly complete: boolean;
	readonly totalCount: number;
}
interface SessionListPage {
	readonly sessions: readonly BridgeSessionRecord[];
	readonly nextCursor?: string;
	readonly complete: boolean;
	readonly totalCount: number;
}
interface ActiveRequest {
	readonly controller: AbortController;
	readonly method: OmpAuthorityBridgeMethod;
	promise: Promise<void>;
}
interface BridgeState {
	quiesced: boolean;
	readonly generation: string;
	readonly requests: Map<string, ActiveRequest>;
}
export interface OmpAuthorityBridgeRunnerOptions {
	readonly authority?: OmpAuthorityBridgeAuthority;
	readonly input?: AsyncIterable<string | Uint8Array>;
	readonly write?: (line: string) => void | Promise<void>;
	readonly identity?: { readonly ompVersion: string; readonly ompBuild: string };
	readonly generation?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
		throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
		throw new Error(`${label} is invalid`);
}
function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
	return value;
}
function optionalString(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : requiredString(value, label);
}
function projectName(cwd: string): string {
	return path.basename(cwd) || path.parse(cwd).root || "Project";
}
function stableProjectId(cwd: string): string {
	let canonical = path.resolve(cwd);
	try { canonical = fs.realpathSync.native(canonical); } catch {}
	return `project-${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}
function sessionRecord(info: SessionInfo): BridgeSessionRecord {
	return {
		sessionId: info.id,
		path: info.path,
		cwd: info.cwd,
		projectId: stableProjectId(info.cwd),
		projectName: projectName(info.cwd),
		title: info.title || "Untitled",
		updatedAt: info.modified.toISOString(),
		status: "idle",
		entriesLoaded: false,
		entries: [],
	};
}
function requestedSession(value: unknown): BridgeSessionRecord {
	const item = record(value, "session");
	return {
		sessionId: requiredString(item.sessionId, "session id"),
		path: requiredString(item.path, "session path"),
		cwd: requiredString(item.cwd, "session cwd"),
		projectId: requiredString(item.projectId, "session project id"),
		...(item.projectName === undefined ? {} : { projectName: requiredString(item.projectName, "session project name") }),
		title: requiredString(item.title, "session title"),
		updatedAt: requiredString(item.updatedAt, "session update time"),
		status: "idle",
		entriesLoaded: false,
		entries: [],
	};
}

async function syncFileAndParent(filePath: string): Promise<void> {
	const file = await fs.promises.open(filePath, "r");
	try { await file.sync(); } finally { await file.close(); }
	const directory = await fs.promises.open(path.dirname(filePath), "r");
	try { await directory.sync(); } finally { await directory.close(); }
}

export function createDefaultOmpAuthorityBridgeAuthority(): OmpAuthorityBridgeAuthority {
	const dirtyPaths = new Set<string>();
	const persist = async (manager: SessionManager): Promise<BridgeSessionRecord> => {
		await manager.ensureOnDisk();
		const sessionPath = manager.getSessionFile();
		if (!sessionPath) throw new Error("session file was not created");
		dirtyPaths.add(sessionPath);
		return {
			sessionId: manager.getSessionId(),
			path: sessionPath,
			cwd: manager.getCwd(),
			projectId: stableProjectId(manager.getCwd()),
			projectName: projectName(manager.getCwd()),
			title: manager.getSessionName() || "Untitled",
			updatedAt: new Date().toISOString(),
			status: "idle",
			entriesLoaded: false,
			entries: [],
		};
	};
	const flush = async (): Promise<void> => {
		for (const filePath of [...dirtyPaths]) {
			await syncFileAndParent(filePath);
			dirtyPaths.delete(filePath);
		}
	};
	return {
		async create(cwd, title, signal) {
			if (signal.aborted) throw Object.assign(new Error("operation was cancelled"), { code: "ABORTED" });
			const manager = SessionManager.create(cwd);
			try {
				if (title !== undefined) await manager.setSessionName(title, "user");
				return await persist(manager);
			} finally {
				await manager.close();
			}
		},
		async fork(source, cwd, signal) {
			if (signal.aborted) throw Object.assign(new Error("operation was cancelled"), { code: "ABORTED" });
			const available = (await SessionManager.listAll()).find(candidate => candidate.id === source.sessionId);
			if (!available) throw Object.assign(new Error("unknown session"), { code: "NOT_FOUND" });
			const manager = await SessionManager.forkFrom(available.path, cwd ?? available.cwd);
			try { return await persist(manager); } finally { await manager.close(); }
		},
		async list(signal) {
			if (signal.aborted) throw Object.assign(new Error("operation was cancelled"), { code: "ABORTED" });
			return (await SessionManager.listAll()).map(sessionRecord);
		},
		flush,
		async quiesce() { await flush(); },
	};
}

function sessionListPage(
	id: string,
	snapshot: SessionListSnapshot,
	snapshots: Map<string, SessionListSnapshot>,
): SessionListPage {
	const nextCursor = randomUUID();
	let lower = snapshot.offset;
	let upper = snapshot.references.length;
	while (lower < upper) {
		const end = Math.ceil((lower + upper) / 2);
		const result: SessionListPage = {
			sessions: snapshot.references.slice(snapshot.offset, end),
			...(end < snapshot.references.length ? { nextCursor } : {}),
			complete: snapshot.complete,
			totalCount: snapshot.totalCount,
		};
		try {
			decodeOmpAuthorityBridgeServerFrame(JSON.parse(encodeOmpAuthorityBridgeFrame({
				v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
				type: "response",
				id,
				ok: true,
				result,
			})));
			lower = end;
		} catch {
			upper = end - 1;
		}
	}
	if (lower === snapshot.offset && snapshot.offset < snapshot.references.length)
		throw Object.assign(new Error("one session exceeds the bridge line limit"), { code: "BOUNDS" });
	const result: SessionListPage = {
		sessions: snapshot.references.slice(snapshot.offset, lower),
		...(lower < snapshot.references.length ? { nextCursor } : {}),
		complete: snapshot.complete,
		totalCount: snapshot.totalCount,
	};
	if (result.nextCursor)
		snapshots.set(result.nextCursor, { ...snapshot, offset: lower, expiresAt: Date.now() + SESSION_LIST_SNAPSHOT_TTL_MS });
	return result;
}

async function listSessionPage(
	authority: OmpAuthorityBridgeAuthority,
	id: string,
	params: Record<string, unknown>,
	snapshots: Map<string, SessionListSnapshot>,
	signal: AbortSignal,
): Promise<SessionListPage> {
	const now = Date.now();
	for (const [cursor, snapshot] of snapshots) if (snapshot.expiresAt <= now) snapshots.delete(cursor);
	const cursor = params.cursor === undefined ? undefined : requiredString(params.cursor, "session.list cursor");
	exact(params, cursor === undefined ? [] : ["cursor"], "session.list params");
	if (cursor !== undefined) {
		const snapshot = snapshots.get(cursor);
		snapshots.delete(cursor);
		if (!snapshot) throw Object.assign(new Error("session inventory cursor is unavailable"), { code: "NOT_FOUND" });
		return sessionListPage(id, snapshot, snapshots);
	}
	if (snapshots.size >= MAX_SESSION_LIST_SNAPSHOTS)
		throw Object.assign(new Error("too many session inventory snapshots"), { code: "BOUNDS" });
	const all = await authority.list(signal);
	const references = all.slice(0, MAX_SESSION_RECORDS);
	return sessionListPage(id, {
		references,
		offset: 0,
		expiresAt: now + SESSION_LIST_SNAPSHOT_TTL_MS,
		complete: all.length <= MAX_SESSION_RECORDS,
		totalCount: all.length,
	}, snapshots);
}

function lifecycleParams(params: Record<string, unknown>, generation: string): { timeoutMs: number; interrupt: boolean } {
	exact(params, [
		...(params.generation === undefined ? [] : ["generation"]),
		...(params.timeoutMs === undefined ? [] : ["timeoutMs"]),
		...(params.interrupt === undefined ? [] : ["interrupt"]),
	], "authority lifecycle params");
	if (params.generation !== undefined && requiredString(params.generation, "runtime generation") !== generation)
		throw Object.assign(new Error("runtime generation is stale"), { code: "STALE_GENERATION" });
	const timeoutMs = params.timeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > MAX_LIFECYCLE_TIMEOUT_MS)
		throw Object.assign(new Error("lifecycle timeout is invalid"), { code: "BOUNDS" });
	if (params.interrupt !== undefined && typeof params.interrupt !== "boolean") throw new Error("interrupt policy is invalid");
	return { timeoutMs: timeoutMs as number, interrupt: params.interrupt !== false };
}
async function bounded<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(Object.assign(new Error("operation timed out"), { code: "TIMEOUT" })), timeoutMs);
	try { return await Promise.race([task, timeout.promise]); } finally { clearTimeout(timer); }
}
function acknowledgement(generation: string, quiesced: boolean): Record<string, unknown> {
	return { schemaVersion: 1, generation, durable: true, ...(quiesced ? { quiesced: true } : {}) };
}
function safeError(error: unknown): { code: string; message: string } {
	const raw = error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code.toUpperCase()
		: "BRIDGE_FAILED";
	const known: Record<string, string> = {
		ABORTED: "operation was cancelled",
		BOUNDS: "operation exceeds a bridge limit",
		CONFLICT: "operation conflicts with current state",
		FORBIDDEN: "operation is not permitted",
		NOT_FOUND: "resource was not found",
		QUIESCED: "authority is quiesced",
		STALE_GENERATION: "runtime generation is stale",
		TIMEOUT: "operation timed out",
		UNSUPPORTED: "operation is unsupported",
	};
	const code = known[raw] ? raw : "BRIDGE_FAILED";
	return { code, message: known[code] ?? "OMP authority bridge request failed" };
}

async function* lines(input: AsyncIterable<string | Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let pending = "";
	for await (const chunk of input) {
		pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		let index = pending.indexOf("\n");
		while (index >= 0) {
			const line = pending.slice(0, index).replace(/\r$/u, "");
			if (Buffer.byteLength(line, "utf8") > OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES)
				throw new Error("bridge input exceeds the line limit");
			yield line;
			pending = pending.slice(index + 1);
			index = pending.indexOf("\n");
		}
		if (Buffer.byteLength(pending, "utf8") > OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES)
			throw new Error("bridge input exceeds the line limit");
	}
	pending += decoder.decode();
	if (Buffer.byteLength(pending, "utf8") > OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES)
		throw new Error("bridge input exceeds the line limit");
	if (pending) yield pending;
}

async function dispatch(
	authority: OmpAuthorityBridgeAuthority,
	frame: Extract<OmpAuthorityBridgeClientFrame, { type: "request" }>,
	signal: AbortSignal,
	snapshots: Map<string, SessionListSnapshot>,
	state: BridgeState,
): Promise<unknown> {
	const params = frame.params;
	switch (frame.method) {
		case "host.info":
			exact(params, [], "host.info params");
			return { transcriptImageRoot: getBlobsDir(), generation: state.generation, health: "ready", acceptingMutations: !state.quiesced };
		case "authority.flush": {
			const policy = lifecycleParams(params, state.generation);
			const pending = [...state.requests.entries()]
				.filter(([id, request]) => id !== frame.id && MUTATING_METHODS[request.method])
				.map(([, request]) => request.promise);
			await bounded(Promise.allSettled(pending).then(() => undefined), policy.timeoutMs);
			await bounded(authority.flush(), policy.timeoutMs);
			return acknowledgement(state.generation, false);
		}
		case "authority.quiesce": {
			const policy = lifecycleParams(params, state.generation);
			const previous = state.quiesced;
			state.quiesced = true;
			try {
				const active = [...state.requests.entries()].filter(([id]) => id !== frame.id).map(([, request]) => request);
				if (!policy.interrupt && active.length > 0)
					throw Object.assign(new Error("authority work is active"), { code: "CONFLICT" });
				if (policy.interrupt) for (const request of active) request.controller.abort();
				await bounded(Promise.allSettled(active.map(request => request.promise)).then(() => undefined), policy.timeoutMs);
				await bounded(authority.quiesce({ interrupt: policy.interrupt }), policy.timeoutMs);
				return acknowledgement(state.generation, true);
			} catch (error) {
				state.quiesced = previous;
				throw error;
			}
		}
		case "session.create": {
			exact(params, ["cwd", ...(params.title === undefined ? [] : ["title"])], "session.create params");
			return authority.create(requiredString(params.cwd, "session cwd"), optionalString(params.title, "session title"), signal);
		}
		case "session.fork": {
			exact(params, ["session", ...(params.cwd === undefined ? [] : ["cwd"])], "session.fork params");
			return authority.fork(requestedSession(params.session), optionalString(params.cwd, "fork cwd"), signal);
		}
		case "session.list":
			return listSessionPage(authority, frame.id, params, snapshots, signal);
		default:
			throw Object.assign(new Error("unsupported"), { code: "UNSUPPORTED" });
	}
}

export async function runOmpAuthorityBridge(options: OmpAuthorityBridgeRunnerOptions = {}): Promise<void> {
	const authority = options.authority ?? createDefaultOmpAuthorityBridgeAuthority();
	const input = options.input ?? process.stdin as unknown as AsyncIterable<Uint8Array>;
	const output = options.write ?? (line => new Promise<void>((resolve, reject) => {
		process.stdout.write(line, error => error ? reject(error) : resolve());
	}));
	let writeTail = Promise.resolve();
	const write = (frame: Parameters<typeof encodeOmpAuthorityBridgeFrame>[0]): Promise<void> => {
		const line = encodeOmpAuthorityBridgeFrame(frame);
		writeTail = writeTail.then(() => output(line));
		return writeTail;
	};
	const generation = options.generation ?? process.env.T4_RUNTIME_GENERATION ?? `standalone:${randomUUID()}`;
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(generation)) throw new Error("runtime generation is invalid");
	const identity = options.identity ?? {
		ompVersion: VERSION,
		ompBuild: process.env.T4_OMP_BUILD ?? process.env.OMP_BUILD ?? "source",
	};
	await write({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "ready", methods: METHODS, ...identity });
	const state: BridgeState = { quiesced: false, generation, requests: new Map() };
	const snapshots = new Map<string, SessionListSnapshot>();
	for await (const line of lines(input)) {
		if (!line) continue;
		const frame = decodeOmpAuthorityBridgeClientFrame(JSON.parse(line));
		if (frame.type === "cancel") {
			state.requests.get(frame.id)?.controller.abort();
			continue;
		}
		if (!(METHODS as readonly OmpAuthorityBridgeMethod[]).includes(frame.method)) {
			await write({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "response", id: frame.id, ok: false, error: safeError({ code: "UNSUPPORTED" }) });
			continue;
		}
		if (state.requests.has(frame.id)) throw new Error("duplicate bridge request id");
		if (state.quiesced && MUTATING_METHODS[frame.method]) {
			await write({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "response", id: frame.id, ok: false, error: safeError({ code: "QUIESCED" }) });
			continue;
		}
		const controller = new AbortController();
		const active: ActiveRequest = { controller, method: frame.method, promise: Promise.resolve() };
		state.requests.set(frame.id, active);
		active.promise = dispatch(authority, frame, controller.signal, snapshots, state)
			.then(
				result => write({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "response", id: frame.id, ok: true, result: result ?? null }),
				error => write({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "response", id: frame.id, ok: false, error: safeError(error) }),
			)
			.then(() => undefined)
			.finally(() => state.requests.delete(frame.id));
	}
	for (const request of state.requests.values()) request.controller.abort();
	await Promise.allSettled([...state.requests.values()].map(request => request.promise));
	await writeTail;
}
