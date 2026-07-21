import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { buildAsyncResultBlock } from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";

const OSC8 = /\x1b\]8;[^;]*;([^\x1b\x07]+)(?:\x1b\\|\x07)/;

beforeAll(async () => {
	await initTheme();
});

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-artifact-links-"));
	tempDirs.push(dir);
	return dir;
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
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

	it("uses async-result linkPath instead of the result artifact mentioned in content", () => {
		Settings.instance.override("tui.hyperlinks", "always");
		const transcriptPath = path.join("/tmp", "session", "ReviewBot.jsonl");
		const outputPath = path.join("/tmp", "session", "ReviewBot.md");
		const block = buildAsyncResultBlock({
			role: "custom",
			customType: "async-result",
			content: `Background task completed\nWrote ${outputPath}`,
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
			details: {
				jobs: [{ jobId: "ReviewBot", type: "task", linkPath: transcriptPath }],
			},
		});

		const text = block.render(120).join("\n");

		expect(text.match(OSC8)?.[1]).toBe(url.pathToFileURL(transcriptPath).href);
		expect(text).not.toContain(url.pathToFileURL(outputPath).href);
	});

	it("rebases a moved completed-job link into the current session artifact directory", () => {
		Settings.instance.override("tui.hyperlinks", "always");
		const staleTranscriptPath = path.join("/tmp", "old-root", "session", "Tan-123.jsonl");
		const currentSessionFile = path.join("/tmp", "new-root", "session.jsonl");
		const movedTranscriptPath = path.join("/tmp", "new-root", "session", "Tan-123.jsonl");
		const block = buildAsyncResultBlock(
			{
				role: "custom",
				customType: "async-result",
				content: "",
				display: true,
				attribution: "agent",
				timestamp: Date.now(),
				details: {
					jobs: [{ jobId: "bg_1", type: "task", linkPath: staleTranscriptPath }],
				},
			},
			currentSessionFile,
		);

		const line = block.render(120).find(rendered => rendered.includes("bg_1")) ?? "";

		expect(line.match(OSC8)?.[1]).toBe(url.pathToFileURL(movedTranscriptPath).href);
	});

	it("prefers a copied artifact child in the current session directory over an existing source link", () => {
		Settings.instance.override("tui.hyperlinks", "always");
		const root = createTempDir();
		const sourceArtifactsDir = path.join(root, "source-session");
		const currentSessionFile = path.join(root, "copy-session.jsonl");
		const currentArtifactsDir = path.join(root, "copy-session");
		const sourceTranscriptPath = path.join(sourceArtifactsDir, "Worker.jsonl");
		const copiedTranscriptPath = path.join(currentArtifactsDir, "Worker.jsonl");
		fs.mkdirSync(sourceArtifactsDir, { recursive: true });
		fs.mkdirSync(currentArtifactsDir, { recursive: true });
		fs.writeFileSync(sourceTranscriptPath, "source\n");
		fs.writeFileSync(copiedTranscriptPath, "copy\n");
		const block = buildAsyncResultBlock(
			{
				role: "custom",
				customType: "async-result",
				content: "",
				display: true,
				attribution: "agent",
				timestamp: Date.now(),
				details: {
					jobs: [{ jobId: "bg_1", type: "task", linkPath: sourceTranscriptPath }],
				},
			},
			currentSessionFile,
		);

		const line = block.render(120).find(rendered => rendered.includes("bg_1")) ?? "";

		expect(line.match(OSC8)?.[1]).toBe(url.pathToFileURL(copiedTranscriptPath).href);
	});

	it("rebases a copied artifact child after the source artifact directory is removed", () => {
		Settings.instance.override("tui.hyperlinks", "always");
		const root = createTempDir();
		const sourceTranscriptPath = path.join(root, "source-session", "Worker.jsonl");
		const currentSessionFile = path.join(root, "copy-session.jsonl");
		const copiedTranscriptPath = path.join(root, "copy-session", "Worker.jsonl");
		fs.mkdirSync(path.dirname(copiedTranscriptPath), { recursive: true });
		fs.writeFileSync(copiedTranscriptPath, "copy\n");
		const block = buildAsyncResultBlock(
			{
				role: "custom",
				customType: "async-result",
				content: "",
				display: true,
				attribution: "agent",
				timestamp: Date.now(),
				details: {
					jobs: [{ jobId: "bg_1", type: "task", linkPath: sourceTranscriptPath }],
				},
			},
			currentSessionFile,
		);

		const line = block.render(120).find(rendered => rendered.includes("bg_1")) ?? "";

		expect(line.match(OSC8)?.[1]).toBe(url.pathToFileURL(copiedTranscriptPath).href);
	});
});
