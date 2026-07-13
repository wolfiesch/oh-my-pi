import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findMostRecentSession, resolveResumableSession } from "../../src/session/session-listing";
import { acquireSessionLock, lockPathForSession, SessionLockError } from "../../src/session/session-lock";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

class FailingAtomicStorage extends FileSessionStorage {
	override async writeTextAtomic(): Promise<void> {
		throw new Error("injected atomic write failure");
	}
}
const OWNER_A = "00000000-0000-4000-8000-000000000011";
const OWNER_B = "00000000-0000-4000-8000-000000000012";

function probe() {
	return { processStartMarker: () => "marker", isAlive: () => true as const };
}

describe("SessionManager persistent lock integration", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function fixture() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-manager-lock-"));
		dirs.push(dir);
		return { dir, cwd: path.join(dir, "cwd"), sessions: path.join(dir, "sessions") };
	}

	it("locks persistent ensureOnDisk and releases on dispose while memory sessions stay lock-free", async () => {
		const { cwd, sessions } = fixture();
		fs.mkdirSync(cwd);
		const lockOptions = { ownerId: OWNER_A, pid: 101, processStartMarker: "marker", processProbe: probe() };
		const manager = SessionManager.create(cwd, sessions, undefined, lockOptions);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		expect(fs.existsSync(lockPathForSession(sessionFile))).toBe(true);
		await expect(
			SessionManager.open(sessionFile, undefined, undefined, {
				lockOptions: { ...lockOptions, ownerId: OWNER_B, pid: 102 },
			}),
		).rejects.toBeInstanceOf(SessionLockError);
		await manager.dispose();
		expect(fs.existsSync(lockPathForSession(sessionFile))).toBe(false);
		const memory = SessionManager.inMemory(cwd);
		await memory.ensureOnDisk();
		expect(memory.getSessionFile()).toBeUndefined();
		await memory.dispose();
	});

	it("reacquires a persisted snapshot lock before restore", async () => {
		const { cwd, sessions } = fixture();
		fs.mkdirSync(cwd);
		const lockOptions = { ownerId: OWNER_A, pid: 103, processStartMarker: "marker", processProbe: probe() };
		const manager = SessionManager.create(cwd, sessions, undefined, lockOptions);
		await manager.ensureOnDisk();
		const snapshot = manager.captureState();
		await manager.close();
		manager.restoreState(snapshot);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		expect(fs.existsSync(lockPathForSession(sessionFile))).toBe(true);
		await expect(
			SessionManager.open(sessionFile, undefined, undefined, {
				lockOptions: { ...lockOptions, ownerId: OWNER_B, pid: 104 },
			}),
		).rejects.toBeInstanceOf(SessionLockError);
		await manager.dispose();
	});

	it("moves under a target lock and leaves only the target lock", async () => {
		const { cwd, sessions } = fixture();
		const targetCwd = path.join(path.dirname(cwd), "target-cwd");
		fs.mkdirSync(cwd);
		fs.mkdirSync(targetCwd);
		const manager = SessionManager.create(cwd, sessions, undefined, {
			ownerId: OWNER_A,
			pid: 105,
			processStartMarker: "marker",
			processProbe: probe(),
		});
		await manager.ensureOnDisk();
		const oldFile = manager.getSessionFile();
		if (!oldFile) throw new Error("missing session file");
		await manager.moveTo(targetCwd, path.join(path.dirname(sessions), "target-sessions"));
		const newFile = manager.getSessionFile();
		if (!newFile) throw new Error("missing moved session file");
		expect(path.resolve(newFile)).not.toBe(path.resolve(oldFile));
		expect(fs.existsSync(lockPathForSession(oldFile))).toBe(false);
		expect(fs.existsSync(lockPathForSession(newFile))).toBe(true);
		await manager.dispose();
	});
	it("filters active locked sessions from recent and resumable resolution", async () => {
		const { cwd, sessions } = fixture();
		fs.mkdirSync(cwd);
		const manager = SessionManager.create(cwd, sessions, undefined, {
			ownerId: OWNER_A,
			pid: 106,
			processStartMarker: "marker",
			processProbe: probe(),
		});
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		expect(await findMostRecentSession(sessions)).toBeNull();
		expect(await resolveResumableSession(path.basename(sessionFile), cwd, sessions)).toBeUndefined();
		await manager.dispose();
		expect(await findMostRecentSession(sessions)).toBe(sessionFile);
	});

	it("releases a destination lock when materialization fails and preserves disk failure", async () => {
		const { cwd, sessions } = fixture();
		fs.mkdirSync(cwd);
		const manager = SessionManager.create(cwd, sessions, new FailingAtomicStorage(), {
			// Explicitly opt custom storage into the real filesystem lock adapter.
			ownerId: OWNER_A,
			enabled: true,
			pid: 107,
			processStartMarker: "marker",
			processProbe: probe(),
		});
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		await expect(manager.ensureOnDisk()).rejects.toThrow("injected atomic write failure");
		expect(fs.existsSync(lockPathForSession(sessionFile))).toBe(false);
		const competitor = acquireSessionLock(sessionFile, {
			ownerId: OWNER_B,
			pid: 108,
			processStartMarker: "marker-b",
			processProbe: probe(),
		});
		competitor.release();
	});
});
