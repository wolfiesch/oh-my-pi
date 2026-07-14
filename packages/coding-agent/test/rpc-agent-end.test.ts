import { describe, expect, test } from "bun:test";
import {
	boundedRpcSessionEvent,
	boundedRpcSubagentFrame,
	RPC_AGENT_END_MAX_BYTES,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const encodedBytes = (value: object): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("RPC terminal event bounds", () => {
	test("preserves ordinary agent_end events exactly", () => {
		const event: Extract<AgentSessionEvent, { type: "agent_end" }> = {
			type: "agent_end",
			messages: [{ role: "user", content: "done", timestamp: 1 }],
		};

		expect(boundedRpcSessionEvent(event)).toBe(event);
	});

	test("keeps the newest message suffix when agent_end exceeds the line ceiling", () => {
		const messages = Array.from({ length: 20 }, (_, index) => ({
			role: "user" as const,
			content: `${index}:${"x".repeat(60_000)}`,
			timestamp: index,
		}));
		const event: Extract<AgentSessionEvent, { type: "agent_end" }> = { type: "agent_end", messages };
		expect(encodedBytes(event)).toBeGreaterThan(1024 * 1024);

		const bounded = boundedRpcSessionEvent(event);
		expect(bounded.type).toBe("agent_end");
		if (bounded.type !== "agent_end") throw new Error("expected agent_end");
		const terminal = bounded as unknown as Record<string, unknown>;
		expect(encodedBytes(bounded)).toBeLessThanOrEqual(RPC_AGENT_END_MAX_BYTES);
		expect(bounded.messages.length).toBeGreaterThan(0);
		expect(bounded.messages.length).toBeLessThan(messages.length);
		expect(bounded.messages.at(-1)).toEqual(messages.at(-1));
		expect(terminal.messageCount).toBe(messages.length);
		expect(terminal.status).toBe("completed");
		expect(event.messages).toHaveLength(20);
	});

	test("counts multibyte content by encoded bytes", () => {
		const messages = Array.from({ length: 8 }, (_, index) => ({
			role: "user" as const,
			content: `${index}:${"🦀".repeat(40_000)}`,
			timestamp: index,
		}));
		const event: Extract<AgentSessionEvent, { type: "agent_end" }> = { type: "agent_end", messages };
		expect(JSON.stringify(event).length).toBeLessThan(RPC_AGENT_END_MAX_BYTES);
		expect(encodedBytes(event)).toBeGreaterThan(RPC_AGENT_END_MAX_BYTES);

		const bounded = boundedRpcSessionEvent(event);
		expect(encodedBytes(bounded)).toBeLessThanOrEqual(RPC_AGENT_END_MAX_BYTES);
		if (bounded.type !== "agent_end") throw new Error("expected agent_end");
		expect(bounded.messages.at(-1)).toEqual(messages.at(-1));
	});

	test("preserves failure metadata when the final assistant message cannot fit", () => {
		const event = {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "x".repeat(1_000_000) }],
					stopReason: "error",
					timestamp: 1,
				},
			],
		} as unknown as Extract<AgentSessionEvent, { type: "agent_end" }>;

		const bounded = boundedRpcSessionEvent(event);
		expect(bounded.type).toBe("agent_end");
		if (bounded.type !== "agent_end") throw new Error("expected agent_end");
		const terminal = bounded as unknown as Record<string, unknown>;
		expect(encodedBytes(bounded)).toBeLessThanOrEqual(RPC_AGENT_END_MAX_BYTES);
		expect(bounded.messages).toEqual([]);
		expect(terminal.messageCount).toBe(1);
		expect(terminal.status).toBe("failed");
	});

	test("bounds agent_end events nested in streamed subagent frames", () => {
		const messages = Array.from({ length: 20 }, (_, index) => ({
			role: "user" as const,
			content: `${index}:${"x".repeat(60_000)}`,
			timestamp: index,
		}));
		const frame = {
			type: "subagent_event" as const,
			payload: {
				id: "subagent-1",
				event: { type: "agent_end" as const, messages },
			},
		};

		const bounded = boundedRpcSubagentFrame(frame);
		expect(encodedBytes(bounded)).toBeLessThan(1024 * 1024);
		expect(bounded.type).toBe("subagent_event");
		if (bounded.type !== "subagent_event" || bounded.payload.event.type !== "agent_end") {
			throw new Error("expected nested agent_end");
		}
		expect(bounded.payload.event.messages.length).toBeLessThan(messages.length);
		expect(bounded.payload.event.messages.at(-1)).toEqual(messages.at(-1));
	});
});
