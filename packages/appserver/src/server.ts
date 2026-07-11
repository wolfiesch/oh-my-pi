import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeClientFrame, type CommandFrame, type DurableEntry, type HelloFrame, type HostId, type ResultFrame, type ServerFrame, type SessionId } from "@oh-my-pi/app-wire";
import { COMMAND_DESCRIPTORS, DEVICE_CAPABILITIES } from "@oh-my-pi/app-wire";
import type { AppserverHandle, AppserverOptions, ChildHandle, CommandOutcome, Clock, SessionRecord } from "./types.ts";
import { createEpoch, createHostId, defaultSocketPath } from "./identity.ts";
import { FileSessionDiscovery } from "./discovery.ts";
import { SessionProjection } from "./projection.ts";
import { IdempotencyStore } from "./idempotency.ts";
import { BunRpcChildFactory, RpcChildSupervisor } from "./rpc-child.ts";

const clock: Clock = { now: () => new Date() };
function response(hostId: HostId, command: CommandFrame, ok: boolean, result?: unknown, error?: { code: string; message: string; details?: Record<string, unknown> }): ResultFrame {
  return { v: "omp-app/1", type: "response", requestId: command.requestId, commandId: command.commandId, hostId, sessionId: command.sessionId, ok, ...(ok ? { result } : { error }) } as ResultFrame;
}
function fromRpcEntry(raw: Record<string, unknown>, host: HostId, session: SessionId): DurableEntry | undefined {
  if (typeof raw.id !== "string" || typeof raw.type !== "string") return undefined;
  return { id: raw.id as DurableEntry["id"], parentId: (typeof raw.parentId === "string" ? raw.parentId : null) as DurableEntry["parentId"], hostId: host, sessionId: session, kind: raw.type, timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date(0).toISOString(), data: Object.fromEntries(Object.entries(raw).filter(([key]) => !["id", "parentId", "type", "timestamp"].includes(key))) };
}
export class LocalAppserver implements AppserverHandle {
  readonly hostId: HostId; readonly epoch: string; readonly socketPath: string;
  #clock: Clock; #discovery; #factory; #lockCheck; #ringSize; #projections = new Map<SessionId, SessionProjection>(); #supervisors = new Map<SessionId, RpcChildSupervisor>(); #idempotency = new IdempotencyStore(); #server?: Bun.Server<{ socket: ServerWebSocketData }>; #clients = new Set<ServerWebSocket<{ socket: ServerWebSocketData }>>(); #started = false;
  constructor(options: AppserverOptions = {}) { this.hostId = options.hostId ?? createHostId(); this.epoch = createEpoch(options.epoch); this.socketPath = options.socketPath ?? defaultSocketPath(); this.#clock = options.clock ?? clock; this.#discovery = options.discovery ?? new FileSessionDiscovery(`${process.env.HOME || "."}/.omp/sessions`, undefined, this.hostId); this.#factory = options.childFactory ?? new BunRpcChildFactory(); this.#lockCheck = options.lockCheck; this.#ringSize = options.ringSize ?? 256; }
  async start(): Promise<void> {
    if (this.#started) return; await this.loadSessions(); await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 }); try { await chmod(dirname(this.socketPath), 0o700); } catch {} try { await unlink(this.socketPath); } catch {}
    this.#server = Bun.serve<{ socket: ServerWebSocketData }>({ unix: this.socketPath, maxPayloadLength: 1024 * 1024, backpressureLimit: 1024 * 1024, closeOnBackpressureLimit: true, fetch: (request, server) => this.fetch(request, server), websocket: { open: ws => { this.#clients.add(ws); }, message: (ws, message) => { void this.message(ws, message); }, close: ws => { this.#clients.delete(ws); } } });
    await chmod(this.socketPath, 0o600); this.#started = true;
  }
  async stop(): Promise<void> {
    if (!this.#started && !this.#server) return; for (const ws of this.#clients) ws.close(1001, "server stopping"); this.#clients.clear(); for (const supervisor of this.#supervisors.values()) supervisor.stop(); this.#supervisors.clear(); this.#server?.stop(true); this.#server = undefined; try { await unlink(this.socketPath); } catch {} this.#started = false;
  }
  snapshot(sessionId: SessionId) { return this.#projections.get(sessionId)?.value; }
  replay(sessionId: SessionId, cursor: { epoch: string; seq: number }): ServerFrame[] { return this.#projections.get(sessionId)?.replay(cursor) ?? []; }
  childFor(sessionId: SessionId): ChildHandle | undefined { return this.#supervisors.get(sessionId)?.child(); }
  async command(command: CommandFrame): Promise<CommandOutcome> {
    if (command.hostId !== this.hostId) return { frame: response(this.hostId, command, false, undefined, { code: "host_mismatch", message: "command targets another host" }) };
    const descriptor = COMMAND_DESCRIPTORS[command.command]; if (!descriptor) return { frame: response(this.hostId, command, false, undefined, { code: "unsupported", message: "unknown command" }) };
    const check = this.#idempotency.begin(command.commandId, command); if (check.kind === "replay") return check.outcome; if (check.kind === "conflict") return { frame: response(this.hostId, command, false, undefined, { code: "idempotency_conflict", message: "commandId was already used with another payload", details: { commandId: command.commandId, payloadHash: check.hash } }) };
    const projection = command.sessionId ? this.#projections.get(command.sessionId) : undefined;
    if (descriptor.scope === "session" && !projection) return this.finish(command, { frame: response(this.hostId, command, false, undefined, { code: "unknown_session", message: "session is not indexed" }) });
    if (command.expectedRevision && projection && command.expectedRevision !== projection.value.revision) return this.finish(command, { frame: response(this.hostId, command, false, undefined, { code: "stale_revision", message: "session revision is stale", details: { expectedRevision: command.expectedRevision, actualRevision: projection.value.revision } }) });
    if (descriptor.confirmation === "challenge" && command.command !== "session.cancel") return this.finish(command, { frame: response(this.hostId, command, false, undefined, { code: "unsupported", message: "confirmation challenges arrive in Wave 3" }) });
    let outcome: CommandOutcome;
    try {
      if (command.command === "host.list" || command.command === "session.list") outcome = { frame: response(this.hostId, command, true, this.sessionsFrame()) };
      else if (command.command === "session.prompt") { const supervisor = this.#supervisors.get(command.sessionId!); if (!supervisor) throw new Error("session child unavailable"); await this.#lockCheck?.(this.record(command.sessionId!)); const result = await supervisor.prompt(command.requestId, String(command.args.message ?? "")); outcome = { frame: response(this.hostId, command, result.success, result, result.success ? undefined : { code: "child_error", message: result.error }) }; }
      else if (command.command === "session.cancel") { const supervisor = this.#supervisors.get(command.sessionId!); if (!supervisor) throw new Error("session child unavailable"); const result = await supervisor.cancel(command.requestId); outcome = { frame: response(this.hostId, command, result.success, result, result.success ? undefined : { code: "child_error", message: result.error }) }; }
      else outcome = { frame: response(this.hostId, command, false, undefined, { code: "unsupported", message: "command is deferred to a later wave" }) };
    } catch (error) { outcome = { frame: response(this.hostId, command, false, undefined, { code: "outcome_unknown", message: error instanceof Error ? error.message : String(error), details: { recovery: "reconnect and replay from snapshot" } }), unknown: true }; }
    return this.finish(command, outcome);
  }
  private finish(command: CommandFrame, outcome: CommandOutcome): CommandOutcome { this.#idempotency.complete(command.commandId, command, outcome); return outcome; }
  private record(sessionId: SessionId): SessionRecord { const projection = this.#projections.get(sessionId); if (!projection) throw new Error("unknown session"); return { sessionId, path: "", cwd: projection.value.ref.project.canonicalCwd, projectId: projection.value.ref.project.projectId, title: projection.value.ref.title, updatedAt: projection.value.ref.updatedAt, status: projection.value.ref.status, entries: projection.value.entries }; }
  private async loadSessions(): Promise<void> { const records = await this.#discovery.list(); for (const record of records) { const projection = new SessionProjection(this.hostId, record, this.epoch, this.#ringSize); this.#projections.set(record.sessionId, projection); const supervisor = new RpcChildSupervisor(this.#factory, record, { entry: frame => { const entry = fromRpcEntry(frame.entry as unknown as Record<string, unknown>, this.hostId, record.sessionId); if (entry) projection.appendEntry(entry); }, event: frame => projection.appendEvent({ type: typeof frame.type === "string" ? frame.type : "rpc", ...frame }), crashed: () => { projection.value.ref = { ...projection.value.ref, status: "closed" }; this.#supervisors.delete(record.sessionId); } }, this.#factory instanceof BunRpcChildFactory ? this.#factory.argv() : ["omp", "--mode", "rpc"]); this.#supervisors.set(record.sessionId, supervisor); try { await this.#lockCheck?.(record); await supervisor.start(); } catch { supervisor.stop(); this.#supervisors.delete(record.sessionId); projection.value.ref = { ...projection.value.ref, status: "closed" }; } } }
  private sessionsFrame(): ServerFrame { return { v: "omp-app/1", type: "sessions", cursor: { epoch: this.epoch, seq: 0 }, sessions: [...this.#projections.values()].map(value => value.value.ref) }; }
  private fetch(request: Request, server: Bun.Server<{ socket: ServerWebSocketData }>): Response | undefined { const url = new URL(request.url); if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true, hostId: this.hostId, epoch: this.epoch }); if (url.pathname !== "/ws" || request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Not Found", { status: 404 }); if (server.upgrade(request, { data: { socket: {} } })) return undefined; return new Response("Upgrade Required", { status: 426 }); }
  private async message(ws: ServerWebSocket<{ socket: ServerWebSocketData }>, raw: string | Buffer): Promise<void> { try { const frame = decodeClientFrame(JSON.parse(typeof raw === "string" ? raw : raw.toString())); if (frame.type === "hello") this.hello(ws, frame); else if (frame.type === "ping") ws.send(JSON.stringify({ v: "omp-app/1", type: "pong", nonce: frame.nonce, timestamp: this.#clock.now().toISOString() })); else if (frame.type === "command") ws.send(JSON.stringify((await this.command(frame)).frame)); else ws.send(JSON.stringify({ v: "omp-app/1", type: "error", code: "unsupported", message: "frame is not supported" })); } catch (error) { ws.send(JSON.stringify({ v: "omp-app/1", type: "error", code: "invalid_frame", message: error instanceof Error ? error.message : String(error) })); ws.close(1008, "invalid frame"); } }
  private hello(ws: ServerWebSocket<{ socket: ServerWebSocketData }>, frame: HelloFrame): void { const welcome = { v: "omp-app/1", type: "welcome", selectedProtocol: "omp-app/1", hostId: this.hostId, ompVersion: "local", ompBuild: "local", appserverVersion: "0.1.0", appserverBuild: "local", epoch: this.epoch, grantedCapabilities: [...DEVICE_CAPABILITIES], grantedFeatures: frame.requestedFeatures, negotiatedLimits: { maxPayloadLength: 1024 * 1024, ringSize: this.#ringSize }, resumed: frame.savedCursors.some(cursor => cursor.hostId === this.hostId && cursor.cursor.epoch === this.epoch) }; ws.send(JSON.stringify(welcome)); ws.send(JSON.stringify(this.sessionsFrame())); for (const saved of frame.savedCursors) if (saved.hostId === this.hostId) for (const output of this.replay(saved.sessionId, saved.cursor)) ws.send(JSON.stringify(output)); }
}
interface ServerWebSocketData { socket: Record<string, never>; }
export function createAppserver(options: AppserverOptions = {}): LocalAppserver { return new LocalAppserver(options); }
