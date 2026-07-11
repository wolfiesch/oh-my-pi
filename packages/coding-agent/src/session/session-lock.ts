import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SESSION_LOCK_PROTOCOL_VERSION = 1;
export const SESSION_LOCK_HEARTBEAT_MS = 5_000;
export const SESSION_LOCK_SUSPECT_AFTER_MS = 15_000;
export const SESSION_LOCK_STEAL_AFTER_MS = 20_000;
const MAX_LOCK_BYTES = 16 * 1024;
const MAX_OWNER_ID_BYTES = 64;
const MAX_MARKER_BYTES = 256;
const MAX_HOSTNAME_BYTES = 255;
const MAX_SESSION_PATH_BYTES = 4 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_KEYS: Record<string, true> = {
	protocolVersion: true,
	ownerId: true,
	pid: true,
	processStartMarker: true,
	hostname: true,
	createdAt: true,
	heartbeatAt: true,
	sessionFile: true,
};

type ErrorCode = "EEXIST" | "ENOENT" | string;

export type SessionLockStatus = "missing" | "live" | "suspect" | "stale" | "malformed";
export type SessionLockErrorCode = "locked" | "malformed" | "not-owner" | "io";

export interface SessionLockRecord {
	protocolVersion: number;
	ownerId: string;
	pid: number;
	processStartMarker: string;
	hostname: string;
	createdAt: number;
	heartbeatAt: number;
	sessionFile: string;
}

export interface SessionLockProcessProbe {
	isAlive(pid: number, processStartMarker: string): boolean | "unknown";
	processStartMarker(pid: number): string | null;
}

export interface SessionLockOptions {
	/** Enable a filesystem lock when used by SessionManager with custom storage. */
	enabled?: boolean;
	now?: () => number;
	ownerId?: string;
	pid?: number;
	hostname?: string;
	processStartMarker?: string;
	processProbe?: SessionLockProcessProbe;
	heartbeatIntervalMs?: number;
	onHeartbeatError?: (error: SessionLockError) => void;
}

export interface SessionLockInspection {
	lockPath: string;
	status: SessionLockStatus;
	record?: SessionLockRecord;
	heartbeatAgeMs?: number;
	processAlive?: boolean | "unknown";
	stealable: boolean;
}

export class SessionLockError extends Error {
	readonly code: SessionLockErrorCode;
	readonly sessionFile: string;
	readonly lockPath: string;
	readonly inspection?: SessionLockInspection;
	readonly owner?: SessionLockRecord;
	readonly cause?: unknown;

	constructor(
		code: SessionLockErrorCode,
		message: string,
		sessionFile: string,
		lockPath: string,
		inspection?: SessionLockInspection,
		cause?: unknown,
	) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SessionLockError";
		this.code = code;
		this.sessionFile = sessionFile;
		this.lockPath = lockPath;
		this.inspection = inspection;
		this.owner = inspection?.record;
		this.cause = cause;
	}
}

export interface SessionLockHandle {
	readonly record: SessionLockRecord;
	readonly lockPath: string;
	heartbeat(): void;
	release(): void;
	readonly released: boolean;
}


interface SessionLockClaim {
	protocolVersion: number;
	ownerId: string;
	pid: number;
	processStartMarker: string;
	hostname: string;
	createdAt: number;
	sessionFile: string;
}
interface SessionLockRuntime {
	now: () => number;
	ownerId: string;
	pid: number;
	hostname: string;
	processProbe: SessionLockProcessProbe;
	processStartMarker: string;
	heartbeatIntervalMs: number;
	onHeartbeatError?: (error: SessionLockError) => void;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function errorCode(error: unknown): ErrorCode | undefined {
	return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function defaultProcessStartMarker(pid: number): string | null {
	if (process.platform === "linux") {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			const closingParen = stat.lastIndexOf(")");
			if (closingParen < 0) return null;
			// After the comm field, fields[0] is stat field 3 (state), so
			// starttime (field 22) is index 19.
			const fields = stat.slice(closingParen + 1).trim().split(/\s+/);
			const startTime = fields[19];
			return startTime ? `linux:${startTime}` : null;
		} catch {
			return null;
		}
	}

	if (process.platform === "darwin") {
		try {
			// execFileSync passes argv directly: no shell interpolation of a PID.
			const value = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			return value ? `darwin:${value}` : null;
		} catch {
			return null;
		}
	}

	return null;
}

const defaultProcessProbe: SessionLockProcessProbe = {
	processStartMarker: defaultProcessStartMarker,
	isAlive(pid, processStartMarker) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			return errorCode(error) === "ESRCH" ? false : "unknown";
		}
		const currentMarker = defaultProcessStartMarker(pid);
		if (currentMarker === null) return "unknown";
		return currentMarker === processStartMarker;
	},
};

