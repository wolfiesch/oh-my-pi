/**
 * Regression: the fullscreen transcript viewer must align the header, body, and
 * footer on a single shared gutter. The transcript components carry their own
 * 1-column left pad, so the viewer must NOT add a second outer gutter to body
 * rows — doing so shifted the content one column right of the "Agent Hub" title
 * (the reported "first char off / title shift"). Scrolling must also move the
 * visible window.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentHubRemote } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const TS = new Date().toISOString();
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function sessionHeader(id = "adv"): string {
	return JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: TS, cwd: "/tmp" });
}

function userLine(id: string, text: string, parentId: string | null = null): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: TS,
		message: { role: "user", synthetic: true, attribution: "agent", content: text, timestamp: 0 },
	});
}

function assistantLine(id: string, text: string, parentId: string | null = null): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: TS,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "gpt-5.5",
			usage,
			stopReason: "stop",
			timestamp: 1,
		},
	});
}

function jsonl(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function renderedBody(viewer: AgentTranscriptViewer): string {
	return viewer
		.render(80)
		.map(l => Bun.stripANSI(l))
		.join("\n");
}

function countOccurrences(text: string, marker: string): number {
	return text.split(marker).length - 1;
}

async function waitForBody(viewer: AgentTranscriptViewer, predicate: (body: string) => boolean): Promise<string> {
	const deadline = Date.now() + 5000;
	let body = renderedBody(viewer);
	while (!predicate(body) && Date.now() < deadline) {
		await Bun.sleep(50);
		body = renderedBody(viewer);
	}
	return body;
}

function buildJsonl(): string {
	const lines = [sessionHeader()];
	let parentId = "u0";
	lines.push(userLine(parentId, "PROMPTMARKER"));
	for (let i = 0; i < 40; i++) {
		const id = `a${i}`;
		lines.push(assistantLine(id, `Reviewing step ${i}.`, parentId));
		parentId = id;
	}
	return jsonl(lines);
}

function makeViewer(file: string | null, remote?: AgentHubRemote, requestRender: () => void = () => {}) {
	const agents = new AgentRegistry();
	agents.register({
		id: "Main/advisor",
		displayName: "advisor",
		kind: "advisor",
		parentId: "Main",
		session: null,
		sessionFile: file,
		status: "parked",
	});
	return new AgentTranscriptViewer({
		agentId: "Main/advisor",
		registry: agents,
		remote,
		ui: { requestRender: () => {}, requestComponentRender: () => {} } as never,
		cwd: "/tmp",
		expandKeys: ["ctrl+o"],
		hubKeys: ["ctrl+s"],
		requestRender,
		onClose: () => {},
		onHubClose: () => {},
	});
}

/** Leading-space count of a stripped line (its content gutter). */
function gutter(line: string): number {
	const stripped = Bun.stripANSI(line);
	return stripped.length - stripped.trimStart().length;
}

