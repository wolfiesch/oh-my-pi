import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { setTerminalHeadless, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../config/model-registry";
import { resetSettingsForTest, Settings } from "../../config/settings";
import { AgentRegistry } from "../../registry/agent-registry";
import { AgentSession } from "../../session/agent-session";
import { AuthStorage } from "../../session/auth-storage";
import { HistoryStorage } from "../../session/history-storage";
import { SessionManager } from "../../session/session-manager";
import { formatSessionTerminalTitle } from "../../utils/title-generator";
import { buildSessionTerminalTitleOptions, InteractiveMode } from "../interactive-mode";
import { countRunningSubagentBadgeAgents, resolveTerminalTitleBaseState } from "../running-subagent-badge";
import { initTheme, theme } from "../theme/theme";

function registryWithRunningSubagents(count: number): AgentRegistry {
	const registry = new AgentRegistry();
	for (let index = 0; index < count; index += 1) {
		registry.register({
			id: `Sub${index}`,
			displayName: `Sub ${index}`,
			kind: "sub",
			session: null,
			status: "running",
		});
	}
	return registry;
}

describe("terminal title state", () => {
	it("treats detached running subagents as a running title state", () => {
		const registry = registryWithRunningSubagents(1);

		expect(countRunningSubagentBadgeAgents(registry)).toBe(1);
		expect(
			resolveTerminalTitleBaseState({
				sessionStreaming: false,
				sessionCompacting: false,
				viewSessionStreaming: false,
				viewSessionCompacting: false,
				sessionPostPromptWork: false,
				viewSessionPostPromptWork: false,
				collabHostStreaming: false,
				hasLoadingAnimation: false,
				hasCompactionLoader: false,
				hasAutoCompactionLoader: false,
				hasRetryLoader: false,
				runningTitleDepth: 0,
				hasInputCallback: false,
				runningSubagentCount: countRunningSubagentBadgeAgents(registry),
			}),
		).toBe("running");
	});

	it("preserves waiting title state when no session work or detached subagents are running", () => {
		expect(
			resolveTerminalTitleBaseState({
				sessionStreaming: false,
				sessionCompacting: false,
				viewSessionStreaming: false,
				viewSessionCompacting: false,
				sessionPostPromptWork: false,
				viewSessionPostPromptWork: false,
				collabHostStreaming: false,
				hasLoadingAnimation: false,
				hasCompactionLoader: false,
				hasAutoCompactionLoader: false,
				hasRetryLoader: false,
				runningTitleDepth: 0,
				hasInputCallback: true,
				runningSubagentCount: 0,
			}),
		).toBe("waiting");
	});

	it("treats a streaming collab host as a running title state", () => {
		expect(
			resolveTerminalTitleBaseState({
				sessionStreaming: false,
				sessionCompacting: false,
				viewSessionStreaming: false,
				viewSessionCompacting: false,
				sessionPostPromptWork: false,
				viewSessionPostPromptWork: false,
				collabHostStreaming: true,
				hasLoadingAnimation: false,
				hasCompactionLoader: false,
				hasAutoCompactionLoader: false,
				hasRetryLoader: false,
				runningTitleDepth: 0,
				hasInputCallback: false,
				runningSubagentCount: 0,
			}),
		).toBe("running");
	});

	it("treats queued post-prompt work as a running title state", () => {
		expect(
			resolveTerminalTitleBaseState({
				sessionStreaming: false,
				sessionCompacting: false,
				viewSessionStreaming: false,
				viewSessionCompacting: false,
				sessionPostPromptWork: true,
				viewSessionPostPromptWork: false,
				collabHostStreaming: false,
				hasLoadingAnimation: false,
				hasCompactionLoader: false,
				hasAutoCompactionLoader: false,
				hasRetryLoader: false,
				runningTitleDepth: 0,
				hasInputCallback: false,
				runningSubagentCount: 0,
			}),
		).toBe("running");
	});

	it("builds stateful collab session title options from the active run state", () => {
		const options = buildSessionTerminalTitleOptions({
			showTitleState: true,
			state: "running",
			stateSymbol: "▶",
		});

		expect(options).toEqual({ state: "running", stateSymbol: "▶" });
	});

	it("omits collab session title options when title-state prefixes are disabled", () => {
		expect(
			buildSessionTerminalTitleOptions({
				showTitleState: false,
				state: "running",
				stateSymbol: "▶",
			}),
		).toEqual({ state: "idle", stateSymbol: undefined });
	});
});

describe("terminal title registry subscription", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-title-state-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.addMessageToChat = vi.fn();
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		HistoryStorage.resetInstance();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
	});

	it("flips the OSC title to running when a detached subagent registers and back when it finishes", () => {
		const previousHeadless = setTerminalHeadless(false);
		const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		try {
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			const write = process.stdout.write as typeof process.stdout.write & {
				mock: { calls: unknown[][] };
				mockClear(): void;
			};
			mode.settings.set("terminal.showTitleState", true);
			// Establish the badge subscription against the global registry — the
			// same wiring the live TUI uses for detached subagents.
			mode.syncRunningSubagentBadge({ requestRender: false });
			write.mockClear();

			const cwd = mode.sessionManager.getCwd();
			const idleTitle = `\x1b]0;${formatSessionTerminalTitle(undefined, cwd)}\x07`;
			const runningTitle = `\x1b]0;${formatSessionTerminalTitle(undefined, cwd, {
				state: "running",
				stateSymbol: theme.symbol("status.running"),
			})}\x07`;
			expect(runningTitle).not.toBe(idleTitle);

			// A detached subagent starting must push the running-state OSC title
			// through the registry change listener, with no other trigger.
			AgentRegistry.global().register({
				id: "DetachedSub",
				displayName: "Detached Sub",
				kind: "sub",
				session: null,
				status: "running",
			});
			const titleWrites = () =>
				write.mock.calls.map(call => String(call[0])).filter(chunk => chunk.startsWith("\x1b]0;"));
			expect(titleWrites().at(-1)).toBe(runningTitle);
			write.mockClear();

			// The subagent finishing must drop the running prefix again.
			AgentRegistry.global().setStatus("DetachedSub", "idle");
			expect(titleWrites().at(-1)).toBe(idleTitle);
		} finally {
			setTerminalHeadless(previousHeadless);
			if (originalTTY) {
				Object.defineProperty(process.stdout, "isTTY", originalTTY);
			} else {
				Reflect.deleteProperty(process.stdout, "isTTY");
			}
		}
	});
});
