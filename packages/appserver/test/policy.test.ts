import { expect, test } from "bun:test";
import type { ClientFrame, CommandFrame, HelloFrame } from "@oh-my-pi/app-wire";
import { TailscaleRemotePolicy } from "../src/remote/policy.ts";
import type { AuthenticatedPrincipal, DeviceRecord, DeviceRegistry, RemotePeerIdentity } from "../src/security/index.ts";
import type { RemoteConnection } from "../src/remote/types.ts";

const identity: RemotePeerIdentity = { nodeId: "node", login: "user@example", hostId: "host", tailnetIp: "100.64.0.2" };
const identityKey = JSON.stringify([identity.nodeId, identity.login, identity.hostId, identity.tailnetIp]);
const record: DeviceRecord = { deviceId: "device", identityKey, capabilities: ["sessions.read", "sessions.control", "files.write", "term.input"], metadata: { label: "test" }, createdAt: 1, lastSeenAt: 1, tokenExpiresAt: 9_999_999, revokedAt: null, epoch: 0 };
class Registry implements DeviceRegistry {
  readonly listeners = new Set<(deviceId: string) => void>();
  readonly active = new Map<string, AuthenticatedPrincipal>();
  current: DeviceRecord = record;
  authenticate(deviceId: string, token: string, _identity: RemotePeerIdentity, connectionId: string): AuthenticatedPrincipal { if (deviceId !== record.deviceId || token !== "token") throw new Error("denied"); const principal = { ...this.current, authenticatedAt: 1, connectionId }; this.active.set(`${connectionId}:${deviceId}`, principal); return principal; }
  get(deviceId: string) { return deviceId === this.current.deviceId ? this.current : null; }
  create() {}
  updateMetadata() {}
  revoke(deviceId: string) { if (deviceId !== this.current.deviceId) return; this.current = { ...this.current, revokedAt: 2, epoch: this.current.epoch + 1 }; for (const key of this.active.keys()) if (key.endsWith(`:${deviceId}`)) this.active.delete(key); for (const listener of this.listeners) listener(deviceId); }
  list() { return [this.current]; }
  close() {}
  getAuthenticatedPrincipal(connectionId: string, deviceId: string) { return this.active.get(`${connectionId}:${deviceId}`) ?? null; }
  onInvalidation(listener: (deviceId: string) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
function connection(connectionId: string, closeCalls: { count: number }): RemoteConnection { return { connectionId, peer: { address: identity.tailnetIp, source: "direct", identity: { ...identity, addresses: [identity.tailnetIp], source: "direct" } }, socket: { connectionId, peer: { address: identity.tailnetIp, source: "direct", identity: { ...identity, addresses: [identity.tailnetIp], source: "direct" } }, send: () => true, close: () => { closeCalls.count += 1; } } }; }
function hello(connectionId: string, capabilities?: string[], requestedFeatures: string[] = []): HelloFrame { return { v: "omp-app/1", type: "hello", protocol: { min: "omp-app/1", max: "omp-app/1" }, client: { name: "test", version: "1", build: "test", platform: "linux" }, requestedFeatures, savedCursors: [], ...(capabilities === undefined ? {} : { capabilities: { client: capabilities } }), authentication: { deviceId: "device", deviceToken: "token" } } as HelloFrame; }
function command(commandId: string, name: string, sessionId = "session", args: Record<string, unknown> = {}): CommandFrame { return { v: "omp-app/1", type: "command", requestId: `request-${commandId}`, commandId, hostId: "host", sessionId, command: name, args } as unknown as CommandFrame; }

test("authenticated capability omission uses the explicit default, while empty is zero", () => {
  const registry = new Registry();
  const policy = new TailscaleRemotePolicy({ registry });
  const omitted = connection("omitted", { count: 0 });
  expect(policy.authenticate(omitted, hello("omitted")).grantedCapabilities).toEqual(["sessions.read", "sessions.control"]);
  const empty = connection("empty", { count: 0 });
  expect(policy.authenticate(empty, hello("empty", [] as string[])).grantedCapabilities).toEqual([]);
  policy.close();
});

test("controller lease feature gates interception and replay is idempotent", () => {
  const registry = new Registry();
  const policy = new TailscaleRemotePolicy({ registry, supportedFeatures: ["controller.lease"] });
  const calls = { count: 0 };
  const connectionValue = connection("lease", calls);
  expect(policy.authenticate(connectionValue, hello("lease", ["sessions.control"], [])).grantedFeatures).toEqual([]);
  const denied = command("acquire-denied", "controller.lease.acquire");
  expect(policy.authorize(connectionValue, denied, { connectionId: "lease", peer: connectionValue.peer })).toBe(false);
  expect(policy.handleCommand(connectionValue, denied)).toBeUndefined();
  const reconnect = connection("lease-ready", calls);
  expect(policy.authenticate(reconnect, hello("lease-ready", ["sessions.control"], ["controller.lease"])).grantedFeatures).toEqual(["controller.lease"]);
  const acquire = command("acquire", "controller.lease.acquire");
  expect(policy.authorize(reconnect, acquire, { connectionId: "lease-ready", peer: reconnect.peer })).toBe(true);
  const first = policy.handleCommand(reconnect, acquire);
  expect(first).toBeDefined();
  expect(policy.authorize(reconnect, acquire, { connectionId: "lease-ready", peer: reconnect.peer })).toBe(true);
  expect(policy.handleCommand(reconnect, acquire)).toEqual(first);
  expect(policy.authorize(reconnect, command("acquire", "controller.lease.acquire", "other"), { connectionId: "lease-ready", peer: reconnect.peer })).toBe(false);
  policy.close();
});

test("registry invalidation closes once and clears authorization state", () => {
  const registry = new Registry();
  const calls = { count: 0 };
  const policy = new TailscaleRemotePolicy({ registry, supportedFeatures: ["controller.lease"] });
  const connectionValue = connection("revoke", calls);
  policy.authenticate(connectionValue, hello("revoke", ["sessions.control"], ["controller.lease"]));
  const acquire = command("acquire", "controller.lease.acquire");
  expect(policy.authorize(connectionValue, acquire, { connectionId: "revoke", peer: connectionValue.peer })).toBe(true);
  registry.revoke("device");
  expect(calls.count).toBe(1);
  expect(policy.authorize(connectionValue, acquire, { connectionId: "revoke", peer: connectionValue.peer })).toBe(false);
  expect(calls.count).toBe(1);
  expect(policy.handleCommand(connectionValue, acquire)).toBeUndefined();
  policy.disconnected(connectionValue);
  policy.disconnected(connectionValue);
  policy.close();
});

test("controller lease gates session mutations for the owning connection and expires", () => {
  let now = 1_000;
  const registry = new Registry();
  const policy = new TailscaleRemotePolicy({ registry, clock: { now: () => now }, supportedFeatures: ["controller.lease"] });
  const owner = connection("mutation-owner", { count: 0 });
  policy.authenticate(owner, hello("mutation-owner", ["sessions.control", "files.write"], ["controller.lease"]));
  const acquire = command("mutation-lease", "controller.lease.acquire", "session");
  expect(policy.authorize(owner, acquire, { connectionId: owner.connectionId, peer: owner.peer })).toBe(true);
  const leaseResponse = policy.handleCommand(owner, acquire);
  const leaseId = String((leaseResponse as { result?: { leaseId?: string } } | undefined)?.result?.leaseId);
  expect(leaseId).not.toBe("undefined");
  const write = command("write", "files.write", "session", { leaseId, path: "file.txt", content: "ok" });
  expect(policy.authorize(owner, write, { connectionId: owner.connectionId, peer: owner.peer })).toBe(true);
  const review = command("review", "review.apply", "session", { leaseId, reviewId: "review" });
  expect(policy.authorize(owner, review, { connectionId: owner.connectionId, peer: owner.peer })).toBe(true);
  const wrongConnection = connection("mutation-other", { count: 0 });
  policy.authenticate(wrongConnection, hello("mutation-other", ["sessions.control", "files.write"], ["controller.lease"]));
  expect(policy.authorize(wrongConnection, command("wrong", "files.write", "session", { leaseId, path: "file.txt", content: "no" }), { connectionId: wrongConnection.connectionId, peer: wrongConnection.peer })).toBe(false);
  now += 31_000;
  expect(policy.authorize(owner, command("expired", "files.write", "session", { leaseId, path: "file.txt", content: "late" }), { connectionId: owner.connectionId, peer: owner.peer })).toBe(false);
  policy.close();
});

test("terminal input needs terminal.io even when term.input is granted", () => {
  const registry = new Registry();
  const policy = new TailscaleRemotePolicy({ registry, supportedFeatures: ["controller.lease"] });
  const connectionValue = connection("terminal", { count: 0 });
  policy.authenticate(connectionValue, hello("terminal", ["term.input"], []));
  const terminal = { v: "omp-app/1", type: "terminal.input", hostId: "host", sessionId: "session", terminalId: "terminal", data: "x" } as unknown as ClientFrame;
  expect(policy.authorize(connectionValue, terminal, { connectionId: "terminal", peer: connectionValue.peer })).toBe(false);
  policy.close();
});
