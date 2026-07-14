import { afterEach, describe, expect, test } from "bun:test";
import { MAX_ARRAY_ITEMS, parseBounded } from "@oh-my-pi/app-wire";
import {
	boundedRpcSessionEvent,
	createRpcSessionEntrySubscription,
	RPC_AGENT_END_MAX_BYTES,
	type RpcSessionEntryFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

type EntryListener = (entry: SessionEntry) => void;

class FakeSessionManager {
	readonly listeners = new Set<EntryListener>();
	subscribeCalls = 0;
	unsubscribeCalls = 0;

	subscribeEntryAppended(listener: EntryListener): () => void {
		this.subscribeCalls += 1;
		this.listeners.add(listener);
		return () => {
			this.unsubscribeCalls += 1;
			this.listeners.delete(listener);
		};
	}

	append(entry: SessionEntry): void {
		for (const listener of this.listeners) listener(entry);
	}
}

function entry(id: string, parentId: string | null, timestamp: string): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp,
		customType: "rpc-test",
		data: { id },
	};
}

describe("RPC durable session-entry frames", () => {
	const originalStdoutWrite = process.stdout.write;

	afterEach(() => {
		process.stdout.write = originalStdoutWrite;
	});

	test("emits one exact frame per durable append in append order", () => {
		const manager = new FakeSessionManager();
		const frames: RpcSessionEntryFrame[] = [];
		const subscription = createRpcSessionEntrySubscription(frame => frames.push(frame));
		subscription.bind(manager);

		const first = entry("entry-1", null, "2026-07-11T12:00:00.000Z");
		const second = entry("entry-2", "entry-1", "2026-07-11T12:00:01.000Z");
		manager.append(first);
		manager.append(second);

		expect(frames).toEqual([
			{ type: "session_entry", entry: first },
			{ type: "session_entry", entry: second },
		]);
		expect(frames.map(frame => [frame.entry.id, frame.entry.parentId, frame.entry.timestamp])).toEqual([
			["entry-1", null, "2026-07-11T12:00:00.000Z"],
			["entry-2", "entry-1", "2026-07-11T12:00:01.000Z"],
		]);
		expect(manager.subscribeCalls).toBe(1);
		subscription.dispose();
	});

	test("switch detaches the old manager and dispose detaches the active manager", () => {
		const oldManager = new FakeSessionManager();
		const newManager = new FakeSessionManager();
		const frames: RpcSessionEntryFrame[] = [];
		const subscription = createRpcSessionEntrySubscription(frame => frames.push(frame));
		subscription.bind(oldManager);
		subscription.switchTo(newManager);

		oldManager.append(entry("old", null, "2026-07-11T12:01:00.000Z"));
		newManager.append(entry("new", null, "2026-07-11T12:01:01.000Z"));
		expect(frames.map(frame => frame.entry.id)).toEqual(["new"]);
		expect(oldManager.unsubscribeCalls).toBe(1);
		expect(newManager.subscribeCalls).toBe(1);

		subscription.dispose();
		newManager.append(entry("after-dispose", null, "2026-07-11T12:01:02.000Z"));
		expect(frames.map(frame => frame.entry.id)).toEqual(["new"]);
		expect(newManager.unsubscribeCalls).toBe(1);
	});

	test("failed session changes keep the active manager subscribed", () => {
		const manager = new FakeSessionManager();
		const frames: RpcSessionEntryFrame[] = [];
		const subscription = createRpcSessionEntrySubscription(frame => frames.push(frame));
		subscription.bind(manager);

		try {
			throw new Error("switch rejected");
		} catch {
			subscription.bind(manager);
		}
		manager.append(entry("after-failed-switch", null, "2026-07-11T12:01:03.000Z"));

		expect(frames.map(frame => frame.entry.id)).toEqual(["after-failed-switch"]);
		expect(manager.subscribeCalls).toBe(1);
		expect(manager.unsubscribeCalls).toBe(0);
		subscription.dispose();
	});

	test("keeps the listener during an async transition and avoids duplicate rebinds", async () => {
		const manager = new FakeSessionManager();
		const frames: RpcSessionEntryFrame[] = [];
		const subscription = createRpcSessionEntrySubscription(frame => frames.push(frame));
		subscription.bind(manager);

		await (async () => {
			await Promise.resolve();
			manager.append(entry("during-transition", null, "2026-07-11T12:01:04.000Z"));
			subscription.bind(manager);
		})();
		manager.append(entry("after-transition", "during-transition", "2026-07-11T12:01:05.000Z"));

		expect(frames.map(frame => frame.entry.id)).toEqual(["during-transition", "after-transition"]);
		expect(manager.subscribeCalls).toBe(1);
		expect(manager.unsubscribeCalls).toBe(0);
		subscription.dispose();
	});

	test("writer error cleans up the subscription", () => {
		const manager = new FakeSessionManager();
		let writes = 0;
		const subscription = createRpcSessionEntrySubscription(() => {
			writes += 1;
			throw new Error("writer closed");
		});
		subscription.bind(manager);

		expect(() => manager.append(entry("failed", null, "2026-07-11T12:02:00.000Z"))).toThrow("writer closed");
		manager.append(entry("ignored", null, "2026-07-11T12:02:01.000Z"));
		expect(writes).toBe(1);
		expect(manager.unsubscribeCalls).toBe(1);
	});

	test("subscription never writes directly to stdout", () => {
		let stdoutWrites = 0;
		process.stdout.write = (() => {
			stdoutWrites += 1;
			return true;
		}) as typeof process.stdout.write;
		const manager = new FakeSessionManager();
		const frames: RpcSessionEntryFrame[] = [];
		const subscription = createRpcSessionEntrySubscription(frame => frames.push(frame));
		subscription.bind(manager);
		manager.append(entry("no-stdout", null, "2026-07-11T12:03:00.000Z"));

		expect(frames).toHaveLength(1);
		expect(stdoutWrites).toBe(0);
		subscription.dispose();
	});
});

