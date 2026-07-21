import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression coverage for the wakeup / session-replacement timing race:
 * a wakeup can complete while a replacement transition (newSession, handoff,
 * switchSession, branch, branchFromBtw) is still awaiting pre-work — handoff
 * generation, the `session_before_switch` hook, `abort()`, or
 * `sessionManager.flush()` — before the transition's cancellation point. Its
 * completion delivery would then enqueue an async-result follow-up and start
 * a turn in the session being replaced, and that turn survives the reset.
 *
 * The contract these tests defend:
 * 1. Wakeup deliveries are suppressed from the transition's first await
 *    onward — nothing is delivered into the session *during* the transition.
 * 2. Wakeup timers are cancelled only once the replacement commits. A hook
 *    veto, hook emit rejection, or any pre-commit failure leaves the old
 *    session live with its wakeups intact: a wakeup that completed while
 *    suppressed is delivered exactly once afterwards, and a still-pending
 *    timer keeps running and delivers normally later.
 * 3. Suppression snapshots only deliveries the transition newly owns: a
 *    wakeup whose delivery already drained is never re-delivered by a
 *    restore, and suppression owned by someone else (e.g. a `hub`
 *    acknowledgement) is never lifted.
 * 4. Ordinary delivery with no transition in flight keeps working.
 */
