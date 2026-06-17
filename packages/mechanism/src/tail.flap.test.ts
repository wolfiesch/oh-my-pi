import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Drive the (unpinned) auto-switch path with temp files by controlling what the
// active-session resolver returns. getSubagentDir mirrors the real impl so the
// subagent scan keeps working.
let activeSession: string | null = null;
mock.module("./sources", () => ({
	findActiveMainSession: async () => activeSession,
	getSubagentDir: (mainSessionFile: string) => mainSessionFile.slice(0, -6),
}));

const { SessionTailer } = await import("./tail");
type TailerRecord = import("./tail").TailerRecord;

// Large poll so the unref'd interval never fires mid-test; the switch decision is
// driven deterministically via refreshActiveSession() instead of a wall-clock wait.
const NO_AUTO_POLL = 1_000_000;
const activeTailers: InstanceType<typeof SessionTailer>[] = [];

afterEach(() => {
	for (const tailer of activeTailers.splice(0)) tailer.stop();
	activeSession = null;
});

function sessionLine(id: string): string {
	return `${JSON.stringify({ type: "session", id, timestamp: "2026-06-17T00:00:00.000Z" })}\n`;
}

function collectResets(tailer: InstanceType<typeof SessionTailer>): string[] {
	const resets: string[] = [];
	tailer.onRecord((record: TailerRecord) => {
		if (record.t === "reset") resets.push(record.mainFile);
	});
	return resets;
}

describe("SessionTailer auto-switch flap guard", () => {
	test("stays attached while the current session is still active even if a newer one appears", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mech-flap-"));
		try {
			const fileA = path.join(tempDir, "a.jsonl");
			const fileB = path.join(tempDir, "b.jsonl");
			await Bun.write(fileA, sessionLine("session-a"));

			activeSession = fileA;
			const tailer = new SessionTailer({ activeSessionPollMs: NO_AUTO_POLL });
			activeTailers.push(tailer);
			const resets = collectResets(tailer);
			await tailer.start();
			expect(resets).toEqual([fileA]);

			// A newer, mtime-leading session becomes "active", but A is fresh (well within
			// STALE_SWITCH_MS) -> the roster must not re-snapshot.
			await Bun.write(fileB, sessionLine("session-b"));
			activeSession = fileB;
			await tailer.refreshActiveSession();
			expect(resets).toEqual([fileA]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("switches to the newer session once the current one goes stale", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mech-flap-"));
		try {
			const fileA = path.join(tempDir, "a.jsonl");
			const fileB = path.join(tempDir, "b.jsonl");
			await Bun.write(fileA, sessionLine("session-a"));
			await Bun.write(fileB, sessionLine("session-b"));

			activeSession = fileA;
			const tailer = new SessionTailer({ activeSessionPollMs: NO_AUTO_POLL });
			activeTailers.push(tailer);
			const resets = collectResets(tailer);
			await tailer.start();
			expect(resets).toEqual([fileA]);

			// Backdate A's mtime past the staleness window, then point the resolver at B.
			const staleSeconds = (Date.now() - 60_000) / 1000;
			await fs.utimes(fileA, staleSeconds, staleSeconds);
			activeSession = fileB;
			await tailer.refreshActiveSession();
			expect(resets).toEqual([fileA, fileB]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