function withViewer(fn: (viewer: AgentTranscriptViewer) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
	const file = path.join(dir, "__advisor.jsonl");
	fs.writeFileSync(file, buildJsonl());
	try {
		fn(makeViewer(file));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("AgentTranscriptViewer", () => {
	let rowsDesc: PropertyDescriptor | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		initTheme();
		rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 24 });
	});

	afterEach(() => {
		if (rowsDesc) {
			Object.defineProperty(process.stdout, "rows", rowsDesc);
		} else {
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: undefined, writable: true });
		}
	});

	it("aligns the title and body content on the same gutter", () => {
		withViewer(viewer => {
			viewer.render(80); // populate the scroll view before navigating
			viewer.handleInput("g"); // scroll to top so the first message is visible
			const lines = viewer.render(80).map(l => Bun.stripANSI(l));
			const titleLine = lines.find(l => l.includes("Agent Hub"));
			const bodyLine = lines.find(l => l.includes("PROMPTMARKER"));
			expect(titleLine).toBeDefined();
			expect(bodyLine).toBeDefined();
			// The body must not sit one column right of the title.
			expect(gutter(bodyLine!)).toBe(gutter(titleLine!));
		});
	});

	it("scrolls the visible window with j/k and g/G", () => {
		withViewer(viewer => {
			const atBottom = viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
			viewer.handleInput("g");
			const atTop = viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
			expect(atTop).not.toEqual(atBottom);
			expect(atTop).toContain("PROMPTMARKER");
			expect(atBottom).not.toContain("PROMPTMARKER");
		});
	});

	it("tails complete local appends without duplicating old transcript rows", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		fs.writeFileSync(file, jsonl([sessionHeader(), userLine("old", "LOCAL-OLD")]));
		const viewer = makeViewer(file);
		try {
			viewer.render(80);
			fs.appendFileSync(file, `${userLine("new", "LOCAL-NEW", "old")}\n`);
			const body = await waitForBody(viewer, text => text.includes("LOCAL-NEW"));
			expect(body).toContain("LOCAL-NEW");
			expect(countOccurrences(body, "LOCAL-OLD")).toBe(1);
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("buffers partial trailing local JSONL until the newline arrives", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		fs.writeFileSync(file, jsonl([sessionHeader(), userLine("old", "LOCAL-OLD")]));
		const viewer = makeViewer(file);
		const partial = userLine("partial", "LOCAL-PARTIAL", "old");
		try {
			viewer.render(80);
			fs.appendFileSync(file, partial.slice(0, -2));
			const withoutPartial = await waitForBody(viewer, text => text.includes("LOCAL-OLD"));
			expect(withoutPartial).not.toContain("LOCAL-PARTIAL");

			fs.appendFileSync(file, `${partial.slice(-2)}\n`);
			const body = await waitForBody(viewer, text => text.includes("LOCAL-PARTIAL"));
			expect(countOccurrences(body, "LOCAL-PARTIAL")).toBe(1);
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fully rebuilds local content when the transcript file is replaced", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		fs.writeFileSync(file, jsonl([sessionHeader(), userLine("old", "LOCAL-OLD")]));
		const viewer = makeViewer(file);
		try {
			viewer.render(80);
			const replacement = path.join(dir, "replacement.jsonl");
			fs.writeFileSync(replacement, jsonl([sessionHeader(), userLine("replaced", "LOCAL-REPLACED")]));
			fs.renameSync(replacement, file);
			const body = await waitForBody(viewer, text => text.includes("LOCAL-REPLACED") && !text.includes("LOCAL-OLD"));
			expect(body).toContain("LOCAL-REPLACED");
			expect(body).not.toContain("LOCAL-OLD");
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("clears remote placeholders, appends later messages, and drops stale rows after rotation", async () => {
		const firstHeader = jsonl([sessionHeader("remote")]);
		const laterMessage = userLine("remote-message", "REMOTE-LATER");
		const rotatedHeader = jsonl([sessionHeader("remote-rotated")]);
		const laterChunk = `${laterMessage}\n`;
		const responses = [
			{ text: firstHeader, newSize: Buffer.byteLength(firstHeader) },
			{ text: laterChunk, newSize: Buffer.byteLength(firstHeader) + Buffer.byteLength(laterChunk) },
			{ text: "", newSize: 0 },
			{ text: rotatedHeader, newSize: Buffer.byteLength(rotatedHeader) },
		];
		const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		let calls = 0;
		const remote: AgentHubRemote = {
			chat: () => {},
			kill: () => {},
			revive: () => {},
			readTranscript: async () => {
				const index = calls++;
				if (index > 0) await gates[index - 1]?.promise;
				return responses[index] ?? { text: "", newSize: Buffer.byteLength(rotatedHeader) };
			},
		};
		let renderRequests = 0;
		const viewer = makeViewer(null, remote, () => {
			renderRequests++;
		});
		try {
			const emptyBody = await waitForBody(viewer, text => text.includes("No messages yet."));
			expect(emptyBody).toContain("No messages yet.");
			expect(emptyBody).not.toContain("Loading transcript from host");
			expect(renderRequests).toBeGreaterThan(0);
			gates[0].resolve();

			const messageBody = await waitForBody(viewer, text => text.includes("REMOTE-LATER"));
			expect(messageBody).toContain("REMOTE-LATER");
			gates[1].resolve();
			gates[2].resolve();

			const rotatedBody = await waitForBody(
				viewer,
				text => !text.includes("REMOTE-LATER") && text.includes("No messages yet."),
			);
			expect(rotatedBody).not.toContain("REMOTE-LATER");
			expect(rotatedBody).toContain("No messages yet.");
		} finally {
			viewer.dispose();
		}
	}, 10000);
	it("clears stale content when the transcript file is deleted while open", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		fs.writeFileSync(file, buildJsonl());
		const viewer = makeViewer(file);
		const body = () =>
			viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
		try {
			viewer.render(80);
			viewer.handleInput("g");
			expect(body()).toContain("PROMPTMARKER");

			fs.rmSync(file);
			// Poll until the viewer's own poll timer re-stats and clears (deadline-bounded).
			const deadline = Date.now() + 5000;
			while (body().includes("PROMPTMARKER") && Date.now() < deadline) {
				await Bun.sleep(50);
			}
			expect(body()).not.toContain("PROMPTMARKER");
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