function normalizeSessionFile(sessionFile: string): string {
	const resolved = path.resolve(sessionFile);
	try {
		return fs.realpathSync(resolved);
	} catch {
		try {
			return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
		} catch {
			return resolved;
		}
	}
}

function lockPathFor(sessionFile: string): string {
	return `${normalizeSessionFile(sessionFile)}.lock`;
}

function claimPathFor(lockPath: string): string {
	return `${lockPath}.steal`;
}

function runtime(options: SessionLockOptions): SessionLockRuntime {
	const pid = options.pid ?? process.pid;
	const processProbe = options.processProbe ?? defaultProcessProbe;
	const processStartMarker = options.processStartMarker ?? processProbe.processStartMarker(pid);
	if (!processStartMarker) throw new Error(`Unable to determine process start marker for pid ${pid}`);
	const ownerId = options.ownerId ?? randomUUID();
	if (!UUID_PATTERN.test(ownerId)) throw new Error("Session lock ownerId must be a UUID");
	const hostname = options.hostname ?? os.hostname();
	if (!hostname || byteLength(hostname) > MAX_HOSTNAME_BYTES) throw new Error("Session lock hostname is invalid");
	if (!Number.isInteger(pid) || pid <= 0) throw new Error("Session lock pid is invalid");
	if (byteLength(processStartMarker) > MAX_MARKER_BYTES) throw new Error("Session lock process marker is too long");
	return {
		now: options.now ?? Date.now,
		ownerId,
		pid,
		hostname,
		processProbe,
		processStartMarker,
		heartbeatIntervalMs: options.heartbeatIntervalMs ?? SESSION_LOCK_HEARTBEAT_MS,
		onHeartbeatError: options.onHeartbeatError,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(text: string, expectedSessionFile?: string): SessionLockRecord | null {
	if (byteLength(text) > MAX_LOCK_BYTES) return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	if (Object.keys(value).length !== Object.keys(LOCK_KEYS).length || Object.keys(value).some(key => !LOCK_KEYS[key])) return null;
	const protocolVersion = value.protocolVersion;
	const ownerId = value.ownerId;
	const pid = value.pid;
	const processStartMarker = value.processStartMarker;
	const hostname = value.hostname;
	const createdAt = value.createdAt;
	const heartbeatAt = value.heartbeatAt;
	const sessionFile = value.sessionFile;
	if (
		protocolVersion !== SESSION_LOCK_PROTOCOL_VERSION ||
		typeof ownerId !== "string" ||
		!UUID_PATTERN.test(ownerId) ||
		byteLength(ownerId) > MAX_OWNER_ID_BYTES ||
		!Number.isSafeInteger(pid) ||
		(pid as number) <= 0 ||
		typeof processStartMarker !== "string" ||
		!processStartMarker ||
		byteLength(processStartMarker) > MAX_MARKER_BYTES ||
		typeof hostname !== "string" ||
		!hostname ||
		byteLength(hostname) > MAX_HOSTNAME_BYTES ||
		typeof createdAt !== "number" ||
		!Number.isFinite(createdAt) ||
		createdAt < 0 ||
		typeof heartbeatAt !== "number" ||
		!Number.isFinite(heartbeatAt) ||
		heartbeatAt < 0 ||
		typeof sessionFile !== "string" ||
		!sessionFile ||
		byteLength(sessionFile) > MAX_SESSION_PATH_BYTES ||
		sessionFile !== normalizeSessionFile(sessionFile) ||
		(expectedSessionFile !== undefined && sessionFile !== normalizeSessionFile(expectedSessionFile))
	) {
		return null;
	}
	return { protocolVersion, ownerId, pid, processStartMarker, hostname, createdAt, heartbeatAt, sessionFile };
}

function parseClaim(text: string, expectedSessionFile: string): SessionLockClaim | null {
	if (byteLength(text) > MAX_LOCK_BYTES) return null;
	try {
		const value = JSON.parse(text) as Record<string, unknown>;
		const expectedKeys = ["protocolVersion", "ownerId", "pid", "processStartMarker", "hostname", "createdAt", "sessionFile"];
		if (!isRecord(value) || Object.keys(value).length !== expectedKeys.length || Object.keys(value).some(key => !expectedKeys.includes(key))) return null;
		if (
			value.protocolVersion !== SESSION_LOCK_PROTOCOL_VERSION ||
			typeof value.ownerId !== "string" ||
			!UUID_PATTERN.test(value.ownerId) ||
			typeof value.pid !== "number" ||
			!Number.isSafeInteger(value.pid) ||
			typeof value.processStartMarker !== "string" ||
			typeof value.hostname !== "string" ||
			typeof value.createdAt !== "number" ||
			!Number.isFinite(value.createdAt) ||
			typeof value.sessionFile !== "string" ||
			value.sessionFile !== normalizeSessionFile(expectedSessionFile)
		) return null;
		return value as unknown as SessionLockClaim;
	} catch {
		return null;
	}
}

type LoadedRecord = { kind: "missing" } | { kind: "malformed" } | { kind: "record"; record: SessionLockRecord };

function readRecord(lockPath: string, expectedSessionFile: string): LoadedRecord {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(lockPath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "missing" };
		throw error;
	}
	if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return { kind: "malformed" };
	try {
		const record = parseRecord(fs.readFileSync(lockPath, "utf8"), expectedSessionFile);
		return record ? { kind: "record", record } : { kind: "malformed" };
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "missing" };
		throw error;
	}
}

