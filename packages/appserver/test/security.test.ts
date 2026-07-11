import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  DefaultAuthorizationGuard,
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
const identity = { nodeId: "node-a", login: "alice@example.com", hostId: "host-a" };
const clock = { value: 1_000, now() { return this.value; } };

beforeAll(() => { dbPath = `/tmp/omp-security-${process.pid}.sqlite`; });
afterAll(async () => { await unlink(dbPath).catch(() => undefined); });

describe("security core", () => {
  it("pairs once and verifies a returned token without storing plaintext", () => {
    const registry = new SqliteDeviceRegistry(dbPath, clock);
    const pairing = new SqlitePairingService(registry, clock, { bytes: (n) => new Uint8Array(n).fill(7), digits: (n) => "123456" });
    const grant = pairing.create(identity, ["sessions.read"]);
    const result = pairing.complete(grant.pairingId, grant.code);
    expect(registry.verifyToken(result.deviceId, result.token)).toBe(true);
    expect(registry.verifyToken(result.deviceId, "wrong")).toBe(false);
    expect(() => pairing.complete(grant.pairingId, grant.code)).toThrow();
    registry.db.close();
  });

  it("binds authorization to the capability intersection", () => {
    const guard = new DefaultAuthorizationGuard();
    const record = { deviceId: "d", identityKey: "i", capabilities: ["sessions.read"] as const, createdAt: 1, lastSeenAt: 1, revokedAt: null, epoch: 0 };
    expect(() => guard.authorize(record, "host.list", ["sessions.read"])).not.toThrow();
    expect(() => guard.authorize(record, "session.prompt", ["sessions.read"])).toThrow();
  });

  it("expires and releases a single-owner lease", () => {
    const leases = new LeaseRegistry(clock);
    leases.acquire("s", "owner", 10);
    expect(() => leases.acquire("s", "other")).toThrow();
    clock.value += 11;
    expect(() => leases.acquire("s", "other")).not.toThrow();
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
