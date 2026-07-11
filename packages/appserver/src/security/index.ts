import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, stat, rename } from "node:fs/promises";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { COMMAND_DESCRIPTORS, DEVICE_CAPABILITIES, isCapability, type CommandDescriptor, type DeviceCapability } from "@oh-my-pi/app-wire";

export type Capability = DeviceCapability;
export type Clock = { now(): number };
export type Random = { bytes(size: number): Uint8Array; digits(size: number): string };
const realClock: Clock = { now: () => Date.now() };
const realRandom: Random = { bytes: (size) => randomBytes(size), digits: (size) => Array.from(randomBytes(size), (x) => String(x % 10)).join("") };
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const digest = (salt: Uint8Array, token: string) => createHash("sha256").update(salt).update(token).digest();
const text = (v: unknown, max = 256) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v) ? v : null;

export interface RemotePeerIdentity { readonly nodeId: string; readonly login: string; readonly hostId: string; readonly tailnetIp?: string; }
export interface DeviceRecord { readonly deviceId: string; readonly identityKey: string; readonly capabilities: readonly Capability[]; readonly createdAt: number; readonly lastSeenAt: number | null; readonly revokedAt: number | null; readonly epoch: number; }
export interface DeviceRegistry { get(deviceId: string): DeviceRecord | null; upsert(record: DeviceRecord, token?: string): void; revoke(deviceId: string, now?: number): void; list(): readonly DeviceRecord[]; verifyToken(deviceId: string, token: string): boolean; }
export interface PairingGrant { readonly pairingId: string; readonly code: string; readonly expiresAt: number; }
export interface PairingService { create(identity: RemotePeerIdentity, capabilities: readonly Capability[], ttlMs?: number): PairingGrant; complete(pairingId: string, code: string): { readonly deviceId: string; readonly token: string; readonly expiresAt: number }; }

export class SqliteDeviceRegistry implements DeviceRegistry {
  readonly db: Database;
  constructor(path: string, private readonly clock: Clock = realClock, private readonly random: Random = realRandom) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS devices(device_id TEXT PRIMARY KEY, identity_key TEXT NOT NULL, capabilities TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER, epoch INTEGER NOT NULL, salt BLOB NOT NULL, token_digest BLOB NOT NULL)");
  }
  get(deviceId: string): DeviceRecord | null {
    const row = this.db.query("SELECT * FROM devices WHERE device_id=?").get(deviceId) as Record<string, unknown> | null;
    if (!row) return null;
    return { deviceId: String(row.device_id), identityKey: String(row.identity_key), capabilities: JSON.parse(String(row.capabilities)) as Capability[], createdAt: Number(row.created_at), lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at), revokedAt: row.revoked_at === null ? null : Number(row.revoked_at), epoch: Number(row.epoch) };
  }
  upsert(record: DeviceRecord, token?: string): void { const salt = this.random.bytes(16); const value = token ?? ""; this.db.query("INSERT OR REPLACE INTO devices(device_id,identity_key,capabilities,created_at,last_seen_at,revoked_at,epoch,salt,token_digest) VALUES(?,?,?,?,?,?,?,?,?)").run(record.deviceId, record.identityKey, JSON.stringify(record.capabilities), record.createdAt, record.lastSeenAt, record.revokedAt, record.epoch, salt, digest(salt, value)); }
  revoke(deviceId: string, now = this.clock.now()): void { this.db.query("UPDATE devices SET revoked_at=?, epoch=epoch+1 WHERE device_id=?").run(now, deviceId); }
  list(): readonly DeviceRecord[] { return this.db.query("SELECT device_id FROM devices ORDER BY created_at").all().map((row) => this.get(String((row as Record<string, unknown>).device_id))).filter((x): x is DeviceRecord => x !== null); }
  verifyToken(deviceId: string, token: string): boolean { const row = this.db.query("SELECT salt,token_digest,revoked_at FROM devices WHERE device_id=?").get(deviceId) as Record<string, unknown> | null; if (!row || row.revoked_at !== null) return false; const expected = Buffer.from(row.token_digest as Uint8Array); const actual = digest(Buffer.from(row.salt as Uint8Array), token); return expected.length === actual.length && timingSafeEqual(expected, actual); }
}