function processAlive(record: SessionLockRecord, rt: SessionLockRuntime): boolean | "unknown" {
	if (record.hostname !== rt.hostname) return "unknown";
	try {
		return rt.processProbe.isAlive(record.pid, record.processStartMarker);
	} catch {
		return "unknown";
	}
}

function inspectWithRuntime(sessionFile: string, rt: SessionLockRuntime): SessionLockInspection {
	const normalized = normalizeSessionFile(sessionFile);
	const lockPath = lockPathFor(normalized);
	const loaded = readRecord(lockPath, normalized);
	if (loaded.kind === "missing") return { lockPath, status: "missing", stealable: false };
	if (loaded.kind === "malformed") return { lockPath, status: "malformed", stealable: false };
	const record = loaded.record;
	const heartbeatAgeMs = Math.max(0, rt.now() - record.heartbeatAt);
	const alive = processAlive(record, rt);
	const stale = heartbeatAgeMs >= SESSION_LOCK_STEAL_AFTER_MS && alive === false;
	const status: SessionLockStatus = stale
		? "stale"
		: heartbeatAgeMs >= SESSION_LOCK_SUSPECT_AFTER_MS
			? "suspect"
			: "live";
	return { lockPath, status, record, heartbeatAgeMs, processAlive: alive, stealable: stale };
}

export function inspectSessionLock(sessionFile: string, options: SessionLockOptions = {}): SessionLockInspection {
	const normalized = normalizeSessionFile(sessionFile);
	const lockPath = lockPathFor(normalized);
	try {
		return inspectWithRuntime(normalized, runtime(options));
	} catch (error) {
		if (error instanceof SessionLockError) throw error;
		throw ioError(normalized, lockPath, error);
	}
}

function sameOwner(a: SessionLockRecord, b: SessionLockRecord): boolean {
	return (
		a.protocolVersion === b.protocolVersion &&
		a.ownerId === b.ownerId &&
		a.pid === b.pid &&
		a.processStartMarker === b.processStartMarker &&
		a.hostname === b.hostname &&
		a.sessionFile === b.sessionFile
	);
}

function serializedRecord(record: SessionLockRecord): Buffer {
	const data = Buffer.from(JSON.stringify(record), "utf8");
	if (data.byteLength > MAX_LOCK_BYTES) throw new Error("Session lock record exceeds size limit");
	return data;
}

