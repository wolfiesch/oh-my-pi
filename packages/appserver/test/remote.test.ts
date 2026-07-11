import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { decodeServerFrame, requestId, type HelloFrame, type PairStartFrame, type ServerFrame } from "@oh-my-pi/app-wire";
import { runAppserverPair } from "../../coding-agent/src/cli/appserver-cli.ts";
import { createAppserver } from "../src/server.ts";
import { LocalPairingTicketIssuer, SqliteDeviceRegistry } from "../src/security/index.ts";
import { TailscaleRemotePolicy } from "../src/remote/policy.ts";
import { TailscaleWhoisResolver } from "../src/remote/resolver.ts";
import { createListenerPlan, createServeProxyPlan, directPeer, isTailnetAddress, originAllowed, resolveServePeer } from "../src/remote/listener.ts";

describe("remote address policy", () => {
  test("accepts Tailscale IPv4/IPv6 edges and rejects wildcard/LAN/loopback", () => {
    expect(isTailnetAddress("::ffff:100.64.0.1")).toBe(true); expect(directPeer("::ffff:100.64.0.1", "n").address).toBe("100.64.0.1"); expect(() => createListenerPlan({ mode: "direct", address: "::ffff:100.64.0.1", port: 1 } as never)).toThrow();
    expect(() => createListenerPlan({ address: "0.0.0.0", port: 1 })).toThrow(); expect(createListenerPlan({ address: "100.64.0.1", port: 443 }).path).toBe("/v1/ws"); expect(() => createServeProxyPlan({ address: "100.64.0.1", port: 80, serveProxy: true })).toThrow();
  });
  test("Serve headers require loopback trusted proxy and complete validated identity", () => {
    const headers = new Headers({ "Tailscale-Node-ID": "node", "Tailscale-Node-Name": "host", "Tailscale-User-Login": "u@example", "Tailscale-Client-IP": "100.64.0.1" });
    expect(resolveServePeer("127.0.0.1", headers, true)?.identity.nodeId).toBe("node"); expect(resolveServePeer("10.0.0.1", headers, true)).toBeUndefined(); expect(resolveServePeer("127.0.0.1", headers, false)).toBeUndefined(); expect(resolveServePeer("127.0.0.1", new Headers({ ...Object.fromEntries(headers), "Tailscale-Client-IP": "127.0.0.1" }), true)).toBeUndefined();
    expect(directPeer("100.64.0.2", "node").source).toBe("direct"); expect(() => directPeer("127.0.0.1", "node")).toThrow();
  });
});
  test("origin policy is exact allowlist and denies browser wildcard", () => { expect(originAllowed(null)).toBe(true); expect(originAllowed("https://app.example", ["https://app.example"])).toBe(true); expect(originAllowed("https://evil.example", ["https://app.example"])).toBe(false); });

