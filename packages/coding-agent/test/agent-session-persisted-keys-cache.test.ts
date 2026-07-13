import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await Bun.sleep(1);
	}
}

describe("AgentSession persistence-keys cache", () => {
	let session: AgentSession;
	let tempDir: string;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage | undefined;
	let events: AgentSessionEvent[];

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-cache-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tools = await createTools(toolSession);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("bundled model claude-sonnet-4-5 not found");
		}
		const agent = new Agent({
			getApiKey: () => "fake-key",
			initialState: { model, systemPrompt: [], tools },
		});

		sessionManager = SessionManager.create(tempDir, tempDir);
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});

		events = [];
		session.subscribe(event => events.push(event));
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		if (fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("does not duplicate a message on re-persist attempts", async () => {
		const msg: AgentMessage = { role: "user", content: [{ type: "text", text: "Hello cache" }], timestamp: 1000 };

		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
		}

		const count1 = sessionManager.getBranch().filter(e => e.type === "message").length;
		expect(count1).toBe(1);

		// Re-emit should be ignored due to cache
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
		}

		const count2 = sessionManager.getBranch().filter(e => e.type === "message").length;
		expect(count2).toBe(1);
	});

	it("emits one exact stream ID through lifecycle and maps it after the durable append", async () => {
		const order: string[] = [];
		session.subscribe(event => {
			if (
				event.type === "message_start" ||
				event.type === "message_update" ||
				event.type === "message_end" ||
				event.type === "message_persisted"
			) {
				order.push(event.type);
			}
		});
		const unsubscribeEntry = sessionManager.subscribeEntryAppended(entry => order.push(`entry:${entry.id}`));
		try {
			const message = createAssistantMessage("correlated");
			message.timestamp = 1_000;
			session.agent.emitExternalEvent({ type: "message_start", message });
			session.agent.emitExternalEvent({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "correlated" },
			} as never);
			session.agent.emitExternalEvent({ type: "message_end", message });

			await waitFor(
				() => events.some(event => event.type === "message_persisted"),
				"timed out waiting for assistant persistence correlation",
			);
			await sessionManager.flush();

			const lifecycle = events.filter(
				(
					event,
				): event is Extract<AgentSessionEvent, { type: "message_start" | "message_update" | "message_end" }> =>
					event.type === "message_start" || event.type === "message_update" || event.type === "message_end",
			);
			const streamIds = lifecycle.map(event => event.streamId);
			expect(streamIds).toHaveLength(3);
			expect(new Set(streamIds).size).toBe(1);
			expect(streamIds[0]).toBeString();

			const persisted = events.find(event => event.type === "message_persisted");
			if (persisted?.type !== "message_persisted") throw new Error("expected persistence mapping");
			const entry = sessionManager.getBranch().find(value => value.type === "message" && value.message === message);
			expect(entry?.id).toBeString();
			expect(persisted).toMatchObject({ streamId: streamIds[0], entryId: entry?.id });

			const messageEndIndex = order.indexOf("message_end");
			const entryIndex = order.indexOf(`entry:${entry?.id}`);
			const persistedIndex = order.indexOf("message_persisted");
			expect(messageEndIndex).toBeGreaterThanOrEqual(0);
			expect(entryIndex).toBeGreaterThan(messageEndIndex);
			expect(persistedIndex).toBeGreaterThan(entryIndex);
		} finally {
			unsubscribeEntry();
		}
	});

	it("maps same-millisecond replies exactly and reuses an already-persisted identical entry", async () => {
		const first = createAssistantMessage("first");
		first.timestamp = 2_000;
		const second = createAssistantMessage("second");
		second.timestamp = 2_000;

		for (const message of [first, second, first]) {
			const expectedCount = events.filter(event => event.type === "message_persisted").length + 1;
			session.agent.emitExternalEvent({ type: "message_start", message });
			session.agent.emitExternalEvent({ type: "message_end", message });
			await waitFor(
				() => events.filter(event => event.type === "message_persisted").length === expectedCount,
				"timed out waiting for same-millisecond persistence mapping",
			);
		}
		await sessionManager.flush();

		const entries = sessionManager.getBranch().filter(entry => entry.type === "message");
		expect(entries).toHaveLength(2);
		const mappings = events.filter(
			(event): event is Extract<AgentSessionEvent, { type: "message_persisted" }> =>
				event.type === "message_persisted",
		);
		expect(mappings).toHaveLength(3);
		expect(new Set(mappings.map(event => event.streamId)).size).toBe(3);
		expect(mappings.map(event => event.entryId)).toEqual([entries[0].id, entries[1].id, entries[0].id]);
	});

	it("emits an explicit skipped mapping for an empty provider error", async () => {
		const message = createAssistantMessage("");
		message.content = [];
		message.stopReason = "error";
		message.timestamp = 3_000;
		session.agent.emitExternalEvent({ type: "message_start", message });
		session.agent.emitExternalEvent({ type: "message_end", message });
		await waitFor(
			() => events.some(event => event.type === "message_persisted"),
			"timed out waiting for skipped persistence mapping",
		);
		await sessionManager.flush();

		const persisted = events.find(event => event.type === "message_persisted");
		expect(persisted).toMatchObject({ type: "message_persisted", entryId: null });
		expect(sessionManager.getBranch().filter(entry => entry.type === "message")).toEqual([]);
	});

	it("caches missing-key checks across a growing branch", async () => {
		const getBranch = spyOn(sessionManager, "getBranch");

		try {
			for (let i = 0; i < 25; i++) {
				const msg: AgentMessage = {
					role: "user",
					content: [{ type: "text", text: `Cache perf ${i}` }],
					timestamp: 2000 + i,
				};
				session.agent.emitExternalEvent({ type: "message_end", message: msg });
				await sessionManager.flush();
				for (let spin = 0; spin < 5; spin++) {
					await Promise.resolve();
				}
			}

			expect(getBranch).toHaveBeenCalledTimes(1);
		} finally {
			getBranch.mockRestore();
		}

		const entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(25);
	});

	it("reflects the NEW branch after a rewind (stale cache would wrongly skip)", async () => {
		// 1. Send first message (assistant)
		const msg1: AssistantMessage = createAssistantMessage("Msg 1");
		session.agent.emitExternalEvent({ type: "message_end", message: msg1 });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		// 2. Send second message (user)
		const msg2: AgentMessage = { role: "user", content: [{ type: "text", text: "Msg 2" }], timestamp: 1002 };
		session.agent.emitExternalEvent({ type: "message_end", message: msg2 });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		let entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(2);

		// 3. Rewind to msg1 (by navigating to the assistant message msg1)
		// This sets the leaf exactly to msg1.
		const msg1EntryId = entries[0].id;
		const navResult = await session.navigateTree(msg1EntryId, { summarize: false });
		expect(navResult.cancelled).toBe(false);

		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		// Confirm rewind occurred (only msg1 remains)
		entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(1);
		expect(entries[0].message.role).toBe("assistant");

		// 4. Send msg2 AGAIN
		// If cache wasn't invalidated on rewind, it remembers msg2 and wrongly skips it.
		session.agent.emitExternalEvent({ type: "message_end", message: msg2 });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		// Cache must be invalidated, so the re-persist succeeds.
		entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(2);
		expect(entries[1].message.role).toBe("user");
	});
});