function writeExclusive(lockPath: string, record: SessionLockRecord): boolean {
	let fd: number | undefined;
	try {
		fd = fs.openSync(lockPath, "wx", 0o600);
		const data = serializedRecord(record);
		fs.writeSync(fd, data, 0, data.length);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function writeClaim(claimPath: string, claim: SessionLockClaim): boolean {
	const tempPath = `${claimPath}.${claim.ownerId}.tmp`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(tempPath, "wx", 0o600);
		const data = Buffer.from(JSON.stringify(claim), "utf8");
		if (data.byteLength > MAX_LOCK_BYTES) throw new Error("Session lock claim exceeds size limit");
		fs.writeSync(fd, data, 0, data.length);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		try {
			fs.linkSync(tempPath, claimPath);
			return true;
		} catch (error) {
			if (errorCode(error) === "EEXIST") return false;
			throw error;
		}
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// The temp was already cleaned or is an orphan left by a killed writer.
		}
	}
}

function claimIsRecoverable(claimPath: string, sessionFile: string, rt: SessionLockRuntime): boolean {
	try {
		const stat = fs.statSync(claimPath);
		if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return false;
		const claim = parseClaim(fs.readFileSync(claimPath, "utf8"), sessionFile);
		if (!claim || rt.now() - claim.createdAt < SESSION_LOCK_STEAL_AFTER_MS) return false;
		if (claim.hostname !== rt.hostname) return false;
		return processAlive(claim as SessionLockRecord, rt) === false;
	} catch {
		return false;
	}
}

function recoverClaim(claimPath: string, sessionFile: string, rt: SessionLockRuntime): void {
	if (!claimIsRecoverable(claimPath, sessionFile, rt)) return;
	removeClaim(claimPath);
}

function removeClaim(claimPath: string): void {
	try {
		fs.unlinkSync(claimPath);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

function writeAtomic(lockPath: string, record: SessionLockRecord): void {
	const tempPath = `${lockPath}.${record.ownerId}.tmp`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(tempPath, "wx", 0o600);
		const data = serializedRecord(record);
		fs.writeSync(fd, data, 0, data.length);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(tempPath, lockPath);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// The rename already removed the temporary file.
		}
	}
}

function malformedError(sessionFile: string, inspection: SessionLockInspection): SessionLockError {
	return new SessionLockError(
		"malformed",
		`Session lock is malformed; refusing to overwrite ${inspection.lockPath}`,
		sessionFile,
		inspection.lockPath,
		inspection,
	);
}

function lockedError(sessionFile: string, inspection: SessionLockInspection): SessionLockError {
	return new SessionLockError(
		"locked",
		`Session is already writable by ${inspection.record?.ownerId ?? "another process"}`,
		sessionFile,
		inspection.lockPath,
		inspection,
	);
}

function ioError(sessionFile: string, lockPath: string, error: unknown): SessionLockError {
	return new SessionLockError("io", `Session lock I/O failed for ${lockPath}`, sessionFile, lockPath, undefined, error);
}

