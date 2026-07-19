import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__internalsForTesting,
	acquireSessionLock,
	inspectSessionLock,
	lockPathForSession,
	SessionLockError,
} from "../src/session/session-lock";

const OWNER_A = "00000000-0000-4000-8000-000000000001";
const OWNER_B = "00000000-0000-4000-8000-000000000002";

function probe(alive: boolean | "unknown") {
	return {
		processStartMarker: () => "marker",
		isAlive: () => alive,
	};
}

describe("session lock", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function fixture() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-lock-"));
		dirs.push(dir);
		return { dir, session: path.join(dir, "session.jsonl") };
	}

	it("acquires, heartbeats, and releases only its own record", () => {
		const { session } = fixture();
		let now = 1000;
		const lock = acquireSessionLock(session, {
			now: () => now,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(true),
		});
		expect(
			inspectSessionLock(session, {
				now: () => now,
				pid: 43,
				processStartMarker: "other",
				processProbe: probe(true),
			}).status,
		).toBe("live");
		now += 5000;
		lock.heartbeat();
		expect(
			inspectSessionLock(session, {
				now: () => now,
				pid: 43,
				processStartMarker: "other",
				processProbe: probe(true),
			}).heartbeatAgeMs,
		).toBe(0);
		lock.release();
		lock.release();
		expect(fs.existsSync(lockPathForSession(session))).toBe(false);
	});

	it("prevents competing writers and classifies suspect locks", () => {
		const { session } = fixture();
		const now = 20_000;
		const first = acquireSessionLock(session, {
			now: () => 0,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(true),
		});
		expect(() =>
			acquireSessionLock(session, {
				now: () => now,
				ownerId: OWNER_B,
				pid: 43,
				processStartMarker: "marker-b",
				processProbe: probe(true),
			}),
		).toThrow(SessionLockError);
		expect(
			inspectSessionLock(session, {
				now: () => 15_000,
				pid: 43,
				processStartMarker: "marker-b",
				processProbe: probe(true),
			}).status,
		).toBe("suspect");
		first.release();
	});

	it("steals only a dead owner after the threshold", () => {
		const { session } = fixture();
		const first = acquireSessionLock(session, {
			now: () => 0,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(false),
		});
		const second = acquireSessionLock(session, {
			now: () => 20_001,
			ownerId: OWNER_B,
			pid: 43,
			processStartMarker: "marker-b",
			processProbe: probe(false),
		});
		expect(second.record.ownerId).toBe(OWNER_B);
		first.release();
		expect(
			inspectSessionLock(session, {
				now: () => 20_001,
				pid: 43,
				processStartMarker: "marker-b",
				processProbe: probe(false),
			}).record?.ownerId,
		).toBe(OWNER_B);
		second.release();
	});

	it("does not leak the replacement lock when stale-claim cleanup fails", () => {
		const { session } = fixture();
		const first = acquireSessionLock(session, {
			now: () => 0,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(false),
		});
		const unlinkSync = fs.unlinkSync;
		const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (String(target).endsWith(".steal")) {
				const error = new Error("claim cleanup denied") as NodeJS.ErrnoException;
				error.code = "EACCES";
				throw error;
			}
			return unlinkSync(target);
		});
		try {
			expect(() =>
				acquireSessionLock(session, {
					now: () => 20_001,
					ownerId: OWNER_B,
					pid: 43,
					processStartMarker: "marker-b",
					processProbe: probe(false),
				}),
			).toThrow(SessionLockError);
			expect(fs.existsSync(lockPathForSession(session))).toBe(false);
		} finally {
			unlinkSpy.mockRestore();
			first.release();
		}
	});

	it("does not steal before twenty seconds even when the owner is dead", () => {
		const { session } = fixture();
		const first = acquireSessionLock(session, {
			now: () => 0,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(false),
		});
		expect(() =>
			acquireSessionLock(session, {
				now: () => 19_999,
				ownerId: OWNER_B,
				pid: 43,
				processStartMarker: "marker-b",
				processProbe: probe(false),
			}),
		).toThrow(SessionLockError);
		first.release();
	});

	it("fails closed for foreign hosts, unknown liveness, malformed records, and path mismatches", () => {
		const { session } = fixture();
		const first = acquireSessionLock(session, {
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(false),
			hostname: "foreign-host",
		});
		const inspection = inspectSessionLock(session, {
			now: () => 30_000,
			hostname: "local-host",
			pid: 43,
			processStartMarker: "marker-b",
			processProbe: probe(false),
		});
		expect(inspection.processAlive).toBe("unknown");
		expect(inspection.stealable).toBe(false);
		first.release();

		fs.writeFileSync(lockPathForSession(session), JSON.stringify({ protocolVersion: 1, ownerId: OWNER_A }));
		expect(
			inspectSessionLock(session, { pid: 43, processStartMarker: "marker-b", processProbe: probe(false) }).status,
		).toBe("malformed");
	});

	it("uses canonical real paths for symlink aliases and preserves 0600 claims", () => {
		const { dir, session } = fixture();
		fs.writeFileSync(session, "session");
		const alias = path.join(dir, "alias.jsonl");
		fs.symlinkSync(session, alias);
		expect(lockPathForSession(alias)).toBe(lockPathForSession(session));
		const lock = acquireSessionLock(alias, {
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(true),
		});
		expect(fs.statSync(lockPathForSession(session)).mode & 0o777).toBe(0o600);
		expect(() =>
			acquireSessionLock(session, {
				ownerId: OWNER_B,
				pid: 43,
				processStartMarker: "marker-b",
				processProbe: probe(true),
			}),
		).toThrow(SessionLockError);
		lock.release();
	});

	it("serializes a heartbeat against an explicit stale-steal claim", () => {
		const { session } = fixture();
		const old = acquireSessionLock(session, {
			now: () => 0,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(false),
		});
		const claimPath = __internalsForTesting.claimPathFor(lockPathForSession(session));
		const claim = {
			protocolVersion: 1,
			ownerId: OWNER_B,
			pid: 43,
			processStartMarker: "marker-b",
			hostname: "claim-host",
			createdAt: 20_000,
			sessionFile: lockPathForSession(session).slice(0, -".lock".length),
		};
		expect(__internalsForTesting.writeClaim(claimPath, claim as never)).toBe(true);
		expect(__internalsForTesting.parseClaim(fs.readFileSync(claimPath, "utf8"), session)).not.toBeNull();
		expect(() => old.heartbeat()).toThrow(SessionLockError);
		fs.unlinkSync(claimPath);
		old.release();
	});

	it("recovers only dead local orphan claims, never live or unknown claims", () => {
		const { session } = fixture();
		const claimPath = __internalsForTesting.claimPathFor(lockPathForSession(session));
		const claim = {
			protocolVersion: 1,
			ownerId: OWNER_B,
			pid: 43,
			processStartMarker: "marker-b",
			hostname: "local",
			createdAt: 0,
			sessionFile: lockPathForSession(session).slice(0, -".lock".length),
		};
		const rt = {
			now: () => 20_001,
			hostname: "local",
			processProbe: probe(false),
		} as never;
		__internalsForTesting.writeClaim(claimPath, claim as never);
		__internalsForTesting.recoverClaim(claimPath, session, rt);
		expect(fs.existsSync(claimPath)).toBe(false);
		__internalsForTesting.writeClaim(claimPath, { ...claim, hostname: "foreign" } as never);
		__internalsForTesting.recoverClaim(claimPath, session, rt);
		expect(fs.existsSync(claimPath)).toBe(true);
		fs.unlinkSync(claimPath);
	});

	it("treats start-marker mismatch and unknown probes as non-stealable", () => {
		const { session } = fixture();
		const lock = acquireSessionLock(session, {
			now: () => 0,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker-a",
			processProbe: { processStartMarker: () => "marker-b", isAlive: () => "unknown" },
		});
		expect(
			inspectSessionLock(session, {
				now: () => 30_000,
				pid: 43,
				processStartMarker: "marker-b",
				processProbe: probe("unknown"),
			}).stealable,
		).toBe(false);
		lock.release();
	});
});