describe("AgentSession wakeup suppression across session replacement", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let manager: AsyncJobManager;
	let gates: Array<PromiseWithResolvers<string>>;
	let enqueue: Mock<(kind: string, entry: unknown) => void>;
	let beforeSwitchHandler: (() => Promise<{ cancel?: boolean } | undefined>) | undefined;

	/** Register a session-owned wakeup that stays pending until fired or cancelled. */
	function registerGatedWakeup(): { jobId: string; fire: (text: string) => void } {
		const gate = Promise.withResolvers<string>();
		gates.push(gate);
		const jobId = manager.register(
			"wakeup",
			"pending wakeup",
			async ({ signal }) => {
				signal.addEventListener("abort", () => gate.resolve("cancelled"), { once: true });
				return await gate.promise;
			},
			{
				ownerId: "Main",
				passive: true,
			},
		);
		return { jobId, fire: text => gate.resolve(text) };
	}

	function seedPersistedMessages(): Promise<void> {
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "seed" }], timestamp: Date.now() });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ack" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		return sessionManager.flush();
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-wakeup-replacement-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		// Mirrors the SDK's completion sink: the manager's delivery loop already
		// skips suppressed job ids before invoking this handler.
		manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				session.yieldQueue.enqueue("async-result", { jobId, result: text });
			},
		});
		gates = [];
		beforeSwitchHandler = undefined;
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_switch" && !!beforeSwitchHandler),
			emit: vi.fn(async (event: { type: string }) =>
				event.type === "session_before_switch" && beforeSwitchHandler ? await beforeSwitchHandler() : undefined,
			),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			agentId: "Main",
			asyncJobManager: manager,
			extensionRunner,
		});
		enqueue = vi.spyOn(session.yieldQueue, "enqueue");
	});

	afterEach(async () => {
		for (const gate of gates) gate.resolve("done");
		await session.dispose();
		manager.cancelAll();
		await manager.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("suppresses a wakeup that completes during replacement pre-work, before the cancellation point", async () => {
		const { jobId, fire } = registerGatedWakeup();
		// Fire the wakeup inside the session_before_switch await — the window
		// between "replacement committed" and the transition's cancellation
		// point. The hook drains the manager so the completion would have fully
		// delivered here without suppression.
		let deliveriesDuringTransition = -1;
		beforeSwitchHandler = async () => {
			fire("old-session wakeup");
			await manager.waitForAll();
			await manager.drainDeliveries();
			deliveriesDuringTransition = enqueue.mock.calls.length;
			return undefined;
		};

		await expect(session.newSession()).resolves.toBe(true);
		await manager.drainDeliveries();

		expect(deliveriesDuringTransition).toBe(0);
		expect(enqueue).not.toHaveBeenCalled();
		expect(manager.isDeliverySuppressed(jobId)).toBe(true);
	});

	it("restores and delivers a suppressed wakeup exactly once when the pre-switch hook vetoes", async () => {
		const { jobId, fire } = registerGatedWakeup();
		let deliveriesDuringTransition = -1;
		beforeSwitchHandler = async () => {
			fire("vetoed-transition wakeup");
			await manager.waitForAll();
			await manager.drainDeliveries();
			deliveriesDuringTransition = enqueue.mock.calls.length;
			return { cancel: true };
		};

		await expect(session.newSession()).resolves.toBe(false);
		await manager.drainDeliveries();

		expect(deliveriesDuringTransition).toBe(0);
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith(
			"async-result",
			expect.objectContaining({ jobId, result: "vetoed-transition wakeup" }),
		);
	});

	it("restores a suppressed wakeup when the pre-switch hook emit rejects", async () => {
		const { jobId, fire } = registerGatedWakeup();
		// The real ExtensionRunner contains handler errors, but AgentSession also
		// runs against injected runners whose emit can reject — a leaked
		// suppression would silently swallow the wakeup forever.
		let deliveriesDuringTransition = -1;
		beforeSwitchHandler = async () => {
			fire("hook-failure wakeup");
			await manager.waitForAll();
			await manager.drainDeliveries();
			deliveriesDuringTransition = enqueue.mock.calls.length;
			throw new Error("hook emit failed");
		};

		await expect(session.newSession()).rejects.toThrow("hook emit failed");
		await manager.drainDeliveries();

		expect(deliveriesDuringTransition).toBe(0);
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith(
			"async-result",
			expect.objectContaining({ jobId, result: "hook-failure wakeup" }),
		);
	});

	it("restores a suppressed wakeup when the replacement fails after the cancellation point", async () => {
		// The commit itself fails: the old session stays live, so the wakeup
		// must survive — its delivery restored and its timer NOT cancelled.
		const { jobId, fire } = registerGatedWakeup();
		vi.spyOn(sessionManager, "newSession").mockRejectedValue(new Error("session create failed"));

		await expect(session.newSession()).rejects.toThrow("session create failed");

		expect(manager.getJob(jobId)?.status).toBe("running");
		expect(manager.isDeliverySuppressed(jobId)).toBe(false);

		fire("post-failure wakeup");
		await manager.waitForAll();
		await manager.drainDeliveries();

		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith(
			"async-result",
			expect.objectContaining({ jobId, result: "post-failure wakeup" }),
		);
	});

	it("does not re-deliver an already-delivered wakeup when a transition is vetoed", async () => {
		const { jobId, fire } = registerGatedWakeup();
		fire("already delivered");
		await manager.waitForAll();
		await manager.drainDeliveries();
		expect(enqueue).toHaveBeenCalledTimes(1);

		// The finished job is still retained by the manager. A veto restore must
		// not re-enqueue its long-drained delivery.
		beforeSwitchHandler = async () => ({ cancel: true });
		await expect(session.newSession()).resolves.toBe(false);
		await manager.drainDeliveries();

		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	it("does not lift suppression owned by someone else when a transition is vetoed", async () => {
		const { jobId, fire } = registerGatedWakeup();
		// Someone else (e.g. a `hub` acknowledgement) suppressed this wakeup's
		// delivery before the transition began; it then completes while
		// suppressed. A veto restore must not lift that foreign suppression.
		manager.acknowledgeDeliveries([jobId]);
		fire("hub-acknowledged wakeup");
		await manager.waitForAll();
		await manager.drainDeliveries();
		expect(enqueue).not.toHaveBeenCalled();

		beforeSwitchHandler = async () => ({ cancel: true });
		await expect(session.newSession()).resolves.toBe(false);
		await manager.drainDeliveries();

		expect(enqueue).not.toHaveBeenCalled();
		expect(manager.isDeliverySuppressed(jobId)).toBe(true);
	});

	it("suppresses a wakeup that fires during handoff pre-work and restores it when the handoff fails", async () => {
		await seedPersistedMessages();
		const { jobId, fire } = registerGatedWakeup();
		// Fail at handoff's FIRST await — the generation phase, long before the
		// pre-switch hook. The wakeup fires inside that await window.
		let deliveriesDuringHandoff = -1;
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async () => {
			fire("mid-handoff wakeup");
			await manager.waitForAll();
			await manager.drainDeliveries();
			deliveriesDuringHandoff = enqueue.mock.calls.length;
			return undefined;
		});

		await expect(session.handoff()).rejects.toThrow("No API key");
		await manager.drainDeliveries();

		expect(deliveriesDuringHandoff).toBe(0);
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith(
			"async-result",
			expect.objectContaining({ jobId, result: "mid-handoff wakeup" }),
		);
	});

	it("restores a suppressed wakeup when switchSession fails and rolls back", async () => {
		await seedPersistedMessages();
		const { jobId, fire } = registerGatedWakeup();
		let deliveriesDuringSwitch = -1;
		vi.spyOn(sessionManager, "setSessionFile").mockImplementation(async () => {
			await manager.waitForAll();
			await manager.drainDeliveries();
			deliveriesDuringSwitch = enqueue.mock.calls.length;
			throw new Error("switch load failed");
		});

		const switching = session.switchSession(path.join(tempDir.path(), "sessions", "other-session.jsonl"));
		// Suppression is synchronous at switchSession entry; the wakeup fires
		// inside the abort/flush await window that precedes the failing load.
		fire("rollback wakeup");
		await expect(switching).rejects.toThrow("switch load failed");
		await manager.waitForAll();
		await manager.drainDeliveries();

		expect(deliveriesDuringSwitch).toBe(0);
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith(
			"async-result",
			expect.objectContaining({ jobId, result: "rollback wakeup" }),
		);
	});

	it("cancels pending wakeup timers when a different-session switch commits", async () => {
		await seedPersistedMessages();
		const { jobId } = registerGatedWakeup();

		await expect(session.switchSession(path.join(tempDir.path(), "sessions", "fresh-target.jsonl"))).resolves.toBe(
			true,
		);
		await manager.waitForAll();
		await manager.drainDeliveries();

		expect(manager.getJob(jobId)?.status).toBe("cancelled");
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("delivers a wakeup normally when no replacement transition is in flight", async () => {
		const { jobId, fire } = registerGatedWakeup();
		fire("ordinary wakeup");
		await manager.waitForAll();
		await manager.drainDeliveries();

		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith(
			"async-result",
			expect.objectContaining({ jobId, result: "ordinary wakeup" }),
		);
	});
});
