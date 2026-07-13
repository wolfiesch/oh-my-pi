import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession selector and thinking validation", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let sessionSettings: Settings;
	let sharedDir: TempDir;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-model-selector-shared-");
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		// Authenticate anthropic
		sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-model-selector-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		tempDir.removeSync();
	});

	function getModelOrThrow(provider: Parameters<typeof getBundledModel>[0], id: string): Model<Api> {
		const model = getBundledModel(provider, id);
		if (!model) throw new Error(`Expected model ${provider}/${id} to exist`);
		return model;
	}

	async function createSession(options?: {
		initialModel?: Model<Api>;
		modelRoles?: Record<string, string>;
	}): Promise<{ settings: Settings; session: AgentSession }> {
		const model = options?.initialModel ?? getModelOrThrow("anthropic", "claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
		});

		sessionSettings = Settings.isolated();
		const modelRoles = options?.modelRoles;
		if (modelRoles) {
			for (const role in modelRoles) {
				const modelRoleValue = modelRoles[role];
				if (modelRoleValue !== undefined) {
					sessionSettings.setModelRole(role, modelRoleValue);
				}
			}
		}

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry: sharedModelRegistry,
		});

		return { settings: sessionSettings, session };
	}

	it("concrete/session: concrete selector without persist does not update default role and has undefined role projection", async () => {
		const defaultModel = getModelOrThrow("anthropic", "claude-sonnet-4-5");
		const nextModel = getModelOrThrow("anthropic", "claude-sonnet-4-6");

		const { session: s, settings } = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
		});

		await s.setModelSelector({ selector: "anthropic/claude-sonnet-4-6", persist: false });

		expect(s.model?.id).toBe(nextModel.id);
		expect(s.configuredModelRole()).toBeUndefined();
		expect(s.configuredModelSelector()).toBe("anthropic/claude-sonnet-4-6");
		expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-5");
	});

	it("concrete/persist: concrete selector with persist updates default role and has default role projection", async () => {
		const defaultModel = getModelOrThrow("anthropic", "claude-sonnet-4-5");
		const nextModel = getModelOrThrow("anthropic", "claude-sonnet-4-6");

		const { session: s, settings } = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
		});

		await s.setModelSelector({ selector: "anthropic/claude-sonnet-4-6", persist: true });

		expect(s.model?.id).toBe(nextModel.id);
		expect(s.configuredModelRole()).toBe("default");
		expect(s.configuredModelSelector()).toBe("anthropic/claude-sonnet-4-6");
		expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-6");
	});

	it("configured role: resolves, reports and persists only when requested", async () => {
		const defaultModel = getModelOrThrow("anthropic", "claude-sonnet-4-5");
		const nextModel = getModelOrThrow("anthropic", "claude-sonnet-4-6");

		// Test Role Path without persist
		const { session: s1, settings: settings1 } = await createSession({
			initialModel: defaultModel,
			modelRoles: {
				default: "anthropic/claude-sonnet-4-5",
				slow: "anthropic/claude-sonnet-4-6",
			},
		});

		await s1.setModelSelector({ role: "slow", persist: false });

		expect(s1.model?.id).toBe(nextModel.id);
		expect(s1.configuredModelRole()).toBe("slow");
		expect(s1.configuredModelSelector()).toBe("anthropic/claude-sonnet-4-6");
		expect(settings1.getModelRole("slow")).toBe("anthropic/claude-sonnet-4-6");

		// Test Role Path with persist
		const { session: s2, settings: settings2 } = await createSession({
			initialModel: defaultModel,
			modelRoles: {
				default: "anthropic/claude-sonnet-4-5",
				slow: "anthropic/claude-sonnet-4-6",
			},
		});

		await s2.setModelSelector({ role: "slow", persist: true });

		expect(s2.model?.id).toBe(nextModel.id);
		expect(s2.configuredModelRole()).toBe("slow");
		expect(s2.configuredModelSelector()).toBe("anthropic/claude-sonnet-4-6");
		expect(settings2.getModelRole("slow")).toBe("anthropic/claude-sonnet-4-6");
	});

	it("invalid selector/role: rejects invalid inputs", async () => {
		const { session: s } = await createSession({
			modelRoles: {
				default: "anthropic/claude-sonnet-4-5",
				slow: "anthropic/claude-sonnet-4-6",
			},
		});

		// 1. Both defined
		expect(s.setModelSelector({ selector: "anthropic/claude-sonnet-4-6", role: "slow" })).rejects.toThrow(
			"Model selection requires a selector or role, but not both"
		);

		// 2. Neither defined
		expect(s.setModelSelector({})).rejects.toThrow(
			"Model selection requires a selector or role"
		);

		// 3. Unconfigured role
		expect(s.setModelSelector({ role: "fast" })).rejects.toThrow(
			"Model role is not configured: fast"
		);

		// 4. Non-existent selector
		expect(s.setModelSelector({ selector: "anthropic/claude-nonexistent" })).rejects.toThrow();

		// 5. Unauthenticated selector (no API key for mistral)
		expect(s.setModelSelector({ selector: "mistral/codestral-latest" })).rejects.toThrow();
	});

	it("temporary state projection behaves correctly", async () => {
		const defaultModel = getModelOrThrow("anthropic", "claude-sonnet-4-5");
		const nextModel = getModelOrThrow("anthropic", "claude-sonnet-4-6");

		const { session: s } = await createSession({
			initialModel: defaultModel,
		});

		// Check configuredModelRole and configuredModelSelector when no change has been recorded
		expect(s.configuredModelRole()).toBeUndefined();
		expect(s.configuredModelSelector()).toBe("anthropic/claude-sonnet-4-5");

		// Record a temporary change directly through setModel with "temporary" role
		await s.setModel(nextModel, "temporary");
		expect(s.configuredModelRole()).toBeUndefined();
		expect(s.configuredModelSelector()).toBe("anthropic/claude-sonnet-4-6");
	});

	it("invalid thinking state throws and valid thinking state does not throw", async () => {
		const { session: s } = await createSession();

		// Invalid levels (casted to bypass compiler)
		expect(() => s.setThinkingLevelValidated("bogus" as unknown as ConfiguredThinkingLevel)).toThrow(
			"Thinking level is unsupported by the current model: bogus"
		);
		expect(() => s.setThinkingLevelValidated("ultra" as unknown as ConfiguredThinkingLevel)).toThrow();

		// Valid levels
		expect(() => s.setThinkingLevelValidated("auto")).not.toThrow();
		expect(() => s.setThinkingLevelValidated("inherit")).not.toThrow();
		expect(() => s.setThinkingLevelValidated("off")).not.toThrow();

		// Levels supported by the model
		const available = s.getAvailableThinkingLevels();
		for (const level of available) {
			expect(() => s.setThinkingLevelValidated(level)).not.toThrow();
		}
	});
});
