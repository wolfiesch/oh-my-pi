import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	Settings.instance.override("tui.hyperlinks", "always");
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

function makeStreamingMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function finishedResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "Focused.Worker",
		agent: "task",
		agentSource: "bundled",
		task: "inspect focused transcript links",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

function taskDetails(outputPath: string): TaskToolDetails {
	return {
		projectAgentsDir: null,
		results: [finishedResult({ outputPath })],
		totalDurationMs: 0,
	};
}

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b\x07]+)(?:\x1b\\|\x07)/g)].map(match => match[1]!);
}

function createFixture(options: {
	mainSessionFile: string;
	focusedSessionFile: string;
	streamingMessage?: AssistantMessage;
}) {
	const pendingTools = new Map<string, unknown>();
	const addedChildren: Array<{ render: (width: number) => readonly string[] }> = [];
	const mainSession = {
		isAborting: false,
		getToolByName: () => undefined,
		sessionManager: { getSessionFile: () => options.mainSessionFile },
	};
	const focusedSession = {
		isStreaming: false,
		isCompacting: false,
		isTtsrAbortPending: false,
		retryAttempt: 0,
		getToolByName: () => undefined,
		sessionManager: { getSessionFile: () => options.focusedSessionFile },
	};
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn() },
		settings,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		streamingComponent: options.streamingMessage
			? { updateContent: vi.fn(), markTranscriptBlockFinalized: vi.fn(), setHideThinkingBlock: vi.fn() }
			: undefined,
		streamingMessage: options.streamingMessage,
		pendingTools,
		noteDisplayableThinkingContent: vi.fn(() => false),
		chatContainer: {
			addChild: vi.fn((child: { render: (width: number) => readonly string[] }) => addedChildren.push(child)),
		},
		toolOutputExpanded: false,
		session: mainSession,
		viewSession: focusedSession,
		focusedAgentId: "Focused.Worker",
		clearTransientSessionUi: vi.fn(),
		sessionManager: { getCwd: () => process.cwd(), getSessionFile: () => options.mainSessionFile },
		setWorkingMessage: vi.fn(),
		autoCompactionLoader: undefined,
		retryLoader: undefined,
	} as unknown as InteractiveModeContext;

	return { controller: new EventController(ctx), addedChildren };
}

function createUiFixture(options: { mainSessionFile: string; focusedSessionFile: string }) {
	const addedChildren: Array<{ render: (width: number) => readonly string[] }> = [];
	const focusedSession = {
		retryAttempt: 0,
		sessionManager: { getSessionFile: () => options.focusedSessionFile },
		getToolByName: () => undefined,
	};
	const ctx = {
		pendingTools: new Map<string, unknown>(),
		lastAssistantUsage: undefined,
		settings,
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		chatContainer: {
			children: [],
			addChild: vi.fn((child: { render: (width: number) => readonly string[] }) => {
				addedChildren.push(child);
			}),
			removeChild: vi.fn(),
		},
		toolOutputExpanded: false,
		session: { isStreaming: false },
		sessionManager: { getSessionFile: () => options.mainSessionFile },
		viewSession: focusedSession,
		ui: { requestRender: vi.fn() },
		getUserMessageText: vi.fn(() => ""),
		editor: { addToHistory: vi.fn() },
		eventController: undefined,
	} as unknown as InteractiveModeContext;
	const helper = new UiHelpers(ctx);
	ctx.addMessageToChat = helper.addMessageToChat.bind(helper);
	return { helper, addedChildren };
}

