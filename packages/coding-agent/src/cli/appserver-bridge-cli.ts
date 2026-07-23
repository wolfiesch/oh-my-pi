import { randomUUID } from "node:crypto";
import { type DeviceCapability, MAX_ARRAY_ITEMS } from "@oh-my-pi/app-wire";
import {
	decodeOmpAuthorityBridgeClientFrame,
	decodeOmpAuthorityBridgeServerFrame,
	encodeOmpAuthorityBridgeFrame,
	OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES,
	OMP_AUTHORITY_BRIDGE_PROTOCOL,
	type OmpAuthorityBridgeClientFrame,
	type OmpAuthorityBridgeMethod,
	type OperationContext,
	type SessionRecord,
} from "@oh-my-pi/appserver";
import { getBlobsDir } from "@oh-my-pi/pi-utils/dirs";
import { createDefaultAppserverRuntime } from "./appserver-cli";
import { getCodingAgentAppserverIdentity } from "./appserver-identity";

type Runtime = Awaited<ReturnType<typeof createDefaultAppserverRuntime>>;
const MAX_SESSION_LIST_SNAPSHOTS = 4;
const SESSION_LIST_SNAPSHOT_TTL_MS = 30_000;

interface SessionListSnapshot {
	readonly references: readonly SessionRecord[];
	readonly offset: number;
	readonly expiresAt: number;
	readonly complete: boolean;
	readonly totalCount: number;
}

interface SessionListPage {
	readonly sessions: readonly SessionRecord[];
	readonly nextCursor?: string;
	readonly complete: boolean;
	readonly totalCount: number;
}

const BASE_METHODS = [
	"host.info",
	"session.create",
	"session.list",
	"session.archive",
	"session.restore",
	"session.delete",
	"discovery.load",
	"discovery.page",
	"project.rootForProject",
	"project.rootForSession",
	"lock.check",
	"lock.status",
	"terminal.input",
	"terminal.resize",
	"terminal.close",
] as const satisfies readonly OmpAuthorityBridgeMethod[];

const OPERATION_METHODS = {
	"operation.filesRead": "filesRead",
	"operation.filesList": "filesList",
	"operation.filesDiff": "filesDiff",
	"operation.filesWrite": "filesWrite",
	"operation.filesPatch": "filesPatch",
	"operation.reviewRead": "reviewRead",
	"operation.reviewApply": "reviewApply",
	"operation.bashRun": "bashRun",
	"operation.termOpen": "termOpen",
	"operation.catalogGet": "catalogGet",
	"operation.settingsRead": "settingsRead",
	"operation.brokerStatus": "brokerStatus",
	"operation.settingsWrite": "settingsWrite",
	"operation.configWrite": "configWrite",
} as const satisfies Partial<Record<OmpAuthorityBridgeMethod, keyof Runtime["operationsAuthority"]>>;

export interface OmpAuthorityBridgeRunnerOptions {
	readonly runtime?: Runtime;
	readonly input?: AsyncIterable<string | Uint8Array>;
	readonly write?: (line: string) => void | Promise<void>;
	readonly identity?: { readonly ompVersion: string; readonly ompBuild: string };
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
		throw new Error(`${label} is invalid`);
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
	return value;
}

function optionalString(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : string(value, label);
}

function session(value: unknown): SessionRecord {
	const item = record(value, "session");
	for (const key of ["sessionId", "path", "cwd", "projectId", "title", "updatedAt", "status"])
		string(item[key], `session.${key}`);
	if (!Array.isArray(item.entries)) throw new Error("session.entries is invalid");
	return item as unknown as SessionRecord;
}

