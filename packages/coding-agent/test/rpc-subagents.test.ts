import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseBounded } from "@oh-my-pi/app-wire";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	handleRpcSessionChange,
	type RpcSessionChangeCommand,
	type RpcSessionChangeResult,
	type RpcSessionChangeSession,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import {
	RPC_SUBAGENT_TRANSCRIPT_MAX_BYTES,
	RPC_SUBAGENT_TRANSCRIPT_MAX_RECORDS,
	RpcSubagentRegistry,
	readRpcSubagentTranscript,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	type AgentProgress,
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const tempPaths: string[] = [];

afterEach(() => {
	for (const tempPath of tempPaths.splice(0)) {
		removeSyncWithRetries(tempPath);
	}
});

function createProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "SubagentA",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Do work",
		assignment: "Implement work",
		description: "Worker",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function createRegistryWithSnapshot(): RpcSubagentRegistry {
	const eventBus = new EventBus();
	const registry = new RpcSubagentRegistry(eventBus, () => {});
	eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: "SubagentA",
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "started",
		sessionFile: "/tmp/subagent.jsonl",
	} satisfies SubagentLifecyclePayload);
	expect(registry.getSubagents()).toHaveLength(1);
	return registry;
}

type SessionChangeStubOptions = {
	newSession?: boolean;
	switchSession?: boolean;
	branch?: { selectedText: string; cancelled: boolean };
};

function createSessionChangeSession(options: SessionChangeStubOptions): RpcSessionChangeSession {
	return {
		newSession: async (_options?: unknown) => options.newSession ?? true,
		switchSession: async (_sessionPath: string) => options.switchSession ?? true,
		branch: async (_entryId: string) => options.branch ?? { selectedText: "branched text", cancelled: false },
	};
}

describe("RPC subagent registry", () => {
	test("defaults subagent frame emission to off while tracking snapshots", () => {
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		const lifecycle: SubagentLifecyclePayload = {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/subagent.jsonl",
			progress: createProgress(),
		};
		const eventPayload: SubagentEventPayload = {
			id: "SubagentA",
			event: { type: "agent_start" },
		};

		expect(registry.getSubscriptionLevel()).toBe("off");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(0);
		expect(registry.getSubagents()).toMatchObject([
			{
				id: "SubagentA",
				status: "running",
				sessionFile: "/tmp/subagent.jsonl",
			},
		]);
		registry.dispose();
	});

	test("emits progress frames after explicit progress subscription and snapshots tracked subagents", () => {
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		registry.setSubscriptionLevel("progress");
		const lifecycle: SubagentLifecyclePayload = {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/subagent.jsonl",
			progress: createProgress(),
		};

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);

		expect(frames.map(frame => frame.type)).toEqual(["subagent_lifecycle", "subagent_progress"]);
		expect(registry.getSubagents()).toMatchObject([
			{
				id: "SubagentA",
				status: "running",
				task: "Do work",
				assignment: "Implement work",
				sessionFile: "/tmp/subagent.jsonl",
				parentToolCallId: "toolu_parent",
			},
		]);

		registry.dispose();
	});

	test("emits idle and parked resumable lifecycle states from the process registry", () => {
		AgentRegistry.resetGlobalForTests();
		const globalRegistry = AgentRegistry.global();
		globalRegistry.register({
			id: "SubagentA",
			displayName: "Worker",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/subagent.jsonl",
			status: "running",
		});
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame), "progress");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
		} satisfies SubagentLifecyclePayload);
		globalRegistry.setStatus("SubagentA", "idle");
		globalRegistry.setStatus("SubagentA", "parked");

		expect(frames.map(frame => frame.type)).toEqual([
			"subagent_lifecycle",
			"subagent_lifecycle",
			"subagent_lifecycle",
		]);
		expect(frames.at(-1)).toMatchObject({
			type: "subagent_lifecycle",
			payload: { status: "parked", resumable: true },
		});
		expect(registry.getSubagents()).toMatchObject([{ id: "SubagentA", status: "parked", resumable: true }]);
		globalRegistry.unregister("SubagentA");
		expect(registry.getSubagents()).toHaveLength(0);
		registry.dispose();
		AgentRegistry.resetGlobalForTests();
	});

	test("clears stale snapshots when the active RPC session changes", () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(1);
		registry.clear();

		expect(registry.getSubagents()).toHaveLength(0);
		registry.dispose();
	});

	test("clears stale snapshots after successful RPC session changes", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: true }),
				expected: { type: "new_session", data: { cancelled: false } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: true }),
				expected: { type: "switch_session", data: { cancelled: false } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({ branch: { selectedText: "Branch text", cancelled: false } }),
				expected: { type: "branch", data: { text: "Branch text", cancelled: false } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot();
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, registry);

				expect(result).toEqual(testCase.expected);
				expect(registry.getSubagents()).toHaveLength(0);
				expect(() => registry.resolveSessionFile({ subagentId: "SubagentA" })).toThrow(
					/Unknown subagent or session file unavailable/,
				);
			} finally {
				registry.dispose();
			}
		}
	});

	test("keeps stale snapshots when RPC session changes are cancelled", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: false }),
				expected: { type: "new_session", data: { cancelled: true } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: false }),
				expected: { type: "switch_session", data: { cancelled: true } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({ branch: { selectedText: "", cancelled: true } }),
				expected: { type: "branch", data: { text: "", cancelled: true } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot();
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, registry);

				expect(result).toEqual(testCase.expected);
				expect(registry.getSubagents()).toMatchObject([{ id: "SubagentA" }]);
				expect(registry.resolveSessionFile({ subagentId: "SubagentA" })).toBe("/tmp/subagent.jsonl");
			} finally {
				registry.dispose();
			}
		}
	});

	test("prunes terminal lifecycle snapshots while retaining transcript selectors", () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		const sessionFile = "/tmp/subagent.jsonl";
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile,
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(1);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			sessionFile,
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(0);
		expect(registry.resolveSessionFile({ subagentId: "SubagentA" })).toBe(sessionFile);
		expect(registry.resolveSessionFile({ sessionFile })).toBe(sessionFile);
		registry.dispose();
	});

	test("gates raw subagent events behind the events subscription level", () => {
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		const eventPayload: SubagentEventPayload = {
			id: "SubagentA",
			event: { type: "agent_start" },
		};

		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);
		expect(frames).toHaveLength(0);

		registry.setSubscriptionLevel("events");
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({ type: "subagent_event", payload: eventPayload });
		registry.dispose();
	});
});