async function dispatchToolStart(controller: EventController, toolCallId: string) {
	await controller.handleEvent({
		type: "tool_execution_start",
		toolCallId,
		toolName: "task",
		args: { tasks: [] },
	} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
}

async function dispatchToolEnd(controller: EventController, toolCallId: string, details: TaskToolDetails) {
	await controller.handleEvent({
		type: "tool_execution_end",
		toolCallId,
		toolName: "task",
		args: { tasks: [] },
		result: { content: [{ type: "text", text: "" }], details },
		isError: false,
	} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
}

describe("EventController focused session tool links", () => {
	it("rebases live task result links from streaming tool-call components against the focused session file", async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-focused-stream-link-"));
		try {
			const mainArtifactsDir = path.join(tempRoot, "main-session");
			const focusedArtifactsDir = path.join(tempRoot, "focused-session");
			const outputName = "Focused.Worker.txt";
			const oldOutputPath = path.join(mainArtifactsDir, outputName);
			const focusedOutputPath = path.join(focusedArtifactsDir, outputName);
			fs.mkdirSync(focusedArtifactsDir, { recursive: true });
			fs.writeFileSync(focusedOutputPath, "focused output");

			const streamingMessage = makeStreamingMessage([
				{ type: "toolCall", id: "tc-stream", name: "task", arguments: { tasks: [] } },
			]);
			const { controller, addedChildren } = createFixture({
				mainSessionFile: `${mainArtifactsDir}.jsonl`,
				focusedSessionFile: `${focusedArtifactsDir}.jsonl`,
				streamingMessage,
			});

			await controller.handleEvent({
				type: "message_update",
				message: streamingMessage,
				assistantMessageEvent: undefined as never,
			} as Extract<AgentSessionEvent, { type: "message_update" }>);
			await dispatchToolEnd(controller, "tc-stream", taskDetails(oldOutputPath));

			const rendered = addedChildren[0]?.render(120).join("\n") ?? "";
			expect(extractLinkUris(rendered)).toContain(url.pathToFileURL(focusedOutputPath).href);
			expect(extractLinkUris(rendered)).not.toContain(url.pathToFileURL(oldOutputPath).href);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("rebases live task result links from tool-start components against the focused session file", async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-focused-start-link-"));
		try {
			const mainArtifactsDir = path.join(tempRoot, "main-session");
			const focusedArtifactsDir = path.join(tempRoot, "focused-session");
			const outputName = "Focused.Worker.txt";
			const oldOutputPath = path.join(mainArtifactsDir, outputName);
			const focusedOutputPath = path.join(focusedArtifactsDir, outputName);
			fs.mkdirSync(focusedArtifactsDir, { recursive: true });
			fs.writeFileSync(focusedOutputPath, "focused output");
			const { controller, addedChildren } = createFixture({
				mainSessionFile: `${mainArtifactsDir}.jsonl`,
				focusedSessionFile: `${focusedArtifactsDir}.jsonl`,
			});

			await dispatchToolStart(controller, "tc-start");
			await dispatchToolEnd(controller, "tc-start", taskDetails(oldOutputPath));

			const rendered = addedChildren[0]?.render(120).join("\n") ?? "";
			expect(extractLinkUris(rendered)).toContain(url.pathToFileURL(focusedOutputPath).href);
			expect(extractLinkUris(rendered)).not.toContain(url.pathToFileURL(oldOutputPath).href);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});
	it("rebases rebuilt async-result links against the focused session file", () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-focused-rebuild-link-"));
		try {
			const mainArtifactsDir = path.join(tempRoot, "main-session");
			const focusedArtifactsDir = path.join(tempRoot, "focused-session");
			const outputName = "Focused.Worker.jsonl";
			const staleOutputPath = path.join(mainArtifactsDir, outputName);
			const focusedOutputPath = path.join(focusedArtifactsDir, outputName);
			fs.mkdirSync(focusedArtifactsDir, { recursive: true });
			fs.writeFileSync(focusedOutputPath, "focused output");
			const { helper, addedChildren } = createUiFixture({
				mainSessionFile: `${mainArtifactsDir}.jsonl`,
				focusedSessionFile: `${focusedArtifactsDir}.jsonl`,
			});

			helper.renderSessionContext({
				messages: [
					{
						role: "custom",
						customType: "async-result",
						content: "",
						display: true,
						attribution: "agent",
						timestamp: Date.now(),
						details: {
							jobs: [{ jobId: "Focused.Worker", type: "task", linkPath: staleOutputPath }],
						},
					},
				],
			} as SessionContext);

			const rendered = addedChildren[0]?.render(120).join("\n") ?? "";
			expect(extractLinkUris(rendered)).toContain(url.pathToFileURL(focusedOutputPath).href);
			expect(extractLinkUris(rendered)).not.toContain(url.pathToFileURL(staleOutputPath).href);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("rebases rebuilt background tangent links against the focused session file", () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-focused-tan-link-"));
		try {
			const mainArtifactsDir = path.join(tempRoot, "main-session");
			const focusedArtifactsDir = path.join(tempRoot, "focused-session");
			const outputName = "Focused.Worker.jsonl";
			const staleOutputPath = path.join(mainArtifactsDir, outputName);
			const focusedOutputPath = path.join(focusedArtifactsDir, outputName);
			fs.mkdirSync(focusedArtifactsDir, { recursive: true });
			fs.writeFileSync(focusedOutputPath, "focused output");
			const { helper, addedChildren } = createUiFixture({
				mainSessionFile: `${mainArtifactsDir}.jsonl`,
				focusedSessionFile: `${focusedArtifactsDir}.jsonl`,
			});

			helper.renderSessionContext({
				messages: [
					{
						role: "custom",
						customType: "background-tan-dispatch",
						content: "",
						display: true,
						attribution: "agent",
						timestamp: Date.now(),
						details: {
							jobId: "Focused.Worker",
							work: "inspect focused tangent transcript links",
							sessionFile: staleOutputPath,
						},
					},
				],
			} as SessionContext);

			const rendered = addedChildren[0]?.render(120).join("\n") ?? "";
			expect(extractLinkUris(rendered)).toContain(url.pathToFileURL(focusedOutputPath).href);
			expect(extractLinkUris(rendered)).not.toContain(url.pathToFileURL(staleOutputPath).href);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