function sessionReference(value: SessionRecord): SessionRecord {
	return {
		sessionId: value.sessionId,
		path: value.path,
		cwd: value.cwd,
		projectId: value.projectId,
		...(value.projectName === undefined ? {} : { projectName: value.projectName }),
		title: value.title,
		updatedAt: value.updatedAt,
		status: value.status,
		...(value.archivedAt === undefined ? {} : { archivedAt: value.archivedAt }),
		...(value.model === undefined ? {} : { model: value.model }),
		...(value.thinking === undefined ? {} : { thinking: value.thinking }),
		...(value.runtime === undefined ? {} : { runtime: value.runtime }),
		entriesLoaded: false,
		entries: [],
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
			const encoded = encodeOmpAuthorityBridgeFrame({
				v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
				type: "response",
				id,
				ok: true,
				result,
			});
			decodeOmpAuthorityBridgeServerFrame(JSON.parse(encoded));
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
	if (result.nextCursor) {
		snapshots.set(result.nextCursor, {
			references: snapshot.references,
			offset: lower,
			expiresAt: Date.now() + SESSION_LIST_SNAPSHOT_TTL_MS,
			complete: snapshot.complete,
			totalCount: snapshot.totalCount,
		});
	}
	return result;
}

async function listSessionPage(
	runtime: Runtime,
	id: string,
	params: Record<string, unknown>,
	snapshots: Map<string, SessionListSnapshot>,
): Promise<SessionListPage> {
	const now = Date.now();
	for (const [cursor, snapshot] of snapshots) if (snapshot.expiresAt <= now) snapshots.delete(cursor);
	const cursor = params.cursor === undefined ? undefined : string(params.cursor, "session.list cursor");
	exact(params, cursor === undefined ? [] : ["cursor"], "session.list params");
	if (cursor !== undefined) {
		const snapshot = snapshots.get(cursor);
		snapshots.delete(cursor);
		if (!snapshot) throw Object.assign(new Error("session inventory cursor is unavailable"), { code: "NOT_FOUND" });
		return sessionListPage(id, snapshot, snapshots);
	}
	if (snapshots.size >= MAX_SESSION_LIST_SNAPSHOTS)
		throw Object.assign(new Error("too many session inventory snapshots"), { code: "BOUNDS" });
	const sessions = await runtime.sessionAuthority.list();
	return sessionListPage(
		id,
		{
			references: sessions.slice(0, MAX_ARRAY_ITEMS).map(sessionReference),
			offset: 0,
			expiresAt: now + SESSION_LIST_SNAPSHOT_TTL_MS,
			complete: sessions.length <= MAX_ARRAY_ITEMS,
			totalCount: sessions.length,
		},
		snapshots,
	);
}

function operationContext(
	value: unknown,
	abortSignal: AbortSignal,
	emitTerminalOutput: (frame: unknown) => void,
): OperationContext {
	const item = record(value, "operation context");
	exact(
		item,
		[
			"hostId",
			...(item.sessionId === undefined ? [] : ["sessionId"]),
			"deviceId",
			"connectionId",
			"capabilities",
			...(item.currentRevision === undefined ? [] : ["currentRevision"]),
			...(item.expectedRevision === undefined ? [] : ["expectedRevision"]),
		],
		"operation context",
	);
	if (!Array.isArray(item.capabilities) || item.capabilities.some(value => typeof value !== "string"))
		throw new Error("operation context capabilities are invalid");
	return {
		hostId: string(item.hostId, "operation host id") as never,
		...(item.sessionId === undefined ? {} : { sessionId: string(item.sessionId, "operation session id") as never }),
		deviceId: string(item.deviceId, "operation device id"),
		connectionId: string(item.connectionId, "operation connection id"),
		capabilities: new Set(item.capabilities as DeviceCapability[]),
		...(item.currentRevision === undefined
			? {}
			: { currentRevision: string(item.currentRevision, "current revision") as never }),
		...(item.expectedRevision === undefined
			? {}
			: { expectedRevision: string(item.expectedRevision, "expected revision") as never }),
		abortSignal,
		emitTerminalOutput,
	};
}

function safeError(error: unknown): { code: string; message: string } {
	const raw =
		error && typeof error === "object" && "code" in error && typeof error.code === "string"
			? error.code.toUpperCase()
			: "BRIDGE_FAILED";
	const known: Record<string, string> = {
		ABORTED: "operation was cancelled",
		BOUNDS: "operation exceeds a bridge limit",
		CONFLICT: "operation conflicts with current state",
		FORBIDDEN: "operation is not permitted",
		NOT_FOUND: "resource was not found",
		OPERATION_FAILED: "operation failed",
		STALE_REVISION: "resource revision is stale",
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

function advertisedMethods(runtime: Runtime): OmpAuthorityBridgeMethod[] {
	const methods: OmpAuthorityBridgeMethod[] = [...BASE_METHODS];
	if (!runtime.discovery.load) methods.splice(methods.indexOf("discovery.load"), 1);
	if (!runtime.discovery.page) methods.splice(methods.indexOf("discovery.page"), 1);
	if (
		!runtime.operationsAuthority.terminalInput ||
		!runtime.operationsAuthority.terminalResize ||
		!runtime.operationsAuthority.terminalClose
	) {
		for (const name of ["terminal.input", "terminal.resize", "terminal.close"] as const) {
			const index = methods.indexOf(name);
			if (index >= 0) methods.splice(index, 1);
		}
	}
	for (const [method, property] of Object.entries(OPERATION_METHODS) as Array<
		[OmpAuthorityBridgeMethod, keyof Runtime["operationsAuthority"]]
	>)
		if (typeof runtime.operationsAuthority[property] === "function") methods.push(method);
	if (runtime.usageAuthority) methods.push("usage.read");
	return methods;
}

async function dispatch(
	runtime: Runtime,
	frame: Extract<OmpAuthorityBridgeClientFrame, { type: "request" }>,
	abortSignal: AbortSignal,
	emitTerminalOutput: (value: unknown) => void,
	sessionListSnapshots: Map<string, SessionListSnapshot>,
): Promise<unknown> {
	const params = frame.params;
	switch (frame.method) {
		case "host.info":
			exact(params, [], "host.info params");
			return { transcriptImageRoot: getBlobsDir() };
		case "session.create": {
			exact(params, ["cwd", ...(params.title === undefined ? [] : ["title"])], "session.create params");
			return runtime.sessionAuthority.create(
				string(params.cwd, "session cwd"),
				optionalString(params.title, "session title"),
			);
		}
		case "session.list": {
			return listSessionPage(runtime, frame.id, params, sessionListSnapshots);
		}
		case "session.archive":
			exact(params, ["session", "archivedAt"], "session.archive params");
			await runtime.sessionAuthority.archive(session(params.session), string(params.archivedAt, "archive time"));
			return null;
		case "session.restore":
		case "session.delete": {
			exact(params, ["session"], `${frame.method} params`);
			await runtime.sessionAuthority[frame.method === "session.restore" ? "restore" : "delete"](
				session(params.session),
			);
			return null;
		}
		case "discovery.load":
			exact(params, ["session"], "discovery.load params");
			if (!runtime.discovery.load) throw Object.assign(new Error("unsupported"), { code: "UNSUPPORTED" });
			return runtime.discovery.load(session(params.session));
		case "discovery.page":
			exact(params, ["session", "args"], "discovery.page params");
			if (!runtime.discovery.page) throw Object.assign(new Error("unsupported"), { code: "UNSUPPORTED" });
			return runtime.discovery.page(session(params.session), record(params.args, "transcript page args") as never);
		case "project.rootForProject":
			exact(params, ["projectId"], "project.rootForProject params");
			return runtime.projectRootForProject(string(params.projectId, "project id") as never);
		case "project.rootForSession":
			exact(params, ["sessionId"], "project.rootForSession params");
			return runtime.projectRootForSession(string(params.sessionId, "session id") as never);
		case "lock.check":
			exact(params, ["session"], "lock.check params");
			await runtime.lockCheck(session(params.session));
			return null;
		case "lock.status":
			exact(params, ["session"], "lock.status params");
			return runtime.lockStatus(session(params.session));
		case "usage.read":
			exact(params, [], "usage.read params");
			if (!runtime.usageAuthority) throw Object.assign(new Error("unsupported"), { code: "UNSUPPORTED" });
			return runtime.usageAuthority.read(abortSignal);
		case "terminal.input":
		case "terminal.resize":
		case "terminal.close": {
			exact(params, ["frame", "context"], `${frame.method} params`);
			const property =
				frame.method === "terminal.input"
					? "terminalInput"
					: frame.method === "terminal.resize"
						? "terminalResize"
						: "terminalClose";
			const handler = runtime.operationsAuthority[property];
			if (!handler) throw Object.assign(new Error("unsupported"), { code: "UNSUPPORTED" });
			await (handler as (frame: never, context: OperationContext) => Promise<void>)(
				record(params.frame, "terminal frame") as never,
				operationContext(params.context, abortSignal, emitTerminalOutput),
			);
			return null;
		}
		default: {
			const property = OPERATION_METHODS[frame.method as keyof typeof OPERATION_METHODS];
			const handler = property ? runtime.operationsAuthority[property] : undefined;
			if (!property || typeof handler !== "function")
				throw Object.assign(new Error("unsupported"), { code: "UNSUPPORTED" });
			exact(params, ["args", "context"], `${frame.method} params`);
			return (handler as (args: never, context: OperationContext) => Promise<unknown>)(
				record(params.args, "operation args") as never,
				operationContext(params.context, abortSignal, emitTerminalOutput),
			);
		}
	}
}

export async function runOmpAuthorityBridge(options: OmpAuthorityBridgeRunnerOptions = {}): Promise<void> {
	const runtime = options.runtime ?? (await createDefaultAppserverRuntime());
	const input = options.input ?? (process.stdin as unknown as AsyncIterable<Uint8Array>);
	const output =
		options.write ??
		(line =>
			new Promise<void>((resolve, reject) => {
				process.stdout.write(line, error => (error ? reject(error) : resolve()));
			}));
	let writeTail = Promise.resolve();
	const write = (frame: Parameters<typeof encodeOmpAuthorityBridgeFrame>[0]): Promise<void> => {
		const line = encodeOmpAuthorityBridgeFrame(frame);
		writeTail = writeTail.then(() => output(line));
		return writeTail;
	};
	const identity = options.identity ?? getCodingAgentAppserverIdentity();
	const methods = advertisedMethods(runtime);
	await write({
		v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
		type: "ready",
		methods,
		ompVersion: identity.ompVersion,
		ompBuild: identity.ompBuild,
	});
	const controllers = new Map<string, AbortController>();
	const requests = new Set<Promise<void>>();
	const sessionListSnapshots = new Map<string, SessionListSnapshot>();
	for await (const line of lines(input)) {
		if (!line) continue;
		const frame = decodeOmpAuthorityBridgeClientFrame(JSON.parse(line));
		if (frame.type === "cancel") {
			controllers.get(frame.id)?.abort();
			continue;
		}
		if (!methods.includes(frame.method)) {
			await write({
				v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
				type: "response",
				id: frame.id,
				ok: false,
				error: { code: "UNSUPPORTED", message: "operation is unsupported" },
			});
			continue;
		}
		if (controllers.has(frame.id)) throw new Error("duplicate bridge request id");
		const controller = new AbortController();
		controllers.set(frame.id, controller);
		const request = dispatch(
			runtime,
			frame,
			controller.signal,
			payload => {
				void write({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "event", id: frame.id, event: "terminal", payload });
			},
			sessionListSnapshots,
		)
			.then(
				result =>
					write({
						v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
						type: "response",
						id: frame.id,
						ok: true,
						result: result ?? null,
					}),
				error =>
					write({
						v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
						type: "response",
						id: frame.id,
						ok: false,
						error: safeError(error),
					}),
			)
			.then(() => undefined)
			.finally(() => {
				controllers.delete(frame.id);
				requests.delete(request);
			});
		requests.add(request);
	}
	for (const controller of controllers.values()) controller.abort();
	await Promise.allSettled(requests);
	await writeTail;
}