describe("readRpcSubagentTranscript", () => {
	test("returns complete JSONL entries and byte cursor", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		const messageLine = `${JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-06-09T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		})}\n`;
		await Bun.write(sessionFile, `${headerLine}${messageLine}{"type":"message"`);

		const result = await readRpcSubagentTranscript(sessionFile);

		expect(result.entries).toHaveLength(2);
		expect(result.messages).toHaveLength(1);
		expect(result.nextByte).toBe(Buffer.byteLength(`${headerLine}${messageLine}`, "utf8"));
		expect(result.reset).toBe(false);

		const incomplete = await readRpcSubagentTranscript(sessionFile, result.nextByte, { maxBytes: 128 });
		expect(incomplete).toMatchObject({
			fromByte: result.nextByte,
			nextByte: result.nextByte,
			reset: false,
			entries: [],
			messages: [],
		});
	});

	test("chunks only complete UTF-8 JSONL records and can omit the redundant message view", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-chunks-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		const text = "grüg 🐗 ".repeat(24);
		const messageLine = `${JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-06-09T00:00:01.000Z",
			message: { role: "assistant", content: [{ type: "text", text }] },
		})}\n`;
		const finalLine = `${JSON.stringify({
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: "2026-06-09T00:00:02.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		})}\n`;
		await Bun.write(sessionFile, `${headerLine}${messageLine}${finalLine}`);
		const maxBytes = Buffer.byteLength(messageLine, "utf8");

		const first = await readRpcSubagentTranscript(sessionFile, 0, { maxBytes, includeMessages: false });
		expect(first.entries.map(entry => entry.type)).toEqual(["session"]);
		expect(first.messages).toEqual([]);
		expect(first.nextByte).toBe(Buffer.byteLength(headerLine, "utf8"));

		const second = await readRpcSubagentTranscript(sessionFile, first.nextByte, {
			maxBytes,
			includeMessages: false,
		});
		expect(second.entries).toMatchObject([
			{ type: "message", id: "m1", message: { content: [{ type: "text", text }] } },
		]);
		expect(second.messages).toEqual([]);
		expect(second.nextByte).toBe(Buffer.byteLength(`${headerLine}${messageLine}`, "utf8"));
	});

	test("rejects an entry that cannot fit in one bounded chunk", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-oversized-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		await Bun.write(
			sessionFile,
			`${JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-06-09T00:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "x".repeat(512) }] },
			})}\n`,
		);

		await expect(readRpcSubagentTranscript(sessionFile, 0, { maxBytes: 128 })).rejects.toThrow(
			"subagent transcript entry exceeds maxBytes (128)",
		);
		await expect(readRpcSubagentTranscript(sessionFile, 0, { maxBytes: 0 })).rejects.toThrow(
			`maxBytes must be an integer between 1 and ${RPC_SUBAGENT_TRANSCRIPT_MAX_BYTES}`,
		);
	});

	test("resets a stale cursor after transcript truncation", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-reset-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const original = `${JSON.stringify({ type: "session", id: "old", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n${JSON.stringify({ type: "custom", id: "old-entry", parentId: null, timestamp: "2026-06-09T00:00:01.000Z" })}\n`;
		await Bun.write(sessionFile, original);
		const cursor = (await readRpcSubagentTranscript(sessionFile)).nextByte;
		const replacement = `${JSON.stringify({ type: "session", id: "new", timestamp: "2026-06-09T00:00:02.000Z", cwd: dir })}\n`;
		await Bun.write(sessionFile, replacement);

		const result = await readRpcSubagentTranscript(sessionFile, cursor);

		expect(result).toMatchObject({
			fromByte: 0,
			nextByte: Buffer.byteLength(replacement, "utf8"),
			reset: true,
			entries: [{ type: "session", id: "new" }],
		});
	});

	test("keeps an entries-only maximum chunk below the appserver RPC line ceiling", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-line-bound-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		const messageLines = Array.from(
			{ length: 8 },
			(_, index) =>
				`${JSON.stringify({
					type: "message",
					id: `m${index}`,
					parentId: index === 0 ? null : `m${index - 1}`,
					timestamp: "2026-06-09T00:00:01.000Z",
					message: { role: "assistant", content: [{ type: "text", text: `${index}:${"x".repeat(47_000)}` }] },
				})}\n`,
		);
		await Bun.write(sessionFile, `${headerLine}${messageLines.join("")}`);

		const result = await readRpcSubagentTranscript(sessionFile, 0, {
			maxBytes: RPC_SUBAGENT_TRANSCRIPT_MAX_BYTES,
			includeMessages: false,
		});
		const responseLine = JSON.stringify({
			id: "read-1",
			type: "response",
			command: "get_subagent_messages",
			success: true,
			data: result,
		});

		expect(result.nextByte).toBeLessThanOrEqual(RPC_SUBAGENT_TRANSCRIPT_MAX_BYTES);
		expect(result.messages).toEqual([]);
		expect(Buffer.byteLength(responseLine, "utf8")).toBeLessThan(1024 * 1024);
		expect(() => parseBounded(responseLine)).not.toThrow();

		const compatibleDefault = await readRpcSubagentTranscript(sessionFile);
		const compatibleResponseLine = JSON.stringify({
			id: "read-2",
			type: "response",
			command: "get_subagent_messages",
			success: true,
			data: compatibleDefault,
		});
		expect(compatibleDefault.messages.length).toBeGreaterThan(0);
		expect(Buffer.byteLength(compatibleResponseLine, "utf8")).toBeLessThan(1024 * 1024);
		expect(() => parseBounded(compatibleResponseLine)).not.toThrow();
	});

	test("caps complete records without letting transport projection skip cursor data", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-record-bound-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const lines = Array.from(
			{ length: RPC_SUBAGENT_TRANSCRIPT_MAX_RECORDS + 17 },
			(_, index) =>
				`${JSON.stringify({
					type: "message",
					id: `m${index}`,
					parentId: index === 0 ? null : `m${index - 1}`,
					timestamp: "2026-06-09T00:00:01.000Z",
					message: { role: "assistant", content: [{ type: "text", text: String(index) }] },
				})}\n`,
		);
		await Bun.write(sessionFile, lines.join(""));

		const first = await readRpcSubagentTranscript(sessionFile, 0, { includeMessages: false });
		const second = await readRpcSubagentTranscript(sessionFile, first.nextByte, { includeMessages: false });
		const firstResponse = JSON.stringify({
			id: "read-records-1",
			type: "response",
			command: "get_subagent_messages",
			success: true,
			data: first,
		});
		const secondResponse = JSON.stringify({
			id: "read-records-2",
			type: "response",
			command: "get_subagent_messages",
			success: true,
			data: second,
		});

		expect(first.entries).toHaveLength(RPC_SUBAGENT_TRANSCRIPT_MAX_RECORDS);
		expect(first.nextByte).toBe(Buffer.byteLength(lines.slice(0, RPC_SUBAGENT_TRANSCRIPT_MAX_RECORDS).join("")));
		expect([...first.entries, ...second.entries].map(entry => ("id" in entry ? entry.id : undefined))).toEqual(
			lines.map((_, index) => `m${index}`),
		);
		expect(() => parseBounded(firstResponse)).not.toThrow();
		expect(() => parseBounded(secondResponse)).not.toThrow();
	});

	test("rejects a single structurally unbounded record before advancing its cursor", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-structure-bound-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		await Bun.write(
			sessionFile,
			`${JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-06-09T00:00:01.000Z",
				message: {
					role: "assistant",
					content: Array.from({ length: 1_001 }, () => ({ type: "text", text: "x" })),
				},
			})}\n`,
		);

		await expect(readRpcSubagentTranscript(sessionFile, 0, { includeMessages: false })).rejects.toThrow(
			"subagent transcript entry exceeds RPC structural bounds",
		);
	});

	test("returns empty cursor result for missing transcript files", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-missing-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "missing.jsonl");

		const result = await readRpcSubagentTranscript(sessionFile, 42);

		expect(result).toEqual({
			sessionFile,
			fromByte: 42,
			nextByte: 42,
			reset: false,
			entries: [],
			messages: [],
		});
	});
});