describe("RPC terminal event bounds", () => {
	const encodedBytes = (value: object): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

	test("preserves ordinary agent_end events exactly", () => {
		const event: Extract<AgentSessionEvent, { type: "agent_end" }> = {
			type: "agent_end",
			messages: [{ role: "user", content: "done", timestamp: 1 }],
		};

		expect(boundedRpcSessionEvent(event)).toBe(event);
	});

	test("keeps the newest message suffix when an aggregate agent_end exceeds the child line ceiling", () => {
		const messages = Array.from({ length: 20 }, (_, index) => ({
			role: "user" as const,
			content: `${index}:${"x".repeat(60_000)}`,
			timestamp: index,
		}));
		const event: Extract<AgentSessionEvent, { type: "agent_end" }> = { type: "agent_end", messages };
		expect(encodedBytes(event)).toBeGreaterThan(1_048_576);

		const bounded = boundedRpcSessionEvent(event);
		expect(bounded.type).toBe("agent_end");
		if (bounded.type !== "agent_end") throw new Error("expected terminal event");
		const terminal = bounded as unknown as Record<string, unknown>;
		expect(encodedBytes(bounded)).toBeLessThanOrEqual(RPC_AGENT_END_MAX_BYTES);
		expect(bounded.messages.length).toBeGreaterThan(0);
		expect(bounded.messages.length).toBeLessThan(messages.length);
		expect(bounded.messages.at(-1)).toEqual(event.messages.at(-1));
		expect(terminal.messageCount).toBe(messages.length);
		expect(terminal.status).toBe("completed");
		expect(event.messages).toHaveLength(20);
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
		if (bounded.type !== "agent_end") throw new Error("expected terminal event");
		const terminal = bounded as unknown as Record<string, unknown>;
		expect(encodedBytes(bounded)).toBeLessThanOrEqual(RPC_AGENT_END_MAX_BYTES);
		expect(bounded.messages).toEqual([]);
		expect(terminal.messageCount).toBe(1);
		expect(terminal.status).toBe("failed");
	});

	test("bounds compact aggregates that exceed the app-wire array item limit", () => {
		const messages = Array.from({ length: MAX_ARRAY_ITEMS + 1 }, (_, index) => ({
			role: "user" as const,
			content: String(index),
			timestamp: index,
		}));
		const event: Extract<AgentSessionEvent, { type: "agent_end" }> = { type: "agent_end", messages };
		expect(encodedBytes(event)).toBeLessThan(RPC_AGENT_END_MAX_BYTES);
		expect(() => parseBounded(JSON.stringify(event))).toThrow();

		const bounded = boundedRpcSessionEvent(event);
		expect(bounded.type).toBe("agent_end");
		if (bounded.type !== "agent_end") throw new Error("expected terminal event");
		const terminal = bounded as unknown as Record<string, unknown>;
		expect(() => parseBounded(JSON.stringify(bounded))).not.toThrow();
		expect(bounded.messages).toHaveLength(MAX_ARRAY_ITEMS);
		expect(bounded.messages.at(-1)).toEqual(messages.at(-1));
		expect(terminal.messageCount).toBe(messages.length);
	});

	test("bounds compact aggregates that exceed the app-wire JSON node limit", () => {
		const messages = Array.from({ length: 200 }, (_, index) => ({
			role: "assistant" as const,
			content: Array.from({ length: 40 }, () => ({ type: "text" as const, text: "x" })),
			stopReason: "stop" as const,
			timestamp: index,
		}));
		const event = { type: "agent_end", messages } as Extract<AgentSessionEvent, { type: "agent_end" }>;
		expect(encodedBytes(event)).toBeLessThan(RPC_AGENT_END_MAX_BYTES);
		expect(() => parseBounded(JSON.stringify(event))).toThrow();

		const bounded = boundedRpcSessionEvent(event);
		expect(bounded.type).toBe("agent_end");
		if (bounded.type !== "agent_end") throw new Error("expected terminal event");
		const terminal = bounded as unknown as Record<string, unknown>;
		expect(() => parseBounded(JSON.stringify(bounded))).not.toThrow();
		expect(bounded.messages.length).toBeGreaterThan(0);
		expect(bounded.messages.length).toBeLessThan(messages.length);
		expect(bounded.messages.at(-1)).toEqual(event.messages.at(-1));
		expect(terminal.messageCount).toBe(messages.length);
	});
});