const canonicalIdentity = (identity: RemotePeerIdentity) => `${identity.nodeId}\n${identity.login}\n${identity.hostId}`;
export class SqlitePairingService implements PairingService {
  private readonly pending = new Map<string, { identity: RemotePeerIdentity; capabilities: readonly Capability[]; code: string; expiresAt: number; used: boolean }>();
  constructor(private readonly registry: DeviceRegistry, private readonly clock: Clock = realClock, private readonly random: Random = realRandom) {}
  create(identity: RemotePeerIdentity, capabilities: readonly Capability[], ttlMs = 120_000): PairingGrant { if (this.pending.size >= 5) throw new Error("pairing capacity reached"); const pairingId = b64(this.random.bytes(12)); const code = this.random.digits(6); const expiresAt = this.clock.now() + Math.min(Math.max(ttlMs, 1), 120_000); this.pending.set(pairingId, { identity, capabilities: capabilities.filter(isCapability), code, expiresAt, used: false }); return { pairingId, code, expiresAt }; }
  complete(pairingId: string, code: string): { readonly deviceId: string; readonly token: string; readonly expiresAt: number } { const pending = this.pending.get(pairingId); if (!pending || pending.used || pending.expiresAt <= this.clock.now() || pending.code !== code) throw new Error("pairing denied"); pending.used = true; this.pending.delete(pairingId); const deviceId = b64(this.random.bytes(12)); const token = b64(this.random.bytes(32)); const now = this.clock.now(); this.registry.upsert({ deviceId, identityKey: canonicalIdentity(pending.identity), capabilities: [...new Set(pending.capabilities)], createdAt: now, lastSeenAt: now, revokedAt: null, epoch: 0 }, token); return { deviceId, token, expiresAt: pending.expiresAt }; }
}

export interface AuthorizationGuard { authorize(device: DeviceRecord, command: string, capabilities: readonly Capability[], args?: Record<string, unknown>): void; }
export class DefaultAuthorizationGuard implements AuthorizationGuard { authorize(device: DeviceRecord, command: string, capabilities: readonly Capability[]): void { const descriptor: CommandDescriptor | undefined = COMMAND_DESCRIPTORS[command]; if (!descriptor || device.revokedAt !== null || !capabilities.includes(descriptor.capability) || !device.capabilities.includes(descriptor.capability)) throw new Error("command denied"); } }

interface Bucket { tokens: number; at: number; }
export class TokenBucketLimiter { private readonly buckets = new Map<string, Bucket>(); constructor(private readonly capacity = 30, private readonly refillPerSecond = 10, private readonly clock: Clock = realClock) {} allow(key: string, cost = 1): boolean { const now = this.clock.now(); const old = this.buckets.get(key) ?? { tokens: this.capacity, at: now }; const tokens = Math.min(this.capacity, old.tokens + (now - old.at) / 1000 * this.refillPerSecond); if (tokens < cost) { this.buckets.set(key, { tokens, at: now }); return false; } this.buckets.set(key, { tokens: tokens - cost, at: now }); return true; } }

