import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { chmod, stat as fsStat, lstat, open, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
	COMMAND_DESCRIPTORS,
	type CommandFrame,
	type ConfirmationChallenge,
	type ConfirmFrame,
	decodeClientFrame,
	decodeCommandArguments,
	decodeCursor,
	decodeSessionPromptArguments,
	decodeSessionStateResult,
	decodeUsageReadResult,
	type HelloFrame,
	type HostId,
	IMAGE_UPLOAD_CHUNK_BYTES,
	type ImageId,
	type PromptImageMimeType,
	parseBounded,
	projectId,
	type ResultFrame,
	requiredCapability,
	type ServerFrame,
	type SessionId,
	type SessionImageReadArguments,
	type SessionRef,
	type SessionStateResult,
	type UsageReadResult,
	utf8ByteLength,
} from "@oh-my-pi/app-wire";
import type {
	RpcResponse,
	RpcSessionEntryFrame,
	RpcSubagentMessagesResult,
} from "../../coding-agent/src/modes/rpc/rpc-types.ts";
import { AgentTranscriptProjection } from "./agent-transcript-projection.ts";
import { completeAttachOutput, prepareAttachOutput } from "./attach-output.ts";
import { AppserverCommandHandlers } from "./command-handler.ts";
import {
	compareSessionRecords,
	fallbackSessionTitle,
	projectMessageText,
	projectNameFromCwd,
	SessionEntryProjector,
	stableProjectId,
} from "./discovery.ts";
import { IdempotencyStore, payloadHash } from "./idempotency.ts";
import { createEpoch, createHostId, defaultSocketPath, loadPersistentHostId, unixSocketActive } from "./identity.ts";
import { ImageUploadError, ImageUploadStore } from "./image-upload-store.ts";
import {
	commandFeature,
	DesktopOperationDispatcher,
	type OperationContext,
	operationCapabilities,
} from "./operations/dispatcher.ts";
import {
	ensureSecureSocketDirectory,
	markerIdentity,
	type OwnerPaths,
	type OwnerRecord,
	ownerPaths,
	readPublicTarget,
	readStrictOwner,
	sameIdentity,
	unlinkIfExists,
} from "./ownership.ts";
import { SessionProjection } from "./projection.ts";
import { BunRemoteListener, createListenerPlan, createServeProxyPlan } from "./remote/listener.ts";
import type { RemoteConnection, RemoteListenerConfig } from "./remote/types.ts";
import { BunRpcChildFactory, RpcChildSupervisor } from "./rpc-child.ts";
import { SubagentProjection, subagentIdFromFrame } from "./subagent-projection.ts";
import { asAppWireEvent, TranscriptEventTranslator } from "./transcript-events.ts";
import { TranscriptImageError, TranscriptImageReader } from "./transcript-image-reader.ts";
import type {
	AppserverDrainBusy,
	AppserverDrainResult,
	AppserverHandle,
	AppserverOptions,
	AppserverUsageAuthority,
	ChildHandle,
	Clock,
	CommandOutcome,
	ConnectionTransport,
	LockCheckHook,
	RemoteConnectionPolicy,
	RemoteHelloDecision,
	RpcChildFactory,
	SessionAuthority,
	SessionDiscovery,
	SessionRecord,
} from "./types.ts";

const clock: Clock = { now: () => new Date() };
const ARCHIVED_SESSION_COMMANDS = new Set([
	"session.attach",
	"session.archive",
	"session.restore",
	"session.delete",
	"session.image.read",
	"files.read",
	"files.list",
	"files.diff",
	"review.read",
]);
const SESSION_LIFECYCLE_COMMANDS = new Set(["session.close", "session.archive", "session.restore", "session.delete"]);
const IMAGE_UPLOAD_COMMANDS = new Set(["session.image.begin", "session.image.chunk", "session.image.discard"]);
const DIRECT_SESSION_RPC_COMMANDS: ReadonlySet<string> = new Set([
	"session.retry",
	"session.pause",
	"session.resume",
	"session.compact",
	"session.rename",
	"session.model.set",
	"session.thinking.set",
	"session.fast.set",
]);
const SESSION_CANCEL_COMMAND = "session.cancel";
const SUBAGENT_TRANSCRIPT_RPC_BYTES = 384 * 1024;
const REMOTE_OUTBOUND_TRANSFORM_TIMEOUT_MS = 10_000;
const DEFAULT_USAGE_READ_TIMEOUT_MS = 15_000;
const PENDING_PROMPT_TEXT_BYTES = 8 * 1024;
// cleanText removes most controls, but retained newlines, quotes, and
// backslashes can double when JSON encoded. Keep enough room for that escaping
// plus the event envelope under the 64 KiB transient-event budget.
const PENDING_PROMPT_EVENT_TEXT_BYTES = 24 * 1024;
const MAX_PENDING_PROMPTS = 16;
// A session snapshot may carry all 16 reconnect prompts, but the session index
// can contain 1,000 refs. Bound that aggregate independently so a pathological
// all-pending index remains decodable by the 1 MiB / 20k-node app-wire limits.
// The canonical per-session projection stays complete; only the index copy is
// reduced, with an explicit count/truncation marker for clients.
const SESSION_LIST_PENDING_PROMPT_BYTES = 256 * 1024;
const SESSION_LIST_PENDING_PROMPT_ENTRIES = 512;
const SESSION_LIST_REFS_BYTES = 768 * 1024;
const SESSION_LIST_REF_NODES = 16_000;
const textEncoder = new TextEncoder();

interface SessionListBudget {
	pendingBytes: number;
	pendingEntries: number;
}

function encodedJsonBytes(value: unknown): number {
	return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function jsonNodeCount(value: unknown, ceiling: number): number {
	const stack: unknown[] = [value];
	let nodes = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		nodes += 1;
		if (nodes > ceiling) return nodes;
		if (!current || typeof current !== "object") continue;
		if (Array.isArray(current)) stack.push(...current);
		else stack.push(...Object.values(current));
	}
	return nodes;
}

function projectSessionListPendingPrompts(ref: SessionRef, budget: SessionListBudget): SessionRef {
	const currentLiveState = ref.liveState;
	if (!currentLiveState) return ref;
	const rawPending = currentLiveState.pendingPrompts;
	if (!Array.isArray(rawPending) || rawPending.length === 0) {
		if (!Object.hasOwn(currentLiveState, "pendingPrompts")) return ref;
		const liveState = { ...currentLiveState };
		delete liveState.pendingPrompts;
		const next = { ...ref };
		if (Object.keys(liveState).length > 0) next.liveState = liveState;
		else delete next.liveState;
		return next;
	}

	const retained: unknown[] = [];
	for (const pending of rawPending) {
		if (budget.pendingEntries >= SESSION_LIST_PENDING_PROMPT_ENTRIES) break;
		const separatorBytes = retained.length === 0 ? 0 : 1;
		const bytes = encodedJsonBytes(pending) + separatorBytes;
		if (budget.pendingBytes + bytes > SESSION_LIST_PENDING_PROMPT_BYTES) break;
		retained.push(pending);
		budget.pendingBytes += bytes;
		budget.pendingEntries += 1;
	}
	if (retained.length === rawPending.length) return ref;

	const liveState: Record<string, unknown> = {
		...currentLiveState,
		pendingPromptCount: rawPending.length,
		pendingPromptsTruncated: true,
	};
	if (retained.length > 0) liveState.pendingPrompts = retained;
	else delete liveState.pendingPrompts;
	return { ...ref, liveState };
}