export function acquireSessionLock(sessionFile: string, options: SessionLockOptions = {}): SessionLockHandle {
	const normalized = normalizeSessionFile(sessionFile);
	if (byteLength(normalized) > MAX_SESSION_PATH_BYTES) {
		throw new SessionLockError("malformed", "Session path exceeds lock record limit", normalized, lockPathFor(normalized));
	}
	const lockPath = lockPathFor(normalized);
	const rt = runtime(options);
	try {
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	} catch (error) {
		throw ioError(normalized, lockPath, error);
	}
	const claim = (): SessionLockClaim => ({
		protocolVersion: SESSION_LOCK_PROTOCOL_VERSION,
		ownerId: rt.ownerId,
		pid: rt.pid,
		processStartMarker: rt.processStartMarker,
		hostname: rt.hostname,
		createdAt: rt.now(),
		sessionFile: normalized,
	});
	const timestamp = rt.now();
	const record: SessionLockRecord = {
		protocolVersion: SESSION_LOCK_PROTOCOL_VERSION,
		ownerId: rt.ownerId,
		pid: rt.pid,
		processStartMarker: rt.processStartMarker,
		hostname: rt.hostname,
		createdAt: timestamp,
		heartbeatAt: timestamp,
		sessionFile: normalized,
	};

	let acquired = false;
	try {
		acquired = writeExclusive(lockPath, record);
	} catch (error) {
		throw ioError(normalized, lockPath, error);
	}
	if (!acquired) {
		let inspection: SessionLockInspection;
		try {
			inspection = inspectWithRuntime(normalized, rt);
		} catch (error) {
			throw ioError(normalized, lockPath, error);
		}
		if (inspection.status === "malformed") throw malformedError(normalized, inspection);
		if (!inspection.stealable || !inspection.record) throw lockedError(normalized, inspection);

		const claimPath = claimPathFor(lockPath);
		let claimed = false;
		try {
			recoverClaim(claimPath, normalized, rt);
			claimed = writeClaim(claimPath, claim());
			if (!claimed) throw lockedError(normalized, inspection);
			const current = inspectWithRuntime(normalized, rt);
			if (current.status !== "stale" || !current.record || !sameOwner(current.record, inspection.record)) {
				throw lockedError(normalized, current);
			}
			writeAtomic(lockPath, record);
			acquired = true;
		} catch (error) {
			if (error instanceof SessionLockError) throw error;
			throw ioError(normalized, lockPath, error);
		} finally {
			if (claimed) {
				try {
					removeClaim(claimPath);
				} catch (error) {
					if (acquired) throw ioError(normalized, lockPath, error);
				}
			}
		}
	}
	if (!acquired) throw lockedError(normalized, inspectWithRuntime(normalized, rt));

	let released = false;
	let timer: Timer | undefined;
	const heartbeat = (): void => {
		if (released) return;
		const claimPath = claimPathFor(lockPath);
		let claimed = false;
		try {
			recoverClaim(claimPath, normalized, rt);
			claimed = writeClaim(claimPath, claim());
			if (!claimed) throw new SessionLockError("locked", "Session lock mutation is claimed by another owner", normalized, lockPath);
			const current = inspectWithRuntime(normalized, rt);
			if (current.status === "malformed" || !current.record || !sameOwner(current.record, record)) {
				throw new SessionLockError("not-owner", `Session lock ownership was lost for ${normalized}`, normalized, lockPath, current);
			}
			const next: SessionLockRecord = { ...record, heartbeatAt: rt.now() };
			writeAtomic(lockPath, next);
			record.heartbeatAt = next.heartbeatAt;
		} catch (error) {
			if (error instanceof SessionLockError) throw error;
			throw ioError(normalized, lockPath, error);
		} finally {
			if (claimed) removeClaim(claimPath);
		}
	};
	const reportHeartbeatError = (error: unknown): void => {
		const typed = error instanceof SessionLockError ? error : ioError(normalized, lockPath, error);
		clearInterval(timer);
		try {
			rt.onHeartbeatError?.(typed);
		} catch {
			// A diagnostic callback cannot keep a lost-lock timer alive.
		}
	};
	timer = setInterval(() => {
		try {
			heartbeat();
		} catch (error) {
			reportHeartbeatError(error);
		}
	}, rt.heartbeatIntervalMs);
	timer.unref?.();

	return {
		record,
		lockPath,
		heartbeat,
		release(): void {
			if (released) return;
			released = true;
			clearInterval(timer);
			let current: LoadedRecord;
			try {
				current = readRecord(lockPath, normalized);
			} catch (error) {
				throw ioError(normalized, lockPath, error);
			}
			if (current.kind !== "record" || !sameOwner(current.record, record)) return;
			try {
				fs.unlinkSync(lockPath);
			} catch (error) {
				if (errorCode(error) !== "ENOENT") throw ioError(normalized, lockPath, error);
			}
		},
		get released() {
			return released;
		},
	};
}

export function lockPathForSession(sessionFile: string): string {
	return lockPathFor(sessionFile);
}
export const __internalsForTesting = {
	parseRecord,
	parseClaim,
	readRecord,
	defaultProcessStartMarker,
	defaultProcessProbe,
	claimPathFor,
	writeClaim,
	recoverClaim,
};
