import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createAppserver } from "../src/server.ts";
import { BunRemoteListener, createListenerPlan } from "../src/remote/listener.ts";
import type { ListenerPeerContext, RemoteConnection, RemoteConnectionHooks, RemoteListenerConfig, RemotePeerIdentity } from "../src/remote/types.ts";
import type { AppserverOptions } from "../src/types.ts";
import type { DesktopOperationsAuthority } from "../src/operations/dispatcher.ts";

type FakeClose = { code?: number; reason?: string };
type FakeSocketData = { peer: ListenerPeerContext; connectionId: string; reserved: boolean; opened: boolean };
type FakeWebSocket = {
	data: FakeSocketData;
	sends: string[];
	closes: FakeClose[];
	sendResult: number;
	send(text: string): number;
	close(code?: number, reason?: string): void;
};
type FakeServeConfig = {
	unix?: string;
	hostname?: string;
	fetch?: (request: Request, server: FakeBunServer) => Response | undefined | Promise<Response | undefined>;
	websocket?: {
		open?(socket: FakeWebSocket): void;
		message?(socket: FakeWebSocket, message: string | Uint8Array): void;
		close?(socket: FakeWebSocket): void;
	};
};
class FakeBunServer {
	readonly config: FakeServeConfig;
	readonly stopCalls: boolean[] = [];
	lastUpgrade?: { data: FakeSocketData };
	constructor(config: FakeServeConfig) { this.config = config; }
	requestIP(): { address: string } { return { address: "100.64.0.1" }; }
	upgrade(_request: Request, options: { data: FakeSocketData }): boolean { this.lastUpgrade = options; return true; }
	stop(force?: boolean): void { this.stopCalls.push(force === true); }
}
class FakeBunHarness {
	readonly servers: FakeBunServer[] = [];
	readonly original = (Bun as unknown as { serve: (config: unknown) => unknown }).serve;
	install(): void {
		const api = Bun as unknown as { serve: (config: unknown) => unknown };
		api.serve = (unknownConfig: unknown): unknown => {
			const config = unknownConfig as FakeServeConfig;
			if (config.unix) writeFileSync(config.unix, "");
			const server = new FakeBunServer(config);
			this.servers.push(server);
			return server;
		};
	}
	restore(): void { (Bun as unknown as { serve: (config: unknown) => unknown }).serve = this.original; }
	remote(): FakeBunServer {
		const server = this.servers.find(candidate => candidate.config.hostname !== undefined);
		if (!server) throw new Error("remote fake server missing");
		return server;
	}
	local(): FakeBunServer {
		const server = this.servers.find(candidate => candidate.config.unix !== undefined);
		if (!server) throw new Error("local fake server missing");
		return server;
	}
}
class FakeSocket implements FakeWebSocket {
	data!: FakeSocketData;
	sends: string[] = [];
	closes: FakeClose[] = [];
	sendResult = 1;
	send(text: string): number { this.sends.push(text); return this.sendResult; }
	close(code?: number, reason?: string): void { this.closes.push({ code, reason }); }
}
function peerIdentity(nodeId: string): RemotePeerIdentity { return { nodeId, hostname: `${nodeId}.tail`, user: `${nodeId}@example`, addresses: ["100.64.0.1"], source: "tailscale" }; }
function hello(requestedFeatures: string[] = ["resume"]): string {
	return JSON.stringify({ v: "omp-app/1", type: "hello", protocol: { min: "omp-app/1", max: "omp-app/1" }, client: { name: "test", version: "1", build: "b", platform: "linux" }, requestedFeatures, savedCursors: [] });
}
function listCommand(requestId: string): string {
	return JSON.stringify({ v: "omp-app/1", type: "command", requestId, commandId: `command-${requestId}`, hostId: "host", command: "session.list", args: {} });
}
function ping(): string { return JSON.stringify({ v: "omp-app/1", type: "ping", nonce: "nonce", timestamp: "2026-01-01T00:00:00.000Z" }); }

async function flush(): Promise<void> { for (let index = 0; index < 20; index++) await Promise.resolve(); }
async function openRemote(server: FakeBunServer): Promise<FakeSocket> {
	if (!server.config.fetch || !server.config.websocket?.open) throw new Error("remote config incomplete");
	await server.config.fetch(new Request("http://remote.test/v1/ws"), server);
	const socket = new FakeSocket();
	const upgrade = server.lastUpgrade;
	if (!upgrade) throw new Error("remote upgrade missing");
	socket.data = upgrade.data;
	server.config.websocket.open(socket);
	return socket;
}
function operations(methods: Partial<Record<keyof DesktopOperationsAuthority, true>> = {}): DesktopOperationsAuthority {
	const authority: DesktopOperationsAuthority = {};
	for (const method of Object.keys(methods) as (keyof DesktopOperationsAuthority)[]) {
		const value = methods[method];
		if (value === true) authority[method] = async () => ({}) as never;
	}
	return authority;
}

