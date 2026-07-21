import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function createContext() {
	const streamState = { isStreaming: false };
	const compactionState = { isCompacting: false };
	const children: unknown[] = [];
	const statusContainer = {
		children,
		clear() {
			children.length = 0;
		},
		disposeChildren() {
			children.length = 0;
		},
		addChild(child: unknown) {
			children.push(child);
		},
		removeChild(child: unknown) {
			const index = children.indexOf(child);
			if (index !== -1) children.splice(index, 1);
		},
	};
	const ctx = {
		isInitialized: true,
		settings: { get: (path: string) => path === "terminal.showProgress" && false },
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		pendingTools: new Map<string, unknown>(),
		hideThinkingBlock: false,
		setWorkingMessage: vi.fn(),
		clearPinnedError: vi.fn(),
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		statusContainer,
		chatContainer: { removeChild: vi.fn(), clear: vi.fn() },
		flushPendingModelSwitch: vi.fn(async () => {}),
		flushCompactionQueue: vi.fn(async () => {}),
		rebuildChatFromMessages: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		editor: { getText: () => "" },
		sessionManager: { getSessionName: () => "test-session" },
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		viewSession: {
			get isCompacting() {
				return compactionState.isCompacting;
			},
			getLastAssistantMessage: () => undefined,
		},
		session: {
			get isStreaming() {
				return streamState.isStreaming;
			},
			get isCompacting() {
				return compactionState.isCompacting;
			},
			getToolByName: () => undefined,
		},
		flushPendingCommandOutput: vi.fn(),
		refreshTerminalTitle: vi.fn(),
	} as unknown as InteractiveModeContext & { refreshTerminalTitle: ReturnlessMock };
	ctx.ensureLoadingAnimation = vi.fn(() => {
		if (ctx.loadingAnimation) return;
		statusContainer.clear();
		ctx.loadingAnimation = { stop: vi.fn() } as unknown as typeof ctx.loadingAnimation;
		statusContainer.addChild(ctx.loadingAnimation);
	});
	return { ctx, streamState, compactionState };
}

type ReturnlessMock = ReturnlessFn & { mock: { calls: unknown[][] } };
type ReturnlessFn = () => void;

const AGENT_START = { type: "agent_start" } as unknown as AgentSessionEvent;
const AGENT_END = { type: "agent_end" } as unknown as AgentSessionEvent;
const COMPACTION_START = {
	type: "auto_compaction_start",
	reason: "overflow",
	action: "context-full",
} as unknown as AgentSessionEvent;
const COMPACTION_END = {
	type: "auto_compaction_end",
	action: "context-full",
	result: { summary: "s", shortSummary: "s", tokensBefore: 10, details: {}, firstKeptEntryId: undefined },
	willRetry: false,
} as unknown as AgentSessionEvent;
const POST_PROMPT_WORK_DRAINED = { type: "post_prompt_work_drained" } as unknown as AgentSessionEvent;

describe("EventController terminal title state", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("refreshes the terminal title around running lifecycle events", async () => {
		const { ctx, streamState } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		expect(ctx.refreshTerminalTitle).toHaveBeenCalledTimes(1);

		streamState.isStreaming = true;
		await controller.handleEvent(COMPACTION_START);
		expect(ctx.refreshTerminalTitle).toHaveBeenCalledTimes(2);

		await controller.handleEvent(COMPACTION_END);
		expect(ctx.refreshTerminalTitle).toHaveBeenCalledTimes(3);

		streamState.isStreaming = false;
		await controller.handleEvent(AGENT_END);
		expect(ctx.refreshTerminalTitle).toHaveBeenCalledTimes(4);
	});

	it("refreshes the terminal title when post-prompt work drains", async () => {
		const { ctx } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(POST_PROMPT_WORK_DRAINED);

		expect(ctx.refreshTerminalTitle).toHaveBeenCalledTimes(1);
		expect(ctx.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("defers the idle title refresh until auto-compaction clears its session flag", async () => {
		const { ctx, compactionState } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(COMPACTION_START);
		expect(ctx.refreshTerminalTitle).toHaveBeenCalledTimes(1);

		compactionState.isCompacting = true;
		await controller.handleEvent(COMPACTION_END);
		expect(ctx.refreshTerminalTitle).toHaveBeenCalledTimes(1);

		compactionState.isCompacting = false;
		vi.advanceTimersByTime(0);
		expect(ctx.refreshTerminalTitle).toHaveBeenCalledTimes(2);
	});
});
