import { isIP } from "node:net";
import type { ListenerPeerContext, ListenerPlan, RemoteConnectionHooks, RemoteListenerConfig, RemotePeerIdentity } from "./types.ts";

export function normalizeIpAddress(address: string): string { return address.startsWith("::ffff:") && isIP(address) === 6 && isIP(address.slice(7)) === 4 ? address.slice(7) : address; }
function ipv4(value: string): number[] | undefined { if (isIP(value) !== 4) return undefined; const parts = value.split(".").map(Number); return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : undefined; }
function ipv6(value: string): bigint | undefined {
  if (isIP(value) !== 6) return undefined;
  const pieces = value.split("::"); if (pieces.length > 2) return undefined;
  const left = pieces[0] ? pieces[0].split(":") : []; const right = pieces[1] ? pieces[1].split(":") : []; const count = left.length + right.length; if ((!pieces[1] && count !== 8) || (pieces[1] && count >= 8)) return undefined;
  const words = [...left, ...Array(8 - count).fill("0"), ...right].map(piece => Number.parseInt(piece, 16)); if (words.some(word => !Number.isInteger(word) || word < 0 || word > 0xffff)) return undefined;
  return words.reduce((result, word) => (result << 16n) | BigInt(word), 0n);
}
export function isTailnetAddress(address: string): boolean {
  const normalized = normalizeIpAddress(address); const v4 = ipv4(normalized); if (v4) return v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127;
  const v6 = ipv6(normalized); return v6 !== undefined && (v6 >> 80n) === 0xfd7a115ca1e0n;
}
export function createListenerPlan(config: RemoteListenerConfig): ListenerPlan {
  if (!isTailnetAddress(config.address) || normalizeIpAddress(config.address) !== config.address) throw new Error("direct listener address must be an explicit Tailscale address");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("listener port is invalid");
  return { mode: "direct", address: config.address, port: config.port, path: "/v1/ws", trustedServeProxy: false };
}
export function originAllowed(origin: string | null, allowlist: readonly string[] = []): boolean { return origin === null || allowlist.includes(origin); }
export function createServeProxyPlan(config: RemoteListenerConfig): ListenerPlan {
  if (config.address !== "127.0.0.1" && config.address !== "::1") throw new Error("Serve proxy must bind loopback");
  if (config.trustedServeProxy !== true) throw new Error("Serve proxy requires trustedServeProxy");
  return { mode: "serve", address: config.address, port: config.port, path: "/v1/ws", trustedServeProxy: config.trustedServeProxy === true };
}
export function resolveServePeer(remoteAddress: string, headers: Headers, trustedServeProxy: boolean): ListenerPeerContext | undefined {
  if (!trustedServeProxy || (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1")) return undefined;
  const nodeId = headers.get("Tailscale-Node-ID"); const hostname = headers.get("Tailscale-Node-Name"); const user = headers.get("Tailscale-User-Login"); const address = headers.get("Tailscale-Client-IP");
  if (!nodeId || !hostname || !user || !address || !isTailnetAddress(address)) return undefined;
  return { address, source: "serve", identity: { nodeId, hostname, user, addresses: [address], source: "serve" } };
}
export function directPeer(address: string, nodeId: string): ListenerPeerContext { const normalized = normalizeIpAddress(address); if (!isTailnetAddress(normalized)) throw new Error("peer is not a Tailscale address"); return { address: normalized, source: "direct", identity: { nodeId, addresses: [normalized], source: "direct" } }; }
type RunState = { stopping: boolean; pending: number; peers: Map<Bun.ServerWebSocket<{ peer: ListenerPeerContext; reserved: boolean; opened: boolean }>, ListenerPeerContext>; server?: Bun.Server<{ peer: ListenerPeerContext; reserved: boolean; opened: boolean }> };
export class BunRemoteListener {
  #run?: RunState;
  constructor(private readonly plan: ListenerPlan, private readonly hooks: RemoteConnectionHooks, private readonly config: RemoteListenerConfig, private readonly resolver?: { resolve(address: string): Promise<RemotePeerIdentity> }) {}
  start(): void {
    if (this.#run) throw new Error("remote listener already started");
    const run: RunState = { stopping: false, pending: 0, peers: new Map() }; this.#run = run;
    const maxConnections = this.config.maxConnections ?? 32; const maxFrameBytes = this.config.maxFrameBytes ?? 1024 * 1024;
    run.server = Bun.serve<{ peer: ListenerPeerContext; reserved: boolean; opened: boolean }>({ hostname: this.plan.address, port: this.plan.port, fetch: async (request, server) => {
      const url = new URL(request.url); if (url.pathname === "/healthz" && request.method === "GET") return Response.json({ ok: true }); if (url.pathname !== this.plan.path) return new Response("Not Found", { status: 404 }); if (!originAllowed(request.headers.get("origin"), this.config.originAllowlist)) return new Response("Forbidden", { status: 403 }); if (run.peers.size + run.pending >= maxConnections) return new Response("Busy", { status: 503 }); run.pending++; let upgraded = false;
      try {
        const requested = server.requestIP(request)?.address; if (!requested) return new Response("Unauthorized", { status: 401 }); const address = normalizeIpAddress(requested);
        let peer: ListenerPeerContext | undefined;
        if (this.plan.mode === "direct") { if (!isTailnetAddress(address) || !this.resolver) return new Response("Unauthorized", { status: 401 }); const identity = await this.resolver.resolve(address); peer = { address, source: "direct", identity }; }
        else { peer = resolveServePeer(address, request.headers, this.plan.trustedServeProxy); if (!peer) return new Response("Forbidden", { status: 403 }); }
        if (!server.upgrade(request, { data: { peer, reserved: true, opened: false } })) return new Response("Upgrade Required", { status: 426 }); upgraded = true; return undefined;
      } catch { return new Response("Unauthorized", { status: 401 }); } finally { if (!upgraded) run.pending--; }
    }, websocket: { maxPayloadLength: maxFrameBytes, idleTimeout: this.config.idleTimeoutSeconds ?? 120, backpressureLimit: this.config.backpressureLimit ?? 1024 * 1024, closeOnBackpressureLimit: true, perMessageDeflate: false, open: ws => { if (this.#run !== run || run.stopping) { ws.data.reserved = false; ws.close(1001, "listener stopping"); return; } if (ws.data.reserved) { ws.data.reserved = false; run.pending--; } ws.data.opened = true; run.peers.set(ws, ws.data.peer); try { void this.hooks.connected?.(ws.data.peer)?.catch(() => ws.close(1011, "hook failure")); } catch { ws.close(1011, "hook failure"); } }, message: (ws, message) => { if (this.#run !== run || run.stopping) return; try { const result = this.hooks.message?.(ws.data.peer, typeof message === "string" ? message : new Uint8Array(message)); if (result) void result.catch(() => ws.close(1011, "hook failure")); } catch { ws.close(1011, "hook failure"); } }, close: ws => { if (ws.data.reserved) { ws.data.reserved = false; run.pending--; } run.peers.delete(ws); if (!ws.data.opened) return; try { const result = this.hooks.disconnected?.(ws.data.peer); if (result) void result.catch(() => {}); } catch {} } } });
  }
  async stop(): Promise<void> { const run = this.#run; if (!run) return; run.stopping = true; for (const ws of run.peers.keys()) ws.close(1001, "listener stopping"); run.server?.stop(true); run.server = undefined; run.peers.clear(); run.pending = 0; if (this.#run === run) this.#run = undefined; }
}