async function grantedFeatures(options: AppserverOptions): Promise<string[]> {
	const harness = new FakeBunHarness();
	harness.install();
	try {
		const appserver = createAppserver(options);
		await appserver.start();
		const local = harness.local();
		const socket = new FakeSocket();
		local.config.websocket?.open?.(socket);
		await local.config.websocket?.message?.(socket, hello(["resume", "catalog.metadata", "settings.metadata", "terminal.io", "files.list", "files.diff", "preview.control"]));
		await flush();
		const welcome = JSON.parse(socket.sends[0] ?? "{}") as { grantedFeatures?: unknown };
		const features = welcome.grantedFeatures;
		if (!Array.isArray(features) || !features.every((feature): feature is string => typeof feature === "string")) throw new Error("feature welcome missing");
		await appserver.stop();
		return features;
	} finally { harness.restore(); }
}

describe("remote socket lifecycle", () => {
	test("IDs are unique, peer snapshots immutable, sends are bounded, and close cleans the map", async () => {
		const harness = new FakeBunHarness();
		try {
		harness.install();
			const disconnected: string[] = [];
			const connected: RemoteConnection[] = [];
			const hooks: RemoteConnectionHooks = { connected: connection => { connected.push(connection); }, disconnected: connection => { disconnected.push(connection.connectionId); } };
			const listener = new BunRemoteListener(createListenerPlan({ address: "100.64.0.1", port: 1 }), hooks, { address: "100.64.0.1", port: 1 }, { resolve: async () => peerIdentity("node") });
			listener.start();
			const server = harness.remote();
			const first = await openRemote(server);
			const second = await openRemote(server);
			expect(first.data.connectionId).not.toBe(second.data.connectionId);
			const firstConnection = connected[0];
			if (!firstConnection) throw new Error("first connection missing");
			expect(Reflect.set(first.data.peer.identity, "nodeId", "changed")).toBe(false);
			expect(first.data.peer.identity.addresses).toEqual(["100.64.0.1"]);
			first.sendResult = 0;
			expect(firstConnection.socket.send("frame")).toBe(false);
			firstConnection.socket.close(1000, "closed");
			expect(first.closes).toHaveLength(1);
			expect(firstConnection.socket.send("late")).toBe(false);
			server.config.websocket?.close?.(first);
			server.config.websocket?.close?.(first);
			expect(disconnected).toEqual([first.data.connectionId]);
			await listener.stop();
			expect(second.closes).toHaveLength(1);
		} finally { harness.restore(); }
	});
});

