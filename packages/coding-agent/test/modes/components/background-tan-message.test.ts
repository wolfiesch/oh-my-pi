import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBackgroundTanDispatchBlock } from "@oh-my-pi/pi-coding-agent/modes/components/background-tan-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE, type CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

function dispatchMessage(details: { jobId: string; work: string; sessionFile?: string }): CustomMessage<unknown> {
	return {
		role: "custom",
		customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
		// The persisted content is the full system-notice the model reads; the
		// renderer must NOT surface it in the transcript.
		content: '<system-notice reason="background_task_dispatched">raw block</system-notice>',
		display: true,
		details,
		attribution: "user",
		timestamp: Date.now(),
	} as CustomMessage<unknown>;
}

function extractLinkUri(text: string): string | undefined {
	return text.match(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/)?.[1];
}

function stripOsc8(text: string): string {
	return text.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "");
}

describe("createBackgroundTanDispatchBlock", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		settings.clearOverride("tui.hyperlinks");
		resetSettingsForTest();
	});

	it("renders one compact line with the job id and work preview, not the raw notice", () => {
		const block = createBackgroundTanDispatchBlock(
			dispatchMessage({ jobId: "job-42", work: "investigate the cache reuse path", sessionFile: "/x/Tan-1.jsonl" }),
		);

		const lines = block.render(120).filter(line => line.trim().length > 0);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("job-42");
		expect(lines[0]).toContain("investigate the cache reuse path");
		expect(lines[0]).not.toContain("system-notice");
	});

	it("truncates an overlong work preview so the line stays a single pill", () => {
		const block = createBackgroundTanDispatchBlock(
			dispatchMessage({ jobId: "job-7", work: "x".repeat(200), sessionFile: "/x/Tan-2.jsonl" }),
		);

		const line = block.render(120).find(rendered => rendered.includes("job-7")) ?? "";

		expect(line).toContain("…");
		expect(line).not.toContain("x".repeat(80));
	});

	it("links the job id to the session file without changing visible text", () => {
		settings.override("tui.hyperlinks", "always");
		const details = { jobId: "job-linked", work: "resume background tan", sessionFile: "/x/Tan linked.jsonl" };
		const linkedBlock = createBackgroundTanDispatchBlock(dispatchMessage(details));
		const legacyBlock = createBackgroundTanDispatchBlock(
			dispatchMessage({ jobId: details.jobId, work: details.work }),
		);

		const linkedLine = linkedBlock.render(120).find(rendered => rendered.includes("job-linked")) ?? "";
		const legacyLine = legacyBlock.render(120).find(rendered => rendered.includes("job-linked")) ?? "";

		expect(extractLinkUri(linkedLine)).toBe(url.pathToFileURL(details.sessionFile).href);
		expect(Bun.stripANSI(stripOsc8(linkedLine))).toBe(Bun.stripANSI(legacyLine));
		expect(extractLinkUri(legacyLine)).toBeUndefined();
	});

	it("rebases a moved tan breadcrumb link into the current session artifact directory", () => {
		settings.override("tui.hyperlinks", "always");
		const staleSessionFile = path.join("/tmp", "old-root", "session", "Tan linked.jsonl");
		const currentSessionFile = path.join("/tmp", "new-root", "session.jsonl");
		const movedSessionFile = path.join("/tmp", "new-root", "session", "Tan linked.jsonl");
		const block = createBackgroundTanDispatchBlock(
			dispatchMessage({ jobId: "job-linked", work: "resume background tan", sessionFile: staleSessionFile }),
			currentSessionFile,
		);

		const line = block.render(120).find(rendered => rendered.includes("job-linked")) ?? "";

		expect(extractLinkUri(line)).toBe(url.pathToFileURL(movedSessionFile).href);
	});
});
