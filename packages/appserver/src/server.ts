import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, open, readlink, rename, stat as fsStat, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { COMMAND_DESCRIPTORS, requiredCapability, type ConfirmFrame, type ConfirmationChallenge } from "@oh-my-pi/app-wire";
import { decodeClientFrame, decodeConfirm, decodeCursor, parseBounded, utf8ByteLength, type CommandFrame, type DurableEntry, type HelloFrame, type HostId, type ResultFrame, type ServerFrame, type SessionId } from "@oh-my-pi/app-wire";
import type { AppserverHandle, AppserverOptions, ChildHandle, CommandOutcome, Clock, LockCheckHook, RpcChildFactory, SessionAuthority, SessionDiscovery, SessionRecord } from "./types.ts";
import { createEpoch, createHostId, defaultSocketPath, loadPersistentHostId, unixSocketActive } from "./identity.ts";
import { FileSessionDiscovery, stableProjectId } from "./discovery.ts";
import { SessionProjection } from "./projection.ts";
import { IdempotencyStore } from "./idempotency.ts";
import { BunRpcChildFactory, RpcChildSupervisor } from "./rpc-child.ts";
import { ensureSecureSocketDirectory, markerIdentity, ownerPaths, readPublicTarget, readStrictOwner, sameIdentity, unlinkIfExists, type OwnerPaths, type OwnerRecord } from "./ownership.ts";
import { AppserverCommandHandlers } from "./command-handler.ts";
const clock: Clock = { now: () => new Date() };
function response(hostId: HostId, command: CommandFrame, ok: boolean, result?: unknown, error?: { code: string; message: string; details?: Record<string, unknown> }): ResultFrame {
  return { v: "omp-app/1", type: "response", requestId: command.requestId, commandId: command.commandId, command: command.command, hostId, sessionId: command.sessionId, ok, ...(ok ? { result } : { error }) } as ResultFrame;
}
function fromRpcEntry(raw: Record<string, unknown>, host: HostId, session: SessionId): DurableEntry {
  if (typeof raw.id !== "string" || typeof raw.type !== "string" || !raw.type || (raw.parentId !== null && typeof raw.parentId !== "string") || typeof raw.timestamp !== "string" || !Number.isFinite(Date.parse(raw.timestamp))) throw new Error("malformed rpc session entry");
  return { id: raw.id as DurableEntry["id"], parentId: raw.parentId as DurableEntry["parentId"], hostId: host, sessionId: session, kind: raw.type, timestamp: raw.timestamp, data: Object.fromEntries(Object.entries(raw).filter(([key]) => !["id", "parentId", "type", "timestamp"].includes(key))) };
}
function argumentError(command: CommandFrame): string | undefined {
  const args = command.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "args must be an object";
  const keys = Object.keys(args);
  if (command.command === "session.prompt") {
    if (keys.length !== 1 || keys[0] !== "message" || typeof args.message !== "string" || args.message.length === 0 || utf8ByteLength(args.message) > 65_536) return "prompt message must be a bounded non-empty UTF-8 string";
    return undefined;
  }
  if (command.command === "session.attach") {
    if (keys.length === 0) return undefined;
    if (keys.length === 1 && keys[0] === "cursor") { try { decodeCursor(args.cursor); return undefined; } catch { return "attach cursor is invalid"; } }
    return "attach accepts only an optional cursor";
  }
  if (command.command === "session.create") {
    if (keys.some(key => key !== "cwd" && key !== "title")) return "create accepts only cwd and title";
    if (args.cwd !== undefined && (typeof args.cwd !== "string" || args.cwd.length === 0 || utf8ByteLength(args.cwd) > 4_096)) return "create cwd must be a bounded non-empty UTF-8 string";
    if (args.title !== undefined && (typeof args.title !== "string" || args.title.length === 0 || utf8ByteLength(args.title) > 512)) return "create title must be a bounded non-empty UTF-8 string";
    return undefined;
  }
  if (keys.length !== 0) return "command does not accept args";
  return undefined;
}
type AppWs = Bun.ServerWebSocket<ServerWebSocketData>;
interface RunIdentity {
  paths: OwnerPaths;
  record: OwnerRecord;
  marker: { device: number; inode: number };
}
function isErrno(error: unknown, code: string): boolean { return (error as NodeJS.ErrnoException).code === code; }
async function pidIsAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; } catch (error) {
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
  if (published.target !== paths.backingName) throw new Error("appserver public symlink target changed during publish");
}
async function publishOwnerAtomic(paths: OwnerPaths, record: OwnerRecord, claimed: { device: number; inode: number }): Promise<{ device: number; inode: number }> {
  const temp = join(paths.directory, `.appserver-owner-${record.ownerId}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.write(`${JSON.stringify(record)}\n`, 0); await handle.sync();
  } finally { await handle.close(); }
  try {
    const current = await statIdentity(paths.ownerPath);
    if (!current || current.device !== claimed.device || current.inode !== claimed.inode) throw new Error("appserver owner marker changed during startup");
    await rename(temp, paths.ownerPath);
  } catch (error) {
    await unlinkIfExists(temp);
    throw error;
  }
  const final = await statIdentity(paths.ownerPath);
  if (!final) throw new Error("appserver owner marker disappeared during startup");
  return final;
}
export class LocalAppserver implements AppserverHandle {
  hostId: HostId; readonly epoch: string; readonly socketPath: string;
  #clock: Clock; #discovery: SessionDiscovery; #authority?: SessionAuthority; #factory: RpcChildFactory; #lockCheck: LockCheckHook; #ringSize: number; #handlers = new AppserverCommandHandlers(); #challenges = new Map<string, { command: CommandFrame; ws: AppWs; expiresAt: number; hash: string }>(); #records = new Map<SessionId, SessionRecord>(); #projections = new Map<SessionId, SessionProjection>(); #supervisors = new Map<SessionId, RpcChildSupervisor>(); #startPromises = new Map<SessionId, Promise<RpcChildSupervisor>>(); #closedSessions = new Set<SessionId>(); #idempotency = new IdempotencyStore(); #server?: Bun.Server<ServerWebSocketData>; #clients = new Set<AppWs>(); #hello = new Set<AppWs>(); #clientCapabilities = new Map<AppWs, Set<string>>(); #attached = new Map<AppWs, Set<SessionId>>(); #started = false; #stopping = false; #hostProvided: boolean; #ownerLock = false; #ownerId?: string; #ownerPaths?: OwnerPaths; #ownerHandle?: FileHandle; #runIdentity?: RunIdentity; #partialBacking?: { path: string; identity: { device: number; inode: number } }; #partialMarker?: { device: number; inode: number }; #ompVersion; #ompBuild; #appserverVersion; #appserverBuild; #supportedFeatures; #supportedCapabilities;
  constructor(options: AppserverOptions = {}) {
    this.#hostProvided = Boolean(options.hostId); this.hostId = options.hostId ?? createHostId(); this.epoch = createEpoch(options.epoch); this.socketPath = options.socketPath ?? defaultSocketPath();
    this.#clock = options.clock ?? clock; this.#authority = options.sessionAuthority; this.#discovery = options.discovery ?? options.sessionAuthority ?? { list: async () => [] }; this.#factory = options.childFactory ?? new BunRpcChildFactory(); this.#lockCheck = options.lockCheck ?? (() => undefined); this.#ringSize = options.ringSize ?? 256;
    this.#ompVersion = options.ompVersion ?? "local"; this.#ompBuild = options.ompBuild ?? "local"; this.#appserverVersion = options.appserverVersion ?? "0.1.0"; this.#appserverBuild = options.appserverBuild ?? "local"; this.#supportedFeatures = new Set(options.supportedFeatures ?? ["resume"]);
    const implemented = new Set(["sessions.read", "sessions.manage", "sessions.prompt", "sessions.control"]); const requested = options.supportedCapabilities ?? [...implemented]; if (requested.some(capability => !implemented.has(capability))) throw new Error("unsupported capability has no Wave1 handler"); this.#supportedCapabilities = new Set(requested);
    this.#handlers.register("session.create", command => this.handleCreate(command));
    this.#handlers.register("session.close", command => this.handleClose(command));
  }
  async start(): Promise<void> {
    if (this.#started) return;
    this.#stopping = false; this.#closedSessions.clear();
    if (!this.#hostProvided) this.hostId = await loadPersistentHostId();
    this.#records.clear(); this.#projections.clear(); await this.loadSessions();
    await ensureSecureSocketDirectory(this.socketPath);
    const ownerId = randomUUID();
    const paths = ownerPaths(this.socketPath, ownerId);
    const initial: OwnerRecord = { version: 2, ownerId, pid: process.pid, backingName: paths.backingName, device: 0, inode: 0 };
    let ownerHandle: FileHandle;
    try {
      ownerHandle = await open(`${this.socketPath}.owner`, "wx", 0o600);
      await ownerHandle.write(`${JSON.stringify(initial)}\n`); await ownerHandle.sync();
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const existing = await readStrictOwner(`${this.socketPath}.owner`);
      if (await pidIsAlive(existing.record.pid)) throw new Error(`appserver socket has another owner: ${this.socketPath}`);
      await this.recoverStale(ownerPaths(this.socketPath, existing.record.ownerId), existing.record, existing.stat);
      ownerHandle = await open(`${this.socketPath}.owner`, "wx", 0o600);
      await ownerHandle.write(`${JSON.stringify(initial)}\n`); await ownerHandle.sync();
    }
    this.#ownerHandle = ownerHandle; this.#ownerLock = true; this.#ownerId = ownerId; this.#ownerPaths = paths;
    try {
      await this.preparePublic(paths);
      this.#server = Bun.serve<ServerWebSocketData>({ unix: paths.backingPath, fetch: (request, server) => this.fetch(request, server), websocket: { maxPayloadLength: 1024 * 1024, backpressureLimit: 1024 * 1024, closeOnBackpressureLimit: true, open: ws => { this.#clients.add(ws); this.#clientCapabilities.set(ws, new Set()); this.#attached.set(ws, new Set()); }, message: (ws, message) => { void this.message(ws, message); }, close: ws => { this.#clients.delete(ws); this.#hello.delete(ws); this.#clientCapabilities.delete(ws); this.#attached.delete(ws); } } });
      await chmod(paths.backingPath, 0o600);
      if (this.#stopping) throw new Error("appserver is stopping");
      const backing = await fsStat(paths.backingPath);
      const record: OwnerRecord = { version: 2, ownerId, pid: process.pid, backingName: paths.backingName, device: Number(backing.dev), inode: Number(backing.ino) };
      this.#partialBacking = { path: paths.backingPath, identity: { device: Number(backing.dev), inode: Number(backing.ino) } };
      const claimed = await markerIdentity(ownerHandle);
      const finalMarker = await publishOwnerAtomic(paths, record, claimed);
      this.#partialMarker = finalMarker;
      const currentRecord = await readStrictOwner(paths.ownerPath);
      if (currentRecord.record.ownerId !== ownerId || !sameIdentity(currentRecord.record, record)) throw new Error("appserver owner marker changed during startup");
      await publishSymlink(paths);
      if (this.#stopping) throw new Error("appserver is stopping");
      this.#runIdentity = { paths, record, marker: finalMarker };
      this.#started = true;
    } catch (error) {
      await this.cleanupPartial();
      throw error;
    }
  }
  async stop(): Promise<void> {
    if (!this.#started && !this.#server && !this.#ownerLock && this.#startPromises.size === 0) return;
    this.#stopping = true;
    for (const ws of this.#clients) ws.close(1001, "server stopping");
    this.#clients.clear(); this.#hello.clear(); this.#attached.clear();
    const server = this.#server; this.#server = undefined;
    let displaced: string | undefined;
    if (this.#runIdentity) {
      const current = await statIdentity(this.#runIdentity.paths.backingPath);
      if (current && !sameIdentity(current, this.#runIdentity.record)) {
        displaced = join(this.#runIdentity.paths.directory, `.appserver-displaced-${this.#runIdentity.record.ownerId}-${randomUUID()}`);
        await rename(this.#runIdentity.paths.backingPath, displaced);
      }
    }
    server?.stop(true);
    if (displaced) {
      try { await rename(displaced, this.#runIdentity?.paths.backingPath ?? ""); } catch (error) { process.emitWarning(error instanceof Error ? error.message : String(error)); }
    }
    for (const supervisor of this.#supervisors.values()) supervisor.stop();
    this.#supervisors.clear();
    await Promise.allSettled([...this.#startPromises.values()]);
    this.#startPromises.clear(); this.#started = false;
    const identity = this.#runIdentity;
    if (identity) await this.cleanupOwned(identity);
    else await this.cleanupPartial();
    this.#runIdentity = undefined; this.#ownerLock = false; this.#ownerId = undefined; this.#ownerPaths = undefined;
    await this.#ownerHandle?.close(); this.#ownerHandle = undefined;
  }
  private async recoverStale(paths: OwnerPaths, record: OwnerRecord, markerStat: { dev: number; ino: number }): Promise<void> {
    if (record.backingName !== paths.backingName) throw new Error(`appserver socket has another owner: ${this.socketPath}`);
    try {
      const publicStat = await lstat(paths.publicPath);
      if (!publicStat.isSymbolicLink()) throw new Error(`appserver socket has another owner: ${this.socketPath}`);
      const target = await readlink(paths.publicPath);
      if (target !== paths.backingName) throw new Error(`appserver socket has another owner: ${this.socketPath}`);
      const backing = await statIdentity(paths.backingPath);
      if (backing && !sameIdentity(backing, record)) throw new Error(`appserver socket has another owner: ${this.socketPath}`);
      const latest = await lstat(paths.publicPath);
      const latestTarget = await readlink(paths.publicPath);
      const latestBacking = await statIdentity(paths.backingPath);
      if (latest.dev !== publicStat.dev || latest.ino !== publicStat.ino || !latest.isSymbolicLink() || latestTarget !== paths.backingName || (latestBacking && !sameIdentity(latestBacking, record))) throw new Error(`appserver socket has another owner: ${this.socketPath}`);
      await unlink(paths.publicPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    const backing = await statIdentity(paths.backingPath);
    if (backing) {
      if (!sameIdentity(backing, record) || await unixSocketActive(paths.backingPath)) throw new Error(`appserver socket has another owner: ${this.socketPath}`);
      await unlink(paths.backingPath);
    }
    const current = await statIdentity(paths.ownerPath);
    if (!current || current.device !== Number(markerStat.dev) || current.inode !== Number(markerStat.ino)) throw new Error(`appserver socket has another owner: ${this.socketPath}`);
    await unlink(paths.ownerPath);
  }
  private async preparePublic(paths: OwnerPaths): Promise<void> {
    try {
      const info = await lstat(paths.publicPath);
      throw new Error(`${info.isSocket() ? "refusing existing public socket" : "refusing non-socket public path"}: ${paths.publicPath}`);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  private async cleanupPartial(): Promise<void> {
    const paths = this.#ownerPaths;
    const marker = this.#partialMarker ?? (this.#ownerHandle ? await markerIdentity(this.#ownerHandle) : undefined);
    this.#server?.stop(true); this.#server = undefined;
    if (paths) {
      const publicInfo = await statIdentity(paths.publicPath);
      if (publicInfo) {
        try {
          const target = await readPublicTarget(paths.publicPath);
          const latest = await lstat(paths.publicPath);
          const latestTarget = await readlink(paths.publicPath);
          const backing = await statIdentity(paths.backingPath);
          if (latest.dev === publicInfo.device && latest.ino === publicInfo.inode && latest.isSymbolicLink() && latestTarget === paths.backingName && (!backing || (this.#partialBacking && sameIdentity(backing, this.#partialBacking.identity)))) await unlink(paths.publicPath);
          else if (target.target !== paths.backingName) process.emitWarning(`appserver socket ownership conflict; preserving ${paths.publicPath}`);
        } catch (error) { if (!isErrno(error, "ENOENT")) process.emitWarning(error instanceof Error ? error.message : String(error)); }
      }
      const backing = await statIdentity(paths.backingPath);
      if (backing && this.#partialBacking && sameIdentity(backing, this.#partialBacking.identity)) {
        const latestBacking = await statIdentity(paths.backingPath);
        if (latestBacking && sameIdentity(latestBacking, backing)) await unlink(paths.backingPath);
      }
      if (marker) {
        const current = await statIdentity(paths.ownerPath);
        const latest = await statIdentity(paths.ownerPath);
        if (current && latest && current.device === marker.device && current.inode === marker.inode && latest.device === current.device && latest.inode === current.inode) await unlink(paths.ownerPath);
      }
    }
    if (this.#ownerHandle) { await this.#ownerHandle.close(); this.#ownerHandle = undefined; }
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
      if (markerValue.record.ownerId !== record.ownerId || markerValue.record.pid !== record.pid || markerValue.record.backingName !== record.backingName || !sameIdentity(markerValue.record, record)) conflict = true;
    } catch (error) { if (!isErrno(error, "ENOENT")) conflict = true; }
    let publicStat: { device: number; inode: number } | undefined;
    try {
      publicStat = (await readPublicTarget(paths.publicPath)).stat;
      if ((await readPublicTarget(paths.publicPath)).target !== record.backingName) conflict = true;
    } catch (error) { if (!isErrno(error, "ENOENT")) conflict = true; }
    const backing = await statIdentity(paths.backingPath);
    if (backing && !sameIdentity(backing, record)) conflict = true;
    if (conflict) { process.emitWarning(`appserver socket ownership conflict; preserving ${paths.publicPath}`); return; }
    if (publicStat) {
      const check = await statIdentity(paths.publicPath);
      if (!check || check.device !== publicStat.device || check.inode !== publicStat.inode) { process.emitWarning(`appserver socket ownership conflict; preserving ${paths.publicPath}`); return; }
      await unlink(paths.publicPath);
    }
    const markerCheck = await statIdentity(paths.ownerPath);
    if (markerCheck && markerCheck.device === marker.device && markerCheck.inode === marker.inode) await unlink(paths.ownerPath);
    const backingCheck = await statIdentity(paths.backingPath);
    if (backingCheck && sameIdentity(backingCheck, record)) await unlink(paths.backingPath);
  }
  snapshot(sessionId: SessionId) { return this.#projections.get(sessionId)?.value; }
  replay(sessionId: SessionId, cursor: { epoch: string; seq: number }): ServerFrame[] { return this.#projections.get(sessionId)?.replay(cursor) ?? []; }
  childFor(sessionId: SessionId): ChildHandle | undefined { return this.#supervisors.get(sessionId)?.child(); }
  async #command(command: CommandFrame, capabilities?: Set<string>, approved = false): Promise<CommandOutcome> {
    if (command.hostId !== this.hostId) return { frame: response(this.hostId, command, false, undefined, { code: "host_mismatch", message: "command targets another host" }) };
    const descriptor = COMMAND_DESCRIPTORS[command.command]; if (!descriptor) return { frame: response(this.hostId, command, false, undefined, { code: "unsupported", message: "unknown command" }) };
    if (descriptor.confirmation === "challenge" && !approved) return { frame: response(this.hostId, command, false, undefined, { code: "confirmation_invalid", message: "command requires a consumed confirmation" }) };
    const required = requiredCapability(command.command); if (capabilities && required && !capabilities.has(required)) return { frame: response(this.hostId, command, false, undefined, { code: "capability_denied", message: "client capability was not granted" }) };
    const check = this.#idempotency.begin(command.commandId, command);
    if (check.kind === "replay") return { frame: { ...check.outcome.frame, requestId: command.requestId } as ServerFrame, unknown: check.outcome.unknown };
    if (check.kind === "pending") { const outcome = await check.outcome; return { frame: { ...outcome.frame, requestId: command.requestId } as ServerFrame, unknown: outcome.unknown }; }
    if (check.kind === "conflict") return { frame: response(this.hostId, command, false, undefined, { code: "idempotency_conflict", message: "commandId was already used with another payload", details: { commandId: command.commandId, payloadHash: check.hash } }) };
    const invalidArgs = argumentError(command);
    if (invalidArgs) return this.finish(command, { frame: response(this.hostId, command, false, undefined, { code: "invalid_frame", message: invalidArgs }) });
    if (descriptor.revision === "required" && command.expectedRevision === undefined) return this.finish(command, { frame: response(this.hostId, command, false, undefined, { code: "stale_revision", message: "expectedRevision is required" }) });
    if (descriptor.revision === "none" && command.expectedRevision !== undefined) return this.finish(command, { frame: response(this.hostId, command, false, undefined, { code: "stale_revision", message: "expectedRevision is forbidden" }) });
    const projection = command.sessionId ? this.#projections.get(command.sessionId) : undefined;
    if (descriptor.scope === "session" && !projection) return this.finish(command, { frame: response(this.hostId, command, false, undefined, { code: "unknown_session", message: "session is not indexed" }) });
    if (descriptor.revisionOwner === "session" && command.expectedRevision !== undefined && projection && command.expectedRevision !== projection.value.revision) return this.finish(command, { frame: response(this.hostId, command, false, undefined, { code: "stale_revision", message: "session revision is stale", details: { expectedRevision: command.expectedRevision, actualRevision: projection.value.revision } }) });
    let outcome: CommandOutcome;
    try {
      const registered = await this.#handlers.dispatch(command);
      if (registered) outcome = registered;
      else if (command.command === "host.list" || command.command === "session.list") outcome = { frame: response(this.hostId, command, true, { cursor: { epoch: this.epoch, seq: 0 }, sessions: [...this.#projections.values()].map(value => value.value.ref) }) };
      else if (command.command === "session.attach") outcome = { frame: response(this.hostId, command, true, { attached: true, cursor: projection!.value.cursor }) };
      else if (command.command === "session.prompt") {
        if (this.#closedSessions.has(command.sessionId!)) throw new Error("session is closed");
        projection!.setStatus("active");
        const supervisor = await this.ensureSupervisor(command.sessionId!);
        const result = await supervisor.prompt(command.requestId, command.args.message as string);
        projection!.setStatus(result.success ? "idle" : "closed");
        outcome = { frame: response(this.hostId, command, result.success, { accepted: result.success }, result.success ? undefined : { code: "child_error", message: result.error }) };
      } else if (command.command === "session.cancel") {
        const supervisor = await this.ensureSupervisor(command.sessionId!);
        const result = await supervisor.cancel(command.requestId);
        outcome = { frame: response(this.hostId, command, result.success, { cancelled: result.success }, result.success ? undefined : { code: "child_error", message: result.error }) };
      } else outcome = { frame: response(this.hostId, command, false, undefined, { code: "unsupported", message: "command is deferred to a later wave" }) };
    } catch (error) {
      const failedProjection = command.command === "session.prompt" ? this.#projections.get(command.sessionId!) : undefined;
      if (failedProjection && failedProjection.value.ref.status === "active" && !this.#closedSessions.has(command.sessionId!)) failedProjection.setStatus("idle");
      outcome = { frame: response(this.hostId, command, false, undefined, { code: "outcome_unknown", message: error instanceof Error ? error.message : "command failed", details: { recovery: "reconnect and replay from snapshot" } }), unknown: true };
    }
    return this.finish(command, outcome);
  }
  private async createSession(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.#authority) throw new Error("session creation is unavailable");
    const requestedCwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
    const title = typeof args.title === "string" ? args.title : undefined;
    const created = await this.#authority.create(requestedCwd, title);
    const timestamp = this.#clock.now().toISOString();
    const record: SessionRecord = { sessionId: created.sessionId, path: created.path, cwd: created.cwd, projectId: stableProjectId(created.cwd), title: created.title ?? "Session", updatedAt: timestamp, status: "idle", entries: created.entries };
    this.#records.set(record.sessionId, record);
    this.#projections.set(record.sessionId, new SessionProjection(this.hostId, record, this.epoch, this.#ringSize));
    return { sessionId: record.sessionId };
  }
  private async handleCreate(command: CommandFrame): Promise<CommandOutcome> {
    const created = await this.createSession(command.args);
    return { frame: response(this.hostId, command, true, { session: this.#projections.get(created.sessionId as SessionId)!.value.ref }) };
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
  private finish(command: CommandFrame, outcome: CommandOutcome): CommandOutcome { this.#idempotency.complete(command.commandId, command, outcome); return outcome; }
  private async ensureSupervisor(sessionId: SessionId): Promise<RpcChildSupervisor> {
    if (this.#stopping) throw new Error("appserver is stopping");
    if (this.#closedSessions.has(sessionId)) throw new Error("session is closed");
    const existing = this.#supervisors.get(sessionId); if (existing) return existing;
    const pending = this.#startPromises.get(sessionId); if (pending) return pending;
    const start = Promise.resolve().then(() => this.startSupervisor(sessionId)); this.#startPromises.set(sessionId, start);
    try { return await start; } finally { this.#startPromises.delete(sessionId); }
  }
  private async startSupervisor(sessionId: SessionId): Promise<RpcChildSupervisor> {
    const existing = this.#supervisors.get(sessionId); if (existing) return existing;
    if (this.#stopping || this.#closedSessions.has(sessionId)) throw new Error("session is closed");
    const record = this.#records.get(sessionId); if (!record) throw new Error("unknown session"); await this.#lockCheck(record);
    if (this.#stopping || this.#closedSessions.has(sessionId)) throw new Error("session is closed");
    const projection = this.#projections.get(sessionId)!;
    const supervisor = new RpcChildSupervisor(this.#factory, record, { entry: frame => { const entry = fromRpcEntry(frame.entry as unknown as Record<string, unknown>, this.hostId, sessionId); const output = entry ? projection.appendEntry(entry) : undefined; if (output) this.broadcast(sessionId, output); }, event: frame => this.broadcast(sessionId, projection.appendEvent({ type: typeof frame.type === "string" ? frame.type : "rpc", ...frame })), crashed: () => { projection.setStatus("closed"); this.#supervisors.delete(sessionId); } }, this.#factory.argv(record.path));
    this.#supervisors.set(sessionId, supervisor); try { await supervisor.start(); return supervisor; } catch (error) { this.#supervisors.delete(sessionId); supervisor.stop(); throw error; }
  }
  private async message(ws: AppWs, raw: string | Buffer): Promise<void> {
    try {
      if (typeof raw !== "string") throw new Error("binary websocket frames are not supported");
      const frame = decodeClientFrame(parseBounded(raw));
      if (frame.type === "hello") { if (this.#hello.has(ws)) throw new Error("hello already received"); this.#hello.add(ws); this.hello(ws, frame); return; }
      if (!this.#hello.has(ws)) throw new Error("hello required before commands");
      if (frame.type === "ping") { ws.send(JSON.stringify({ v: "omp-app/1", type: "pong", nonce: frame.nonce, timestamp: this.#clock.now().toISOString() })); return; }
      if (frame.type === "confirm") { ws.send(JSON.stringify((await this.confirm(ws, frame)).frame)); return; }
      if (frame.type !== "command") { ws.send(JSON.stringify({ v: "omp-app/1", type: "error", code: "unsupported", message: "frame is not supported" })); return; }
      const descriptor = COMMAND_DESCRIPTORS[frame.command];
      if (descriptor?.confirmation === "challenge") {
        if (frame.confirmationId !== undefined) {
          ws.send(JSON.stringify(response(this.hostId, frame, false, undefined, { code: "confirmation_invalid", message: "command confirmation must be approved through a confirm frame" })));
          return;
        }
        ws.send(JSON.stringify(this.challenge(ws, frame)));
        return;
      }
      const outcome = await this.#command(frame, this.#clientCapabilities.get(ws));
      ws.send(JSON.stringify(outcome.frame));
      if (frame.command === "session.attach" && frame.sessionId && outcome.frame.type === "response" && outcome.frame.ok) {
        this.#attached.get(ws)?.add(frame.sessionId);
        const cursor = frame.args.cursor;
        const outputs = cursor ? this.replay(frame.sessionId, cursor as { epoch: string; seq: number }) : [this.#projections.get(frame.sessionId)!.snapshot()];
        for (const output of outputs) ws.send(JSON.stringify(output));
      }
    } catch (error) { ws.send(JSON.stringify({ v: "omp-app/1", type: "error", code: "invalid_frame", message: error instanceof Error ? error.message : "invalid frame" })); ws.close(1008, "invalid frame"); }
  }
  private challenge(ws: AppWs, command: CommandFrame): ConfirmationChallenge {
    const hash = createHash("sha256").update(JSON.stringify({ ...command, confirmationId: undefined })).digest("hex");
    const confirmationId = randomUUID() as never;
    const expiresAt = Date.now() + 60_000;
    this.#challenges.set(String(confirmationId), { command, ws, expiresAt, hash });
    return { v: "omp-app/1", type: "confirmation", confirmationId, commandId: command.commandId, hostId: this.hostId, sessionId: command.sessionId, commandHash: hash, revision: (command.expectedRevision ?? this.#projections.get(command.sessionId!)?.value.revision ?? "host") as never, expiresAt: new Date(expiresAt).toISOString(), summary: command.command };
  }
  private async confirm(ws: AppWs, frame: ConfirmFrame): Promise<CommandOutcome> {
    const pending = this.#challenges.get(String(frame.confirmationId));
    if (!pending || pending.ws !== ws || pending.expiresAt < Date.now() || pending.command.commandId !== frame.commandId || pending.command.hostId !== frame.hostId || pending.command.sessionId !== frame.sessionId) return { frame: response(this.hostId, { ...pending?.command ?? frame, requestId: frame.requestId, commandId: frame.commandId, hostId: this.hostId } as CommandFrame, false, undefined, { code: "confirmation_invalid", message: "confirmation is invalid or expired" }) };
    this.#challenges.delete(String(frame.confirmationId));
    if (frame.decision === "deny") return { frame: response(this.hostId, pending.command, false, undefined, { code: "confirmation_denied", message: "command was denied" }) };
    return this.#command({ ...pending.command, confirmationId: frame.confirmationId }, this.#clientCapabilities.get(ws), true);
  }
  private hello(ws: AppWs, frame: HelloFrame): void { if (frame.authentication !== undefined) throw new Error("device authentication is not accepted on local transport"); const requestedCapabilities = new Set(frame.capabilities?.client ?? this.#supportedCapabilities); const grantedCapabilities = [...this.#supportedCapabilities].filter(capability => requestedCapabilities.has(capability)); this.#clientCapabilities.set(ws, new Set(grantedCapabilities)); const welcome = { v: "omp-app/1", type: "welcome", selectedProtocol: "omp-app/1", hostId: this.hostId, ompVersion: this.#ompVersion, ompBuild: this.#ompBuild, appserverVersion: this.#appserverVersion, appserverBuild: this.#appserverBuild, epoch: this.epoch, grantedCapabilities, grantedFeatures: frame.requestedFeatures.filter(feature => this.#supportedFeatures.has(feature)), negotiatedLimits: { maxPayloadLength: 1024 * 1024, ringSize: this.#ringSize }, authentication: "local", resumed: frame.savedCursors.some(cursor => cursor.hostId === this.hostId && cursor.cursor.epoch === this.epoch) }; ws.send(JSON.stringify(welcome)); ws.send(JSON.stringify(this.sessionsFrame())); }
  private async loadSessions(): Promise<void> { const records = await this.#discovery.list(); records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId)); for (const record of records) { if (this.#records.has(record.sessionId)) throw new Error(`duplicate session id: ${record.sessionId}`); this.#records.set(record.sessionId, record); this.#projections.set(record.sessionId, new SessionProjection(this.hostId, record, this.epoch, this.#ringSize)); } }
  private sessionsFrame(): ServerFrame { return { v: "omp-app/1", type: "sessions", cursor: { epoch: this.epoch, seq: 0 }, sessions: [...this.#projections.values()].map(value => value.value.ref) }; }
  private broadcast(sessionId: SessionId, frame: ServerFrame): void { for (const [client, sessions] of this.#attached) if (sessions.has(sessionId)) client.send(JSON.stringify(frame)); }
  private fetch(request: Request, server: Bun.Server<ServerWebSocketData>): Response | undefined { const url = new URL(request.url); if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true, hostId: this.hostId, epoch: this.epoch }); if (url.pathname !== "/ws" || request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Not Found", { status: 404 }); if (server.upgrade(request, { data: { socket: {} } })) return undefined; return new Response("Upgrade Required", { status: 426 }); }
}
interface ServerWebSocketData { socket: Record<string, never>; }
export function createAppserver(options: AppserverOptions = {}): LocalAppserver { return new LocalAppserver(options); }
