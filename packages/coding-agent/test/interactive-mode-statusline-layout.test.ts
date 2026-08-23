import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function stripAnsi(text: string): string {
	return Bun.stripANSI(text);
}

describe("InteractiveMode mounted statusline layout", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-statusline-layout-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("renders secondary line above box composer without duplicate row below", async () => {
		settings.override("composer.shape", "box");
		settings.override("statusLine.preset", "custom");
		settings.override("statusLine.leftSegments", ["pi", "model"]);
		settings.override("statusLine.rightSegments", ["session_name"]);
		settings.override("statusLine.secondaryLeftSegments", ["context_pct", "context_total"]);
		settings.override("statusLine.secondaryRightSegments", ["time"]);

		mode = new InteractiveMode(session, "test");
		await mode.init();

		const rendered = mode.ui.render(100).map(stripAnsi);
		const nonBlank = rendered.filter(line => line.trim().length > 0);

		// 1. Secondary status line should be rendered above the editor box
		const secondaryIndex = nonBlank.findIndex(line => line.includes("0.0%/"));
		expect(secondaryIndex).toBeGreaterThanOrEqual(0);

		// 2. Editor top border with primary status line (pi, model) should be directly below secondary line
		const topBorderIndex = nonBlank.findIndex(line => line.includes("Sonnet 4.5") && line.includes("╭─"));
		expect(topBorderIndex).toBe(secondaryIndex + 1);
		// 3. Editor prompt line
		const promptIndex = nonBlank.findIndex((line, i) => i > topBorderIndex && line.includes("╰─"));
		expect(promptIndex).toBe(topBorderIndex + 1);

		// 4. Verify no duplicate secondary line or extra bottom line exists below the prompt
		const linesAfterPrompt = nonBlank.slice(promptIndex + 1);
		expect(linesAfterPrompt).toHaveLength(0);
	});

	it("renders secondary line above borderless composer and primary status bar below", async () => {
		settings.override("composer.shape", "borderless");
		settings.override("statusLine.preset", "custom");
		settings.override("statusLine.leftSegments", ["pi", "model"]);
		settings.override("statusLine.rightSegments", ["session_name"]);
		settings.override("statusLine.secondaryLeftSegments", ["context_pct", "context_total"]);
		settings.override("statusLine.secondaryRightSegments", ["time"]);

		mode = new InteractiveMode(session, "test");
		await mode.init();

		const rendered = mode.ui.render(100).map(stripAnsi);
		const nonBlank = rendered.filter(line => line.trim().length > 0);

		// 1. Secondary status line should be rendered above the editor prompt
		const secondaryIndex = nonBlank.findIndex(line => line.includes("0.0%/"));
		expect(secondaryIndex).toBeGreaterThanOrEqual(0);

		// 2. Editor prompt line (borderless prompt uses ❯)
		const promptIndex = nonBlank.findIndex((line, i) => i > secondaryIndex && line.includes("❯"));
		expect(promptIndex).toBe(secondaryIndex + 1);

		// 3. Standalone bottom status bar should be rendered below the prompt
		const bottomBarIndex = nonBlank.findIndex((line, i) => i > promptIndex && line.includes("Sonnet 4.5"));
		expect(bottomBarIndex).toBe(promptIndex + 1);

		// 4. No duplicate secondary or primary lines after bottom bar
		const linesAfterBottomBar = nonBlank.slice(bottomBarIndex + 1);
		expect(linesAfterBottomBar).toHaveLength(0);
	});

	it("renders secondary line above claude shape with top-rule chip and left-only bottom bar", async () => {
		settings.override("composer.shape", "claude");
		settings.override("statusLine.preset", "custom");
		settings.override("statusLine.leftSegments", ["pi", "model"]);
		settings.override("statusLine.rightSegments", ["session_name"]);
		settings.override("statusLine.secondaryLeftSegments", ["context_pct", "context_total"]);
		settings.override("statusLine.secondaryRightSegments", ["time"]);

		mode = new InteractiveMode(session, "test");
		await mode.init();

		const rendered = mode.ui.render(100).map(stripAnsi);
		const nonBlank = rendered.filter(line => line.trim().length > 0);
		// 1. Secondary status line
		const secondaryIndex = nonBlank.findIndex(line => line.includes("0.0%/"));
		expect(secondaryIndex).toBeGreaterThanOrEqual(0);

		// 2. Top rule with chip (contains horizontal rule chars directly below secondary)
		const topRuleIndex = nonBlank.findIndex((line, i) => i > secondaryIndex && line.includes("─"));
		expect(topRuleIndex).toBe(secondaryIndex + 1);

		// 3. Prompt line
		const promptIndex = nonBlank.findIndex((line, i) => i > topRuleIndex && line.includes("❯"));
		expect(promptIndex).toBe(topRuleIndex + 1);

		// 4. Bottom rule
		const bottomRuleIndex = nonBlank.findIndex((line, i) => i > promptIndex && line.includes("─"));
		expect(bottomRuleIndex).toBe(promptIndex + 1);

		// 5. Left-only bottom bar (contains Claude model)
		const bottomBarIndex = nonBlank.findIndex((line, i) => i > bottomRuleIndex && line.includes("Sonnet 4.5"));
		expect(bottomBarIndex).toBe(bottomRuleIndex + 1);

		// 6. No duplicate rows after bottom bar
		const linesAfterBottomBar = nonBlank.slice(bottomBarIndex + 1);
		expect(linesAfterBottomBar).toHaveLength(0);
	});
});