describe("RpcClient subagent frames", () => {
	test("dispatches subagent frames and session-specific events", async () => {
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-subagent-client-${Date.now()}.js`);
		tempPaths.push(scriptPath);
		await Bun.write(
			scriptPath,
			`
let buffer = "";
function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}
const progress = {
	index: 0,
	id: "SubagentA",
	agent: "task",
	agentSource: "bundled",
	status: "running",
	task: "Do work",
	assignment: "Implement work",
	recentTools: [],
	recentOutput: [],
	toolCount: 0,
	tokens: 0,
	cost: 0,
	durationMs: 0
};
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});
function handle(frame) {
	if (frame.type === "set_subagent_subscription") {
		write({ id: frame.id, type: "response", command: "set_subagent_subscription", success: true, data: { level: frame.level } });
		return;
	}
	if (frame.type === "get_subagents") {
		write({ id: frame.id, type: "response", command: "get_subagents", success: true, data: { subagents: [{ id: "SubagentA", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1 }] } });
		return;
	}
	if (frame.type === "get_subagent_messages") {
		write({ id: frame.id, type: "response", command: "get_subagent_messages", success: true, data: { sessionFile: frame.sessionFile || "/tmp/subagent.jsonl", fromByte: frame.fromByte || 0, nextByte: frame.maxBytes || 0, reset: false, entries: [], messages: frame.includeMessages === false ? [] : [{ role: "user", content: "included" }] } });
		return;
	}
	if (frame.type === "prompt") {
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write({ type: "notice", level: "info", message: "subagent test" });
		write({ type: "subagent_lifecycle", payload: { id: "SubagentA", index: 0, agent: "task", agentSource: "bundled", status: "started", sessionFile: "/tmp/subagent.jsonl" } });
		write({ type: "subagent_progress", payload: { index: 0, agent: "task", agentSource: "bundled", task: "Do work", assignment: "Implement work", sessionFile: "/tmp/subagent.jsonl", progress } });
		write({ type: "subagent_event", payload: { id: "SubagentA", event: { type: "agent_start" } } });
		write({ type: "agent_end", messages: [] });
	}
}
`,
		);

		using client = new RpcClient({ cliPath: scriptPath });
		const lifecycleIds: string[] = [];
		const progressTasks: string[] = [];
		const rawEventTypes: string[] = [];
		const sessionEventTypes: string[] = [];
		client.onSubagentLifecycle(payload => lifecycleIds.push(payload.id));
		client.onSubagentProgress(payload => progressTasks.push(payload.task));
		client.onSubagentEvent(payload => rawEventTypes.push(payload.event.type));
		client.onSessionEvent(event => sessionEventTypes.push(event.type));

		await client.start();
		await expect(client.setSubagentSubscription("events")).resolves.toBe("events");
		await client.promptAndWait("Trigger subagent frames");
		expect(await client.getSubagents()).toHaveLength(1);
		expect(
			await client.getSubagentMessages({
				sessionFile: "/tmp/subagent.jsonl",
				maxBytes: 128,
				includeMessages: false,
			}),
		).toMatchObject({
			sessionFile: "/tmp/subagent.jsonl",
			nextByte: 128,
			messages: [],
		});

		expect(lifecycleIds).toEqual(["SubagentA"]);
		expect(progressTasks).toEqual(["Do work"]);
		expect(rawEventTypes).toEqual(["agent_start"]);
		expect(sessionEventTypes).toContain("notice");
	});
});