describe("remote appserver policy transport", () => {
	test("auth precedes Welcome and authorization precedes command dispatch; denied frames close without responses", async () => {
		const harness = new FakeBunHarness();
		harness.install();
		const calls: string[] = [];
		try {
			const appserver = createAppserver({
				hostId: "host" as never,
				socketPath: join(mkdtempSync(join(tmpdir(), "omp-proof-")), "app.sock"),
				discovery: { list: async () => [] },
				remoteEndpoint: { address: "100.64.0.1", port: 1 },
				remoteResolver: { resolve: async () => peerIdentity("node") },
				remotePolicy: {
					authenticate: async () => { calls.push("authenticate"); return { authenticated: true, authentication: "paired" }; },
					authorize: async (_connection, frame) => { calls.push(`authorize:${frame.type}`); return frame.type !== "command"; },
				},
			});
			await appserver.start();
			const server = harness.remote();
			const socket = await openRemote(server);
			await server.config.websocket?.message?.(socket, hello());
			await flush();
			expect(calls).toEqual(["authenticate"]);
			const welcomeCount = socket.sends.length;
			await server.config.websocket?.message?.(socket, listCommand("denied"));
			await flush();
			expect(calls).toEqual(["authenticate", "authorize:command"]);
			expect(socket.sends).toHaveLength(welcomeCount);
			expect(socket.closes.at(-1)).toMatchObject({ code: 1008, reason: "remote policy denied" });
			expect((socket.closes.at(-1)?.reason ?? "").length).toBeLessThanOrEqual(123);
			await appserver.stop();
		} finally { harness.restore(); }
	});

	test("authentication rejection sends no Welcome or core state", async () => {
		const harness = new FakeBunHarness();
		harness.install();
		try {
			const appserver = createAppserver({ hostId: "host" as never, socketPath: join(mkdtempSync(join(tmpdir(), "omp-proof-")), "app.sock"), discovery: { list: async () => [] }, remoteEndpoint: { address: "100.64.0.1", port: 1 }, remoteResolver: { resolve: async () => peerIdentity("node") }, remotePolicy: { authenticate: async () => ({ authenticated: false }), authorize: async () => true } });
			await appserver.start();
			const server = harness.remote();
			const socket = await openRemote(server);
			await server.config.websocket?.message?.(socket, hello());
			expect(socket.sends).toEqual([]);
			expect(socket.closes).toEqual([{ code: 1008, reason: "remote authentication denied" }]);
			await appserver.stop();
		} finally { harness.restore(); }
	});

	test("outbound transforms run once, deny drops, and throw fails closed without raw leakage", async () => {
		const harness = new FakeBunHarness();
		harness.install();
		let transforms = 0;
		try {
			const appserver = createAppserver({ hostId: "host" as never, socketPath: join(mkdtempSync(join(tmpdir(), "omp-proof-")), "app.sock"), discovery: { list: async () => [] }, remoteEndpoint: { address: "100.64.0.1", port: 1 }, remoteResolver: { resolve: async () => peerIdentity("node") }, remotePolicy: { authenticate: async () => ({ authenticated: true }), authorize: async () => true, transformOutbound: async (_connection, frame) => { transforms++; if (frame.type === "sessions") return undefined; if (frame.type === "pong") throw new Error("deny"); return frame; } } });
			await appserver.start();
			const server = harness.remote();
			const socket = await openRemote(server);
			await server.config.websocket?.message?.(socket, hello());
			await flush();
			expect(transforms).toBe(2);
			expect(socket.sends).toHaveLength(1);
			await server.config.websocket?.message?.(socket, ping());
			await flush();
			expect(transforms).toBe(3);
			expect(socket.sends).not.toContain(expect.stringContaining("\"type\":\"pong\""));
			expect(socket.closes).toEqual([{ code: 1011, reason: "remote policy failed" }]);
			await appserver.stop();
		} finally { harness.restore(); }
	});

	test("concurrent connections keep responses isolated and listener stop closes each once before local cleanup", async () => {
		const harness = new FakeBunHarness();
		harness.install();
		const order: string[] = [];
		try {
			const appserver = createAppserver({ hostId: "host" as never, socketPath: join(mkdtempSync(join(tmpdir(), "omp-proof-")), "app.sock"), discovery: { list: async () => [] }, remoteEndpoint: { address: "100.64.0.1", port: 1 }, remoteResolver: { resolve: async () => peerIdentity("node") }, remotePolicy: { authenticate: async connection => ({ authenticated: true, authentication: "paired", deviceId: connection.connectionId }), authorize: async () => true, transformOutbound: async (connection, frame) => ({ ...frame, marker: connection.connectionId }) } });
			await appserver.start();
			const remote = harness.remote();
			const first = await openRemote(remote);
			const second = await openRemote(remote);
			await remote.config.websocket?.message?.(first, hello());
			await flush();
			await remote.config.websocket?.message?.(second, hello());
			await flush();
			const firstFrames = first.sends.map(text => JSON.parse(text) as Record<string, unknown>);
			const secondFrames = second.sends.map(text => JSON.parse(text) as Record<string, unknown>);
			expect(firstFrames.every(frame => frame.marker === first.data.connectionId)).toBe(true);
			expect(secondFrames.every(frame => frame.marker === second.data.connectionId)).toBe(true);
			remote.config.websocket?.close?.(first);
			await remote.config.websocket?.message?.(second, listCommand("second"));
			await flush();
			expect(second.sends.length).toBeGreaterThan(secondFrames.length);
			order.push("remote-stop");
			await appserver.stop();
			expect(first.closes).toHaveLength(0);
			expect(second.closes).toHaveLength(1);
			expect(harness.local().stopCalls).toEqual([true]);
		} finally { harness.restore(); }
		expect(order).toEqual(["remote-stop"]);
	});
});

describe("default feature authority matrix", () => {
	test("resume is always available and additive features require coherent handlers", async () => {
		const base = { hostId: "host" as never, socketPath: join(mkdtempSync(join(tmpdir(), "omp-feature-")), "app.sock") };
		await expect(grantedFeatures({ ...base })).resolves.toEqual(["resume"]);
		const full = operations({ catalogGet: true, settingsRead: true, termOpen: true, terminalInput: true, terminalResize: true, terminalClose: true, filesList: true, filesDiff: true, previewLaunch: true, previewState: true, previewNavigate: true, previewCapture: true });
		await expect(grantedFeatures({ ...base, socketPath: join(mkdtempSync(join(tmpdir(), "omp-feature-")), "app.sock"), operationsAuthority: full })).resolves.toEqual(["resume", "catalog.metadata", "settings.metadata", "terminal.io", "files.list", "files.diff", "preview.control"]);
		const incomplete = operations({ termOpen: true });
		await expect(grantedFeatures({ ...base, socketPath: join(mkdtempSync(join(tmpdir(), "omp-feature-")), "app.sock"), operationsAuthority: incomplete })).resolves.toEqual(["resume"]);
		await expect(grantedFeatures({ ...base, socketPath: join(mkdtempSync(join(tmpdir(), "omp-feature-")), "app.sock"), operationsAuthority: full, supportedFeatures: ["files.list", "catalog.metadata", "resume", "host.watch"] })).resolves.toEqual(["resume", "catalog.metadata", "files.list"]);
	});
});
