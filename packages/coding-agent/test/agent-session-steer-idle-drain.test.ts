import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression: a steer can land on an idle session — the submit path checks
 * `isStreaming` before `#queueSteer`'s (potentially slow) image normalization,
 * so the turn may end in between. Unlike `#queueFollowUp`, `#queueSteer` had no
 * idle drain: the message stranded in the queue (visible chip, never delivered)
 * until the next manual prompt.
 *
 * Contract: steering an idle session schedules an immediate `agent.continue()`,
 * so a queued steer is delivered without waiting for the next manual prompt. A
 * queued steer resumes from any tail (continue() injects it before the next
 * provider call), so there is no "non-resumable steer" case. While a turn is
 * still streaming the drain stands down and the steer simply stays queued.
 */

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function createToolResultMessage(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "text", text: "Interrupted" }],
		isError: true,
		timestamp: Date.now(),
	};
}

describe("AgentSession steer idle drain", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-steer-idle-drain-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	async function createSession(messages: Parameters<typeof Agent.prototype.appendMessage>[0][]): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({}),
			modelRegistry,
		});
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		await session.dispose();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("delivers a steer queued on an idle resumable session via continue()", async () => {
		await createSession([{ role: "user", content: "hello", timestamp: Date.now() }, createAssistantMessage()]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		await session.steer("steer me please");

		// Drained without waiting for the next manual prompt.
		vi.advanceTimersByTime(200);
		await session.waitForIdle();
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("delivers successive idle steers after each successful drain", async () => {
		await createSession([{ role: "user", content: "hello", timestamp: Date.now() }, createAssistantMessage()]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		await session.steer("first steer");
		vi.advanceTimersByTime(200);
		await session.waitForIdle();

		await session.steer("second steer");
		vi.advanceTimersByTime(200);
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(2);
	});

	it("delivers a steer queued after an interrupted tool result", async () => {
		await createSession([
			{ role: "user", content: "hello", timestamp: Date.now() },
			createAssistantMessage(),
			createToolResultMessage(),
		]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		await session.steer("deliver after interrupt");

		vi.advanceTimersByTime(200);
		await session.waitForIdle();
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("round-trips queued images through clearQueue for editor restoration", async () => {
		// A steer queued mid-stream stays in the queue (the idle drain stands down while
		// streaming), so clearQueue round-trips session.steer's normalized image payload
		// for editor restoration. A parked model turn gives a deterministic streaming
		// state. Real timers here: the prompt/stream path awaits real timers that the
		// suite's fake clock would gate (it hangs otherwise), and the parked turn is
		// cancelled by abort via the AbortSignal — never waited on — so there is no 60s wait.
		vi.useRealTimers();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const started = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const running = session.prompt("do the thing");
		await started.promise;
		expect(session.isStreaming).toBe(true);

		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		await session.steer("with image", [image]);

		const { steering } = session.clearQueue();
		expect(steering).toEqual([{ text: "with image", images: [image] }]);
		expect(session.agent.hasQueuedMessages()).toBe(false);

		await session.abort();
		await session.waitForIdle();
		await running.catch(() => {});
	});

	it("defers an idle yield delivery until an IRC wake observer finishes settling", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const providerStarted = Promise.withResolvers<void>();
		const releaseProvider = Promise.withResolvers<void>();
		const queuedDeliveryStarted = Promise.withResolvers<void>();
		let providerRunning = false;
		let queuedDeliveryRunning = false;
		const mock = createMockModel({
			responses: [
				async () => {
					providerRunning = true;
					providerStarted.resolve();
					await releaseProvider.promise;
					return { content: ["IRC wake complete"], stopReason: "stop" };
				},
				() => {
					queuedDeliveryRunning = true;
					queuedDeliveryStarted.resolve();
					return { content: ["Queued delivery complete"], stopReason: "stop" };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const callbackStarted = Promise.withResolvers<void>();
		const releaseCallback = Promise.withResolvers<void>();
		session.setIrcWakeTurnObserver(() => {
			return async () => {
				callbackStarted.resolve();
				await releaseCallback.promise;
			};
		});
		session.yieldQueue.register<string>("settlement-regression", {
			build: entries => ({
				role: "user",
				content: `SETTLEMENT QUEUED: ${entries.join(", ")}`,
				timestamp: Date.now(),
			}),
		});

		const outcome = await session.deliverIrcMessage({
			id: "irc-yield-settlement",
			from: "peer",
			to: "me",
			body: "wake",
			ts: Date.now(),
		} as IrcMessage);
		expect(outcome).toBe("woken");
		vi.advanceTimersByTime(1);
		for (let attempt = 0; attempt < 100 && !providerRunning; attempt++) {
			await Promise.resolve();
			vi.advanceTimersByTime(0);
		}
		expect(providerRunning).toBe(true);
		await providerStarted.promise;
		expect(session.activityPhase).toBe("provider");
		expect(mock.calls).toHaveLength(1);

		releaseProvider.resolve();
		for (let attempt = 0; attempt < 100 && session.activityPhase !== "maintenance"; attempt++) {
			await Promise.resolve();
			vi.advanceTimersByTime(0);
		}
		await callbackStarted.promise;
		expect(session.activityPhase).toBe("maintenance");
		expect(session.isStreaming).toBe(false);
		expect(session.hasPostPromptWork).toBe(true);
		session.yieldQueue.enqueue("settlement-regression", "deliver once");
		expect(session.yieldQueue.has("settlement-regression")).toBe(true);

		let idleResolved = false;
		const idle = session.waitForIdle().then(() => {
			idleResolved = true;
		});
		await Promise.resolve();
		expect(idleResolved).toBe(false);

		// No replacement idle flush may run until the observer callback completes.
		vi.advanceTimersByTime(1);
		await Promise.resolve();
		expect(mock.calls).toHaveLength(1);
		expect(session.yieldQueue.has("settlement-regression")).toBe(true);

		releaseCallback.resolve();
		for (let attempt = 0; attempt < 100 && !queuedDeliveryRunning; attempt++) {
			await Promise.resolve();
			vi.advanceTimersByTime(1);
		}
		expect(queuedDeliveryRunning).toBe(true);
		await queuedDeliveryStarted.promise;
		await idle;
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(
			mock.calls.filter(call => JSON.stringify(call.context.messages).includes("SETTLEMENT QUEUED")),
		).toHaveLength(1);
		expect(session.yieldQueue.has("settlement-regression")).toBe(false);
		expect(session.activityPhase).toBe("idle");
		expect(session.isStreaming).toBe(false);
		expect(session.hasPostPromptWork).toBe(false);
	});
});
