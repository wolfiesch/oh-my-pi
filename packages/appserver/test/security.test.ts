import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  DefaultAuthorizationGuard,
  InMemoryDeviceRegistry,
  DefaultRedactor,
  JsonlAuditSink,
  LeaseRegistry,
  OutboundQueue,
  SecureConfirmationStore,
  SqliteDeviceRegistry,
  SqlitePairingService,
  TokenBucketLimiter,
} from "../src/security/index.ts";

let dbPath = "";
const identity = { nodeId: "node-a", login: "alice@example.com", hostId: "host-a", tailnetIp: "100.64.0.2" };
const clock = { value: 1_000, now() { return this.value; } };

beforeAll(() => { dbPath = `/tmp/omp-security-${process.pid}.sqlite`; });
afterAll(async () => { await unlink(dbPath).catch(() => undefined); });

describe("security core", () => {
  it("pairs once and authenticates a returned token without storing plaintext", () => {
    const registry = new SqliteDeviceRegistry(dbPath, clock);
    const pairing = new SqlitePairingService(registry, clock, { bytes: (n) => new Uint8Array(n).fill(7) });
    const grant = pairing.start("connection-a", ["sessions.read"]);
    const result = pairing.complete("connection-a", grant.code, identity, { label: "device" }, ["sessions.read"]);
    expect(registry.authenticate(result.deviceId, result.token, identity, "connection-a").deviceId).toBe(result.deviceId);
    expect(() => registry.authenticate(result.deviceId, "wrong", identity, "connection-a")).toThrow();
    registry.close();
  });

  it("binds authorization to the authenticated capability intersection", () => {
    const principal = { deviceId: "d", identityKey: "i", capabilities: ["sessions.read"] as const, metadata: { label: "d" }, createdAt: 1, lastSeenAt: 1, revokedAt: null, epoch: 0, authenticatedAt: 1, connectionId: "c" };
    const registry = new InMemoryDeviceRegistry();
    registry.create(principal, "token");
    const guard = new DefaultAuthorizationGuard(registry);
    const base = { principal, connectionId: "c", capabilities: ["sessions.read"] as const, args: {} };
    expect(() => guard.authorize({ ...base, command: "host.list" })).not.toThrow();
    expect(() => guard.authorize({ ...base, command: "session.prompt", sessionId: "s" })).toThrow();
  });

  it("expires and releases a single-owner lease", () => {
    const leases = new LeaseRegistry(clock, { bytes: (n) => new Uint8Array(n).fill(3) });
    leases.acquire("s", "owner", "controller", 10);
    expect(() => leases.acquire("s", "other", "controller")).toThrow();
    clock.value += 11;
    expect(() => leases.acquire("s", "other", "controller")).not.toThrow();
    leases.disconnect("other");
  });

  it("consumes confirmations once and redacts nested secrets", () => {
    const confirmations = new SecureConfirmationStore(clock);
    const grant = confirmations.issue({ connectionId: "c", deviceId: "d", command: "files.write", sessionId: "s", argsDigest: "a", epoch: 0 });
    confirmations.consume(grant.id, { connectionId: "c", deviceId: "d", command: "files.write", sessionId: "s", argsDigest: "a", epoch: 0 });
    expect(() => confirmations.consume(grant.id, { connectionId: "c", deviceId: "d", command: "files.write", sessionId: "s", argsDigest: "a", epoch: 0 })).toThrow();
    expect(new DefaultRedactor().redact({ auth: { token: "secret" }, nested: [{ password: "x" }] })).toEqual({ auth: "[redacted]", nested: [{ password: "[redacted]" }] });
  });

  it("rate limits and never drops terminal queue messages", () => {
    const limiter = new TokenBucketLimiter(1, 0, clock);
    expect(limiter.allow("ip")).toBe(true);
    expect(limiter.allow("ip")).toBe(false);
    const queue = new OutboundQueue(10);
    queue.push({ kind: "result", bytes: 8, payload: "done" });
    expect(() => queue.push({ kind: "event", bytes: 8, payload: "drop-me" })).toThrow();
    expect(queue.shift()?.kind).toBe("result");
  });

  it("writes redacted JSONL audit values", async () => {
    const path = `/tmp/omp-security-audit-${process.pid}.jsonl`;
    const sink = new JsonlAuditSink(path);
    await sink.write({ command: "x", token: "secret-canary" });
    const text = await Bun.file(path).text();
    expect(text).not.toContain("secret-canary");
    await unlink(path).catch(() => undefined);
  });
});
it("rejects expired or replayed pairing and mismatched identity", () => {
  const localClock = { value: 100, now() { return this.value; } };
  const registry = new InMemoryDeviceRegistry(localClock);
  const pairing = new SqlitePairingService(registry, localClock, { bytes: (n) => new Uint8Array(n).fill(9) });
  const grant = pairing.start("c", ["sessions.read"], 10);
  localClock.value = 111;
  expect(() => pairing.complete("c", grant.code, identity, { label: "x" }, ["sessions.read"])).toThrow();
});

it("invalidates an authenticated principal after revoke epoch change", () => {
  const localClock = { value: 100, now() { return this.value; } };
  const registry = new InMemoryDeviceRegistry(localClock);
  const record = { deviceId: "d2", identityKey: JSON.stringify([identity.nodeId, identity.login, identity.hostId, identity.tailnetIp]), capabilities: ["sessions.read"] as const, metadata: { label: "x" }, createdAt: 1, lastSeenAt: 1, revokedAt: null, epoch: 0 };
  registry.create(record, "token");
  const principal = registry.authenticate("d2", "token", identity, "c");
  registry.revoke("d2");
  const guard = new DefaultAuthorizationGuard(registry);
  expect(() => guard.authorize({ principal, connectionId: "c", command: "host.list", capabilities: ["sessions.read"], args: {} })).toThrow();
});

it("coalesces transient events while preserving terminal messages", () => {
  const queue = new OutboundQueue(100);
  queue.push({ kind: "event", coalesceKey: "state", payload: { n: 1 } });
  queue.push({ kind: "event", coalesceKey: "state", payload: { n: 2 } });
  queue.push({ kind: "error", payload: { done: true } });
  expect(queue.drain().map((item) => item.kind)).toEqual(["event", "error"]);
});

it("redacts cycles, JWT, bearer, basic and private-key strings", () => {
  const cycle: Record<string, unknown> = { value: "Bearer abcdefghijklmnopqrstuvwxyz" };
  cycle.self = cycle;
  const output = JSON.stringify(new DefaultRedactor().redact(cycle));
  expect(output).not.toContain("Bearer");
  expect(output).not.toContain("\"self\":{\"self\"");
});
