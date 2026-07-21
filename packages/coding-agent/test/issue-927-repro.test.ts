import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setTerminalHeadless, TempDir } from "@oh-my-pi/pi-utils";

describe("issue #927 optimistic pending spinner", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
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
		tempDir = TempDir.createSync("@pi-issue-927-");
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
		vi.spyOn(session, "prompt").mockResolvedValue(true);
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
	});

	it("clears the optimistic loading animation when prompt returns without a model turn", async () => {
		const input = mode.startPendingSubmission({ text: "/extension-no-turn" });
		expect(mode.loadingAnimation).toBeDefined();
		expect(mode.optimisticUserMessageSignature).toBe("/extension-no-turn\u00000");

		await submitInteractiveInput(mode, session, input);

		expect(mode.loadingAnimation).toBeUndefined();
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
		expect(mode.locallySubmittedUserSignatures.has("/extension-no-turn\u00000")).toBe(false);
		expect(mode.statusContainer.children.length).toBe(0);
	});

	it("refreshes the terminal title around pending-submission loaders", () => {
		const refreshTerminalTitle = vi.spyOn(mode, "refreshTerminalTitle");

		mode.startPendingSubmission({ text: "cancel me" });
		expect(mode.loadingAnimation).toBeDefined();

		mode.cancelPendingSubmission();

		expect(mode.loadingAnimation).toBeUndefined();
		expect(refreshTerminalTitle).toHaveBeenCalledTimes(2);
	});

	it("preserves hook-owned titles until terminal state titles are enabled", () => {
		const previousHeadless = setTerminalHeadless(false);
		const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		try {
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			const write = process.stdout.write as typeof process.stdout.write & {
				mock: { calls: unknown[][] };
				mockClear(): void;
			};

			mode.refreshTerminalTitle();
			expect(write.mock.calls.at(-1)?.[0]).toEqual(expect.stringMatching(/^\x1b]0;π:/));
			write.mockClear();

			mode.setExtensionTerminalTitle("hook title");
			expect(write.mock.calls.at(-1)?.[0]).toBe("\x1b]0;hook title\x07");
			write.mockClear();

			mode.refreshTerminalTitle();
			expect(write.mock.calls).toEqual([]);

			mode.settings.set("terminal.showTitleState", true);
			mode.startPendingSubmission({ text: "running title" });

			const titleWrites = write.mock.calls.map(call => String(call[0]));
			expect(titleWrites.some(title => title.startsWith("\x1b]0;") && title !== "\x1b]0;hook title\x07")).toBe(true);
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
