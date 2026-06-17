import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MAIN_AGENT_ID } from "./normalize";
import { SessionTailer, type TailerRecord } from "./tail";

const activeTailers: SessionTailer[] = [];

afterEach(() => {
	for (const tailer of activeTailers.splice(0)) tailer.stop();
});

describe("SessionTailer", () => {
	test("buffers a partial line until the trailing newline arrives", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mech-tail-"));
		try {
			const mainFile = path.join(tempDir, "main.jsonl");
			await Bun.write(mainFile, "");
			const records: TailerRecord[] = [];
			const tailer = new SessionTailer({ mainSessionFile: mainFile });
			activeTailers.push(tailer);
			tailer.onRecord(record => records.push(record));
			await tailer.start();

			const line = JSON.stringify({ type: "session", id: "session-1", timestamp: "2026-06-17T00:00:00.000Z" });
			await fs.appendFile(mainFile, line);
			await tailer.flush();
			expect(records.some(record => record.t === "entry")).toBe(false);

			await fs.appendFile(mainFile, "\n");
			await tailer.flush();
			const entryRecord = records.find(record => record.t === "entry");
			expect(entryRecord).toBeDefined();
			expect(entryRecord).toMatchObject({
				t: "entry",
				source: { agentId: MAIN_AGENT_ID, parentId: null, depth: 0, isMain: true },
				entry: { type: "session", id: "session-1" },
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("discovers subagent jsonl files in the active session artifacts directory", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mech-tail-"));
		try {
			const mainFile = path.join(tempDir, "main.jsonl");
			await Bun.write(
				mainFile,
				`${JSON.stringify({ type: "session", id: "session-1", timestamp: "2026-06-17T00:00:00.000Z" })}\n`,
			);
			const records: TailerRecord[] = [];
			const tailer = new SessionTailer({ mainSessionFile: mainFile });
			activeTailers.push(tailer);
			tailer.onRecord(record => records.push(record));
			await tailer.start();

			const subagentDir = mainFile.slice(0, -".jsonl".length);
			await fs.mkdir(subagentDir, { recursive: true });
			const subagentFile = path.join(subagentDir, "Worker.jsonl");
			await Bun.write(
				subagentFile,
				`${JSON.stringify({ type: "session", id: "worker-session", timestamp: "2026-06-17T00:00:01.000Z" })}\n`,
			);

			await tailer.flush();
			const agentRecord = records.find(record => record.t === "agent" && record.source.agentId === "Worker");
			expect(agentRecord).toBeDefined();
			expect(agentRecord).toMatchObject({
				t: "agent",
				source: { agentId: "Worker", parentId: MAIN_AGENT_ID, depth: 1, isMain: false },
			});
			expect(records.some(record => record.t === "entry" && record.source.agentId === "Worker")).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
