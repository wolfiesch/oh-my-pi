import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { buildAsyncResultBlock } from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";

const OSC8 = /\x1b\]8;[^;]*;([^\x1b\x07]+)(?:\x1b\\|\x07)/;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("buildAsyncResultBlock", () => {
	it("links a completed task job id to its transcript file when available", () => {
		Settings.instance.override("tui.hyperlinks", "always");
		const transcriptPath = path.join("/tmp", "Tan-123.jsonl");
		const block = buildAsyncResultBlock({
			role: "custom",
			customType: "async-result",
			content: "",
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
			details: {
				jobs: [{ jobId: "bg_1", type: "task", linkPath: transcriptPath }],
			},
		});

		const line = block.render(120).find(rendered => rendered.includes("bg_1")) ?? "";

		expect(line.match(OSC8)?.[1]).toBe(url.pathToFileURL(transcriptPath).href);
		expect(Bun.stripANSI(line)).toContain("Background job completed [task] bg_1");
	});
});