async function boundedRemoteTransform<T>(operation: Promise<T> | T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error("remote outbound transform timed out")),
			REMOTE_OUTBOUND_TRANSFORM_TIMEOUT_MS,
		);
	});
	try {
		return await Promise.race([Promise.resolve(operation), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function raceAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw new Error("operation aborted");
	const gate = Promise.withResolvers<T>();
	const onAbort = (): void => gate.reject(new Error("operation aborted"));
	signal.addEventListener("abort", onAbort, { once: true });
	operation.then(gate.resolve, gate.reject);
	try {
		return await gate.promise;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function queuedLifecycleWork(liveState: Record<string, unknown> | undefined): boolean {
	if (!liveState) return false;
	if (typeof liveState.queuedMessageCount === "number" && liveState.queuedMessageCount > 0) return true;
	const queued = liveState.queuedMessages;
	if (!queued || typeof queued !== "object" || Array.isArray(queued)) return false;
	return Object.values(queued).some(value => Array.isArray(value) && value.length > 0);
}
function response(
	hostId: HostId,
	command: CommandFrame,
	ok: boolean,
	result?: unknown,
	error?: { code: string; message: string; details?: Record<string, unknown> },
): ResultFrame {
	return {
		v: "omp-app/1",
		type: "response",
		requestId: command.requestId,
		commandId: command.commandId,
		command: command.command,
		hostId,
		sessionId: command.sessionId,
		ok,
		...(ok ? { result } : { error }),
	} as ResultFrame;
}
function argumentError(command: CommandFrame): string | undefined {
	const args = command.args;
	if (!args || typeof args !== "object" || Array.isArray(args)) return "args must be an object";
	const keys = Object.keys(args);
	if (command.command === "session.prompt") {
		try {
			decodeSessionPromptArguments(args);
			return undefined;
		} catch {
			return "prompt arguments are invalid";
		}
	}
	if (command.command === "session.attach") {
		if (keys.length === 0) return undefined;
		if (keys.length === 1 && keys[0] === "cursor") {
			try {
				decodeCursor(args.cursor);
				return undefined;
			} catch {
				return "attach cursor is invalid";
			}
		}
		return "attach accepts only an optional cursor";
	}
	if (command.command === "session.create") {
		if (keys.some(key => key !== "projectId" && key !== "title")) return "create accepts only projectId and title";
		if (typeof args.projectId !== "string" || args.projectId.length === 0 || utf8ByteLength(args.projectId) > 256)
			return "create projectId must be a bounded non-empty UTF-8 string";
		if (
			args.title !== undefined &&
			(typeof args.title !== "string" || args.title.length === 0 || utf8ByteLength(args.title) > 512)
		)
			return "create title must be a bounded non-empty UTF-8 string";
		return undefined;
	}
	// Operation argument shapes are validated by decodeCommand and the typed
	// authority. Host/session list remain explicitly empty for compatibility
	// with their legacy broad argument decoders.
	if (command.command !== "host.list" && command.command !== "session.list") return undefined;
	if (keys.length !== 0) return "command does not accept args";
	return undefined;
}
function safeSessionState(value: unknown): SessionStateResult {
	const raw =
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	if (!raw) throw new Error("rpc state is not an object");
	const model =
		raw.model && typeof raw.model === "object" && !Array.isArray(raw.model)
			? (raw.model as Record<string, unknown>)
			: undefined;
	const context =
		raw.contextUsage && typeof raw.contextUsage === "object" && !Array.isArray(raw.contextUsage)
			? (raw.contextUsage as Record<string, unknown>)
			: undefined;
	const queued =
		raw.queuedMessages && typeof raw.queuedMessages === "object" && !Array.isArray(raw.queuedMessages)
			? (raw.queuedMessages as Record<string, unknown>)
			: undefined;
	const state = {
		isStreaming: raw.isStreaming,
		isCompacting: raw.isCompacting,
		isPaused: raw.isPaused === true,
		messageCount: raw.messageCount,
		queuedMessageCount: raw.queuedMessageCount,
		steeringMode: raw.steeringMode,
		followUpMode: raw.followUpMode,
		interruptMode: raw.interruptMode,
		...(model
			? {
					model: {
						id: model.id,
						provider: model.provider,
						...(typeof model.name === "string" ? { displayName: model.name } : {}),
						...(typeof model.selector === "string"
							? { selector: model.selector }
							: typeof raw.modelSelector === "string"
								? { selector: raw.modelSelector }
								: {}),
						...(typeof model.role === "string"
							? { role: model.role }
							: typeof raw.modelRole === "string"
								? { role: raw.modelRole }
								: {}),
					},
				}
			: {}),
		...(raw.thinkingLevel === undefined ? {} : { thinking: raw.thinkingLevel }),
		...(raw.thinkingEffective === undefined ? {} : { thinkingEffective: raw.thinkingEffective }),
		...(raw.thinkingResolved === undefined ? {} : { thinkingResolved: raw.thinkingResolved }),
		...(raw.thinkingLevels === undefined ? {} : { thinkingLevels: raw.thinkingLevels }),
		...(raw.thinkingSupported === undefined ? {} : { thinkingSupported: raw.thinkingSupported }),
		...(raw.thinkingOffFloored === undefined ? {} : { thinkingOffFloored: raw.thinkingOffFloored }),
		...(typeof raw.fast === "boolean" ? { fast: raw.fast } : {}),
		...(raw.fastAvailable === undefined ? {} : { fastAvailable: raw.fastAvailable }),
		...(raw.fastActive === undefined ? {} : { fastActive: raw.fastActive }),
		...(typeof raw.sessionName === "string" ? { sessionName: raw.sessionName } : {}),
		...(context
			? { contextUsage: { used: context.used ?? context.tokens, limit: context.limit ?? context.contextWindow } }
			: {}),
		...(queued ? { queuedMessages: { steering: queued.steering, followUp: queued.followUp } } : {}),
	};
	return decodeSessionStateResult(state);
}
function childBoolean(value: unknown, key: string): boolean {
	const record =
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	if (!record || typeof record[key] !== "boolean") throw new Error("rpc child result is malformed");
	return record[key] as boolean;
}
function childAgentInvoked(value: unknown): boolean | undefined {
	const record =
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	const data =
		record?.data && typeof record.data === "object" && !Array.isArray(record.data)
			? (record.data as Record<string, unknown>)
			: undefined;
	return typeof data?.agentInvoked === "boolean" ? data.agentInvoked : undefined;
}
type AppWs = ConnectionTransport;
type LocalWs = Bun.ServerWebSocket<ServerWebSocketData>;
interface RunIdentity {
	paths: OwnerPaths;
	record: OwnerRecord;
	marker: { device: number; inode: number };
}
interface SessionLifecycleFailure {
	code: string;
	message: string;
	details?: Record<string, unknown>;
}
interface PromptLifecycle {
	requestId: string;
	commandId: string;
	commandHash: string;
	kind: "prompt" | "steer" | "followUp";
	accepted?: true;
	internalId?: string;
	transientEntryId?: string;
}
type PromptDiscardReason = "rejected" | "local-only" | "failed" | "cancelled" | "completed-without-entry";

function promptEntryCorrelationId(entry: RpcSessionEntryFrame["entry"]): string | undefined {
	if (entry.type === "message" && entry.message.role === "user") return entry.message.clientCorrelationId;
	if (entry.type === "custom_message" && entry.attribution === "user") return entry.clientCorrelationId;
	return undefined;
}
function isErrno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException).code === code;
}
async function pidIsAlive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isErrno(error, "ESRCH")) return false;
		return true;
	}
}
async function statIdentity(path: string): Promise<{ device: number; inode: number } | undefined> {
	try {
		const info = await lstat(path);
		return { device: Number(info.dev), inode: Number(info.ino) };
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		throw error;
	}
}
async function publishSymlink(paths: OwnerPaths): Promise<void> {
	await symlink(paths.backingName, paths.publicPath);
	const published = await readPublicTarget(paths.publicPath);
	if (published.target !== paths.backingName)
		throw new Error("appserver public symlink target changed during publish");
}
async function publishOwnerAtomic(
	paths: OwnerPaths,
	record: OwnerRecord,
	claimed: { device: number; inode: number },
): Promise<{ device: number; inode: number }> {
	const temp = join(paths.directory, `.appserver-owner-${record.ownerId}.tmp`);
	const handle = await open(temp, "wx", 0o600);
	try {
		await handle.write(`${JSON.stringify(record)}\n`, 0);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		const current = await statIdentity(paths.ownerPath);
		if (!current || current.device !== claimed.device || current.inode !== claimed.inode)
			throw new Error("appserver owner marker changed during startup");
		await rename(temp, paths.ownerPath);
	} catch (error) {
		await unlinkIfExists(temp);
		throw error;
	}
	const final = await statIdentity(paths.ownerPath);
	if (!final) throw new Error("appserver owner marker disappeared during startup");
	return final;
}
export function appserverSupportedFeatures(
	options: Pick<AppserverOptions, "operationsAuthority" | "supportedFeatures" | "transcriptImageRoot"> & {
		readonly remotePolicy?: AppserverOptions["remotePolicy"];
	},
	includeRemotePolicy = false,
): string[] {
	const unsupportedAdditiveFeatures = new Set(["host.watch", "session.watch"]);
	const implementedFeatures = new Set<string>(["resume", "prompt.images", "agent.transcript"]);
	if (includeRemotePolicy) {
		implementedFeatures.add("controller.lease");
		implementedFeatures.add("prompt.lease");
	}
	const authority = options.operationsAuthority;
	if (options.transcriptImageRoot) implementedFeatures.add("transcript.images");
	if (authority?.catalogGet) implementedFeatures.add("catalog.metadata");
	if (authority?.settingsRead) implementedFeatures.add("settings.metadata");
	if (authority?.termOpen && authority.terminalInput && authority.terminalResize && authority.terminalClose)
		implementedFeatures.add("terminal.io");
	if (authority?.filesList) implementedFeatures.add("files.list");
	if (authority?.filesDiff) implementedFeatures.add("files.diff");
	if (authority?.previewLaunch && authority.previewState && authority.previewNavigate && authority.previewCapture)
		implementedFeatures.add("preview.control");
	return [...(options.supportedFeatures ?? implementedFeatures)].filter(
		feature => implementedFeatures.has(feature) && !unsupportedAdditiveFeatures.has(feature),
	);
}
export function appserverSupportedCapabilities(
	options: Pick<AppserverOptions, "operationsAuthority" | "supportedCapabilities" | "usageAuthority">,
): string[] {
	const implemented = new Set([
		"sessions.read",
		"sessions.manage",
		"sessions.prompt",
		"sessions.control",
		...operationCapabilities(options.operationsAuthority),
	]);
	if (options.usageAuthority?.read) implemented.add("usage.read");
	return [...(options.supportedCapabilities ?? implemented)];
}
export class LocalAppserver implements AppserverHandle {
	hostId: HostId;
	readonly epoch: string;
	readonly socketPath: string;
	#clock: Clock;
	#discovery: SessionDiscovery;
	#authority?: SessionAuthority;
	#operations?: DesktopOperationDispatcher;
	#usageAuthority?: AppserverUsageAuthority;
	#factory: RpcChildFactory;
	#imageUploads: ImageUploadStore;
	#transcriptImages?: TranscriptImageReader;
	#lockCheck: LockCheckHook;
	#ringSize: number;
	#lifecycleQuiesceTimeoutMs: number;
	#usageReadTimeoutMs: number;
	#handlers = new AppserverCommandHandlers();
	#challenges = new Map<string, { command: CommandFrame; ws: AppWs; expiresAt: number; hash: string }>();
	#records = new Map<SessionId, SessionRecord>();
	#createdPending = new Map<SessionId, { record: SessionRecord; refreshesRemaining: number }>();
	#projections = new Map<SessionId, SessionProjection>();
	#supervisors = new Map<SessionId, RpcChildSupervisor>();
	#promptLifecycles = new Map<SessionId, PromptLifecycle>();
	#messageLifecycles = new Map<SessionId, PromptLifecycle[]>();
	#messageLifecyclesByCommandId = new Map<string, PromptLifecycle>();
	#stateRefreshGenerations = new Map<SessionId, number>();
	#transcripts = new Map<SessionId, TranscriptEventTranslator>();
	#subagents = new Map<SessionId, SubagentProjection>();
	#agentTranscripts = new Map<SessionId, AgentTranscriptProjection>();
	#startPromises = new Map<SessionId, Promise<RpcChildSupervisor>>();
	#lifecycleMutations = new Set<SessionId>();
	#inflightSessionOperations = new Map<SessionId, number>();
	#closedSessions = new Set<SessionId>();
	#idempotency: IdempotencyStore;
	#connectionIdempotency = new Map<AppWs, IdempotencyStore>();
	#server?: Bun.Server<ServerWebSocketData>;
	#clients = new Set<AppWs>();
	#draining = false;
	#inflightMessages = 0;
	#inflightLifecycleMutations = 0;
	#hello = new Set<AppWs>();
	#clientCapabilities = new Map<AppWs, Set<string>>();
	#clientFeatures = new Map<AppWs, Set<string>>();
	#attached = new Map<AppWs, Set<SessionId>>();
	#deviceIds = new Map<AppWs, string>();
	#abortControllers = new Map<AppWs, Set<AbortController>>();
	#outboundTails = new Map<AppWs, Promise<void>>();
	#localTransports = new Map<LocalWs, AppWs>();
	#remoteTransports = new Map<string, AppWs>();
	#remoteConnections = new Map<AppWs, RemoteConnection>();
	#remoteDecisions = new Map<AppWs, RemoteHelloDecision>();
	#remoteListener?: BunRemoteListener;
	#remotePolicy?: RemoteConnectionPolicy;
	#admin?: AppserverOptions["admin"];
	#remoteEndpoint?: RemoteListenerConfig;
	#remoteResolver?: AppserverOptions["remoteResolver"];
	#started = false;
	#stopping = false;
	#hostProvided: boolean;
	#hostIdPath?: string;
	#ownerLock = false;
	#ownerId?: string;
	#ownerPaths?: OwnerPaths;
	#ownerHandle?: FileHandle;
	#runIdentity?: RunIdentity;
	#partialBacking?: { path: string; identity: { device: number; inode: number } };
	#partialMarker?: { device: number; inode: number };
	#ompVersion: string;
	#ompBuild: string;
	#appserverVersion: string;
	#appserverBuild: string;
	#supportedFeatures: Set<string>;
	#remoteSupportedFeatures: Set<string>;
	#supportedCapabilities: Set<string>;
	#projectRootForProject?: AppserverOptions["projectRootForProject"];
	constructor(options: AppserverOptions = {}) {
		this.#hostProvided = Boolean(options.hostId);
		this.hostId = options.hostId ?? createHostId();
		this.#hostIdPath = options.hostIdPath;
		this.epoch = createEpoch(options.epoch);
		this.socketPath = options.socketPath ?? defaultSocketPath();
		this.#remotePolicy = options.remotePolicy;
		this.#remoteEndpoint = options.remoteEndpoint;
		this.#remoteResolver = options.remoteResolver;
		this.#admin = options.admin;
		this.#remoteListener = options.remoteListener;
		this.#clock = options.clock ?? clock;
		this.#idempotency = new IdempotencyStore({ now: () => this.#clock.now().getTime() });
		this.#authority = options.sessionAuthority;
		this.#operations = options.operationsAuthority
			? new DesktopOperationDispatcher(options.operationsAuthority, undefined, (frame, owner) => {
					for (const ws of this.#clients)
						if (ws.connectionId === owner.connectionId && ws.deviceId === owner.deviceId)
							void this.#sendFrame(ws, frame as ServerFrame);
				})
			: undefined;
		this.#usageAuthority = options.usageAuthority;
		this.#projectRootForProject = options.projectRootForProject;
		this.#discovery = options.discovery ?? options.sessionAuthority ?? { list: async () => [] };
		this.#imageUploads = new ImageUploadStore({ root: `${this.socketPath}.images` });
		this.#transcriptImages = options.transcriptImageRoot
			? new TranscriptImageReader({ root: options.transcriptImageRoot })
			: undefined;
		this.#factory = options.childFactory ?? new BunRpcChildFactory(undefined, this.#imageUploads.root);
		this.#lockCheck = options.lockCheck ?? (() => undefined);
		this.#ringSize = options.ringSize ?? 256;
		this.#lifecycleQuiesceTimeoutMs = options.lifecycleQuiesceTimeoutMs ?? 2_000;
		this.#usageReadTimeoutMs = options.usageReadTimeoutMs ?? DEFAULT_USAGE_READ_TIMEOUT_MS;
		if (
			!Number.isSafeInteger(this.#lifecycleQuiesceTimeoutMs) ||
			this.#lifecycleQuiesceTimeoutMs <= 0 ||
			this.#lifecycleQuiesceTimeoutMs > 60_000
		)
			throw new Error("lifecycleQuiesceTimeoutMs must be between 1 and 60000");
		if (
			!Number.isSafeInteger(this.#usageReadTimeoutMs) ||
			this.#usageReadTimeoutMs <= 0 ||
			this.#usageReadTimeoutMs > 60_000
		)
			throw new Error("usageReadTimeoutMs must be between 1 and 60000");
		this.#ompVersion = options.ompVersion ?? "local";
		this.#ompBuild = options.ompBuild ?? "local";
		this.#appserverVersion = options.appserverVersion ?? "0.1.0";
		this.#appserverBuild = options.appserverBuild ?? "local";
		this.#supportedFeatures = new Set(appserverSupportedFeatures(options));
		this.#remoteSupportedFeatures = new Set(appserverSupportedFeatures(options, true));
		const requested = appserverSupportedCapabilities(options);
		const implemented = new Set([
			"sessions.read",
			"sessions.manage",
			"sessions.prompt",
			"sessions.control",
			...operationCapabilities(options.operationsAuthority),
		]);
		if (options.usageAuthority?.read) implemented.add("usage.read");
		if (requested.some(capability => !implemented.has(capability)))
			throw new Error("unsupported capability has no handler");
		this.#supportedCapabilities = new Set(requested);
		this.#handlers.register("session.create", command => this.handleCreate(command));
		this.#handlers.register("session.close", command => this.handleClose(command));
		this.#handlers.register("session.archive", command => this.handleArchive(command));
		this.#handlers.register("session.restore", command => this.handleRestore(command));
		this.#handlers.register("session.delete", command => this.handleDelete(command));
	}
	hasDesktopCatalogCommandHandler(command: string): boolean {
		if (command === "usage.read") return this.#usageAuthority !== undefined;
		if (this.#operations?.hasCommand(command)) return true;
		return this.#handlers.has(command) || DIRECT_SESSION_RPC_COMMANDS.has(command) || command === SESSION_CANCEL_COMMAND;
	}
	async start(): Promise<void> {
		if (this.#started) return;
		this.#stopping = false;
		this.#draining = false;
		this.#closedSessions.clear();
		if (!this.#hostProvided) this.hostId = await loadPersistentHostId(this.#hostIdPath);
		this.#records.clear();
		this.#projections.clear();
		await this.loadSessions();
		await ensureSecureSocketDirectory(this.socketPath);
		const ownerId = randomUUID();
		const paths = ownerPaths(this.socketPath, ownerId);
		const initial: OwnerRecord = {
			version: 2,
			ownerId,
			pid: process.pid,
			backingName: paths.backingName,
			device: 0,
			inode: 0,
		};
		let ownerHandle: FileHandle;
		try {
			ownerHandle = await open(`${this.socketPath}.owner`, "wx", 0o600);
			await ownerHandle.write(`${JSON.stringify(initial)}\n`);
			await ownerHandle.sync();
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
			const existing = await readStrictOwner(`${this.socketPath}.owner`);
			if (await pidIsAlive(existing.record.pid))
				throw new Error(`appserver socket has another owner: ${this.socketPath}`);
			await this.recoverStale(ownerPaths(this.socketPath, existing.record.ownerId), existing.record, existing.stat);
			ownerHandle = await open(`${this.socketPath}.owner`, "wx", 0o600);
			await ownerHandle.write(`${JSON.stringify(initial)}\n`);
			await ownerHandle.sync();
		}
		this.#ownerHandle = ownerHandle;
		this.#ownerLock = true;
		this.#ownerId = ownerId;
		this.#ownerPaths = paths;
		try {
			await this.#imageUploads.start();
			await this.preparePublic(paths);
			this.#server = Bun.serve<ServerWebSocketData>({
				unix: paths.backingPath,
				fetch: (request, server) => this.fetch(request, server),
				websocket: {
					maxPayloadLength: 1024 * 1024,
					backpressureLimit: 1024 * 1024,
					closeOnBackpressureLimit: true,
					open: ws => {
						if (this.#draining || this.#stopping) {
							ws.close(1012, "appserver maintenance");
							return;
						}
						const transport = this.#createLocalTransport(ws);
						this.#localTransports.set(ws, transport);
						this.#clients.add(transport);
						this.#clientCapabilities.set(transport, new Set());
						this.#clientFeatures.set(transport, new Set());
						this.#attached.set(transport, new Set());
						this.#deviceIds.set(transport, transport.deviceId);
						this.#abortControllers.set(transport, new Set());
						this.#connectionIdempotency.set(transport, new IdempotencyStore());
					},
					message: (ws, message) => {
						const transport = this.#localTransports.get(ws);
						if (transport) void this.message(transport, message);
					},
					close: ws => {
						const transport = this.#localTransports.get(ws);
						if (transport) void this.disconnectClient(transport);
					},
				},
			});
			await chmod(paths.backingPath, 0o600);
			if (this.#stopping) throw new Error("appserver is stopping");
			const backing = await fsStat(paths.backingPath);
			const record: OwnerRecord = {
				version: 2,
				ownerId,
				pid: process.pid,
				backingName: paths.backingName,
				device: Number(backing.dev),
				inode: Number(backing.ino),
			};
			this.#partialBacking = {
				path: paths.backingPath,
				identity: { device: Number(backing.dev), inode: Number(backing.ino) },
			};
			const claimed = await markerIdentity(ownerHandle);
			const finalMarker = await publishOwnerAtomic(paths, record, claimed);
			this.#partialMarker = finalMarker;
			const currentRecord = await readStrictOwner(paths.ownerPath);
			if (currentRecord.record.ownerId !== ownerId || !sameIdentity(currentRecord.record, record))
				throw new Error("appserver owner marker changed during startup");
			await publishSymlink(paths);
			if (this.#stopping) throw new Error("appserver is stopping");
			this.#runIdentity = { paths, record, marker: finalMarker };
			this.#started = true;
			if (this.#remotePolicy && this.#remoteEndpoint) {
				const listener =
					this.#remoteListener ??
					new BunRemoteListener(
						this.#remoteEndpoint.serveProxy === true
							? createServeProxyPlan(this.#remoteEndpoint)
							: createListenerPlan(this.#remoteEndpoint),
						{
							connected: connection => this.#remoteConnected(connection),
							message: (connection, message) => this.#remoteMessage(connection, message),
							disconnected: connection => this.#remoteDisconnected(connection),
						},
						this.#remoteEndpoint,
						this.#remoteResolver,
					);
				this.#remoteListener = listener;
				try {
					listener.start();
				} catch (error) {
					this.#remoteListener = undefined;
					throw error;
				}
			}
		} catch (error) {
			try {
				await this.cleanupPartial();
			} finally {
				await this.#imageUploads.stop().catch(() => undefined);
			}
			throw error;
		}
	}
	async stop(): Promise<void> {
		if (!this.#started && !this.#server && !this.#ownerLock && this.#startPromises.size === 0) return;
		this.#stopping = true;
		try {
			await this.#remoteListener?.stop();
			this.#remoteListener = undefined;
			await Promise.all(
				[...this.#clients].map(async ws => {
					for (const controller of this.#abortControllers.get(ws) ?? []) controller.abort();
					await this.disconnectClient(ws);
					ws.close(1001, "server stopping");
				}),
			);
			const server = this.#server;
			this.#server = undefined;
			let displaced: string | undefined;
			if (this.#runIdentity) {
				const current = await statIdentity(this.#runIdentity.paths.backingPath);
				if (current && !sameIdentity(current, this.#runIdentity.record)) {
					displaced = join(
						this.#runIdentity.paths.directory,
						`.appserver-displaced-${this.#runIdentity.record.ownerId}-${randomUUID()}`,
					);
					await rename(this.#runIdentity.paths.backingPath, displaced);
				}
			}
			server?.stop(true);
			if (displaced) {
				try {
					await rename(displaced, this.#runIdentity?.paths.backingPath ?? "");
				} catch (error) {
					process.emitWarning(error instanceof Error ? error.message : String(error));
				}
			}
			for (const supervisor of this.#supervisors.values()) supervisor.stop();
			this.#supervisors.clear();
			this.#promptLifecycles.clear();
			this.#messageLifecycles.clear();
			this.#messageLifecyclesByCommandId.clear();
			this.#stateRefreshGenerations.clear();
			this.#transcripts.clear();
			this.#subagents.clear();
			for (const transcript of this.#agentTranscripts.values()) transcript.dispose();
			this.#agentTranscripts.clear();
			await Promise.allSettled([...this.#startPromises.values()]);
			this.#startPromises.clear();
			this.#started = false;
			const identity = this.#runIdentity;
			if (identity) await this.cleanupOwned(identity);
			else await this.cleanupPartial();
			this.#runIdentity = undefined;
			this.#ownerLock = false;
			this.#ownerId = undefined;
			this.#ownerPaths = undefined;
			await this.#ownerHandle?.close();
			this.#ownerHandle = undefined;
		} finally {
			this.#transcriptImages?.clear();
			await this.#imageUploads.stop();
		}
	}
	private async recoverStale(
		paths: OwnerPaths,
		record: OwnerRecord,
		markerStat: { dev: number; ino: number },
	): Promise<void> {
		if (record.backingName !== paths.backingName)
			throw new Error(`appserver socket has another owner: ${this.socketPath}`);
		try {
			const publicStat = await lstat(paths.publicPath);
			if (!publicStat.isSymbolicLink()) throw new Error(`appserver socket has another owner: ${this.socketPath}`);
			const target = await readlink(paths.publicPath);
			if (target !== paths.backingName) throw new Error(`appserver socket has another owner: ${this.socketPath}`);
			const backing = await statIdentity(paths.backingPath);
			if (backing && !sameIdentity(backing, record))
				throw new Error(`appserver socket has another owner: ${this.socketPath}`);
			const latest = await lstat(paths.publicPath);
			const latestTarget = await readlink(paths.publicPath);
			const latestBacking = await statIdentity(paths.backingPath);
			if (
				latest.dev !== publicStat.dev ||
				latest.ino !== publicStat.ino ||
				!latest.isSymbolicLink() ||
				latestTarget !== paths.backingName ||
				(latestBacking && !sameIdentity(latestBacking, record))
			)
				throw new Error(`appserver socket has another owner: ${this.socketPath}`);
			await unlink(paths.publicPath);
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
		const backing = await statIdentity(paths.backingPath);
		if (backing) {
			if (!sameIdentity(backing, record) || (await unixSocketActive(paths.backingPath)))
				throw new Error(`appserver socket has another owner: ${this.socketPath}`);
			await unlink(paths.backingPath);
		}
		const current = await statIdentity(paths.ownerPath);
		if (!current || current.device !== Number(markerStat.dev) || current.inode !== Number(markerStat.ino))
			throw new Error(`appserver socket has another owner: ${this.socketPath}`);
		await unlink(paths.ownerPath);
	}
	private async preparePublic(paths: OwnerPaths): Promise<void> {
		try {
			const info = await lstat(paths.publicPath);
			throw new Error(
				`${info.isSocket() ? "refusing existing public socket" : "refusing non-socket public path"}: ${paths.publicPath}`,
			);
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
	}
	private async cleanupPartial(): Promise<void> {
		const paths = this.#ownerPaths;
		const marker = this.#partialMarker ?? (this.#ownerHandle ? await markerIdentity(this.#ownerHandle) : undefined);
		this.#server?.stop(true);
		this.#server = undefined;
		if (paths) {
			const publicInfo = await statIdentity(paths.publicPath);
			if (publicInfo) {
				try {
					const target = await readPublicTarget(paths.publicPath);
					const latest = await lstat(paths.publicPath);
					const latestTarget = await readlink(paths.publicPath);
					const backing = await statIdentity(paths.backingPath);
					if (
						latest.dev === publicInfo.device &&
						latest.ino === publicInfo.inode &&
						latest.isSymbolicLink() &&
						latestTarget === paths.backingName &&
						(!backing || (this.#partialBacking && sameIdentity(backing, this.#partialBacking.identity)))
					)
						await unlink(paths.publicPath);
					else if (target.target !== paths.backingName)
						process.emitWarning(`appserver socket ownership conflict; preserving ${paths.publicPath}`);
				} catch (error) {
					if (!isErrno(error, "ENOENT"))
						process.emitWarning(error instanceof Error ? error.message : String(error));
				}
			}
			const backing = await statIdentity(paths.backingPath);
			if (backing && this.#partialBacking && sameIdentity(backing, this.#partialBacking.identity)) {
				const latestBacking = await statIdentity(paths.backingPath);
				if (latestBacking && sameIdentity(latestBacking, backing)) await unlink(paths.backingPath);
			}
			if (marker) {
				const current = await statIdentity(paths.ownerPath);
				const latest = await statIdentity(paths.ownerPath);
				if (
					current &&
					latest &&
					current.device === marker.device &&
					current.inode === marker.inode &&
					latest.device === current.device &&
					latest.inode === current.inode
				)
					await unlink(paths.ownerPath);
			}
		}
		if (this.#ownerHandle) {
			await this.#ownerHandle.close();
			this.#ownerHandle = undefined;
		}
		this.#ownerLock = false;
		this.#partialBacking = undefined;
		this.#partialMarker = undefined;
	}
	private async cleanupOwned(identity: RunIdentity): Promise<void> {
		const { paths, record, marker } = identity;
		const markerNow = await statIdentity(paths.ownerPath);
		let conflict = !markerNow || markerNow.device !== marker.device || markerNow.inode !== marker.inode;
		try {
			const markerValue = await readStrictOwner(paths.ownerPath);
			if (
				markerValue.record.ownerId !== record.ownerId ||
				markerValue.record.pid !== record.pid ||
				markerValue.record.backingName !== record.backingName ||
				!sameIdentity(markerValue.record, record)
			)
				conflict = true;
		} catch (error) {
			if (!isErrno(error, "ENOENT")) conflict = true;
		}
		let publicStat: { device: number; inode: number } | undefined;
		try {
			publicStat = (await readPublicTarget(paths.publicPath)).stat;
			if ((await readPublicTarget(paths.publicPath)).target !== record.backingName) conflict = true;
		} catch (error) {
			if (!isErrno(error, "ENOENT")) conflict = true;
		}
		const backing = await statIdentity(paths.backingPath);
		if (backing && !sameIdentity(backing, record)) conflict = true;
		if (conflict) {
			process.emitWarning(`appserver socket ownership conflict; preserving ${paths.publicPath}`);
			return;
		}
		if (publicStat) {
			const check = await statIdentity(paths.publicPath);
			if (!check || check.device !== publicStat.device || check.inode !== publicStat.inode) {
				process.emitWarning(`appserver socket ownership conflict; preserving ${paths.publicPath}`);
				return;
			}
			await unlink(paths.publicPath);
		}
		const markerCheck = await statIdentity(paths.ownerPath);
		if (markerCheck && markerCheck.device === marker.device && markerCheck.inode === marker.inode)
			await unlink(paths.ownerPath);
		const backingCheck = await statIdentity(paths.backingPath);
		if (backingCheck && sameIdentity(backingCheck, record)) await unlink(paths.backingPath);
	}
	snapshot(sessionId: SessionId) {
		return this.#projections.get(sessionId)?.value;
	}
	replay(sessionId: SessionId, cursor: { epoch: string; seq: number }): ServerFrame[] {
		return this.#projections.get(sessionId)?.replay(cursor) ?? [];
	}
	childFor(sessionId: SessionId): ChildHandle | undefined {
		return this.#supervisors.get(sessionId)?.child();
	}
	async #command(command: CommandFrame, ws?: AppWs, approved = false): Promise<CommandOutcome> {
		if (command.hostId !== this.hostId)
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "host_mismatch",
					message: "command targets another host",
				}),
			};
		const capabilities = ws ? this.#clientCapabilities.get(ws) : undefined;
		const descriptor = COMMAND_DESCRIPTORS[command.command];
		if (!descriptor)
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "unsupported",
					message: "unknown command",
				}),
			};
		const promptHasImages =
			command.command === "session.prompt" &&
			command.args !== null &&
			typeof command.args === "object" &&
			!Array.isArray(command.args) &&
			Object.hasOwn(command.args, "images");
		const requiredFeature = commandFeature(command.command) ?? (promptHasImages ? "prompt.images" : undefined);
		if (requiredFeature && (!ws || !this.#clientFeatures.get(ws)?.has(requiredFeature)))
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "UNSUPPORTED_FEATURE",
					message: "command requires an unavailable negotiated feature",
					details: { feature: requiredFeature },
				}),
			};
		if (descriptor.confirmation === "challenge" && !approved)
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "confirmation_invalid",
					message: "command requires a consumed confirmation",
				}),
			};
		const required = requiredCapability(command.command);
		if (capabilities && required && !capabilities.has(required))
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "capability_denied",
					message: "client capability was not granted",
				}),
			};
		if (command.command === "host.list" || command.command === "session.list") await this.refreshSessions();
		const projection = command.sessionId ? this.#projections.get(command.sessionId) : undefined;
		// Attach output is connection-scoped and rebuilt on every delivery. A
		// cached success cannot attach a session that has since been deleted.
		if (command.command === "session.attach" && !projection)
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "unknown_session",
					message: "session is not indexed",
				}),
			};
		// Read chunks can be hundreds of KiB. They are safe to recompute, so never
		// retain their response bodies in the completed-command cache.
		const bypassOutcomeCache = command.command === "session.image.read";
		const acceptedLifecycle = this.#messageLifecyclesByCommandId.get(command.commandId);
		if (acceptedLifecycle?.accepted)
			return acceptedLifecycle.commandHash === payloadHash(command)
				? { frame: response(this.hostId, command, true, { accepted: true }) }
				: {
						frame: response(this.hostId, command, false, undefined, {
							code: "idempotency_conflict",
							message: "commandId was already used with another payload",
						}),
					};
		const idempotency = bypassOutcomeCache
			? undefined
			: ws && IMAGE_UPLOAD_COMMANDS.has(command.command)
				? this.#connectionIdempotency.get(ws)
				: this.#idempotency;
		if (!bypassOutcomeCache && !idempotency)
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "connection_closed",
					message: "image upload connection is closed",
				}),
			};
		if (idempotency) {
			const check = idempotency.begin(command.commandId, command);
			if (check.kind === "replay")
				return {
					frame: { ...check.outcome.frame, requestId: command.requestId } as ServerFrame,
					unknown: check.outcome.unknown,
				};
			if (check.kind === "pending") {
				const outcome = await check.outcome;
				return {
					frame: { ...outcome.frame, requestId: command.requestId } as ServerFrame,
					unknown: outcome.unknown,
				};
			}
			if (check.kind === "conflict")
				return {
					frame: response(this.hostId, command, false, undefined, {
						code: "idempotency_conflict",
						message: "commandId was already used with another payload",
					}),
				};
		}
		const invalidArgs = argumentError(command);
		if (invalidArgs)
			return this.finish(
				command,
				{
					frame: response(this.hostId, command, false, undefined, { code: "invalid_frame", message: invalidArgs }),
				},
				idempotency,
			);
		const promptArguments =
			command.command === "session.prompt" ? decodeSessionPromptArguments(command.args) : undefined;
		if (descriptor.revision === "required" && command.expectedRevision === undefined)
			return this.finish(
				command,
				{
					frame: response(this.hostId, command, false, undefined, {
						code: "stale_revision",
						message: "expectedRevision is required",
					}),
				},
				idempotency,
			);
		if (descriptor.revision === "none" && command.expectedRevision !== undefined)
			return this.finish(
				command,
				{
					frame: response(this.hostId, command, false, undefined, {
						code: "stale_revision",
						message: "expectedRevision is forbidden",
					}),
				},
				idempotency,
			);
		if (descriptor.scope === "session" && !projection)
			return this.finish(
				command,
				{
					frame: response(this.hostId, command, false, undefined, {
						code: "unknown_session",
						message: "session is not indexed",
					}),
				},
				idempotency,
			);
		if (
			descriptor.revisionOwner === "session" &&
			command.expectedRevision !== undefined &&
			projection &&
			command.expectedRevision !== projection.value.revision
		)
			return this.finish(
				command,
				{
					frame: response(this.hostId, command, false, undefined, {
						code: "stale_revision",
						message: "session revision is stale",
						details: { expectedRevision: command.expectedRevision, actualRevision: projection.value.revision },
					}),
				},
				idempotency,
			);
		if (
			command.sessionId &&
			this.sessionArchived(command.sessionId) &&
			!ARCHIVED_SESSION_COMMANDS.has(command.command)
		)
			return this.finish(
				command,
				{
					frame: response(this.hostId, command, false, undefined, {
						code: "session_archived",
						message: "archived sessions are read-only; restore the session to continue work",
					}),
				},
				idempotency,
			);
		const trackSessionOperation = Boolean(command.sessionId && !SESSION_LIFECYCLE_COMMANDS.has(command.command));
		if (trackSessionOperation && !this.beginSessionOperation(command.sessionId!))
			return this.finish(
				command,
				{
					frame: response(this.hostId, command, false, undefined, {
						code: "session_busy",
						message: "session lifecycle mutation is in progress",
					}),
				},
				idempotency,
			);
		const controller = new AbortController();
		if (ws) this.#abortControllers.get(ws)?.add(controller);
		let outcome: CommandOutcome;
		let messageLifecycle: PromptLifecycle | undefined;
		try {
			// Upload commands are connection-owned. Avoid yielding before their
			// spool operation is queued so disconnect cleanup cannot run first and
			// leave a late upload behind for a dead connection.
			const registered = this.#handlers.has(command.command) ? await this.#handlers.dispatch(command) : undefined;
			if (registered) outcome = registered;
			else if (command.command === "host.list" || command.command === "session.list")
				outcome = {
					frame: response(this.hostId, command, true, {
						cursor: { epoch: this.epoch, seq: 0 },
						...this.sessionListResult(),
					}),
				};
			else if (command.command === "usage.read") {
				if (!this.#usageAuthority) {
					outcome = {
						frame: response(this.hostId, command, false, undefined, {
							code: "unsupported",
							message: "usage reading is unavailable",
						}),
					};
				} else {
					const timeoutSignal = AbortSignal.timeout(this.#usageReadTimeoutMs);
					const usageSignal = AbortSignal.any([controller.signal, timeoutSignal]);
					try {
						const result: UsageReadResult = decodeUsageReadResult(
							await raceAbortSignal(this.#usageAuthority.read(usageSignal), usageSignal),
						);
						outcome = { frame: response(this.hostId, command, true, result) };
					} catch {
						const code = controller.signal.aborted
							? "aborted"
							: timeoutSignal.aborted
								? "timeout"
								: "usage_unavailable";
						outcome = {
							frame: response(this.hostId, command, false, undefined, {
								code,
								message: code === "timeout" ? "usage read timed out" : "usage read failed",
							}),
						};
					}
				}
			} else if (command.command === "session.attach") {
				const cursor = command.args.cursor;
				const attachOutput = prepareAttachOutput(
					projection!,
					cursor === undefined ? undefined : decodeCursor(cursor),
				);
				outcome = {
					frame: response(this.hostId, command, true, { attached: true, cursor: attachOutput.baseline }),
					attachOutput,
				};
			} else if (command.command === "session.image.read") {
				if (!ws || !this.#attached.get(ws)?.has(command.sessionId!))
					throw new TranscriptImageError("session_not_attached", "session must be attached before reading images");
				if (!this.#transcriptImages)
					throw new TranscriptImageError("image_not_found", "transcript image reading is unavailable");
				const args = decodeCommandArguments(command.command, command.args) as unknown as SessionImageReadArguments;
				let metadata = projection!.transcriptImage(args.entryId, args.sha256);
				if (!metadata && this.#clientFeatures.get(ws)?.has("agent.transcript"))
					metadata = this.#agentTranscripts.get(command.sessionId!)?.transcriptImage(args.entryId, args.sha256);
				if (!metadata)
					throw new TranscriptImageError(
						"image_not_found",
						"transcript entry does not contain the requested image",
					);
				const result = await this.#transcriptImages.read(
					metadata.sha256,
					metadata.mimeType,
					args.offset,
					controller.signal,
				);
				outcome = { frame: response(this.hostId, command, true, result) };
			} else if (command.command === "session.image.begin") {
				if (!ws) throw new ImageUploadError("image_invalid", "image upload requires a live connection");
				if (controller.signal.aborted)
					throw new ImageUploadError("connection_closed", "image upload connection is closed");
				const args = decodeCommandArguments(command.command, command.args);
				const begun = await this.#imageUploads.begin({
					connectionId: ws.connectionId,
					sessionId: command.sessionId!,
					mimeType: args.mimeType as PromptImageMimeType,
					size: args.size as number,
					sha256: args.sha256 as string,
				});
				outcome = {
					frame: response(this.hostId, command, true, {
						imageId: begun.imageId,
						chunkBytes: IMAGE_UPLOAD_CHUNK_BYTES,
					}),
				};
			} else if (command.command === "session.image.chunk") {
				if (!ws) throw new ImageUploadError("image_invalid", "image upload requires a live connection");
				if (controller.signal.aborted)
					throw new ImageUploadError("connection_closed", "image upload connection is closed");
				const args = decodeCommandArguments(command.command, command.args);
				const content = args.content as string;
				const data = Buffer.from(content, "base64");
				if (data.toString("base64") !== content)
					throw new ImageUploadError("image_invalid", "image chunk content is not canonical base64");
				const progress = await this.#imageUploads.chunk({
					connectionId: ws.connectionId,
					sessionId: command.sessionId!,
					imageId: args.imageId as ImageId,
					offset: args.offset as number,
					data,
				});
				outcome = { frame: response(this.hostId, command, true, progress) };
			} else if (command.command === "session.image.discard") {
				if (!ws) throw new ImageUploadError("image_invalid", "image upload requires a live connection");
				if (controller.signal.aborted)
					throw new ImageUploadError("connection_closed", "image upload connection is closed");
				const args = decodeCommandArguments(command.command, command.args);
				const discarded = await this.#imageUploads.discard(
					ws.connectionId,
					command.sessionId!,
					args.imageId as ImageId,
				);
				outcome = { frame: response(this.hostId, command, true, { discarded }) };
			} else if (command.command === "session.state.get") {
				const supervisor = await this.ensureSupervisor(command.sessionId!);
				const state = await this.refreshState(
					command.sessionId!,
					supervisor,
					command.requestId,
					false,
					controller.signal,
				);
				outcome = { frame: response(this.hostId, command, true, state) };
			} else if (command.command === "session.steer" || command.command === "session.followUp") {
				const supervisor = await this.ensureSupervisor(command.sessionId!);
				const kind = command.command === "session.steer" ? "steer" : "followUp";
				const lifecycle: PromptLifecycle = {
					requestId: command.requestId,
					commandId: command.commandId,
					commandHash: payloadHash(command),
					kind,
				};
				if (!this.#registerMessageLifecycle(command.sessionId!, lifecycle)) {
					outcome = {
						frame: response(this.hostId, command, false, undefined, {
							code: "message_queue_full",
							message: `at most ${MAX_PENDING_PROMPTS} accepted prompts may be pending`,
						}),
					};
				} else {
					messageLifecycle = lifecycle;
					this.updateStatus(command.sessionId!, "active");
					this.#emitPromptTransient(command.sessionId!, command, lifecycle, command.args.message as string, 0);
					const type = kind === "steer" ? "steer" : "follow_up";
					const result = await supervisor.call(
						{ type, message: command.args.message },
						command.requestId,
						undefined,
						internalId => {
							if (this.#hasMessageLifecycle(command.sessionId!, lifecycle)) lifecycle.internalId = internalId;
						},
					);
					if (!result.success) this.#releaseMessageLifecycle(command.sessionId!, lifecycle, "rejected");
					else lifecycle.accepted = true;
					outcome = {
						frame: response(
							this.hostId,
							command,
							result.success,
							{ accepted: result.success },
							result.success ? undefined : { code: "child_error", message: "session command failed" },
						),
					};
					this.scheduleStateRefresh(command.sessionId!, supervisor, command.requestId);
				}
			} else if (command.command === "session.ui.respond") {
				const supervisor = await this.ensureSupervisor(command.sessionId!);
				const requestId = command.args.requestId;
				if (typeof requestId !== "string") throw new Error("UI request ID is invalid");
				const transcript = this.#transcripts.get(command.sessionId!);
				if (!transcript) throw new Error("session transcript translator is unavailable");
				const pendingUi = transcript.pendingUiRequest(requestId);
				if (!pendingUi) throw new Error("UI request is no longer pending");
				let payload: { value?: string; confirmed?: boolean; cancelled?: true };
				if (command.args.cancelled === true) payload = { cancelled: true };
				else if (pendingUi.kind === "ask" && typeof command.args.value === "string")
					payload = { value: command.args.value };
				else if (pendingUi.kind === "approval" && typeof command.args.confirmed === "boolean")
					payload = { confirmed: command.args.confirmed };
				else throw new Error("UI response kind does not match the pending request");
				await supervisor.respondUi(requestId, payload);
				const resolved = transcript.resolveUiRequest(requestId);
				if (resolved) this.broadcast(command.sessionId!, projection!.appendEvent(asAppWireEvent(resolved)));
				outcome = { frame: response(this.hostId, command, true, { accepted: true }) };
			} else if (DIRECT_SESSION_RPC_COMMANDS.has(command.command)) {
				const supervisor = await this.ensureSupervisor(command.sessionId!);
				const type =
					command.command === "session.retry"
						? "retry"
						: command.command === "session.pause"
							? "pause"
							: command.command === "session.resume"
								? "resume"
								: command.command === "session.compact"
									? "compact"
									: command.command === "session.rename"
										? "set_session_name"
										: command.command === "session.model.set"
											? "set_model"
											: command.command === "session.thinking.set"
												? "set_thinking_level"
												: "set_fast";
				const args =
					command.command === "session.compact"
						? { customInstructions: command.args.instructions }
						: command.command === "session.rename"
							? { name: command.args.name }
							: command.command === "session.model.set"
								? {
										selector: command.args.selector,
										role: command.args.role,
										persist: command.args.persistence === "settings",
									}
								: command.command === "session.thinking.set"
									? { level: command.args.level }
									: command.command === "session.fast.set"
										? { enabled: command.args.enabled }
										: {};
				const result = await supervisor.call({ type, ...args }, command.requestId, controller.signal);
				if (!result.success)
					outcome = {
						frame: response(this.hostId, command, false, undefined, {
							code: "child_error",
							message: "session command failed",
						}),
					};
				else {
					const childData = "data" in result ? result.data : undefined;
					const data =
						command.command === "session.retry"
							? { retried: childBoolean(childData, "retried") }
							: command.command === "session.pause"
								? { paused: childBoolean(childData, "paused"), changed: childBoolean(childData, "changed") }
								: command.command === "session.resume"
									? { resumed: childBoolean(childData, "resumed"), paused: childBoolean(childData, "paused") }
									: command.command === "session.compact"
										? { compacted: true }
										: command.command === "session.rename"
											? { renamed: true }
											: { accepted: true };
					if (
						command.command === "session.model.set" ||
						command.command === "session.thinking.set" ||
						command.command === "session.fast.set"
					)
						await this.refreshState(command.sessionId!, supervisor, command.requestId);
					outcome = { frame: response(this.hostId, command, true, data) };
				}
				if (
					command.command !== "session.model.set" &&
					command.command !== "session.thinking.set" &&
					command.command !== "session.fast.set"
				)
					this.scheduleStateRefresh(command.sessionId!, supervisor, command.requestId);
			} else if (command.command === "session.prompt") {
				if (this.#closedSessions.has(command.sessionId!)) throw new Error("session is closed");
				const supervisor = await this.ensureSupervisor(command.sessionId!);
				if (this.#promptLifecycles.has(command.sessionId!)) {
					outcome = {
						frame: response(this.hostId, command, false, undefined, {
							code: "session_busy",
							message: "another prompt is still running; use steer or follow-up",
						}),
					};
				} else if (this.#pendingMessageCount(command.sessionId!) >= MAX_PENDING_PROMPTS) {
					outcome = {
						frame: response(this.hostId, command, false, undefined, {
							code: "message_queue_full",
							message: `at most ${MAX_PENDING_PROMPTS} accepted prompts may be pending`,
						}),
					};
				} else {
					const lifecycle: PromptLifecycle = {
						requestId: command.requestId,
						commandId: command.commandId,
						commandHash: payloadHash(command),
						kind: "prompt",
					};
					messageLifecycle = lifecycle;
					if (!this.#registerMessageLifecycle(command.sessionId!, lifecycle))
						throw new Error("pending prompt capacity changed");
					this.#promptLifecycles.set(command.sessionId!, lifecycle);
					this.updateStatus(command.sessionId!, "active");
					const managedImages = promptArguments?.images
						? await this.#imageUploads.consume(ws!.connectionId, command.sessionId!, promptArguments.images)
						: undefined;
					this.#emitPromptTransient(
						command.sessionId!,
						command,
						lifecycle,
						promptArguments!.message,
						promptArguments?.images?.length ?? 0,
					);
					let result: RpcResponse;
					try {
						result = await supervisor.prompt(
							command.requestId,
							promptArguments!.message,
							// Registration and transient publication make this accepted work.
							// Client disconnect must not revoke it before the child acknowledges it.
							undefined,
							internalId => {
								if (this.#hasMessageLifecycle(command.sessionId!, lifecycle)) lifecycle.internalId = internalId;
							},
							managedImages,
						);
					} finally {
						if (managedImages) await this.#imageUploads.release(managedImages);
					}
					if (!result.success || childAgentInvoked(result) === false) {
						const reason = result.success ? "local-only" : "rejected";
						if (this.#releaseMessageLifecycle(command.sessionId!, lifecycle, reason))
							this.#projectTerminalStatus(command.sessionId!, supervisor, `${command.requestId}:terminal`);
					} else lifecycle.accepted = true;
					outcome = {
						frame: response(
							this.hostId,
							command,
							result.success,
							{ accepted: result.success },
							result.success ? undefined : { code: "child_error", message: "session command failed" },
						),
					};
					if (this.#hasMessageLifecycle(command.sessionId!, lifecycle))
						this.scheduleStateRefresh(command.sessionId!, supervisor, command.requestId, true);
				}
			} else if (command.command === SESSION_CANCEL_COMMAND) {
				// Capture the exact root before the first yield. A root which settles
				// while the supervisor starts must not let this unscoped RPC abort a
				// newer prompt that registered in the meantime.
				const cancelledLifecycle = this.#promptLifecycles.get(command.sessionId!);
				const supervisor = await this.ensureSupervisor(command.sessionId!);
				if (this.#promptLifecycles.get(command.sessionId!) !== cancelledLifecycle) {
					outcome = { frame: response(this.hostId, command, true, { cancelled: false }) };
				} else {
					const result = await supervisor.cancel(command.requestId);
					if (result.success) {
						this.#releaseMessageLifecycle(command.sessionId!, cancelledLifecycle, "cancelled");
						this.#projectTerminalStatus(command.sessionId!, supervisor, `${command.requestId}:terminal`);
					}
					outcome = {
						frame: response(
							this.hostId,
							command,
							result.success,
							{ cancelled: result.success },
							result.success ? undefined : { code: "child_error", message: "session command failed" },
						),
					};
				}
			} else if (this.#operations && ws) {
				const context: OperationContext = {
					hostId: this.hostId,
					sessionId: command.sessionId,
					deviceId: ws.deviceId,
					connectionId: ws.connectionId,
					capabilities: (capabilities ?? new Set()) as OperationContext["capabilities"],
					currentRevision: projection?.value.revision,
					expectedRevision: command.expectedRevision,
					abortSignal: controller.signal,
				};
				const result = await this.#operations.dispatch(command, context);
				outcome = { frame: response(this.hostId, command, true, result) };
			} else
				outcome = {
					frame: response(this.hostId, command, false, undefined, {
						code: "unsupported",
						message: "command is unsupported",
					}),
				};
		} catch (error) {
			if (
				messageLifecycle &&
				this.#releaseMessageLifecycle(command.sessionId!, messageLifecycle, "failed") &&
				!this.#closedSessions.has(command.sessionId!)
			)
				this.#projectTerminalStatus(command.sessionId!);
			const imageError =
				error instanceof ImageUploadError || error instanceof TranscriptImageError ? error : undefined;
			const operation =
				this.#operations &&
				ws &&
				![
					"session.create",
					"session.close",
					"session.prompt",
					"session.cancel",
					"session.attach",
					"session.list",
					"host.list",
				].includes(command.command);
			const code = imageError
				? imageError.code
				: command.command === "session.ui.respond"
					? "ui_request_invalid"
					: operation && error && typeof error === "object" && "code" in error && typeof error.code === "string"
						? error.code
						: "outcome_unknown";
			outcome = {
				frame: response(this.hostId, command, false, undefined, {
					code,
					message: imageError?.message ?? (operation ? "operation failed" : "command failed"),
				}),
				unknown: !operation && !imageError,
			};
		} finally {
			if (ws) this.#abortControllers.get(ws)?.delete(controller);
			if (trackSessionOperation) this.endSessionOperation(command.sessionId!);
		}
		return this.finish(command, outcome, idempotency);
	}
	private async createSession(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (!this.#authority) throw new Error("session creation is unavailable");
		if (!this.#projectRootForProject) throw new Error("session project resolver is unavailable");
		const requestedProjectId = args.projectId;
		if (typeof requestedProjectId !== "string") throw new Error("session projectId is invalid");
		const requestedProject = projectId(requestedProjectId);
		const requestedCwd = await this.#projectRootForProject(requestedProject);
		if (typeof requestedCwd !== "string" || !requestedCwd.startsWith("/"))
			throw new Error("project resolver returned an invalid local root");
		let canonical: string;
		try {
			canonical = await realpath(requestedCwd);
			if (!(await fsStat(canonical)).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new Error("project resolver returned an unavailable local root");
		}
		if (stableProjectId(canonical) !== requestedProject)
			throw new Error("project resolver returned a mismatched local root");
		const title = typeof args.title === "string" ? args.title : undefined;
		const created = await this.#authority.create(canonical, title);
		const timestamp = this.#clock.now().toISOString();
		const record: SessionRecord = {
			sessionId: created.sessionId,
			path: created.path,
			cwd: created.cwd,
			projectId: stableProjectId(created.cwd),
			projectName: projectNameFromCwd(created.cwd),
			title: created.title ?? "Session",
			updatedAt: timestamp,
			status: "idle",
			entries: created.entries,
		};
		this.#records.set(record.sessionId, record);
		this.#projections.set(record.sessionId, new SessionProjection(this.hostId, record, this.epoch, this.#ringSize));
		this.#createdPending.set(record.sessionId, { record, refreshesRemaining: 1 });
		return { sessionId: record.sessionId };
	}
	private async handleCreate(command: CommandFrame): Promise<CommandOutcome> {
		const created = await this.createSession(command.args);
		const projection = this.#projections.get(created.sessionId as SessionId)!;
		await this.broadcastIndex(projection.indexUpsert());
		return {
			frame: response(this.hostId, command, true, {
				session: projection.value.ref,
			}),
		};
	}
	private async handleClose(command: CommandFrame): Promise<CommandOutcome> {
		const sessionId = command.sessionId!;
		if (this.#lifecycleMutations.has(sessionId))
			return this.lifecycleBusyOutcome(command, "session lifecycle mutation is already in progress");
		this.#lifecycleMutations.add(sessionId);
		let supervisor: RpcChildSupervisor | undefined;
		let alreadyExplicitlyClosed = false;
		try {
			const projection = this.#projections.get(sessionId)!;
			alreadyExplicitlyClosed = this.#closedSessions.has(sessionId) && projection.value.ref.status === "closed";
			this.#closedSessions.add(sessionId);
			await this.#imageUploads.cleanupSession(sessionId);
			const pending = this.#startPromises.get(sessionId);
			if (pending) await pending.catch(() => undefined);
			supervisor = this.#supervisors.get(sessionId);
			if (!(await this.quiesceSupervisor(sessionId))) {
				if (!alreadyExplicitlyClosed) {
					this.#closedSessions.delete(sessionId);
					if (supervisor) this.markSupervisorCrashed(sessionId, supervisor);
				}
				return this.lifecycleBusyOutcome(command, "session runtime did not stop cleanly");
			}
			this.#releaseAllMessageLifecycles(sessionId, "cancelled");
			this.#stateRefreshGenerations.delete(sessionId);
			this.#transcripts.delete(sessionId);
			this.disposeSubagentState(sessionId);
			if (alreadyExplicitlyClosed)
				return { frame: response(this.hostId, command, true, { closed: true, sessionId }) };
			this.updateStatus(sessionId, "closed");
			this.broadcast(sessionId, projection.appendEvent({ type: "session_closed" }));
			return { frame: response(this.hostId, command, true, { closed: true, sessionId }) };
		} catch (error) {
			if (!alreadyExplicitlyClosed) {
				this.#closedSessions.delete(sessionId);
				if (supervisor) this.markSupervisorCrashed(sessionId, supervisor);
			}
			throw error;
		} finally {
			this.#lifecycleMutations.delete(sessionId);
		}
	}
	private async deletePreflight(
		command: CommandFrame,
		ignoreLifecycleFence = false,
	): Promise<SessionLifecycleFailure | undefined> {
		const sessionId = command.sessionId;
		if (!sessionId) return { code: "unknown_session", message: "session is not indexed" };
		if (!this.#authority) return { code: "unsupported", message: "session lifecycle management is unavailable" };
		const revisionFailure = this.lifecycleRevisionFailure(command);
		if (revisionFailure) return revisionFailure;
		const record = this.#records.get(sessionId);
		if (!record) return { code: "unknown_session", message: "session is not indexed" };
		if (this.sessionLifecycleBusy(sessionId, ignoreLifecycleFence))
			return { code: "session_busy", message: "session has active or pending work" };
		if (!this.#supervisors.has(sessionId)) {
			try {
				await this.#lockCheck(record);
			} catch {
				return { code: "session_locked", message: "session is locked by another process" };
			}
		}
		return undefined;
	}
	private sessionArchived(sessionId: SessionId): boolean {
		return Boolean(
			this.#records.get(sessionId)?.archivedAt || this.#projections.get(sessionId)?.value.ref.archivedAt,
		);
	}
	private beginSessionOperation(sessionId: SessionId): boolean {
		if (this.#draining || this.#stopping || this.#lifecycleMutations.has(sessionId)) return false;
		this.#inflightSessionOperations.set(sessionId, (this.#inflightSessionOperations.get(sessionId) ?? 0) + 1);
		return true;
	}
	private endSessionOperation(sessionId: SessionId): void {
		const count = this.#inflightSessionOperations.get(sessionId) ?? 0;
		if (count <= 1) this.#inflightSessionOperations.delete(sessionId);
		else this.#inflightSessionOperations.set(sessionId, count - 1);
	}
	private sessionLifecycleBusy(sessionId: SessionId, ignoreLifecycleFence = false): boolean {
		const ref = this.#projections.get(sessionId)?.value.ref;
		const liveState = ref?.liveState;
		return (
			(!ignoreLifecycleFence && this.#lifecycleMutations.has(sessionId)) ||
			(this.#inflightSessionOperations.get(sessionId) ?? 0) > 0 ||
			this.#startPromises.has(sessionId) ||
			this.#supervisors.get(sessionId)?.hasPendingCalls() === true ||
			this.#pendingMessageCount(sessionId) > 0 ||
			(this.#transcripts.get(sessionId)?.pendingUiRequests().length ?? 0) > 0 ||
			ref?.status === "active" ||
			ref?.pendingApproval === true ||
			ref?.pendingUserInput === true ||
			liveState?.isStreaming === true ||
			liveState?.isCompacting === true ||
			liveState?.pendingApproval === true ||
			liveState?.pendingUserInput === true ||
			queuedLifecycleWork(liveState)
		);
	}
	private lifecycleRevisionFailure(command: CommandFrame): SessionLifecycleFailure | undefined {
		const projection = command.sessionId ? this.#projections.get(command.sessionId) : undefined;
		if (!projection) return { code: "unknown_session", message: "session is not indexed" };
		if (command.expectedRevision === undefined)
			return { code: "stale_revision", message: "expectedRevision is required" };
		if (command.expectedRevision === projection.value.revision) return undefined;
		return {
			code: "stale_revision",
			message: "session revision is stale",
			details: { expectedRevision: command.expectedRevision, actualRevision: projection.value.revision },
		};
	}
	private lifecycleBusyOutcome(command: CommandFrame, message: string): CommandOutcome {
		return { frame: response(this.hostId, command, false, undefined, { code: "session_busy", message }) };
	}
	private lifecycleFailureOutcome(command: CommandFrame, failure: SessionLifecycleFailure): CommandOutcome {
		return { frame: response(this.hostId, command, false, undefined, failure) };
	}
	private async childExitedWithinLifecycleTimeout(child: ChildHandle): Promise<boolean> {
		return Promise.race([
			child.exited.then(() => true).catch(() => false),
			Bun.sleep(this.#lifecycleQuiesceTimeoutMs).then(() => false),
		]);
	}
	private async quiesceSupervisor(sessionId: SessionId): Promise<boolean> {
		const supervisor = this.#supervisors.get(sessionId);
		if (!supervisor) {
			this.#stateRefreshGenerations.delete(sessionId);
			return true;
		}
		const child = supervisor.child();
		if (!child) return false;
		supervisor.stop("SIGTERM");
		if (!(await this.childExitedWithinLifecycleTimeout(child))) {
			// A lifecycle mutation may proceed only after the process itself exits,
			// not merely after the supervisor has rejected its pending RPC calls.
			supervisor.stop("SIGKILL");
			if (!(await this.childExitedWithinLifecycleTimeout(child))) return false;
		}
		const current = this.#supervisors.get(sessionId);
		if (current && current !== supervisor) return false;
		this.#supervisors.delete(sessionId);
		this.#releaseAllMessageLifecycles(sessionId, "cancelled");
		this.#stateRefreshGenerations.delete(sessionId);
		this.#transcripts.delete(sessionId);
		this.disposeSubagentState(sessionId);
		return true;
	}
	private releaseSupervisorAfterExit(sessionId: SessionId, supervisor: RpcChildSupervisor): void {
		const release = () => {
			if (this.#supervisors.get(sessionId) !== supervisor) return;
			this.#supervisors.delete(sessionId);
			if (this.#stopping || this.#closedSessions.has(sessionId)) return;
			const restartable = this.#projections.get(sessionId)?.markRuntimeRestartable();
			if (restartable) this.broadcast(sessionId, restartable);
		};
		const child = supervisor.child();
		if (child) void child.exited.then(release, release);
		else release();
	}
	private markSupervisorCrashed(sessionId: SessionId, supervisor: RpcChildSupervisor): void {
		if (this.#supervisors.get(sessionId) !== supervisor) return;
		this.advanceStateRefreshGeneration(sessionId);
		this.#releaseAllMessageLifecycles(sessionId, "failed");
		const crashed = this.#projections.get(sessionId)?.markRuntimeCrashed();
		if (crashed) this.broadcast(sessionId, crashed);
		this.#stateRefreshGenerations.delete(sessionId);
		this.#transcripts.delete(sessionId);
		this.disposeSubagentState(sessionId);
		this.releaseSupervisorAfterExit(sessionId, supervisor);
	}
	private disposeSubagentState(sessionId: SessionId): void {
		this.#subagents.delete(sessionId);
		this.#agentTranscripts.get(sessionId)?.dispose();
		this.#agentTranscripts.delete(sessionId);
	}
	private async quiesceSessionRuntime(sessionId: SessionId): Promise<boolean> {
		if (this.#operations?.hasOpenTerminals(sessionId)) {
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const closed = await Promise.race([
					this.#operations
						.closeSessionTerminals(sessionId, controller.signal)
						.then(() => true)
						.catch(() => false),
					new Promise<false>(resolve => {
						timer = setTimeout(() => {
							controller.abort();
							resolve(false);
						}, this.#lifecycleQuiesceTimeoutMs);
					}),
				]);
				if (!closed) return false;
			} finally {
				if (timer) clearTimeout(timer);
			}
		}
		return this.quiesceSupervisor(sessionId);
	}
	private async handleArchive(command: CommandFrame): Promise<CommandOutcome> {
		const sessionId = command.sessionId!;
		if (this.#lifecycleMutations.has(sessionId))
			return this.lifecycleBusyOutcome(command, "session lifecycle mutation is already in progress");
		this.#lifecycleMutations.add(sessionId);
		try {
			if (!this.#authority)
				return this.lifecycleFailureOutcome(command, {
					code: "unsupported",
					message: "session lifecycle management is unavailable",
				});
			const revisionFailure = this.lifecycleRevisionFailure(command);
			if (revisionFailure) return this.lifecycleFailureOutcome(command, revisionFailure);
			const projection = this.#projections.get(sessionId)!;
			const record = this.#records.get(sessionId)!;
			if (record.archivedAt) return { frame: response(this.hostId, command, true, { archived: true }) };
			if (this.sessionLifecycleBusy(sessionId, true))
				return this.lifecycleBusyOutcome(command, "sessions with active or pending work cannot be archived");
			if (!(await this.quiesceSessionRuntime(sessionId)))
				return this.lifecycleBusyOutcome(command, "session runtime did not stop cleanly");
			try {
				await this.#lockCheck(record);
			} catch {
				return {
					frame: response(this.hostId, command, false, undefined, {
						code: "session_locked",
						message: "session is locked by another process",
					}),
				};
			}
			const archivedAt = this.#clock.now().toISOString();
			await this.#imageUploads.cleanupSession(sessionId);
			await this.#authority.archive(record, archivedAt);
			record.archivedAt = archivedAt;
			await this.broadcastAttachedOrdered(
				sessionId,
				projection.appendEvent({ type: "session_archived", archivedAt }),
			);
			const delta = projection.updateArchivedAt(archivedAt);
			if (delta) await this.broadcastIndex(delta);
			return { frame: response(this.hostId, command, true, { archived: true }) };
		} catch {
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "session_lifecycle_failed",
					message: "session archive failed",
				}),
			};
		} finally {
			this.#lifecycleMutations.delete(sessionId);
		}
	}
	private async handleRestore(command: CommandFrame): Promise<CommandOutcome> {
		const sessionId = command.sessionId!;
		if (this.#lifecycleMutations.has(sessionId))
			return this.lifecycleBusyOutcome(command, "session lifecycle mutation is already in progress");
		this.#lifecycleMutations.add(sessionId);
		try {
			if (!this.#authority)
				return this.lifecycleFailureOutcome(command, {
					code: "unsupported",
					message: "session lifecycle management is unavailable",
				});
			const revisionFailure = this.lifecycleRevisionFailure(command);
			if (revisionFailure) return this.lifecycleFailureOutcome(command, revisionFailure);
			const projection = this.#projections.get(sessionId)!;
			const record = this.#records.get(sessionId)!;
			if (!record.archivedAt) return { frame: response(this.hostId, command, true, { restored: true }) };
			await this.#imageUploads.cleanupSession(sessionId);
			await this.#authority.restore(record);
			delete record.archivedAt;
			await this.broadcastAttachedOrdered(sessionId, projection.appendEvent({ type: "session_restored" }));
			const delta = projection.updateArchivedAt();
			if (delta) await this.broadcastIndex(delta);
			return { frame: response(this.hostId, command, true, { restored: true }) };
		} catch {
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "session_lifecycle_failed",
					message: "session restore failed",
				}),
			};
		} finally {
			this.#lifecycleMutations.delete(sessionId);
		}
	}
	private async handleDelete(command: CommandFrame): Promise<CommandOutcome> {
		const sessionId = command.sessionId!;
		if (this.#lifecycleMutations.has(sessionId))
			return this.lifecycleBusyOutcome(command, "session lifecycle mutation is already in progress");
		this.#lifecycleMutations.add(sessionId);
		try {
			const projection = this.#projections.get(sessionId);
			const record = this.#records.get(sessionId);
			if (!projection || !record)
				return this.lifecycleFailureOutcome(command, {
					code: "unknown_session",
					message: "session is not indexed",
				});
			const guarded = await this.deletePreflight(command, true);
			if (guarded && guarded.code !== "session_busy") return this.lifecycleFailureOutcome(command, guarded);
			if (guarded)
				return this.lifecycleBusyOutcome(command, "session became busy while deletion was being confirmed");
			if (!(await this.quiesceSessionRuntime(sessionId)))
				return this.lifecycleBusyOutcome(command, "session runtime did not stop cleanly");
			const finalGuard = await this.deletePreflight(command, true);
			if (finalGuard) return this.lifecycleFailureOutcome(command, finalGuard);
			await this.#imageUploads.cleanupSession(sessionId);
			await this.#authority!.delete(record);
			await this.broadcastAttachedOrdered(sessionId, projection.appendEvent({ type: "session_deleted" }));
			await this.broadcastIndex(projection.remove());
			this.#records.delete(sessionId);
			this.#projections.delete(sessionId);
			this.#closedSessions.delete(sessionId);
			this.#releaseAllMessageLifecycles(sessionId, "completed-without-entry");
			this.#stateRefreshGenerations.delete(sessionId);
			this.#transcripts.delete(sessionId);
			this.disposeSubagentState(sessionId);
			for (const sessions of this.#attached.values()) sessions.delete(sessionId);
			return { frame: response(this.hostId, command, true, { deleted: true }) };
		} catch {
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "session_lifecycle_failed",
					message: "session deletion failed",
				}),
			};
		} finally {
			this.#lifecycleMutations.delete(sessionId);
		}
	}
	private finish(
		command: CommandFrame,
		outcome: CommandOutcome,
		idempotency: IdempotencyStore | undefined,
	): CommandOutcome {
		if (!idempotency) return outcome;
		const cached: CommandOutcome = { ...outcome };
		delete cached.attachOutput;
		idempotency.complete(command.commandId, command, cached);
		return outcome;
	}
	#pendingMessageCount(sessionId: SessionId): number {
		return this.#messageLifecycles.get(sessionId)?.length ?? 0;
	}
	#hasMessageLifecycle(sessionId: SessionId, lifecycle: PromptLifecycle): boolean {
		return this.#messageLifecycles.get(sessionId)?.includes(lifecycle) === true;
	}
	#registerMessageLifecycle(sessionId: SessionId, lifecycle: PromptLifecycle): boolean {
		const current = this.#messageLifecycles.get(sessionId) ?? [];
		if (current.length >= MAX_PENDING_PROMPTS || this.#messageLifecyclesByCommandId.has(lifecycle.commandId))
			return false;
		this.#messageLifecycles.set(sessionId, [...current, lifecycle]);
		this.#messageLifecyclesByCommandId.set(lifecycle.commandId, lifecycle);
		this.advanceStateRefreshGeneration(sessionId);
		return true;
	}
	#findMessageLifecycle(sessionId: SessionId, internalId: string | undefined): PromptLifecycle | undefined {
		if (internalId === undefined) return undefined;
		return this.#messageLifecycles.get(sessionId)?.find(lifecycle => lifecycle.internalId === internalId);
	}
	#removeMessageLifecycle(sessionId: SessionId, lifecycle: PromptLifecycle): boolean {
		const current = this.#messageLifecycles.get(sessionId);
		if (!current?.includes(lifecycle)) return false;
		const next = current.filter(candidate => candidate !== lifecycle);
		if (next.length > 0) this.#messageLifecycles.set(sessionId, next);
		else this.#messageLifecycles.delete(sessionId);
		if (this.#messageLifecyclesByCommandId.get(lifecycle.commandId) === lifecycle)
			this.#messageLifecyclesByCommandId.delete(lifecycle.commandId);
		if (this.#promptLifecycles.get(sessionId) === lifecycle) this.#promptLifecycles.delete(sessionId);
		this.advanceStateRefreshGeneration(sessionId);
		return true;
	}
	#emitPromptTransient(
		sessionId: SessionId,
		command: CommandFrame,
		lifecycle: PromptLifecycle,
		message: string,
		attachmentCount: number,
	): void {
		if (!this.#hasMessageLifecycle(sessionId, lifecycle) || lifecycle.transientEntryId) return;
		const transientEntryId = `user:${createHash("sha256").update(command.commandId).digest("hex").slice(0, 32)}`;
		lifecycle.transientEntryId = transientEntryId;
		const projection = this.#projections.get(sessionId);
		if (!projection) return;
		const at = this.#clock.now().toISOString();
		const pending = projection.addPendingPrompt({
			entryId: transientEntryId,
			text: projectMessageText(message, PENDING_PROMPT_TEXT_BYTES),
			attachmentCount,
			at,
		});
		if (pending) this.broadcast(sessionId, pending);
		this.broadcast(
			sessionId,
			projection.appendEvent(
				asAppWireEvent({
					type: "message.update",
					entryId: transientEntryId,
					role: "user",
					text: projectMessageText(message, PENDING_PROMPT_EVENT_TEXT_BYTES),
					reasoning: "",
					attachmentCount,
					at,
				}),
			),
		);
	}
	#settlePromptTransient(sessionId: SessionId, lifecycle: PromptLifecycle | undefined, entryId: string): void {
		const transientEntryId = lifecycle?.transientEntryId;
		if (!lifecycle || !this.#hasMessageLifecycle(sessionId, lifecycle) || !transientEntryId) return;
		lifecycle.transientEntryId = undefined;
		const projection = this.#projections.get(sessionId);
		if (!projection) return;
		this.broadcast(
			sessionId,
			projection.appendEvent(
				asAppWireEvent({
					type: "message.settled",
					transientEntryId,
					entryId,
					at: this.#clock.now().toISOString(),
				}),
			),
		);
		const pending = projection.clearPendingPrompt(transientEntryId);
		if (pending) this.broadcast(sessionId, pending);
		if (lifecycle.kind !== "prompt") this.#removeMessageLifecycle(sessionId, lifecycle);
	}
	#discardPromptTransient(sessionId: SessionId, lifecycle: PromptLifecycle, reason: PromptDiscardReason): void {
		const transientEntryId = lifecycle.transientEntryId;
		if (!transientEntryId) return;
		lifecycle.transientEntryId = undefined;
		const projection = this.#projections.get(sessionId);
		if (!projection) return;
		this.broadcast(
			sessionId,
			projection.appendEvent(
				asAppWireEvent({
					type: "message.discarded",
					transientEntryId,
					reason,
					at: this.#clock.now().toISOString(),
				}),
			),
		);
		const pending = projection.clearPendingPrompt(transientEntryId);
		if (pending) this.broadcast(sessionId, pending);
	}
	#releaseMessageLifecycle(
		sessionId: SessionId,
		lifecycle?: PromptLifecycle,
		reason: PromptDiscardReason = "completed-without-entry",
	): boolean {
		if (!lifecycle || !this.#hasMessageLifecycle(sessionId, lifecycle)) return false;
		this.#discardPromptTransient(sessionId, lifecycle, reason);
		return this.#removeMessageLifecycle(sessionId, lifecycle);
	}
	#releaseAllMessageLifecycles(sessionId: SessionId, reason: PromptDiscardReason): boolean {
		const lifecycles = [...(this.#messageLifecycles.get(sessionId) ?? [])];
		let released = false;
		for (const lifecycle of lifecycles)
			if (this.#releaseMessageLifecycle(sessionId, lifecycle, reason)) released = true;
		return released;
	}
	#projectTerminalStatus(
		sessionId: SessionId,
		supervisor = this.#supervisors.get(sessionId),
		requestId = "terminal",
	): void {
		if (this.#closedSessions.has(sessionId)) return;
		if (this.#pendingMessageCount(sessionId) > 0) this.updateStatus(sessionId, "active");
		if (supervisor) {
			this.scheduleStateRefresh(sessionId, supervisor, requestId);
			return;
		}
		if (this.#projections.get(sessionId)?.value.ref.liveState?.isStreaming !== true)
			this.updateStatus(sessionId, "idle");
	}
	private advanceStateRefreshGeneration(sessionId: SessionId): number {
		const generation = (this.#stateRefreshGenerations.get(sessionId) ?? 0) + 1;
		this.#stateRefreshGenerations.set(sessionId, generation);
		return generation;
	}
	private updateStatus(sessionId: SessionId, status: SessionRef["status"]): void {
		const frame = this.#projections.get(sessionId)?.updateStatus(status);
		if (frame) this.broadcast(sessionId, frame);
	}
	private async refreshState(
		sessionId: SessionId,
		supervisor: RpcChildSupervisor,
		requestId: string,
		preserveProjectedStatus = false,
		signal?: AbortSignal,
	): Promise<SessionStateResult> {
		const generation = this.advanceStateRefreshGeneration(sessionId);
		const result = await supervisor.call({ type: "get_state" }, `${requestId}:state`, signal);
		if (!result.success || !("data" in result)) throw new Error("rpc state query failed");
		const state = safeSessionState(result.data);
		const projection = this.#projections.get(sessionId);
		if (!projection) throw new Error("unknown session");
		if (this.#stateRefreshGenerations.get(sessionId) !== generation) return state;
		const statusOverride = preserveProjectedStatus
			? projection.value.ref.status
			: this.#pendingMessageCount(sessionId) > 0
				? "active"
				: undefined;
		const frame = projection.updateState(state, statusOverride, !this.#closedSessions.has(sessionId));
		if (frame) await this.broadcastIndex(frame);
		return state;
	}
	private scheduleStateRefresh(
		sessionId: SessionId,
		supervisor: RpcChildSupervisor,
		requestId: string,
		preserveProjectedStatus = false,
	): void {
		void this.refreshState(sessionId, supervisor, requestId, preserveProjectedStatus).catch(() => undefined);
	}
	private async ensureSupervisor(sessionId: SessionId): Promise<RpcChildSupervisor> {
		if (this.#draining) throw new Error("appserver is draining");
		if (this.#stopping) throw new Error("appserver is stopping");
		if (this.#closedSessions.has(sessionId)) throw new Error("session is closed");
		if (this.#lifecycleMutations.has(sessionId)) throw new Error("session lifecycle mutation is in progress");
		if (this.sessionArchived(sessionId)) throw new Error("session is archived");
		const pending = this.#startPromises.get(sessionId);
		if (pending) return pending;
		const existing = this.#supervisors.get(sessionId);
		if (existing) return existing;
		const start = Promise.resolve().then(() => this.startSupervisor(sessionId));
		this.#startPromises.set(sessionId, start);
		try {
			return await start;
		} finally {
			this.#startPromises.delete(sessionId);
		}
	}
	private async startSupervisor(sessionId: SessionId): Promise<RpcChildSupervisor> {
		const existing = this.#supervisors.get(sessionId);
		if (existing) return existing;
		if (this.#stopping || this.#closedSessions.has(sessionId)) throw new Error("session is closed");
		if (this.#lifecycleMutations.has(sessionId)) throw new Error("session lifecycle mutation is in progress");
		const record = this.#records.get(sessionId);
		if (!record) throw new Error("unknown session");
		if (this.sessionArchived(sessionId)) throw new Error("session is archived");
		await this.#lockCheck(record);
		if (this.#stopping || this.#closedSessions.has(sessionId)) throw new Error("session is closed");
		if (this.#lifecycleMutations.has(sessionId) || this.sessionArchived(sessionId))
			throw new Error("session lifecycle changed while starting");
		const projection = this.#projections.get(sessionId)!;
		const transcript = new TranscriptEventTranslator();
		transcript.observeKnownEntries(projection.value.entries);
		this.#transcripts.set(sessionId, transcript);
		const subagents = new SubagentProjection(this.hostId, sessionId);
		this.#subagents.set(sessionId, subagents);
		const projector = new SessionEntryProjector(this.hostId, sessionId, "live", projection.value.entries);
		let supervisor: RpcChildSupervisor;
		const agentTranscripts = new AgentTranscriptProjection({
			hostId: this.hostId,
			sessionId,
			epoch: this.epoch,
			read: async (agent, fromByte): Promise<RpcSubagentMessagesResult> => {
				const result = await supervisor.call(
					{
						type: "get_subagent_messages",
						subagentId: agent,
						fromByte,
						maxBytes: SUBAGENT_TRANSCRIPT_RPC_BYTES,
						includeMessages: false,
					},
					`agent-transcript:${agent}`,
				);
				if (!result.success || result.command !== "get_subagent_messages")
					throw new Error(result.success ? "subagent transcript response mismatch" : result.error);
				return result.data;
			},
			revision: () => projection.value.revision,
			emit: frame => this.broadcast(sessionId, frame),
		});
		this.#agentTranscripts.set(sessionId, agentTranscripts);
		supervisor = new RpcChildSupervisor(
			this.#factory,
			record,
			{
				entry: frame => {
					const value: unknown = frame.entry;
					const raw =
						value && typeof value === "object" && !Array.isArray(value)
							? (value as Record<string, unknown>)
							: undefined;
					if (!raw) return;
					const entries = projector.project(raw);
					const settlementEvents = transcript.observeSessionEntry(raw, entries);
					const lifecycle = this.#findMessageLifecycle(sessionId, promptEntryCorrelationId(frame.entry));
					const correlatedPromptEntry = lifecycle !== undefined;
					let durableUserEntryId: string | undefined;
					for (const entry of entries) {
						const output = projection.appendEntry(entry);
						if (output) this.broadcast(sessionId, output);
						if (
							correlatedPromptEntry &&
							entry.kind === "message" &&
							entry.data.role === "user" &&
							durableUserEntryId === undefined
						)
							durableUserEntryId = entry.id;
					}
					if (durableUserEntryId) this.#settlePromptTransient(sessionId, lifecycle, durableUserEntryId);
					const projectedTitle =
						projector.titleChange ??
						(projection.value.ref.title === "Session" || projection.value.ref.title === "Untitled"
							? fallbackSessionTitle(projector.firstUserText)
							: undefined);
					if (projectedTitle) {
						record.title = projectedTitle;
						const output = projection.updateTitle(projectedTitle);
						if (output) this.broadcast(sessionId, output);
					}
					for (const event of settlementEvents)
						this.broadcast(sessionId, projection.appendEvent(asAppWireEvent(event)));
				},
				event: frame => {
					const agentFrame = subagents.applyFrame(frame);
					if (agentFrame) this.broadcast(sessionId, agentFrame);
					const transcriptAgentId = subagentIdFromFrame(frame);
					if (transcriptAgentId) agentTranscripts.refresh(transcriptAgentId);
					const terminalPromptResult =
						frame.type === "prompt_result" &&
						(typeof frame.agentInvoked === "boolean" || typeof frame.error === "string");
					const terminalLifecycle =
						terminalPromptResult && typeof frame.id === "string"
							? this.#findMessageLifecycle(sessionId, frame.id)
							: undefined;
					const currentPromptResult = terminalLifecycle !== undefined;
					for (const event of transcript.translate(frame, { currentPromptResult })) {
						this.broadcast(sessionId, projection.appendEvent(asAppWireEvent(event)));
						if (event.type === "turn.start" || event.type === "agent.start")
							this.updateStatus(sessionId, "active");
					}
					if (terminalLifecycle) {
						const reason =
							typeof frame.error === "string"
								? "failed"
								: frame.agentInvoked === false
									? "local-only"
									: "completed-without-entry";
						if (this.#releaseMessageLifecycle(sessionId, terminalLifecycle, reason))
							this.#projectTerminalStatus(sessionId, supervisor, `${frame.id}:terminal`);
					}
					if (frame.type === "agent_end") this.scheduleStateRefresh(sessionId, supervisor, "agent-end");
					if (frame.type === "thinking_level_changed")
						this.scheduleStateRefresh(sessionId, supervisor, "thinking-level-changed");
				},
				crashed: () => {
					this.markSupervisorCrashed(sessionId, supervisor);
				},
			},
			this.#factory.argv(record.path),
		);
		this.#supervisors.set(sessionId, supervisor);
		try {
			await supervisor.start();
			return supervisor;
		} catch (error) {
			this.#supervisors.delete(sessionId);
			this.#releaseAllMessageLifecycles(sessionId, "failed");
			this.#transcripts.delete(sessionId);
			this.disposeSubagentState(sessionId);
			supervisor.stop();
			throw error;
		}
	}
	private async message(ws: AppWs, raw: string | Uint8Array): Promise<void> {
		this.#inflightMessages += 1;
		try {
			if (this.#draining || this.#stopping) {
				ws.close(1012, "appserver maintenance");
				return;
			}
			if (typeof raw !== "string") throw new Error("binary websocket frames are not supported");
			const frame = decodeClientFrame(parseBounded(raw));
			if (frame.type === "hello") {
				if (this.#hello.has(ws)) throw new Error("hello already received");
				let decision: RemoteHelloDecision | undefined;
				if (ws.remote) {
					const connection = this.#remoteConnections.get(ws);
					if (!connection || !this.#remotePolicy) throw new Error("remote connection is unavailable");
					decision = await this.#remotePolicy.authenticate(connection, frame);
					if (!decision.authenticated && decision.authentication !== "pairing-required") {
						ws.close(1008, "remote authentication denied");
						return;
					}
					this.#remoteDecisions.set(ws, decision);
				}
				this.#hello.add(ws);
				await this.hello(ws, frame, decision);
				return;
			}
			if (frame.type === "pair.start") {
				if (!this.#hello.has(ws) || !ws.remote) throw new Error("pairing requires remote hello");
				const connection = this.#remoteConnections.get(ws);
				if (!connection || !this.#remotePolicy?.pairStart) throw new Error("pairing unavailable");
				const result = await this.#remotePolicy.pairStart(connection, frame);
				if (!result) {
					await this.#sendFrame(ws, {
						v: "omp-app/1",
						type: "pair.error",
						code: "pairing_denied",
						message: "pairing denied",
						requestId: frame.requestId,
					});
					return;
				}
				await this.#sendFrame(ws, result);
				return;
			}
			if (!this.#hello.has(ws)) throw new Error("hello required before commands");
			if (ws.remote) {
				const connection = this.#remoteConnections.get(ws);
				if (!connection || !this.#remotePolicy) throw new Error("remote connection is unavailable");
				const remoteProjection =
					frame.type === "command" &&
					COMMAND_DESCRIPTORS[frame.command]?.scope === "session" &&
					frame.sessionId !== undefined
						? this.#projections.get(frame.sessionId)
						: undefined;
				const allowed = await this.#remotePolicy.authorize(connection, frame, {
					connectionId: ws.connectionId,
					peer: connection.peer,
					...(frame.type === "command" ? { command: frame } : {}),
					...(remoteProjection ? { sessionRevision: remoteProjection.value.revision } : {}),
				});
				if (!allowed) {
					if (!this.#remotePolicy.isClosed?.(connection)) ws.close(1008, "remote policy denied");
					return;
				}
			}
			if (ws.remote && frame.type === "command") {
				const connection = this.#remoteConnections.get(ws);
				const handled =
					connection && this.#remotePolicy?.handleCommand
						? await this.#remotePolicy.handleCommand(connection, frame)
						: undefined;
				if (handled) {
					await this.#sendFrame(ws, handled);
					return;
				}
			}
			if (frame.type === "ping") {
				await this.#sendFrame(ws, {
					v: "omp-app/1",
					type: "pong",
					nonce: frame.nonce,
					timestamp: this.#clock.now().toISOString(),
				});
				return;
			}
			if (frame.type === "confirm") {
				await this.#sendFrame(ws, (await this.confirm(ws, frame)).frame);
				return;
			}
			if (frame.type === "terminal.input" || frame.type === "terminal.resize" || frame.type === "terminal.close") {
				if (!this.#operations) {
					await this.#sendFrame(ws, {
						v: "omp-app/1",
						type: "error",
						code: "unsupported",
						message: "terminal operations are unsupported",
					});
					return;
				}
				const session = this.#projections.get(frame.sessionId);
				if (this.sessionArchived(frame.sessionId) && frame.type !== "terminal.close") {
					await this.#sendFrame(ws, {
						v: "omp-app/1",
						type: "error",
						code: "SESSION_ARCHIVED",
						message: "archived sessions are read-only",
					});
					return;
				}
				if (!this.beginSessionOperation(frame.sessionId)) {
					await this.#sendFrame(ws, {
						v: "omp-app/1",
						type: "error",
						code: "SESSION_BUSY",
						message: "session lifecycle mutation is in progress",
					});
					return;
				}
				const controller = new AbortController();
				this.#abortControllers.get(ws)?.add(controller);
				try {
					await this.#operations.routeTerminal(frame, {
						hostId: this.hostId,
						sessionId: frame.sessionId,
						deviceId: ws.deviceId,
						connectionId: ws.connectionId,
						capabilities: (this.#clientCapabilities.get(ws) ?? new Set()) as OperationContext["capabilities"],
						currentRevision: session?.value.revision,
						abortSignal: controller.signal,
					});
				} catch (error) {
					const rawCode =
						error && typeof error === "object" && "code" in error && typeof error.code === "string"
							? error.code.toUpperCase()
							: "OPERATION_FAILED";
					const code = new Set([
						"FORBIDDEN",
						"NOT_FOUND",
						"STALE_REVISION",
						"UNSUPPORTED",
						"ABORTED",
						"CONFLICT",
						"OPERATION_FAILED",
					]).has(rawCode)
						? rawCode
						: "OPERATION_FAILED";
					await this.#sendFrame(ws, { v: "omp-app/1", type: "error", code, message: "terminal operation failed" });
				} finally {
					this.#abortControllers.get(ws)?.delete(controller);
					this.endSessionOperation(frame.sessionId);
				}
				return;
			}
			if (frame.type !== "command") {
				await this.#sendFrame(ws, {
					v: "omp-app/1",
					type: "error",
					code: "unsupported",
					message: "frame is not supported",
				});
				return;
			}
			const descriptor = COMMAND_DESCRIPTORS[frame.command];
			if (descriptor?.confirmation === "challenge") {
				if (frame.confirmationId !== undefined) {
					await this.#sendFrame(
						ws,
						response(this.hostId, frame, false, undefined, {
							code: "confirmation_invalid",
							message: "command confirmation must be approved through a confirm frame",
						}),
					);
					return;
				}
				if (frame.command === "session.delete") {
					const failure = await this.deletePreflight(frame);
					if (failure) {
						await this.#sendFrame(ws, response(this.hostId, frame, false, undefined, failure));
						return;
					}
				}
				await this.#sendFrame(ws, this.challenge(ws, frame));
				return;
			}
			const outcome = await this.#command(frame, ws);
			const outputFrames = [outcome.frame];
			if (
				frame.command === "session.attach" &&
				frame.sessionId &&
				outcome.frame.type === "response" &&
				outcome.frame.ok
			) {
				const attached = this.#attached.get(ws);
				const projection = this.#projections.get(frame.sessionId);
				if (!attached || !projection) throw new Error("attach output is incomplete");
				const cursor = frame.args.cursor;
				const prepared =
					outcome.attachOutput ??
					prepareAttachOutput(projection, cursor === undefined ? undefined : decodeCursor(cursor));
				// A replayed command outcome carries the baseline from its first
				// delivery, while its bulk attach output is deliberately rebuilt.
				// Keep the acknowledgement cursor aligned with the freshly prepared
				// snapshot/replay that immediately follows it.
				outputFrames[0] = response(this.hostId, frame, true, {
					attached: true,
					cursor: prepared.baseline,
				});
				attached.add(frame.sessionId);
				try {
					outputFrames.push(...completeAttachOutput(prepared, projection, this.#subagents.get(frame.sessionId)));
					if (this.#clientFeatures.get(ws)?.has("agent.transcript"))
						outputFrames.push(...(this.#agentTranscripts.get(frame.sessionId)?.frames() ?? []));
				} catch (error) {
					attached.delete(frame.sessionId);
					throw error;
				}
			}
			await Promise.all(outputFrames.map(output => this.#sendFrame(ws, output)));
		} catch {
			if (ws.remote) {
				ws.close(1008, "invalid frame");
				return;
			}
			await this.#sendFrame(ws, { v: "omp-app/1", type: "error", code: "invalid_frame", message: "invalid frame" });
			ws.close(1008, "invalid frame");
		} finally {
			this.#inflightMessages -= 1;
		}
	}
	private challenge(ws: AppWs, command: CommandFrame): ConfirmationChallenge {
		const hash = createHash("sha256")
			.update(JSON.stringify({ ...command, confirmationId: undefined }))
			.digest("hex");
		const confirmationId = randomUUID() as never;
		const expiresAt = Date.now() + 60_000;
		this.#challenges.set(String(confirmationId), { command, ws, expiresAt, hash });
		return {
			v: "omp-app/1",
			type: "confirmation",
			confirmationId,
			commandId: command.commandId,
			hostId: this.hostId,
			sessionId: command.sessionId,
			commandHash: hash,
			revision: (command.expectedRevision ??
				this.#projections.get(command.sessionId!)?.value.revision ??
				"host") as never,
			expiresAt: new Date(expiresAt).toISOString(),
			summary: command.command,
		};
	}
	private async confirm(ws: AppWs, frame: ConfirmFrame): Promise<CommandOutcome> {
		const pending = this.#challenges.get(String(frame.confirmationId));
		if (
			!pending ||
			pending.ws !== ws ||
			pending.expiresAt < Date.now() ||
			pending.command.commandId !== frame.commandId ||
			pending.command.hostId !== frame.hostId ||
			pending.command.sessionId !== frame.sessionId
		)
			return {
				frame: response(
					this.hostId,
					{
						...(pending?.command ?? frame),
						requestId: frame.requestId,
						commandId: frame.commandId,
						hostId: this.hostId,
					} as CommandFrame,
					false,
					undefined,
					{ code: "confirmation_invalid", message: "confirmation is invalid or expired" },
				),
			};
		this.#challenges.delete(String(frame.confirmationId));
		if (frame.decision === "deny")
			return {
				frame: response(this.hostId, pending.command, false, undefined, {
					code: "confirmation_denied",
					message: "command was denied",
				}),
			};
		return this.#command({ ...pending.command, confirmationId: frame.confirmationId }, ws, true);
	}
	private async disconnectClient(ws: AppWs): Promise<void> {
		if (!this.#clients.has(ws)) return;
		const controllers = this.#abortControllers.get(ws);
		for (const controller of controllers ?? []) controller.abort();
		if (this.#operations) {
			const contextBase = {
				hostId: this.hostId,
				deviceId: ws.deviceId,
				capabilities: (this.#clientCapabilities.get(ws) ?? new Set()) as OperationContext["capabilities"],
				abortSignal: AbortSignal.abort(),
			};
			try {
				await this.#operations.disconnectConnection(ws.connectionId, contextBase);
			} catch {
				/* owner cleanup is best effort; registry always releases */
			}
		}
		await this.#imageUploads.cleanupConnection(ws.connectionId);
		this.#clients.delete(ws);
		this.#hello.delete(ws);
		this.#clientCapabilities.delete(ws);
		this.#clientFeatures.delete(ws);
		this.#attached.delete(ws);
		this.#deviceIds.delete(ws);
		this.#abortControllers.delete(ws);
		this.#remoteDecisions.delete(ws);
		this.#remoteConnections.delete(ws);
		this.#remoteTransports.delete(ws.connectionId);
		this.#connectionIdempotency.delete(ws);
		for (const [confirmationId, pending] of this.#challenges)
			if (pending.ws === ws) this.#challenges.delete(confirmationId);
		for (const [socket, transport] of this.#localTransports)
			if (transport === ws) this.#localTransports.delete(socket);
	}
	private async hello(ws: AppWs, frame: HelloFrame, decision?: RemoteHelloDecision): Promise<void> {
		if (!ws.remote && frame.authentication !== undefined)
			throw new Error("device authentication is not accepted on local transport");
		const capabilityCeiling = decision?.grantedCapabilities
			? new Set(decision.grantedCapabilities)
			: this.#supportedCapabilities;
		const requestedCapabilities = new Set(frame.capabilities?.client ?? this.#supportedCapabilities);
		const grantedCapabilities = [...this.#supportedCapabilities].filter(
			capability => requestedCapabilities.has(capability) && capabilityCeiling.has(capability),
		);
		const supportedFeatures = ws.remote ? this.#remoteSupportedFeatures : this.#supportedFeatures;
		const featureCeiling = decision?.grantedFeatures ? new Set(decision.grantedFeatures) : supportedFeatures;
		const grantedFeatures = frame.requestedFeatures.filter(
			feature => supportedFeatures.has(feature) && featureCeiling.has(feature),
		);
		this.#clientCapabilities.set(ws, new Set(grantedCapabilities));
		this.#clientFeatures.set(ws, new Set(grantedFeatures));
		const welcome = {
			v: "omp-app/1",
			type: "welcome",
			selectedProtocol: "omp-app/1",
			hostId: this.hostId,
			ompVersion: this.#ompVersion,
			ompBuild: this.#ompBuild,
			appserverVersion: this.#appserverVersion,
			appserverBuild: this.#appserverBuild,
			epoch: this.epoch,
			grantedCapabilities,
			grantedFeatures,
			negotiatedLimits: { maxPayloadLength: 1024 * 1024, ringSize: this.#ringSize },
			authentication: decision?.authentication ?? (ws.remote ? "remote" : "local"),
			resumed: frame.savedCursors.some(
				cursor => cursor.hostId === this.hostId && cursor.cursor.epoch === this.epoch,
			),
		};
		await this.#sendFrame(ws, welcome as ServerFrame);
		if (decision?.authentication === "pairing-required") return;
		await this.#sendFrame(ws, this.sessionsFrame());
	}
	#createLocalTransport(ws: LocalWs): AppWs {
		let closed = false;
		const transport: AppWs = {
			connectionId: randomUUID(),
			deviceId: randomUUID(),
			remote: false,
			send: text => {
				if (closed) return false;
				try {
					const result = ws.send(text);
					return typeof result === "number" ? result > 0 : true;
				} catch {
					return false;
				}
			},
			close: (code, reason) => {
				if (closed) return;
				closed = true;
				try {
					ws.close(code, reason);
				} catch {}
			},
		};
		return transport;
	}
	#remoteConnected(connection: RemoteConnection): void {
		if (this.#draining || this.#stopping) {
			connection.socket.close(1012, "appserver maintenance");
			return;
		}
		let closed = false;
		const transport: AppWs = {
			connectionId: connection.connectionId,
			deviceId: connection.peer.identity.nodeId,
			remote: true,
			send: text => connection.socket.send(text),
			close: (code, reason) => {
				if (closed) return;
				closed = true;
				connection.socket.close(code, reason);
			},
		};
		this.#remoteConnections.set(transport, connection);
		this.#remoteTransports.set(transport.connectionId, transport);
		this.#clients.add(transport);
		this.#clientCapabilities.set(transport, new Set());
		this.#clientFeatures.set(transport, new Set());
		this.#attached.set(transport, new Set());
		this.#deviceIds.set(transport, transport.deviceId);
		this.#abortControllers.set(transport, new Set());
		this.#connectionIdempotency.set(transport, new IdempotencyStore());
	}
	async #remoteMessage(connection: RemoteConnection, message: string | Uint8Array): Promise<void> {
		const transport = this.#remoteTransports.get(connection.connectionId);
		if (transport) await this.message(transport, typeof message === "string" ? message : new Uint8Array(message));
	}
	async #remoteDisconnected(connection: RemoteConnection): Promise<void> {
		this.#inflightLifecycleMutations += 1;
		try {
			const transport = this.#remoteTransports.get(connection.connectionId);
			if (transport) await this.disconnectClient(transport);
			if (this.#remotePolicy?.disconnected) await this.#remotePolicy.disconnected(connection);
		} finally {
			this.#inflightLifecycleMutations -= 1;
		}
	}
	async #sendFrame(transport: AppWs, frame: ServerFrame): Promise<boolean> {
		const previous = this.#outboundTails.get(transport) ?? Promise.resolve();
		const send = previous.then(() => this.#sendFrameNow(transport, frame));
		const tail = send.then(
			() => undefined,
			() => undefined,
		);
		this.#outboundTails.set(transport, tail);
		try {
			return await send;
		} finally {
			if (this.#outboundTails.get(transport) === tail) this.#outboundTails.delete(transport);
		}
	}
	async #sendFrameNow(transport: AppWs, frame: ServerFrame): Promise<boolean> {
		if (transport.remote) {
			const connection = this.#remoteConnections.get(transport);
			if (!connection || !this.#remotePolicy) return false;
			let transformed: ServerFrame | string | undefined;
			try {
				transformed = this.#remotePolicy.transformOutbound
					? await boundedRemoteTransform(this.#remotePolicy.transformOutbound(connection, frame))
					: frame;
			} catch {
				connection.socket.close(1011, "remote policy failed");
				return false;
			}
			if (transformed === undefined) return false;
			return transport.send(typeof transformed === "string" ? transformed : JSON.stringify(transformed));
		}
		return transport.send(JSON.stringify(frame));
	}
	private async loadSessions(): Promise<void> {
		const records = await this.#discovery.list();
		records.sort(compareSessionRecords);
		for (const record of records) {
			if (this.#records.has(record.sessionId)) throw new Error(`duplicate session id: ${record.sessionId}`);
			this.#records.set(record.sessionId, record);
			this.#projections.set(
				record.sessionId,
				new SessionProjection(this.hostId, record, this.epoch, this.#ringSize),
			);
		}
	}
	private async refreshSessions(): Promise<void> {
		const discovered = await this.#discovery.list();
		const discoveredIds = new Set(discovered.map(record => record.sessionId));
		for (const record of discovered) {
			this.#records.set(record.sessionId, record);
			this.#createdPending.delete(record.sessionId);
			const projection = this.#projections.get(record.sessionId);
			if (!projection) {
				const inserted = new SessionProjection(this.hostId, record, this.epoch, this.#ringSize);
				this.#projections.set(record.sessionId, inserted);
				await this.broadcastIndex(inserted.indexUpsert());
			} else {
				const output = projection.reconcileRecord(record);
				if (output) await this.broadcastIndex(output);
			}
		}
		for (const [sessionId, pending] of this.#createdPending) {
			if (discoveredIds.has(sessionId)) {
				this.#createdPending.delete(sessionId);
				continue;
			}
			if (pending.refreshesRemaining > 0) pending.refreshesRemaining -= 1;
			else {
				this.#createdPending.delete(sessionId);
				const projection = this.#projections.get(sessionId);
				if (projection) await this.broadcastIndex(projection.remove());
				await this.#imageUploads.cleanupSession(sessionId);
				this.#records.delete(sessionId);
				this.#projections.delete(sessionId);
				this.#stateRefreshGenerations.delete(sessionId);
			}
		}
		for (const sessionId of [...this.#records.keys()]) {
			if (discoveredIds.has(sessionId) || this.#createdPending.has(sessionId)) continue;
			if (this.#lifecycleMutations.has(sessionId)) continue;
			this.#lifecycleMutations.add(sessionId);
			try {
				if (!(await this.quiesceSessionRuntime(sessionId))) continue;
				const projection = this.#projections.get(sessionId);
				if (projection) await this.broadcastIndex(projection.remove());
				await this.#imageUploads.cleanupSession(sessionId);
				this.#records.delete(sessionId);
				this.#projections.delete(sessionId);
				this.#closedSessions.delete(sessionId);
				this.#releaseAllMessageLifecycles(sessionId, "completed-without-entry");
				this.#stateRefreshGenerations.delete(sessionId);
				this.#transcripts.delete(sessionId);
				this.disposeSubagentState(sessionId);
				for (const sessions of this.#attached.values()) sessions.delete(sessionId);
			} finally {
				this.#lifecycleMutations.delete(sessionId);
			}
		}
	}
	private sessionListResult(): { sessions: SessionRef[]; totalCount: number; truncated: boolean } {
		const allSessions = [...this.#projections.values()].map(value => value.value.ref);
		allSessions.sort((a, b) => {
			if (a.updatedAt < b.updatedAt) return 1;
			if (a.updatedAt > b.updatedAt) return -1;
			if (a.sessionId < b.sessionId) return -1;
			if (a.sessionId > b.sessionId) return 1;
			return 0;
		});
		const totalCount = allSessions.length;
		const pendingBudget: SessionListBudget = { pendingBytes: 0, pendingEntries: 0 };
		const sessions: SessionRef[] = [];
		let refsBytes = 2; // JSON array brackets
		let refNodes = 1; // JSON array node
		for (const current of allSessions.slice(0, 1000)) {
			const ref = projectSessionListPendingPrompts(current, pendingBudget);
			const separatorBytes = sessions.length === 0 ? 0 : 1;
			const bytes = encodedJsonBytes(ref) + separatorBytes;
			const nodes = jsonNodeCount(ref, SESSION_LIST_REF_NODES - refNodes);
			if (refsBytes + bytes > SESSION_LIST_REFS_BYTES || refNodes + nodes > SESSION_LIST_REF_NODES) break;
			sessions.push(ref);
			refsBytes += bytes;
			refNodes += nodes;
		}
		return { sessions, totalCount, truncated: totalCount > sessions.length };
	}
	private sessionsFrame(): ServerFrame {
		return {
			v: "omp-app/1",
			type: "sessions",
			hostId: this.hostId,
			cursor: { epoch: this.epoch, seq: 0 },
			...this.sessionListResult(),
		};
	}
	private broadcast(sessionId: SessionId, frame: ServerFrame): void {
		if (frame.type === "session.delta") {
			void this.broadcastIndex(frame);
			return;
		}
		for (const [client, sessions] of this.#attached) {
			if (!sessions.has(sessionId)) continue;
			if (frame.type === "agent.transcript" && !this.#clientFeatures.get(client)?.has("agent.transcript")) continue;
			void this.#sendFrame(client, frame);
		}
	}
	private async broadcastAttachedOrdered(sessionId: SessionId, frame: ServerFrame): Promise<void> {
		for (const [client, sessions] of this.#attached)
			if (sessions.has(sessionId)) await this.#sendFrame(client, frame);
	}
	private async broadcastIndex(frame: ServerFrame): Promise<void> {
		const sends: Array<Promise<boolean>> = [];
		for (const client of this.#clients) {
			if (!this.#hello.has(client) || !this.#clientCapabilities.get(client)?.has("sessions.read")) continue;
			sends.push(this.#sendFrame(client, frame));
		}
		await Promise.all(sends);
	}
	#emptyDrainBusy(): AppserverDrainBusy {
		return {
			connections: 0,
			inflightMessages: 0,
			startingSupervisors: 0,
			lifecycleMutations: 0,
			sessionOperations: 0,
			activePrompts: 0,
			rpcSupervisorsWithPendingCalls: 0,
			busySessions: 0,
			openTerminalSessions: 0,
			pendingConfirmations: 0,
			outboundSends: 0,
		};
	}
	#drainBusy(): AppserverDrainBusy {
		const now = Date.now();
		for (const [confirmationId, pending] of this.#challenges)
			if (pending.expiresAt < now || !this.#clients.has(pending.ws)) this.#challenges.delete(confirmationId);
		let sessionOperations = 0;
		for (const count of this.#inflightSessionOperations.values()) sessionOperations += count;
		let rpcSupervisorsWithPendingCalls = 0;
		for (const supervisor of this.#supervisors.values())
			if (supervisor.hasPendingCalls()) rpcSupervisorsWithPendingCalls += 1;
		let busySessions = 0;
		let openTerminalSessions = 0;
		for (const sessionId of this.#records.keys()) {
			if (this.sessionLifecycleBusy(sessionId)) busySessions += 1;
			if (this.#operations?.hasOpenTerminals(sessionId)) openTerminalSessions += 1;
		}
		return {
			connections: this.#clients.size,
			inflightMessages: this.#inflightMessages,
			startingSupervisors: this.#startPromises.size,
			lifecycleMutations: this.#lifecycleMutations.size + this.#inflightLifecycleMutations,
			sessionOperations,
			activePrompts: [...this.#messageLifecycles.values()].reduce(
				(count, lifecycles) => count + lifecycles.length,
				0,
			),
			rpcSupervisorsWithPendingCalls,
			busySessions,
			openTerminalSessions,
			pendingConfirmations: this.#challenges.size,
			outboundSends: this.#outboundTails.size,
		};
	}
	#tryDrainIfIdle(expectedHostId: string, expectedEpoch: string): AppserverDrainResult {
		const health = { ok: true as const, hostId: this.hostId, epoch: this.epoch };
		if (expectedHostId !== this.hostId || expectedEpoch !== this.epoch)
			return { state: "identity_mismatch", health, busy: this.#drainBusy() };
		if (this.#draining) return { state: "draining", health, busy: this.#emptyDrainBusy() };
		this.#draining = true;
		const busy = this.#drainBusy();
		if (Object.values(busy).some(count => count > 0)) {
			this.#draining = false;
			return { state: "busy", health, busy };
		}
		return { state: "draining", health, busy };
	}
	private async fetch(request: Request, server: Bun.Server<ServerWebSocketData>): Promise<Response | undefined> {
		const url = new URL(request.url);
		if (url.pathname === "/health" && request.method === "GET")
			return Response.json({ ok: true, hostId: this.hostId, epoch: this.epoch, draining: this.#draining });
		if (url.pathname === "/admin/drain-if-idle") return this.#adminDrainIfIdle(request);
		if (url.pathname === "/admin/pair-ticket") return this.adminPairTicket(request);
		if (url.pathname === "/admin/devices") return this.adminDevices(request);
		if (url.pathname === "/admin/revoke") return this.adminRevoke(request);
		if (
			url.pathname !== "/ws" ||
			request.method !== "GET" ||
			request.headers.get("upgrade")?.toLowerCase() !== "websocket"
		)
			return new Response("Not Found", { status: 404 });
		if (this.#draining || this.#stopping) return new Response("Service Unavailable", { status: 503 });
		if (server.upgrade(request, { data: { socket: {} } })) return undefined;
		return new Response("Upgrade Required", { status: 426 });
	}
	private adminError(status = 400): Response {
		return Response.json({ error: "invalid admin request" }, { status });
	}
	private async adminJson(request: Request, keys: readonly string[]): Promise<Record<string, unknown> | Response> {
		if (request.method !== "POST" || request.headers.get("content-type") !== "application/json")
			return this.adminError(405);
		const length = request.headers.get("content-length");
		if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 16_384)) return this.adminError(413);
		let bytes: ArrayBuffer;
		try {
			bytes = await request.arrayBuffer();
		} catch {
			return this.adminError();
		}
		if (bytes.byteLength > 16_384) return this.adminError(413);
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			return this.adminError();
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) return this.adminError();
		const body = value as Record<string, unknown>;
		if (Object.keys(body).some(key => !keys.includes(key))) return this.adminError();
		return body;
	}
	async #adminDrainIfIdle(request: Request): Promise<Response> {
		if (this.#stopping) return this.adminError(503);
		const body = await this.adminJson(request, ["expectedHostId", "expectedEpoch"]);
		if (body instanceof Response) return body;
		if (this.#stopping) return this.adminError(503);
		if (
			typeof body.expectedHostId !== "string" ||
			body.expectedHostId.length === 0 ||
			body.expectedHostId.length > 1024 ||
			typeof body.expectedEpoch !== "string" ||
			body.expectedEpoch.length === 0 ||
			body.expectedEpoch.length > 1024
		)
			return this.adminError();
		return Response.json(this.#tryDrainIfIdle(body.expectedHostId, body.expectedEpoch));
	}
	private async adminPairTicket(request: Request): Promise<Response> {
		if (!this.#admin || request.method !== "POST") return this.adminError(404);
		if (this.#draining || this.#stopping) return this.adminError(503);
		this.#inflightLifecycleMutations += 1;
		try {
			const body = await this.adminJson(request, ["capabilities", "ttlMs", "expectedNodeId"]);
			if (body instanceof Response) return body;
			if (this.#draining || this.#stopping) return this.adminError(503);
			const capabilities = body.capabilities;
			if (
				!Array.isArray(capabilities) ||
				capabilities.length === 0 ||
				capabilities.length > 32 ||
				capabilities.some(value => typeof value !== "string" || value.length === 0 || value.length > 128)
			)
				return this.adminError();
			const ttl = body.ttlMs;
			if (ttl !== undefined && (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 600_000))
				return this.adminError();
			const nodeId = body.expectedNodeId;
			if (nodeId !== undefined && (typeof nodeId !== "string" || nodeId.length === 0 || nodeId.length > 512))
				return this.adminError();
			try {
				return Response.json(this.#admin.issuePairingTicket(capabilities, ttl, nodeId));
			} catch {
				return this.adminError();
			}
		} finally {
			this.#inflightLifecycleMutations -= 1;
		}
	}
	private adminDevices(request: Request): Response {
		if (!this.#admin || request.method !== "GET") return this.adminError(404);
		try {
			return Response.json({ devices: this.#admin.listDevices() });
		} catch {
			return this.adminError(500);
		}
	}
	private async adminRevoke(request: Request): Promise<Response> {
		if (!this.#admin || request.method !== "POST") return this.adminError(404);
		if (this.#draining || this.#stopping) return this.adminError(503);
		this.#inflightLifecycleMutations += 1;
		try {
			const body = await this.adminJson(request, ["deviceId"]);
			if (body instanceof Response) return body;
			if (this.#draining || this.#stopping) return this.adminError(503);
			if (typeof body.deviceId !== "string" || body.deviceId.length === 0 || body.deviceId.length > 512)
				return this.adminError();
			try {
				return Response.json(this.#admin.revokeDevice(body.deviceId));
			} catch {
				return this.adminError();
			}
		} finally {
			this.#inflightLifecycleMutations -= 1;
		}
	}
}
interface ServerWebSocketData {
	socket: Record<string, never>;
}
export function createAppserver(options: AppserverOptions = {}): LocalAppserver {
	return new LocalAppserver(options);
}
