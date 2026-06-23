import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { MechFileEntry } from "./entries";
import {
	type AgentFileSource,
	type AgentStatus,
	deriveStatusFromTailText,
	MAIN_AGENT_ID,
	MechanismNormalizer,
	type MechEvent,
} from "./normalize";

const usage = {
	input: 100,
	output: 25,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 125,
	cost: {
		input: 0.001,
		output: 0.002,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0.003,
	},
};

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
		api: "openai-responses" as AssistantMessage["api"],
		provider: "openai" as AssistantMessage["provider"],
		model: "openai/gpt-5.5",
		usage,
		stopReason: "toolUse",
		timestamp: 10,
		...overrides,
	};
}

function toolResultMessage(overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: 11,
		...overrides,
	};
}

describe("MechanismNormalizer", () => {
	test("maps tool, usage, irc, and model updates into MechEvents", () => {
		const normalizer = new MechanismNormalizer({ now: () => 1_000 });
		const source: AgentFileSource = {
			filePath: "/tmp/main.jsonl",
			agentId: MAIN_AGENT_ID,
			parentId: null,
			depth: 0,
			isMain: true,
			mtimeMs: 1_000,
		};
		normalizer.registerAgentFile(source);

		const assistantEntry: MechFileEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-06-17T00:00:00.000Z",
			message: assistantMessage(),
		};
		const toolResultEntry: MechFileEntry = {
			type: "message",
			id: "entry-2",
			parentId: "entry-1",
			timestamp: "2026-06-17T00:00:01.000Z",
			message: toolResultMessage(),
		};
		const ircEntry: MechFileEntry = {
			type: "custom_message",
			id: "entry-3",
			parentId: "entry-2",
			timestamp: "2026-06-17T00:00:02.000Z",
			customType: "irc:relay",
			content: "relay",
			details: { from: "Scout", to: MAIN_AGENT_ID, body: "done" },
			display: true,
		};

		const events: MechEvent[] = [
			...normalizer.processEntry(source, assistantEntry, 1_000),
			...normalizer.processEntry(source, toolResultEntry, 1_000),
			...normalizer.processEntry(source, ircEntry, 1_000),
		];

		expect(events).toEqual([
			{
				t: "roster",
				agents: [
					{
						id: MAIN_AGENT_ID,
						parentId: null,
						model: "openai/gpt-5.5",
						family: "openai",
						status: "running",
						depth: 0,
						label: MAIN_AGENT_ID,
					},
				],
			},
			{ t: "tool", id: MAIN_AGENT_ID, tool: "read", phase: "start" },
			{ t: "usage", model: "openai/gpt-5.5", costUsd: 0.003, tokensIn: 100, tokensOut: 25 },
			{ t: "tool", id: MAIN_AGENT_ID, tool: "read", phase: "end" },
			{ t: "irc", from: "Scout", to: MAIN_AGENT_ID },
		]);
	});

	test("pushIrc emits a direct IRC event without changing JSONL relay replay", () => {
		const normalizer = new MechanismNormalizer();

		expect(normalizer.pushIrc("Main", "Scout")).toEqual([{ t: "irc", from: "Main", to: "Scout" }]);
	});

	test("derives stale running agents as idle from the session tail", async () => {
		let now = 1_000;
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mech-normalize-"));
		try {
			const sessionFile = path.join(tempDir, "main.jsonl");
			const assistant = assistantMessage({ content: [{ type: "text", text: "finished" }], stopReason: "stop" });
			await Bun.write(
				sessionFile,
				`${JSON.stringify({ type: "session", id: "session-1", timestamp: "2026-06-17T00:00:00.000Z" })}\n${JSON.stringify({ type: "message", id: "entry-1", parentId: null, timestamp: "2026-06-17T00:00:01.000Z", message: assistant })}\n`,
			);

			const normalizer = new MechanismNormalizer({ activityThresholdMs: 5_000, now: () => now });
			normalizer.registerAgentFile({
				filePath: sessionFile,
				agentId: MAIN_AGENT_ID,
				parentId: null,
				depth: 0,
				isMain: true,
				mtimeMs: now,
			});
			now = 7_000;

			await expect(normalizer.checkStatuses()).resolves.toEqual([
				{ t: "status", id: MAIN_AGENT_ID, status: "idle" },
			]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("never emits a parked status from the live tail path", async () => {
		let now = 1_000;
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mech-honesty-"));
		try {
			const sessionFile = path.join(tempDir, "main.jsonl");
			const assistant = assistantMessage({ content: [{ type: "text", text: "finished" }], stopReason: "stop" });
			await Bun.write(
				sessionFile,
				`${JSON.stringify({ type: "session", id: "session-1", timestamp: "2026-06-17T00:00:00.000Z" })}\n${JSON.stringify({ type: "message", id: "entry-1", parentId: null, timestamp: "2026-06-17T00:00:01.000Z", message: assistant })}\n`,
			);

			const normalizer = new MechanismNormalizer({ activityThresholdMs: 5_000, now: () => now });
			const source: AgentFileSource = {
				filePath: sessionFile,
				agentId: MAIN_AGENT_ID,
				parentId: null,
				depth: 0,
				isMain: true,
				mtimeMs: now,
			};
			const messageEntry: MechFileEntry = {
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-06-17T00:00:01.000Z",
				message: assistant,
			};

			const events: MechEvent[] = [
				...normalizer.registerAgentFile(source),
				...normalizer.processEntry(source, messageEntry, now),
			];
			now = 10_000;
			events.push(...(await normalizer.checkStatuses()));
			now = 60_000;
			events.push(...(await normalizer.checkStatuses()));

			const statuses: AgentStatus[] = [];
			for (const event of events) {
				if (event.t === "status") statuses.push(event.status);
				else if (event.t === "spawn") statuses.push(event.agent.status);
				else if (event.t === "roster") for (const agent of event.agents) statuses.push(agent.status);
			}

			const allowed: AgentStatus[] = ["running", "idle", "aborted"];
			expect(statuses.length).toBeGreaterThan(0);
			expect(statuses).not.toContain("parked");
			for (const status of statuses) expect(allowed).toContain(status);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("deriveStatusFromTailText", () => {
	test("classifies assistant stop, error, and pending tool states", () => {
		const idleLine = JSON.stringify({
			type: "message",
			message: assistantMessage({ content: [], stopReason: "stop" }),
		});
		const errorLine = JSON.stringify({
			type: "message",
			message: assistantMessage({ content: [], stopReason: "error", errorMessage: "provider failed" }),
		});
		const toolUseLine = JSON.stringify({ type: "message", message: assistantMessage() });

		expect(deriveStatusFromTailText(`${idleLine}\n`)).toBe("idle");
		expect(deriveStatusFromTailText(`${errorLine}\n`)).toBe("aborted");
		expect(deriveStatusFromTailText(`${toolUseLine}\n`)).toBe("running");
	});
});
