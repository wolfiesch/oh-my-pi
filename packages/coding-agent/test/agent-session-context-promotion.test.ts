import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession context promotion", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		// ModelRegistry eagerly loads the immutable bundled model catalog in its
		// constructor (~100ms). The catalog and auth fixture never change between
		// tests here (tests only read models and add benign extra runtime keys),
		// so build them once instead of paying ~950ms across the 9 cases.
		//
		// The bundled catalog no longer ships a Codex promotion pair with
		// increasing windows, so pin gpt-5.6-luna (272k) -> gpt-5.6-terra (372k)
		// via modelOverrides — the same mechanism users configure promotion pairs
		// with. Luna's override is text-only, ensuring snapcompact (vision-based)
		// cannot run.
		tempDir = TempDir.createSync("@pi-context-promotion-");
		const modelsConfigPath = path.join(tempDir.path(), "models.json");
		await Bun.write(
			modelsConfigPath,
			JSON.stringify({
				providers: {
					"openai-codex": {
						modelOverrides: {
							"gpt-5.6-luna": {
								contextWindow: 272_000,
								contextPromotionTarget: "openai-codex/gpt-5.6-terra",
								input: ["text"],
							},
						},
					},
				},
			}),
		);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		modelRegistry = new ModelRegistry(authStorage, modelsConfigPath);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		vi.restoreAllMocks();
	});

	function createOverflowMessage(
		model: Model,
		errorMessage = "context_length_exceeded: Your input exceeds the context window of this model.",
	): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage,
			timestamp: Date.now(),
		};
	}

	function createIncompleteMessage(model: Model): AssistantMessage {
		// Mirrors what the codex/responses provider produces for `response.incomplete`:
		// stopReason "length", reasoning-only content, no actionable deliverable.
		return {
			role: "assistant",
			content: [{ type: "thinking", thinking: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
	}

	function createUserMessage(content: string) {
		return {
			role: "user" as const,
			content,
			timestamp: Date.now(),
		};
	}

	function createAssistantMessage(model: Model, text = "ok"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(10);
		}
		throw new Error("Timed out waiting for condition");
	}

	// Deterministically drain the fire-and-forget `agent_end` handler that
	// `emitExternalEvent` dispatches. The handler's terminal maintenance work
	// (`#checkCompaction`) is microtask-based on the no-promotion paths, so a
	// single macrotask turn fully flushes it; `waitForIdle` then settles any
	// tracked continuation. Used by the negative tests, which assert that *no*
	// promotion happened and therefore need the handler to have actually run.
	async function settle(): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, 0));
		await session.waitForIdle();
	}

	it("promotes to a larger-context model on overflow and clears codex websocket session state", async () => {
		const smallModel = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		const largeModel = modelRegistry.find("openai-codex", "gpt-5.6-terra");
		if (!smallModel || !largeModel) {
			throw new Error("Expected small and large codex models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: smallModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const overflowMessage = createOverflowMessage(smallModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await waitFor(() => session.model?.id === largeModel.id);

		expect(session.model?.provider).toBe(largeModel.provider);
		expect(session.model?.id).toBe(largeModel.id);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("compacts an oversized child prompt instead of promoting past its context budget", async () => {
		const smallModel = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		const largeModel = modelRegistry.find("openai-codex", "gpt-5.6-terra");
		if (!smallModel || !largeModel) {
			throw new Error("Expected small and large codex models to exist");
		}

		const settings = createSubagentSettings(
			Settings.isolated({
				"task.childContextBudgetTokens": 50,
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.strategy": "context-full",
				"compaction.keepRecentTokens": 1,
				"contextPromotion.enabled": true,
			}),
		);
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(createUserMessage("old child context ".repeat(120)));
		sessionManager.appendMessage(createAssistantMessage(smallModel, "old response"));

		const agent = new Agent({
			initialState: {
				model: smallModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			agentKind: "sub",
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "budgeted child summary",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
		});

		await session.prompt("pending child prompt ".repeat(120));

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(session.model?.id).toBe(smallModel.id);
		expect(session.model?.id).not.toBe(largeModel.id);
	});

	it("preserves percentage-threshold promotion while a child remains below its looser budget", async () => {
		const smallModel = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		const largeModel = modelRegistry.find("openai-codex", "gpt-5.6-terra");
		if (!smallModel || !largeModel) {
			throw new Error("Expected small and large codex models to exist");
		}

		const settings = createSubagentSettings(
			Settings.isolated({
				"task.childContextBudgetTokens": 100_000,
				"compaction.thresholdTokens": -1,
				"compaction.thresholdPercent": 1,
				"compaction.enabled": true,
				"compaction.strategy": "context-full",
				"contextPromotion.enabled": true,
			}),
		);
		const agent = new Agent({
			initialState: {
				model: smallModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			agentKind: "sub",
		});
		const compactSpy = vi.spyOn(compactionModule, "compact");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);

		await session.prompt("pending child prompt ".repeat(2_000));

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy).not.toHaveBeenCalled();
		expect(session.model?.provider).toBe(largeModel.provider);
		expect(session.model?.id).toBe(largeModel.id);
	});

	it("does not compact or promote when pruning brings a child below its ceiling", async () => {
		const smallModel = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		const largeModel = modelRegistry.find("openai-codex", "gpt-5.6-terra");
		if (!smallModel || !largeModel) {
			throw new Error("Expected small and large codex models to exist");
		}

		const settings = createSubagentSettings(
			Settings.isolated({
				"task.childContextBudgetTokens": 100_000,
				"compaction.thresholdTokens": 150_000,
				"compaction.enabled": true,
				"compaction.strategy": "context-full",
				"compaction.dropUseless": true,
				"compaction.keepRecentTokens": 1,
				"contextPromotion.enabled": true,
			}),
		);
		const sessionManager = SessionManager.inMemory();
		const now = Date.now();
		sessionManager.appendMessage(createUserMessage("Investigate everything."));
		const largeCallId = "call-large-useless";
		sessionManager.appendMessage({
			...createAssistantMessage(smallModel),
			content: [{ type: "toolCall", id: largeCallId, name: "grep", arguments: { pattern: "TODO" } }],
			stopReason: "toolUse",
			timestamp: now - 20,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: largeCallId,
			toolName: "grep",
			content: [{ type: "text", text: "match line\n".repeat(20_000) }],
			isError: false,
			useless: true,
			timestamp: now - 19,
		});
		for (let index = 0; index < 4; index++) {
			const callId = `call-small-${index}`;
			sessionManager.appendMessage({
				...createAssistantMessage(smallModel),
				content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: `note-${index}.md` } }],
				stopReason: "toolUse",
				timestamp: now - 18 + index * 2,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: callId,
				toolName: "read",
				content: [{ type: "text", text: `tiny note ${index}` }],
				isError: false,
				timestamp: now - 17 + index * 2,
			});
		}

		const agent = new Agent({
			initialState: {
				model: smallModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			agentKind: "sub",
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "unexpected child compaction",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const finalAssistant = {
			...createAssistantMessage(smallModel, "continuing"),
			usage: {
				input: 120_000,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120_001,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};

		session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });
		await settle();

		expect(compactSpy).not.toHaveBeenCalled();
		expect(session.model?.provider).toBe(smallModel.provider);
		expect(session.model?.id).toBe(smallModel.id);
		expect(session.model?.id).not.toBe(largeModel.id);
	});

	it("preserves overflow promotion for a budgeted child when compaction is disabled", async () => {
		const smallModel = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		const largeModel = modelRegistry.find("openai-codex", "gpt-5.6-terra");
		if (!smallModel || !largeModel) {
			throw new Error("Expected small and large codex models to exist");
		}

		const settings = createSubagentSettings(
			Settings.isolated({
				"task.childContextBudgetTokens": 50,
				"compaction.enabled": false,
				"contextPromotion.enabled": true,
			}),
		);
		const agent = new Agent({
			initialState: {
				model: smallModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			agentKind: "sub",
		});

		const overflowMessage = createOverflowMessage(smallModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await waitFor(() => session.model?.id === largeModel.id);

		expect(session.model?.provider).toBe(largeModel.provider);
		expect(session.model?.id).toBe(largeModel.id);
	});

	it("promotes on 413 payload-too-large overflow errors", async () => {
		const smallModel = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		const largeModel = modelRegistry.find("openai-codex", "gpt-5.6-terra");
		if (!smallModel || !largeModel) {
			throw new Error("Expected small and large codex models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: smallModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const overflowMessage = createOverflowMessage(
			smallModel,
			"413 Request Entity Too Large: payload too large for model request body",
		);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await waitFor(() => session.model?.id === largeModel.id);

		expect(session.model?.provider).toBe(largeModel.provider);
		expect(session.model?.id).toBe(largeModel.id);
	});
	it("clears codex provider session state on manual setModel switch away from codex", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		const nonCodexModel = modelRegistry.getAll().find(model => model.api !== "openai-codex-responses");
		if (!codexModel || !nonCodexModel) {
			throw new Error("Expected codex and non-codex models to exist");
		}
		authStorage.setRuntimeApiKey(nonCodexModel.provider, "test-other-key");

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		await session.setModel(nonCodexModel);

		expect(session.model?.provider).toBe(nonCodexModel.provider);
		expect(session.model?.id).toBe(nonCodexModel.id);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("clears codex provider session state on manual temporary switch into codex", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		const nonCodexModel = modelRegistry.getAll().find(model => model.api !== "openai-codex-responses");
		if (!codexModel || !nonCodexModel) {
			throw new Error("Expected codex and non-codex models to exist");
		}
		authStorage.setRuntimeApiKey(nonCodexModel.provider, "test-other-key");

		const agent = new Agent({
			initialState: {
				model: nonCodexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		await session.setModelTemporary(codexModel);

		expect(session.model?.provider).toBe(codexModel.provider);
		expect(session.model?.id).toBe(codexModel.id);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("clears codex provider session state when branching rewrites history", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		if (!codexModel) {
			throw new Error("Expected codex model to exist");
		}

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const firstUserId = session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "first response"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "second response"));
		const sessionContext = session.sessionManager.buildSessionContext();
		session.agent.replaceMessages(sessionContext.messages);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const result = await session.branch(firstUserId);

		expect(result.cancelled).toBe(false);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("clears codex provider session state when tree navigation rewrites history", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		if (!codexModel) {
			throw new Error("Expected codex model to exist");
		}

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const firstUserId = session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "first response"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "second response"));
		const sessionContext = session.sessionManager.buildSessionContext();
		session.agent.replaceMessages(sessionContext.messages);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const result = await session.navigateTree(firstUserId, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("does not promote when promotion is disabled", async () => {
		const smallModel = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		if (!smallModel) {
			throw new Error("Expected small codex model to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": false,
		});

		const agent = new Agent({
			initialState: {
				model: smallModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const overflowMessage = createOverflowMessage(smallModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await settle();

		expect(session.model?.provider).toBe(smallModel.provider);
		expect(session.model?.id).toBe(smallModel.id);
		expect(closeSpy).not.toHaveBeenCalled();
		expect(session.providerSessionState.size).toBe(1);
	});

	it("does not promote by default", async () => {
		const smallModel = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		if (!smallModel) {
			throw new Error("Expected small codex model to exist");
		}

		const agent = new Agent({
			initialState: {
				model: smallModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const overflowMessage = createOverflowMessage(smallModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await settle();

		expect(session.model?.provider).toBe(smallModel.provider);
		expect(session.model?.id).toBe(smallModel.id);
	});

	it("falls back to LLM compaction when snapcompact cannot run during overflow recovery", async () => {
		const model = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		if (!model) {
			throw new Error("Expected codex model to exist");
		}
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "snapcompact",
			"compaction.keepRecentTokens": 1,
			"compaction.thresholdPercent": -1,
			"contextPromotion.enabled": false,
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "fallback summary",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

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
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.sessionManager.appendMessage(createUserMessage("old context ".repeat(80_000)));
		session.sessionManager.appendMessage(createAssistantMessage(model, "old response"));
		session.sessionManager.appendMessage(createUserMessage("current request"));
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		const events: Array<Extract<AgentSessionEvent, { type: "auto_compaction_end" }>> = [];
		const compactionDone = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") {
				events.push(event);
				compactionDone.resolve();
			}
		});
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const overflowMessage = createOverflowMessage(model);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await compactionDone.promise;

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(events[0]?.errorMessage).toBeUndefined();
		expect(events[0]?.willRetry).toBe(true);
		await waitFor(() => continueSpy.mock.calls.length === 1);
		expect(session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
	});

	it("promotes to a larger-context model on response.incomplete (length stop)", async () => {
		const smallModel = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		const largeModel = modelRegistry.find("openai-codex", "gpt-5.6-terra");
		if (!smallModel || !largeModel) {
			throw new Error("Expected small and large codex models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: smallModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const incompleteMessage = createIncompleteMessage(smallModel);
		session.agent.emitExternalEvent({ type: "message_end", message: incompleteMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [incompleteMessage] });

		await waitFor(() => session.model?.id === largeModel.id);

		expect(session.model?.provider).toBe(largeModel.provider);
		expect(session.model?.id).toBe(largeModel.id);
	});

	it("does not promote on length stop when message is from a different model", async () => {
		// Switching from a small-context model to a larger one and then receiving a
		// stale length-stop event for the previous model must NOT trigger promotion
		// or compaction on the new model — same guard as the overflow path.
		const smallModel = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		const largeModel = modelRegistry.find("openai-codex", "gpt-5.6-terra");
		if (!smallModel || !largeModel) {
			throw new Error("Expected small and large codex models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: largeModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		// Stale incomplete from the smaller model — current session is already on the large model.
		const staleIncomplete = createIncompleteMessage(smallModel);
		session.agent.emitExternalEvent({ type: "message_end", message: staleIncomplete });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [staleIncomplete] });

		await settle();

		expect(session.model?.provider).toBe(largeModel.provider);
		expect(session.model?.id).toBe(largeModel.id);
	});
});