describe("bounded tailscale whois", () => {
  test("uses fixed argv and parses strict identity", async () => {
    const calls: string[][] = []; const resolver = new TailscaleWhoisResolver({ run: async (argv) => { calls.push(argv); return { exitCode: 0, stdout: JSON.stringify({ Node: { StableID: "node", Name: "host", ComputedName: "host.tail", Addresses: ["100.64.0.1/32", "fd7a:115c:a1e0::1/128"] }, UserProfile: { LoginName: "u" } }) }; } });
    await expect(resolver.resolve("100.64.0.1")).resolves.toMatchObject({ nodeId: "node", hostname: "host.tail", user: "u", addresses: ["100.64.0.1", "fd7a:115c:a1e0::1"] }); expect(calls[0]).toEqual(["tailscale", "whois", "--json", "100.64.0.1"]);
  });
  test("rejects injection, bad JSON, failure, and oversized output", async () => {
    const runner = { run: async () => ({ exitCode: 0, stdout: "{" }) }; await expect(new TailscaleWhoisResolver(runner).resolve("100.64.0.1")).rejects.toThrow(); await expect(new TailscaleWhoisResolver(runner).resolve("100.64.0.1; rm -rf /")).rejects.toThrow(); await expect(new TailscaleWhoisResolver({ run: async () => ({ exitCode: 1, stdout: "" }) }).resolve("100.64.0.1")).rejects.toThrow();
  });
});
async function udsAdmin(socketPath: string, path: string, method: "GET" | "POST", body?: Record<string, unknown>): Promise<unknown> {
	const gate = Promise.withResolvers<unknown>();
	const payload = body === undefined ? undefined : JSON.stringify(body);
	const request = http.request({ socketPath, path, method, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : undefined }, response => {
		const chunks: Buffer[] = [];
		response.on("data", chunk => chunks.push(Buffer.from(chunk)));
		response.on("end", () => {
			try { gate.resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { gate.reject(error); }
		});
		response.on("error", gate.reject);
	});
	request.on("error", gate.reject);
	if (payload) request.write(payload);
	request.end();
	return gate.promise;
}

test("remote welcome preserves protocol authentication state while redacting nested secrets", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-remote-policy-"));
	const registry = new SqliteDeviceRegistry(join(root, "devices.sqlite"));
	const policy = new TailscaleRemotePolicy({ registry });
	const connection = {
		connectionId: "welcome-connection",
		peer: { address: "100.64.0.2", source: "direct" as const, identity: { nodeId: "node-1", addresses: ["100.64.0.2"], source: "direct" as const } },
		socket: { connectionId: "welcome-connection", peer: undefined as never, send: () => true, close: () => undefined },
	};
	try {
		const hello: HelloFrame = { v: "omp-app/1", type: "hello", protocol: { min: "1", max: "1" }, client: { name: "test", version: "1", build: "test", platform: "linux" }, requestedFeatures: [], savedCursors: [] };
		expect(policy.authenticate(connection, hello).authentication).toBe("pairing-required");
		const frame = {
			v: "omp-app/1", type: "welcome", selectedProtocol: "omp-app/1", hostId: "host", ompVersion: "1", ompBuild: "test",
			appserverVersion: "1", appserverBuild: "test", epoch: "epoch", grantedCapabilities: [], grantedFeatures: [],
			negotiatedLimits: { authentication: "nested-auth", token: "nested-token", deviceToken: "nested-device-token" },
			authentication: "pairing-required", resumed: false,
		} as unknown as ServerFrame;
		const outbound = policy.transformOutbound(connection, frame);
		expect(outbound?.type).toBe("welcome");
		expect((outbound as Record<string, unknown>).authentication).toBe("pairing-required");
		expect((outbound as Extract<ServerFrame, { type: "welcome" }>).negotiatedLimits).toEqual({ authentication: "[redacted]", token: "[redacted]", deviceToken: "[redacted]" });
		expect(decodeServerFrame(outbound)).toMatchObject({ type: "welcome", authentication: "pairing-required" });
		const response = {
			v: "omp-app/1", type: "response", requestId: "request-1", commandId: "command-1",
			command: "controller.lease.acquire", hostId: "host", ok: true,
			result: { leaseId: "lease-1", owner: "owner", deviceId: "device-1", connectionId: "welcome-connection", expiresAt: 1 },
		} as unknown as ServerFrame;
		const responseOutbound = policy.transformOutbound(connection, response)!;
		expect((responseOutbound as Record<string, unknown>).command).toBe("controller.lease.acquire");
		expect(decodeServerFrame(responseOutbound)).toMatchObject({ type: "response", command: "controller.lease.acquire" });
	} finally {
		policy.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("pair CLI admin ticket reaches the in-process issuer and is one-use across reconnect", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-admin-e2e-"));
	const registry = new SqliteDeviceRegistry(join(root, "devices.sqlite"));
	const issuer = new LocalPairingTicketIssuer(registry, new Uint8Array(32).fill(7));
	const policy = new TailscaleRemotePolicy({ registry, localPairing: issuer });
	const appserver = createAppserver({
		socketPath: join(root, "app.sock"),
		remotePolicy: policy,
		admin: {
			issuePairingTicket: (capabilities, ttlMs, nodeId) => policy.issuePairingTicket(capabilities, ttlMs, nodeId),
			listDevices: () => policy.listDeviceSummaries(),
			revokeDevice: deviceId => policy.revokeDevice(deviceId),
		},
	});
	await appserver.start();
	const originalWrite = process.stdout.write;
	let output = "";
	process.stdout.write = ((chunk: string | Uint8Array) => { output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk); return true; }) as typeof process.stdout.write;
	try {
		await runAppserverPair({ socketPath: () => appserver.socketPath, adminRequest: udsAdmin }, { json: true, capabilities: ["sessions.read"], ttlSeconds: 30 });
	} finally {
		process.stdout.write = originalWrite;
	}
	const ticket = JSON.parse(output) as { code: string };
	const connection = {
		connectionId: "connection-1",
		peer: { address: "100.64.0.2", source: "direct" as const, identity: { nodeId: "node-1", addresses: ["100.64.0.2"], source: "direct" as const } },
		socket: { connectionId: "connection-1", peer: { address: "100.64.0.2", source: "direct" as const, identity: { nodeId: "node-1", addresses: ["100.64.0.2"], source: "direct" as const } }, send: () => true, close: () => undefined },
	};
	const hello: HelloFrame = { v: "omp-app/1", type: "hello", protocol: { min: "1", max: "1" }, client: { name: "test", version: "1", build: "test", platform: "linux" }, requestedFeatures: [], savedCursors: [] };
	expect(policy.authenticate(connection, hello).authentication).toBe("pairing-required");
	const frame: PairStartFrame = { v: "omp-app/1", type: "pair.start", requestId: requestId("pair-request"), code: ticket.code, deviceId: "device-1", deviceName: "test", platform: "test", requestedCapabilities: ["sessions.read"] };
	expect(policy.pairStart(connection, frame)?.type).toBe("pair.ok");
	expect(policy.pairStart({ ...connection, connectionId: "connection-2" }, frame)).toBeUndefined();
	await appserver.stop();
	policy.close();
	await rm(root, { recursive: true, force: true });
});
