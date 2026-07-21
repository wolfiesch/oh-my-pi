import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task/types";

function rendered(hub: AgentHubOverlayComponent): string {
	return Bun.stripANSI(hub.render(120).join("\n"));
}

function register(
	registry: AgentRegistry,
	id: string,
	status: "running" | "idle" | "parked" | "aborted",
	kind: "sub" | "advisor" = "sub",
	session?: AgentSession,
): void {
	registry.register({
		id,
		displayName: id,
		kind,
		status,
		session: session ?? (status === "running" || status === "idle" ? ({} as AgentSession) : null),
	});
}

function progress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "run-a",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Inspect the runtime",
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

function makeHub(
	registry: AgentRegistry,
	observers = new SessionObserverRegistry(),
	overrides: Partial<ConstructorParameters<typeof AgentHubOverlayComponent>[0]> = {},
): AgentHubOverlayComponent {
	return new AgentHubOverlayComponent({
		observers,
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry,
		irc: new IrcBus(registry),
		focusAgent: async () => {},
		...overrides,
	});
}

describe("Agent Hub dashboard", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("separates running work, collapsed idle agents, and archived history", () => {
		const registry = new AgentRegistry();
		register(registry, "run-a", "running");
		register(registry, "run-b", "running");
		register(registry, "idle-a", "idle");
		register(registry, "idle-b", "idle");
		register(registry, "park-a", "parked");
		register(registry, "park-b", "parked");
		register(registry, "park-c", "parked");
		register(registry, "abort-a", "aborted");
		register(registry, "advisor-a", "parked", "advisor");
		const hub = makeHub(registry);

		let output = rendered(hub);
		expect(output).toContain("Agent Hub · 2 running · 2 idle · 5 archived");
		expect(output).toContain("▸ 2 idle agents");
		expect(output).toContain("run-a");
		expect(output).toContain("run-b");
		for (const hidden of ["idle-a", "idle-b", "park-a", "abort-a", "advisor-a"]) expect(output).not.toContain(hidden);

		hub.handleInput("j");
		hub.handleInput("i");
		output = rendered(hub);
		expect(output).toContain("▾ 2 idle agents");
		expect(output).toContain("idle-a");
		expect(output.indexOf("run-a")).toBeLessThan(output.indexOf("idle-a"));
		const selectedBeforeTab = output.match(/(run-[ab] · running · sub)/)?.[1];
		expect(selectedBeforeTab).toBeDefined();

		hub.handleInput("\t");
		output = rendered(hub);
		for (const archived of ["park-a", "park-b", "park-c", "abort-a", "advisor-a"]) expect(output).toContain(archived);
		for (const active of ["run-a", "run-b", "idle-a", "idle-b"]) expect(output).not.toContain(active);

		hub.handleInput("\t");
		output = rendered(hub);
		expect(output).toContain(selectedBeforeTab as string);
		hub.dispose();
	});

	it("moves status transitions between tabs and clamps selection", () => {
		vi.useFakeTimers();
		const registry = new AgentRegistry();
		register(registry, "run-a", "running");
		register(registry, "run-b", "running");
		register(registry, "park-a", "parked");
		const hub = makeHub(registry);
		hub.handleInput("j");
		registry.setStatus("run-b", "idle");
		vi.advanceTimersByTime(100);
		let output = rendered(hub);
		expect(output).not.toContain("run-b");
		expect(output).toContain("run-a");

		registry.setStatus("park-a", "running");
		vi.advanceTimersByTime(100);
		output = rendered(hub);
		expect(output).toContain("park-a");
		hub.handleInput("\t");
		expect(rendered(hub)).not.toContain("park-a");
		hub.dispose();
	});

	it("renders structured progress with retry precedence and caps recent tools", () => {
		const registry = new AgentRegistry();
		register(registry, "run-a", "running");
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "run-a",
				kind: "subagent",
				label: "Run A",
				status: "active",
				lastUpdate: Date.now(),
				progress: progress({
					resolvedModel: "openai-codex/gpt-5.6-sol",
					thinkingLevel: Effort.High,
					lspEnabled: true,
					advisorActive: true,
					requests: 7,
					tokens: 1234,
					contextTokens: 32000,
					contextWindow: 128000,
					toolCount: 9,
					cost: 1.25,
					durationMs: 65000,
					currentTool: "bash",
					currentToolArgs: "bun test",
					lastIntent: "old intent",
					retryState: {
						attempt: 2,
						maxAttempts: 4,
						delayMs: 5000,
						errorMessage: "rate limited",
						startedAtMs: Date.now(),
					},
					recentTools: ["one", "two", "three", "four"].map((tool, index) => ({
						tool,
						args: `arg-${index}`,
						endMs: Date.now() - index * 1000,
					})),
					recentOutput: ["RAW SECRET OUTPUT"],
				}),
			},
		]);
		const hub = makeHub(registry, observers);
		const output = rendered(hub);
		expect(output).toContain("Model openai-codex/gpt-5.6-sol · Reasoning high");
		expect(output).toContain("Advisor on · LSP on");
		expect(output).toContain("Turns 7 · Tokens 1.2K · Context 25.0%/128K");
		expect(output).toContain("Tools 9 · Duration 1m5s · Cost $1.25");
		expect(output).toContain("retry 2/4 in 5.0s: rate limited");
		expect(output).not.toContain("bash bun test");
		expect(output).not.toContain("one arg-0");
		expect(output).toContain("four arg-3");
		expect(output).not.toContain("RAW SECRET OUTPUT");
		hub.dispose();
	});

	it("prefers live session metadata and metrics over stale progress", () => {
		const currentModel: Model<Api> = buildModel({
			provider: "live",
			id: "current",
			name: "current",
			api: "openai-completions",
			baseUrl: "https://live.example.test",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		});
		const session = {
			model: currentModel,
			thinkingLevel: "medium",
			contextUsageRevision: 1,
			getActiveToolNames: () => ["lsp", "yield"],
			isAdvisorActive: () => false,
			getSessionStats: () => ({
				assistantMessages: 4,
				toolCalls: 6,
				cost: 0.5,
				tokens: { input: 100, output: 20, cacheWrite: 30 },
			}),
			getContextUsage: () => ({ tokens: 50000, contextWindow: 200000, percent: 25 }),
		} as unknown as AgentSession;
		const registry = new AgentRegistry();
		register(registry, "run-a", "running", "sub", session);
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "run-a",
				kind: "subagent",
				label: "Run A",
				status: "active",
				lastUpdate: Date.now(),
				progress: progress({
					task: "Keep this task",
					resolvedModel: "stale/model",
					thinkingLevel: Effort.Low,
					lspEnabled: false,
					advisorActive: true,
					requests: 99,
					tokens: 99,
				}),
			},
		]);
		const hub = makeHub(registry, observers);
		const output = rendered(hub);
		expect(output).toContain("Task: Keep this task");
		expect(output).toContain("Model live/current · Reasoning medium");
		expect(output).toContain("Advisor off · LSP on");
		expect(output).toContain("Turns 4 · Tokens 150 · Context 25.0%/200K");
		expect(output).toContain("Tools 6");
		hub.dispose();
	});
});
