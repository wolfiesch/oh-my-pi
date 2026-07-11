import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { chmod, stat as fsStat, lstat, open, readlink, rename, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
	COMMAND_DESCRIPTORS,
	type CommandFrame,
	type ConfirmationChallenge,
	type ConfirmFrame,
	type DurableEntry,
	decodeClientFrame,
	decodeCursor,
	type HelloFrame,
	type HostId,
	parseBounded,
	projectId,
	type ResultFrame,
	requiredCapability,
	type ServerFrame,
	type SessionId,
	utf8ByteLength,
} from "@oh-my-pi/app-wire";
import { AppserverCommandHandlers } from "./command-handler.ts";
import { stableProjectId } from "./discovery.ts";
import { IdempotencyStore } from "./idempotency.ts";
import { createEpoch, createHostId, defaultSocketPath, loadPersistentHostId, unixSocketActive } from "./identity.ts";
import {
	DesktopOperationDispatcher,
	commandFeature,
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
import { BunRpcChildFactory, RpcChildSupervisor } from "./rpc-child.ts";
import type {
	AppserverHandle,
	AppserverOptions,
	ChildHandle,
	Clock,
	CommandOutcome,
	ConnectionTransport,
	LockCheckHook,
	RemoteAuthorizationContext,
	RemoteConnectionPolicy,
	RemoteHelloDecision,
	RpcChildFactory,
	SessionAuthority,
	SessionDiscovery,
	SessionRecord,
} from "./types.ts";
import { BunRemoteListener, createListenerPlan, createServeProxyPlan } from "./remote/listener.ts";
import type { RemoteConnection, RemoteListenerConfig } from "./remote/types.ts";

const clock: Clock = { now: () => new Date() };
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
function fromRpcEntry(raw: Record<string, unknown>, host: HostId, session: SessionId): DurableEntry {
	if (
		typeof raw.id !== "string" ||
		typeof raw.type !== "string" ||
		!raw.type ||
		(raw.parentId !== null && typeof raw.parentId !== "string") ||
		typeof raw.timestamp !== "string" ||
		!Number.isFinite(Date.parse(raw.timestamp))
	)
		throw new Error("malformed rpc session entry");
	return {
		id: raw.id as DurableEntry["id"],
		parentId: raw.parentId as DurableEntry["parentId"],
		hostId: host,
		sessionId: session,
		kind: raw.type,
		timestamp: raw.timestamp,
		data: Object.fromEntries(
			Object.entries(raw).filter(([key]) => !["id", "parentId", "type", "timestamp"].includes(key)),
		),
	};
}
function argumentError(command: CommandFrame): string | undefined {
	const args = command.args;
	if (!args || typeof args !== "object" || Array.isArray(args)) return "args must be an object";
	const keys = Object.keys(args);
	if (command.command === "session.prompt") {
		if (
			keys.length !== 1 ||
			keys[0] !== "message" ||
			typeof args.message !== "string" ||
			args.message.length === 0 ||
			utf8ByteLength(args.message) > 65_536
		)
			return "prompt message must be a bounded non-empty UTF-8 string";
		return undefined;
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
	// authority. Do not reject their non-empty payloads here.
	if (
		command.command !== "host.list" &&
		command.command !== "session.list" &&
		command.command !== "session.cancel" &&
		command.command !== "session.close"
	)
		return undefined;
	if (keys.length !== 0) return "command does not accept args";
	return undefined;
}
type AppWs = ConnectionTransport;
type LocalWs = Bun.ServerWebSocket<ServerWebSocketData>;
interface RunIdentity {
	paths: OwnerPaths;
	record: OwnerRecord;
	marker: { device: number; inode: number };
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
export function appserverSupportedFeatures(options: Pick<AppserverOptions, "operationsAuthority" | "supportedFeatures"> & { readonly remotePolicy?: AppserverOptions["remotePolicy"] }, includeRemotePolicy = false): string[] {
	const unsupportedAdditiveFeatures = new Set(["host.watch", "session.watch", "prompt.lease"]);
	const implementedFeatures = new Set<string>(["resume"]);
	if (includeRemotePolicy || options.remotePolicy) implementedFeatures.add("controller.lease");
	const authority = options.operationsAuthority;
	if (authority?.catalogGet) implementedFeatures.add("catalog.metadata");
	if (authority?.settingsRead) implementedFeatures.add("settings.metadata");
	if (authority?.termOpen && authority.terminalInput && authority.terminalResize && authority.terminalClose) implementedFeatures.add("terminal.io");
	if (authority?.filesList) implementedFeatures.add("files.list");
	if (authority?.filesDiff) implementedFeatures.add("files.diff");
	if (authority?.previewLaunch && authority.previewState && authority.previewNavigate && authority.previewCapture) implementedFeatures.add("preview.control");
	return [...(options.supportedFeatures ?? implementedFeatures)].filter(feature => implementedFeatures.has(feature) && !unsupportedAdditiveFeatures.has(feature));
}
export function appserverSupportedCapabilities(options: Pick<AppserverOptions, "operationsAuthority" | "supportedCapabilities">): string[] {
	const implemented = new Set(["sessions.read", "sessions.manage", "sessions.prompt", "sessions.control", ...operationCapabilities(options.operationsAuthority)]);
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
	#factory: RpcChildFactory;
	#lockCheck: LockCheckHook;
	#ringSize: number;
	#handlers = new AppserverCommandHandlers();
	#challenges = new Map<string, { command: CommandFrame; ws: AppWs; expiresAt: number; hash: string }>();
	#records = new Map<SessionId, SessionRecord>();
	#createdPending = new Map<SessionId, { record: SessionRecord; refreshesRemaining: number }>();
	#projections = new Map<SessionId, SessionProjection>();
	#supervisors = new Map<SessionId, RpcChildSupervisor>();
	#startPromises = new Map<SessionId, Promise<RpcChildSupervisor>>();
	#closedSessions = new Set<SessionId>();
	#idempotency = new IdempotencyStore();
	#server?: Bun.Server<ServerWebSocketData>;
	#clients = new Set<AppWs>();
	#hello = new Set<AppWs>();
	#clientCapabilities = new Map<AppWs, Set<string>>();
	#attached = new Map<AppWs, Set<SessionId>>();
	#deviceIds = new Map<AppWs, string>();
	#abortControllers = new Map<AppWs, Set<AbortController>>();
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
	#supportedCapabilities: Set<string>;
	#projectRootForProject?: AppserverOptions["projectRootForProject"];
	constructor(options: AppserverOptions = {}) {
		this.#hostProvided = Boolean(options.hostId);
		this.hostId = options.hostId ?? createHostId();
		this.epoch = createEpoch(options.epoch);
		this.socketPath = options.socketPath ?? defaultSocketPath();
		this.#remotePolicy = options.remotePolicy;
		this.#remoteEndpoint = options.remoteEndpoint;
		this.#remoteResolver = options.remoteResolver;
		this.#admin = options.admin;
		this.#remoteListener = options.remoteListener;
		this.#clock = options.clock ?? clock;
		this.#authority = options.sessionAuthority;
		this.#operations = options.operationsAuthority
			? new DesktopOperationDispatcher(options.operationsAuthority, undefined, (frame, owner) => {
					for (const ws of this.#clients)
						if (ws.connectionId === owner.connectionId && ws.deviceId === owner.deviceId) void this.#sendFrame(ws, frame as ServerFrame);
				})
			: undefined;
		this.#projectRootForProject = options.projectRootForProject;
		this.#discovery = options.discovery ?? options.sessionAuthority ?? { list: async () => [] };
		this.#factory = options.childFactory ?? new BunRpcChildFactory();
		this.#lockCheck = options.lockCheck ?? (() => undefined);
		this.#ringSize = options.ringSize ?? 256;
		this.#ompVersion = options.ompVersion ?? "local";
		this.#ompBuild = options.ompBuild ?? "local";
		this.#appserverVersion = options.appserverVersion ?? "0.1.0";
		this.#appserverBuild = options.appserverBuild ?? "local";
		this.#supportedFeatures = new Set(appserverSupportedFeatures(options));
		const requested = appserverSupportedCapabilities(options);
		const implemented = new Set(["sessions.read", "sessions.manage", "sessions.prompt", "sessions.control", ...operationCapabilities(options.operationsAuthority)]);
		if (requested.some(capability => !implemented.has(capability)))
			throw new Error("unsupported capability has no handler");
		this.#supportedCapabilities = new Set(requested);
		this.#handlers.register("session.create", command => this.handleCreate(command));
		this.#handlers.register("session.close", command => this.handleClose(command));
	}
	async start(): Promise<void> {
		if (this.#started) return;
		this.#stopping = false;
		this.#closedSessions.clear();
		if (!this.#hostProvided) this.hostId = await loadPersistentHostId();
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
			await this.preparePublic(paths);
			this.#server = Bun.serve<ServerWebSocketData>({
				unix: paths.backingPath,
				fetch: (request, server) => this.fetch(request, server),
				websocket: {
					maxPayloadLength: 1024 * 1024,
					backpressureLimit: 1024 * 1024,
					closeOnBackpressureLimit: true,
					open: ws => {
						const transport = this.#createLocalTransport(ws);
						this.#localTransports.set(ws, transport);
						this.#clients.add(transport);
						this.#clientCapabilities.set(transport, new Set());
						this.#attached.set(transport, new Set());
						this.#deviceIds.set(transport, transport.deviceId);
						this.#abortControllers.set(transport, new Set());
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
			await this.cleanupPartial();
			throw error;
		}
	}
	async stop(): Promise<void> {
		if (!this.#started && !this.#server && !this.#ownerLock && this.#startPromises.size === 0) return;
		this.#stopping = true;
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
		const requiredFeature = commandFeature(command.command);
		if (requiredFeature)
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
		const check = this.#idempotency.begin(command.commandId, command);
		if (check.kind === "replay")
			return {
				frame: { ...check.outcome.frame, requestId: command.requestId } as ServerFrame,
				unknown: check.outcome.unknown,
			};
		if (check.kind === "pending") {
			const outcome = await check.outcome;
			return { frame: { ...outcome.frame, requestId: command.requestId } as ServerFrame, unknown: outcome.unknown };
		}
		if (check.kind === "conflict")
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "idempotency_conflict",
					message: "commandId was already used with another payload",
				}),
			};
		const invalidArgs = argumentError(command);
		if (invalidArgs)
			return this.finish(command, {
				frame: response(this.hostId, command, false, undefined, { code: "invalid_frame", message: invalidArgs }),
			});
		if (descriptor.revision === "required" && command.expectedRevision === undefined)
			return this.finish(command, {
				frame: response(this.hostId, command, false, undefined, {
					code: "stale_revision",
					message: "expectedRevision is required",
				}),
			});
		if (descriptor.revision === "none" && command.expectedRevision !== undefined)
			return this.finish(command, {
				frame: response(this.hostId, command, false, undefined, {
					code: "stale_revision",
					message: "expectedRevision is forbidden",
				}),
			});
		const projection = command.sessionId ? this.#projections.get(command.sessionId) : undefined;
		if (descriptor.scope === "session" && !projection)
			return this.finish(command, {
				frame: response(this.hostId, command, false, undefined, {
					code: "unknown_session",
					message: "session is not indexed",
				}),
			});
		if (
			descriptor.revisionOwner === "session" &&
			command.expectedRevision !== undefined &&
			projection &&
			command.expectedRevision !== projection.value.revision
		)
			return this.finish(command, {
				frame: response(this.hostId, command, false, undefined, {
					code: "stale_revision",
					message: "session revision is stale",
					details: { expectedRevision: command.expectedRevision, actualRevision: projection.value.revision },
				}),
			});
		const controller = new AbortController();
		if (ws) this.#abortControllers.get(ws)?.add(controller);
		let outcome: CommandOutcome;
		try {
			const registered = await this.#handlers.dispatch(command);
			if (registered) outcome = registered;
			else if (command.command === "host.list" || command.command === "session.list")
				outcome = {
					frame: response(this.hostId, command, true, {
						cursor: { epoch: this.epoch, seq: 0 },
						sessions: [...this.#projections.values()].map(value => value.value.ref),
					}),
				};
			else if (command.command === "session.attach")
				outcome = {
					frame: response(this.hostId, command, true, { attached: true, cursor: projection!.value.cursor }),
				};
			else if (command.command === "session.prompt") {
				if (this.#closedSessions.has(command.sessionId!)) throw new Error("session is closed");
				projection!.setStatus("active");
				const supervisor = await this.ensureSupervisor(command.sessionId!);
				const result = await supervisor.prompt(command.requestId, command.args.message as string, controller.signal);
				projection!.setStatus(result.success ? "idle" : "closed");
				outcome = {
					frame: response(
						this.hostId,
						command,
						result.success,
						{ accepted: result.success },
						result.success ? undefined : { code: "child_error", message: "session command failed" },
					),
				};
			} else if (command.command === "session.cancel") {
				const supervisor = await this.ensureSupervisor(command.sessionId!);
				const result = await supervisor.cancel(command.requestId);
				outcome = {
					frame: response(
						this.hostId,
						command,
						result.success,
						{ cancelled: result.success },
						result.success ? undefined : { code: "child_error", message: "session command failed" },
					),
				};
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
			const failedProjection =
				command.command === "session.prompt" ? this.#projections.get(command.sessionId!) : undefined;
			if (
				failedProjection &&
				failedProjection.value.ref.status === "active" &&
				!this.#closedSessions.has(command.sessionId!)
			)
				failedProjection.setStatus("idle");
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
			const code =
				operation && error && typeof error === "object" && "code" in error && typeof error.code === "string"
					? error.code
					: "outcome_unknown";
			outcome = {
				frame: response(this.hostId, command, false, undefined, {
					code,
					message: operation ? "operation failed" : "command failed",
				}),
				unknown: !operation,
			};
		} finally {
			if (ws) this.#abortControllers.get(ws)?.delete(controller);
		}
		return this.finish(command, outcome);
	}
	private async createSession(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (!this.#authority) throw new Error("session creation is unavailable");
		if (!this.#projectRootForProject) throw new Error("session project resolver is unavailable");
		const requestedProjectId = args.projectId;
		if (typeof requestedProjectId !== "string") throw new Error("session projectId is invalid");
		const requestedCwd = await this.#projectRootForProject(projectId(requestedProjectId));
		if (typeof requestedCwd !== "string" || !requestedCwd.startsWith("/"))
			throw new Error("project resolver returned an invalid local root");
		const title = typeof args.title === "string" ? args.title : undefined;
		const created = await this.#authority.create(requestedCwd, title);
		const timestamp = this.#clock.now().toISOString();
		const record: SessionRecord = {
			sessionId: created.sessionId,
			path: created.path,
			cwd: created.cwd,
			projectId: stableProjectId(created.cwd),
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
		return {
			frame: response(this.hostId, command, true, {
				session: this.#projections.get(created.sessionId as SessionId)!.value.ref,
			}),
		};
	}
	private async handleClose(command: CommandFrame): Promise<CommandOutcome> {
		const sessionId = command.sessionId!;
		const projection = this.#projections.get(sessionId)!;
		this.#closedSessions.add(sessionId);
		const pending = this.#startPromises.get(sessionId);
		if (pending) await pending.catch(() => undefined);
		this.#supervisors.get(sessionId)?.stop();
		this.#supervisors.delete(sessionId);
		projection.setStatus("closed");
		this.broadcast(sessionId, projection.appendEvent({ type: "session_closed" }));
		return { frame: response(this.hostId, command, true, { closed: true, sessionId }) };
	}
	private finish(command: CommandFrame, outcome: CommandOutcome): CommandOutcome {
		this.#idempotency.complete(command.commandId, command, outcome);
		return outcome;
	}
	private async ensureSupervisor(sessionId: SessionId): Promise<RpcChildSupervisor> {
		if (this.#stopping) throw new Error("appserver is stopping");
		if (this.#closedSessions.has(sessionId)) throw new Error("session is closed");
		const existing = this.#supervisors.get(sessionId);
		if (existing) return existing;
		const pending = this.#startPromises.get(sessionId);
		if (pending) return pending;
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
		const record = this.#records.get(sessionId);
		if (!record) throw new Error("unknown session");
		await this.#lockCheck(record);
		if (this.#stopping || this.#closedSessions.has(sessionId)) throw new Error("session is closed");
		const projection = this.#projections.get(sessionId)!;
		const supervisor = new RpcChildSupervisor(
			this.#factory,
			record,
			{
				entry: frame => {
					const entry = fromRpcEntry(frame.entry as unknown as Record<string, unknown>, this.hostId, sessionId);
					const output = entry ? projection.appendEntry(entry) : undefined;
					if (output) this.broadcast(sessionId, output);
				},
				event: frame =>
					this.broadcast(
						sessionId,
						projection.appendEvent({ type: typeof frame.type === "string" ? frame.type : "rpc", ...frame }),
					),
				crashed: () => {
					projection.setStatus("closed");
					this.#supervisors.delete(sessionId);
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
			supervisor.stop();
			throw error;
		}
	}
	private async message(ws: AppWs, raw: string | Uint8Array): Promise<void> {
		try {
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
					await this.#sendFrame(ws, { v: "omp-app/1", type: "pair.error", code: "pairing_denied", message: "pairing denied", requestId: frame.requestId });
					return;
				}
				await this.#sendFrame(ws, result);
				return;
			}
			if (!this.#hello.has(ws)) throw new Error("hello required before commands");
			if (ws.remote) {
				const connection = this.#remoteConnections.get(ws);
				if (!connection || !this.#remotePolicy) throw new Error("remote connection is unavailable");
				const allowed = await this.#remotePolicy.authorize(connection, frame, {
					connectionId: ws.connectionId,
					peer: connection.peer,
					...(frame.type === "command" ? { command: frame } : {}),
				});
				if (!allowed) {
					if (!this.#remotePolicy.isClosed?.(connection)) ws.close(1008, "remote policy denied");
					return;
				}
			}
			if (ws.remote && frame.type === "command") {
				const connection = this.#remoteConnections.get(ws);
				const handled = connection && this.#remotePolicy?.handleCommand ? await this.#remotePolicy.handleCommand(connection, frame) : undefined;
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
					await this.#sendFrame(ws, { v: "omp-app/1", type: "error", code: "unsupported", message: "terminal operations are unsupported" });
					return;
				}
				const session = this.#projections.get(frame.sessionId);
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
					const code = new Set(["FORBIDDEN", "NOT_FOUND", "STALE_REVISION", "UNSUPPORTED", "ABORTED", "CONFLICT", "OPERATION_FAILED"]).has(rawCode)
						? rawCode
						: "OPERATION_FAILED";
					await this.#sendFrame(ws, { v: "omp-app/1", type: "error", code, message: "terminal operation failed" });
				} finally {
					this.#abortControllers.get(ws)?.delete(controller);
				}
				return;
			}
			if (frame.type !== "command") {
				await this.#sendFrame(ws, { v: "omp-app/1", type: "error", code: "unsupported", message: "frame is not supported" });
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
				await this.#sendFrame(ws, this.challenge(ws, frame));
				return;
			}
			const outcome = await this.#command(frame, ws);
			await this.#sendFrame(ws, outcome.frame);
			if (frame.command === "session.attach" && frame.sessionId && outcome.frame.type === "response" && outcome.frame.ok) {
				this.#attached.get(ws)?.add(frame.sessionId);
				const cursor = frame.args.cursor;
				const outputs = cursor ? this.replay(frame.sessionId, cursor as { epoch: string; seq: number }) : [this.#projections.get(frame.sessionId)!.snapshot()];
				for (const output of outputs) await this.#sendFrame(ws, output);
			}
		} catch {
			if (ws.remote) {
				ws.close(1008, "invalid frame");
				return;
			}
			await this.#sendFrame(ws, { v: "omp-app/1", type: "error", code: "invalid_frame", message: "invalid frame" });
			ws.close(1008, "invalid frame");
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
			for (const sessionId of this.#projections.keys()) {
				try {
					await this.#operations.disconnect(ws.connectionId, { ...contextBase, sessionId });
				} catch {
					/* owner cleanup is best effort; registry always releases */
				}
			}
		}
		this.#clients.delete(ws);
		this.#hello.delete(ws);
		this.#clientCapabilities.delete(ws);
		this.#attached.delete(ws);
		this.#deviceIds.delete(ws);
		this.#abortControllers.delete(ws);
		this.#remoteDecisions.delete(ws);
		this.#remoteConnections.delete(ws);
		this.#remoteTransports.delete(ws.connectionId);
		for (const [socket, transport] of this.#localTransports) if (transport === ws) this.#localTransports.delete(socket);
	}
	private async hello(ws: AppWs, frame: HelloFrame, decision?: RemoteHelloDecision): Promise<void> {
		if (!ws.remote && frame.authentication !== undefined) throw new Error("device authentication is not accepted on local transport");
		const capabilityCeiling = decision?.grantedCapabilities
			? new Set(decision.grantedCapabilities)
			: this.#supportedCapabilities;
		const requestedCapabilities = new Set(frame.capabilities?.client ?? this.#supportedCapabilities);
		const grantedCapabilities = [...this.#supportedCapabilities].filter(
			capability => requestedCapabilities.has(capability) && capabilityCeiling.has(capability),
		);
		this.#clientCapabilities.set(ws, new Set(grantedCapabilities));
		const featureCeiling = decision?.grantedFeatures ? new Set(decision.grantedFeatures) : this.#supportedFeatures;
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
			grantedFeatures: frame.requestedFeatures.filter(feature => this.#supportedFeatures.has(feature) && featureCeiling.has(feature)),
			negotiatedLimits: { maxPayloadLength: 1024 * 1024, ringSize: this.#ringSize },
			authentication: decision?.authentication ?? (ws.remote ? "remote" : "local"),
			resumed: frame.savedCursors.some(cursor => cursor.hostId === this.hostId && cursor.cursor.epoch === this.epoch),
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
		this.#attached.set(transport, new Set());
		this.#deviceIds.set(transport, transport.deviceId);
		this.#abortControllers.set(transport, new Set());
	}
async #remoteMessage(connection: RemoteConnection, message: string | Uint8Array): Promise<void> {
		const transport = this.#remoteTransports.get(connection.connectionId);
		if (transport) await this.message(transport, typeof message === "string" ? message : new Uint8Array(message));
	}
async #remoteDisconnected(connection: RemoteConnection): Promise<void> {
		const transport = this.#remoteTransports.get(connection.connectionId);
		if (transport) await this.disconnectClient(transport);
		if (this.#remotePolicy?.disconnected) await this.#remotePolicy.disconnected(connection);
	}
	async #sendFrame(transport: AppWs, frame: ServerFrame): Promise<boolean> {
		if (transport.remote) {
			const connection = this.#remoteConnections.get(transport);
			if (!connection || !this.#remotePolicy) return false;
			let transformed: ServerFrame | string | undefined;
			try {
				transformed = this.#remotePolicy.transformOutbound
					? await this.#remotePolicy.transformOutbound(connection, frame)
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
		records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId));
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
			if (!this.#projections.has(record.sessionId))
				this.#projections.set(
					record.sessionId,
					new SessionProjection(this.hostId, record, this.epoch, this.#ringSize),
				);
		}
		for (const [sessionId, pending] of this.#createdPending) {
			if (discoveredIds.has(sessionId)) {
				this.#createdPending.delete(sessionId);
				continue;
			}
			if (pending.refreshesRemaining > 0) pending.refreshesRemaining -= 1;
			else {
				this.#createdPending.delete(sessionId);
				this.#records.delete(sessionId);
				this.#projections.delete(sessionId);
			}
		}
		for (const sessionId of [...this.#records.keys()]) {
			if (discoveredIds.has(sessionId) || this.#createdPending.has(sessionId)) continue;
			this.#records.delete(sessionId);
			this.#projections.delete(sessionId);
			this.#closedSessions.delete(sessionId);
			this.#supervisors.get(sessionId)?.stop();
			this.#supervisors.delete(sessionId);
		}
	}
	private sessionsFrame(): ServerFrame {
		return {
			v: "omp-app/1",
			type: "sessions",
			cursor: { epoch: this.epoch, seq: 0 },
			sessions: [...this.#projections.values()].map(value => value.value.ref),
		};
	}
	private broadcast(sessionId: SessionId, frame: ServerFrame): void {
		for (const [client, sessions] of this.#attached) if (sessions.has(sessionId)) void this.#sendFrame(client, frame);
	}
	private async fetch(request: Request, server: Bun.Server<ServerWebSocketData>): Promise<Response | undefined> {
		const url = new URL(request.url);
		if (url.pathname === "/health" && request.method === "GET")
			return Response.json({ ok: true, hostId: this.hostId, epoch: this.epoch });
		if (url.pathname === "/admin/pair-ticket") return this.adminPairTicket(request);
		if (url.pathname === "/admin/devices") return this.adminDevices(request);
		if (url.pathname === "/admin/revoke") return this.adminRevoke(request);
		if (
			url.pathname !== "/ws" ||
			request.method !== "GET" ||
			request.headers.get("upgrade")?.toLowerCase() !== "websocket"
		)
			return new Response("Not Found", { status: 404 });
		if (server.upgrade(request, { data: { socket: {} } })) return undefined;
		return new Response("Upgrade Required", { status: 426 });
	}
	private adminError(status = 400): Response {
		return Response.json({ error: "invalid admin request" }, { status });
	}
	private async adminJson(request: Request, keys: readonly string[]): Promise<Record<string, unknown> | Response> {
		if (request.method !== "POST" || request.headers.get("content-type") !== "application/json") return this.adminError(405);
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
	private async adminPairTicket(request: Request): Promise<Response> {
		if (!this.#admin || request.method !== "POST") return this.adminError(404);
		const body = await this.adminJson(request, ["capabilities", "ttlMs", "expectedNodeId"]);
		if (body instanceof Response) return body;
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
		const body = await this.adminJson(request, ["deviceId"]);
		if (body instanceof Response) return body;
		if (typeof body.deviceId !== "string" || body.deviceId.length === 0 || body.deviceId.length > 512)
			return this.adminError();
		try {
			return Response.json(this.#admin.revokeDevice(body.deviceId));
		} catch {
			return this.adminError();
		}
	}
}
interface ServerWebSocketData {
	socket: Record<string, never>;
}
export function createAppserver(options: AppserverOptions = {}): LocalAppserver {
	return new LocalAppserver(options);
}
