import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "../../config/settings";
import { initTheme, theme } from "../../modes/theme/theme";
import { renderResult } from "../render";
import type { AgentProgress, TaskToolDetails } from "../types";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "tui.hyperlinks": "always" } });
	await initTheme(false);
});

afterEach(() => {
	resetSettingsForTest();
});

function progress(overrides: Partial<AgentProgress>): AgentProgress {
	return {
		index: 0,
		id: "ReviewBot",
		agent: "reviewer",
		agentSource: "bundled",
		status: "pending",
		task: "review",
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

function renderProgress(progressItem: AgentProgress): string {
	const details: TaskToolDetails = {
		projectAgentsDir: null,
		results: [],
		totalDurationMs: 0,
		progress: [progressItem],
	};
	const component = renderResult({ content: [], details }, { expanded: true, isPartial: true }, theme);
	return component.render(120).join("\n");
}

describe("live progress links", () => {
	it("renders missing session files as plain task ids", () => {
		const text = renderProgress(progress({ sessionFile: undefined }));

		expect(text).toContain("ReviewBot");
		expect(text).not.toContain("\x1b]8;");
		expect(text).not.toContain("history://ReviewBot");
	});

	it("links live progress ids to session files when available", () => {
		const sessionFile = path.join("/tmp", "session", "ReviewBot.jsonl");
		const text = renderProgress(progress({ sessionFile }));

		expect(text).toContain("ReviewBot");
		expect(text).toContain("\x1b]8;");
		expect(text).toContain("file:///tmp/session/ReviewBot.jsonl");
		expect(text).not.toContain("history://ReviewBot");
	});
});