export interface Lease { readonly leaseId: string; readonly owner: string; readonly sessionId: string; readonly expiresAt: number; }
export class LeaseRegistry { private readonly leases = new Map<string, Lease>(); constructor(private readonly clock: Clock = realClock) {} acquire(sessionId: string, owner: string, ttlMs = 30_000): Lease { this.releaseExpired(); if ([...this.leases.values()].some((x) => x.sessionId === sessionId)) throw new Error("lease held"); const lease = { leaseId: b64(randomBytes(12)), owner, sessionId, expiresAt: this.clock.now() + ttlMs }; this.leases.set(sessionId, lease); return lease; } renew(sessionId: string, owner: string, ttlMs = 30_000): Lease { const old = this.leases.get(sessionId); if (!old || old.owner !== owner) throw new Error("lease denied"); const lease = { ...old, expiresAt: this.clock.now() + ttlMs }; this.leases.set(sessionId, lease); return lease; } release(sessionId: string, owner?: string): void { const old = this.leases.get(sessionId); if (old && (owner === undefined || old.owner === owner)) this.leases.delete(sessionId); } disconnect(owner: string): void { for (const [session, lease] of this.leases) if (lease.owner === owner) this.leases.delete(session); } private releaseExpired(): void { const now = this.clock.now(); for (const [session, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(session); } }

export interface ConfirmationGrant { readonly id: string; readonly connectionId: string; readonly deviceId: string; readonly command: string; readonly sessionId: string; readonly argsDigest: string; readonly epoch: number; readonly expiresAt: number; }
export class SecureConfirmationStore { private readonly grants = new Map<string, ConfirmationGrant>(); constructor(private readonly clock: Clock = realClock) {} issue(input: Omit<ConfirmationGrant, "id" | "expiresAt">, ttlMs = 60_000): ConfirmationGrant { if (this.grants.size >= 5) throw new Error("confirmation capacity reached"); const grant = { ...input, id: b64(randomBytes(12)), expiresAt: this.clock.now() + Math.min(ttlMs, 60_000) }; this.grants.set(grant.id, grant); return grant; } consume(id: string, expected: Omit<ConfirmationGrant, "id" | "expiresAt">): void { const grant = this.grants.get(id); this.grants.delete(id); if (!grant || grant.expiresAt <= this.clock.now() || JSON.stringify(grant) !== JSON.stringify({ ...expected, id, expiresAt: grant.expiresAt })) throw new Error("confirmation denied"); } clear(): void { this.grants.clear(); } }

export interface Redactor { redact(value: unknown): unknown; }
export class DefaultRedactor implements Redactor { redact(value: unknown): unknown { if (Array.isArray(value)) return value.map((x) => this.redact(x)); if (value && typeof value === "object") { const out: Record<string, unknown> = {}; for (const [key, raw] of Object.entries(value)) out[key] = /secret|token|auth|password|cookie/iu.test(key) ? "[redacted]" : this.redact(raw); return out; } if (typeof value === "string") return /bearer\s+[A-Za-z0-9._~+/=-]{12,}/iu.test(value) || /^[A-Za-z0-9_-]{32,}$/u.test(value) ? "[redacted]" : value; return value; } }
export interface AuditSink { write(event: Record<string, unknown>): Promise<void>; }
export class JsonlAuditSink implements AuditSink { constructor(private readonly path: string, private readonly redactor: Redactor = new DefaultRedactor(), private readonly maxBytes = 1_048_576) {} async write(event: Record<string, unknown>): Promise<void> { const line = JSON.stringify(this.redactor.redact(event)) + "\n"; await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); try { const info = await stat(this.path); if (info.size + Buffer.byteLength(line) > this.maxBytes) await rename(this.path, `${this.path}.${Date.now()}`); } catch {} await appendFile(this.path, line, { mode: 0o600 }); } }

export interface OutboundMessage { readonly kind: "event" | "result" | "error" | "confirmation" | "lease" | "revoke"; readonly bytes: number; readonly payload: unknown; }
export class OutboundQueue { private readonly items: OutboundMessage[] = []; private bytes = 0; private closed = false; constructor(private readonly hardCap = 1_048_576) {} push(item: OutboundMessage): void { if (this.closed) throw new Error("queue closed"); if (this.bytes + item.bytes > this.hardCap && ["event"].includes(item.kind)) { const index = this.items.findIndex((x) => x.kind === "event"); if (index >= 0) { this.bytes -= this.items[index].bytes; this.items.splice(index, 1); } } if (this.bytes + item.bytes > this.hardCap) { this.closed = true; throw new Error("outbound queue hard cap"); } this.items.push(item); this.bytes += item.bytes; } shift(): OutboundMessage | undefined { const item = this.items.shift(); if (item) this.bytes -= item.bytes; return item; } get sizeBytes(): number { return this.bytes; } get isClosed(): boolean { return this.closed; } }

export { DEVICE_CAPABILITIES, COMMAND_DESCRIPTORS };
