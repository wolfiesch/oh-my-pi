import { afterEach, describe, expect, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import { MAX_ARRAY_ITEMS, parseBounded } from "@oh-my-pi/app-wire";
import {
	boundedRpcSessionEvent,
	createRpcSessionEntrySubscription,
	RPC_AGENT_END_MAX_BYTES,
	RPC_INLINE_IMAGE_DATA_ENV,
	RPC_SESSION_ENTRIES_ENV,
	type RpcSessionEntryFrame,
	rpcTransportFrame,
	runRpcMode,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { postmortem } from "@oh-my-pi/pi-utils";

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

function imagePayloads(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(imagePayloads);
	if (!value || typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	const current = record.type === "image" && typeof record.data === "string" ? [record.data] : [];
	return [...current, ...Object.values(record).flatMap(imagePayloads)];
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

	test("stock RPC mode does not subscribe or emit unsolicited durable-entry frames", () => {
		const manager = new FakeSessionManager();
		const frames: RpcSessionEntryFrame[] = [];
		const subscription = createRpcSessionEntrySubscription(frame => frames.push(frame), false);
		subscription.bind(manager);
		manager.append(entry("stock-rpc-entry", null, "2026-07-11T12:00:02.000Z"));

		expect(manager.subscribeCalls).toBe(0);
		expect(manager.listeners).toHaveLength(0);
		expect(frames).toEqual([]);
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

	test("managed RPC stdout projects durable image entries before appserver delivery", async () => {
		const inlineImageEnv = process.env[RPC_INLINE_IMAGE_DATA_ENV];
		const sessionEntriesEnv = process.env[RPC_SESSION_ENTRIES_ENV];
		const notificationsEnv = process.env.PI_NOTIFICATIONS;
		const stop = new Error("captured managed session entry");
		const manager = new FakeSessionManager();
		const bytes = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.alloc(64, 0x6a),
		]);
		const data = bytes.toString("base64");
		const digest = createHash("sha256").update(bytes).digest("hex");
		const durable: SessionEntry = {
			type: "message",
			id: "managed-image-entry",
			parentId: null,
			timestamp: "2026-07-14T12:00:00.000Z",
			message: {
				role: "user",
				content: [{ type: "image", mimeType: "image/png", data }],
				timestamp: 1,
			},
		};
		let projected: (RpcSessionEntryFrame & { inlineImageDataOmitted?: true }) | undefined;
		const registerSpy = vi.spyOn(postmortem, "register").mockReturnValue(() => {});
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			const frame = JSON.parse(String(chunk)) as Record<string, unknown>;
			if (frame.type === "ready") {
				manager.append(durable);
				return true;
			}
			if (frame.type === "session_entry") {
				projected = frame as unknown as RpcSessionEntryFrame & { inlineImageDataOmitted?: true };
				throw stop;
			}
			return true;
		});

		try {
			process.env[RPC_INLINE_IMAGE_DATA_ENV] = "omit";
			process.env[RPC_SESSION_ENTRIES_ENV] = "1";

			const session = {
				sessionManager: manager,
				beginDispose() {},
				async dispose() {},
			} as unknown as AgentSession;
			await expect(runRpcMode(session)).rejects.toBe(stop);

			expect(projected?.inlineImageDataOmitted).toBe(true);
			if (projected?.entry.type !== "message" || projected.entry.message.role !== "user")
				throw new Error("expected projected user image entry");
			if (!Array.isArray(projected.entry.message.content)) throw new Error("expected projected image content");
			const image = projected.entry.message.content.find(block => block.type === "image");
			expect(image).toMatchObject({ data: "", mimeType: "image/png", appImageSha256: digest });
			if (durable.message.role !== "user" || !Array.isArray(durable.message.content))
				throw new Error("expected durable user image entry");
			expect(durable.message.content[0]).toMatchObject({ data });
		} finally {
			stdoutSpy.mockRestore();
			registerSpy.mockRestore();
			if (inlineImageEnv === undefined) delete process.env[RPC_INLINE_IMAGE_DATA_ENV];
			else process.env[RPC_INLINE_IMAGE_DATA_ENV] = inlineImageEnv;
			if (sessionEntriesEnv === undefined) delete process.env[RPC_SESSION_ENTRIES_ENV];
			else process.env[RPC_SESSION_ENTRIES_ENV] = sessionEntriesEnv;
			if (notificationsEnv === undefined) delete process.env.PI_NOTIFICATIONS;
			else process.env.PI_NOTIFICATIONS = notificationsEnv;
		}
	});

	test("appserver transport omits inline image bytes without mutating the durable entry", () => {
		const imageData = "a".repeat(700_000);
		const durable: SessionEntry = {
			type: "message",
			id: "image-entry",
			parentId: null,
			timestamp: "2026-07-14T12:00:00.000Z",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "compare these" },
					{ type: "image", mimeType: "image/png", data: imageData },
					{ type: "image", mimeType: "image/jpeg", data: imageData },
				],
				timestamp: 1,
			},
		};
		const rawFrame: RpcSessionEntryFrame = { type: "session_entry", entry: durable };
		expect(new TextEncoder().encode(JSON.stringify(rawFrame)).byteLength).toBeGreaterThan(1_048_576);

		const projected = rpcTransportFrame(rawFrame, true);
		expect(() => parseBounded(JSON.stringify(projected))).not.toThrow();
		expect(projected.inlineImageDataOmitted).toBe(true);
		expect(imagePayloads(projected)).toEqual(["", ""]);
		expect(imagePayloads(durable)).toEqual([imageData, imageData]);
	});

	test("managed image omission carries a verified blob digest while stock RPC stays untouched", () => {
		const bytes = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.alloc(1_024, 0x4a),
		]);
		const data = bytes.toString("base64");
		const digest = createHash("sha256").update(bytes).digest("hex");
		const frame = {
			type: "session_entry",
			entry: {
				type: "message",
				id: "digest-entry",
				parentId: null,
				timestamp: "2026-07-14T12:00:00.000Z",
				message: {
					role: "user",
					content: [
						{
							type: "image",
							mimeType: "image/png",
							data,
							appImageSha256: "f".repeat(64),
						},
					],
				},
			},
		};
		expect(rpcTransportFrame(frame, false)).toBe(frame);
		const projected = rpcTransportFrame(frame, true) as Record<string, unknown>;
		const entry = projected.entry as Record<string, unknown>;
		const message = entry.message as Record<string, unknown>;
		const image = (message.content as Array<Record<string, unknown>>)[0]!;
		expect(image).toMatchObject({ type: "image", mimeType: "image/png", data: "", appImageSha256: digest });
		expect((frame.entry.message.content[0] as Record<string, unknown>).appImageSha256 as string).toBe("f".repeat(64));
	});

	test("appserver transport also bounds image-bearing lifecycle events", () => {
		const imageData = "b".repeat(1_100_000);
		const event: AgentSessionEvent = {
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "image", mimeType: "image/png", data: imageData }],
				timestamp: 1,
			},
		};
		const projected = rpcTransportFrame(event, true);
		expect(() => parseBounded(JSON.stringify(projected))).not.toThrow();
		expect(projected.inlineImageDataOmitted).toBe(true);
		expect(event.message.role === "user" && Array.isArray(event.message.content)).toBe(true);
		if (event.message.role !== "user" || !Array.isArray(event.message.content))
			throw new Error("expected user image");
		const original = event.message.content.find(block => block.type === "image");
		expect(original?.data).toBe(imageData);
	});

	test("ordinary frames retain object identity", () => {
		const frame = { type: "notice", message: "ready" };
		expect(rpcTransportFrame(frame, true)).toBe(frame);
		expect(rpcTransportFrame(frame, false)).toBe(frame);
	});

	test("appserver transport omits standalone image data URLs", () => {
		const dataUrl = `data:image/png;base64,${"c".repeat(1_100_000)}`;
		const frame = { type: "tool_execution_end", result: { preview: dataUrl } };
		const projected = rpcTransportFrame(frame, true);
		expect(() => parseBounded(JSON.stringify(projected))).not.toThrow();
		expect(projected).toEqual({
			type: "tool_execution_end",
			result: { preview: "[inline image data omitted]" },
			inlineImageDataOmitted: true,
			transportDataOmitted: true,
			transportOmissionReasons: ["inline_image_data"],
		});
		expect(frame.result.preview).toBe(dataUrl);
	});

	test("appserver transport drops oversized MCP raw content while retaining tool routing", () => {
		const rawContent = [{ type: "text", text: "m".repeat(1_100_000) }];
		const frame = {
			type: "tool_execution_end",
			toolCallId: "mcp-call-1",
			toolName: "mcp__example__read",
			isError: false,
			result: {
				content: [{ type: "text", text: "bounded summary" }],
				details: { rawContent, provider: "example" },
			},
		};
		expect(() => parseBounded(JSON.stringify(frame))).toThrow();

		const projected = rpcTransportFrame(frame, true);
		expect(() => parseBounded(JSON.stringify(projected))).not.toThrow();
		expect(projected.type).toBe("tool_execution_end");
		expect(projected.toolCallId).toBe("mcp-call-1");
		expect(projected.toolName).toBe("mcp__example__read");
		expect(projected.isError).toBe(false);
		expect(projected.transportDataOmitted).toBe(true);
		expect(projected.transportOmissionReasons).toContain("raw_content");
		expect((projected.result.details as Record<string, unknown>).rawContent).toBe("[transport data omitted]");
		expect(frame.result.details.rawContent).toBe(rawContent);
	});

	test("appserver transport bounds a large durable entry without mutating it", () => {
		const text = "session text ".repeat(100_000);
		const frame = {
			type: "session_entry",
			entry: {
				type: "custom",
				id: "large-session-entry",
				parentId: "parent-entry",
				timestamp: "2026-07-14T12:00:00.000Z",
				customType: "mcp-result",
				data: { text },
			},
		};
		expect(() => parseBounded(JSON.stringify(frame))).toThrow();

		const projected = rpcTransportFrame(frame, true);
		expect(() => parseBounded(JSON.stringify(projected))).not.toThrow();
		expect(projected.type).toBe("session_entry");
		expect(projected.entry.id).toBe("large-session-entry");
		expect(projected.entry.parentId).toBe("parent-entry");
		expect(projected.entry.data.text.length).toBeLessThan(text.length);
		expect(projected.transportOmissionReasons).toContain("oversized_string");
		expect(frame.entry.data.text).toBe(text);
	});

	test("appserver transport projects collection, depth, and node overflows", () => {
		const deep: Record<string, unknown> = {};
		let cursor = deep;
		for (let index = 0; index < 40; index++) {
			const next: Record<string, unknown> = {};
			cursor.next = next;
			cursor = next;
		}
		const wide = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`key-${index}`, index]));
		const frame = {
			type: "future_event",
			id: "routing-id",
			items: Array.from({ length: 1_100 }, (_, index) => ({ index, values: [index, index + 1] })),
			wide,
			deep,
		};
		expect(() => parseBounded(JSON.stringify(frame))).toThrow();

		const projected = rpcTransportFrame(frame, true);
		expect(() => parseBounded(JSON.stringify(projected))).not.toThrow();
		expect(projected.type).toBe("future_event");
		expect(projected.id).toBe("routing-id");
		expect(projected.transportDataOmitted).toBe(true);
		expect(projected.transportOmissionReasons).toContain("array_items");
		expect(projected.transportOmissionReasons).toContain("map_keys");
		expect(projected.transportOmissionReasons).toContain("json_depth_limit");
	});

	test("standard RPC transport leaves even oversized frames byte-for-byte untouched", () => {
		const frame = { type: "future_event", payload: "z".repeat(1_100_000) };
		expect(rpcTransportFrame(frame, false)).toBe(frame);
		expect(rpcTransportFrame(frame, false)).toEqual(frame);
	});

	test("appserver transport preserves routing for cyclic and marker-overflow frames", () => {
		const cyclic: Record<string, unknown> = { type: "future_event", id: "cyclic-routing", status: "active" };
		cyclic.self = cyclic;
		const projectedCycle = rpcTransportFrame(cyclic, true);
		expect(() => parseBounded(JSON.stringify(projectedCycle))).not.toThrow();
		expect(projectedCycle.type).toBe("future_event");
		expect(projectedCycle.id).toBe("cyclic-routing");
		expect(projectedCycle.status).toBe("active");
		expect(projectedCycle.transportOmissionReasons).toContain("cyclic_value");
		expect(cyclic.self).toBe(cyclic);

		const fullMap = {
			type: "tool_execution_end",
			result: { preview: "data:image/png;base64,abc" },
			...Object.fromEntries(Array.from({ length: 510 }, (_, index) => [`field-${index}`, index])),
		};
		expect(Object.keys(fullMap)).toHaveLength(512);
		expect(() => parseBounded(JSON.stringify(fullMap))).not.toThrow();
		const projectedMap = rpcTransportFrame(fullMap, true);
		expect(() => parseBounded(JSON.stringify(projectedMap))).not.toThrow();
		expect(projectedMap.type).toBe("tool_execution_end");
		expect(projectedMap.inlineImageDataOmitted).toBe(true);
		expect(projectedMap.transportOmissionReasons).toContain("map_keys");
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
