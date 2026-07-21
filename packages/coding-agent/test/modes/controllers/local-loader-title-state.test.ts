import { beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { type Component, Container } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

function deferred<T>() {
	const { promise, resolve } = Promise.withResolvers<T>();
	return { promise, resolve };
}

describe("local maintenance loaders terminal title state", () => {
	it("marks the terminal title running while handoff generation owns a local loader", async () => {
		const releaseTitleRunning = vi.fn();
		const handoff = deferred<{ savedPath?: string } | undefined>();
		const ctx = {
			session: { isStreaming: false, handoff: vi.fn(() => handoff.promise) },
			sessionManager: { getEntries: () => [{ type: "message" }, { type: "message" }] },
			loadingAnimation: undefined,
			statusContainer: new Container(),
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			showWarning: vi.fn(),
			showError: vi.fn(),
			rebuildChatFromMessages: vi.fn(),
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			reloadTodos: vi.fn(async () => {}),
			present: vi.fn(),
			showStatus: vi.fn(),
			pushTerminalTitleRunning: vi.fn(() => releaseTitleRunning),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		const run = controller.handleHandoffCommand();
		await Promise.resolve();
		expect(ctx.pushTerminalTitleRunning).toHaveBeenCalledTimes(1);
		expect(releaseTitleRunning).not.toHaveBeenCalled();

		handoff.resolve({});
		await run;
		expect(releaseTitleRunning).toHaveBeenCalledTimes(1);
	});

	it("refreshes the terminal title when new session hooks cancel after a local loader stops", async () => {
		const loader = { stop: vi.fn(), setMessage: vi.fn() };
		const bag = {
			session: {
				isStreaming: false,
				isCompacting: false,
				newSession: vi.fn(async () => false),
			},
			loadingAnimation: loader as { stop(): void } | undefined,
			autoCompactionLoader: undefined,
			statusContainer: new Container(),
			ui: { requestRender: vi.fn() },
			clearOptimisticUserMessage: vi.fn(),
			applyPendingWorkingMessage: vi.fn(),
			refreshTerminalTitle: vi.fn(),
			clearTransientSessionUi: vi.fn(() => {
				bag.loadingAnimation?.stop();
				bag.loadingAnimation = undefined;
			}),
		};
		const ctx = bag as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleClearCommand();

		expect(loader.stop).toHaveBeenCalledTimes(1);
		expect(bag.refreshTerminalTitle).toHaveBeenCalledTimes(1);
		expect(bag.ui.requestRender).not.toHaveBeenCalled();
	});

	it("marks the terminal title running while branch summarization owns a local loader", async () => {
		const releaseTitleRunning = vi.fn();
		const navigation = deferred<{ aborted?: boolean; cancelled?: boolean; editorText?: string }>();
		settings.set("branchSummary.enabled", true);
		let focusedComponent: Component | undefined;
		const editorContainer = new Container();
		const editor = { getText: () => "", setText: vi.fn(), onEscape: undefined as (() => void) | undefined };
		const ctx = {
			session: {
				navigateTree: vi.fn(() => navigation.promise),
				abortBranchSummary: vi.fn(),
			},
			sessionManager: {
				getTree: () => [
					{
						entry: {
							type: "message",
							id: "entry-1",
							parentId: null,
							timestamp: "2026-01-01T00:00:00.000Z",
							message: { role: "user", content: "hello" },
						},
						children: [],
					},
				],
				getLeafId: () => null,
				appendLabelChange: vi.fn(),
			},
			ui: {
				terminal: { rows: 30 },
				setFocus: vi.fn((component: Component) => {
					focusedComponent = component;
				}),
				requestRender: vi.fn(),
				requestComponentRender: vi.fn(),
			},
			editor,
			editorContainer,
			chatContainer: new Container(),
			statusContainer: new Container(),
			showHookSelector: vi.fn(async () => "Summarize"),
			showHookEditor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			renderInitialMessages: vi.fn(),
			reloadTodos: vi.fn(async () => {}),
			pushTerminalTitleRunning: vi.fn(() => releaseTitleRunning),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.showTreeSelector();
		focusedComponent?.handleInput?.("\n");
		await Promise.resolve();
		await Promise.resolve();
		expect(ctx.pushTerminalTitleRunning).toHaveBeenCalledTimes(1);
		expect(releaseTitleRunning).not.toHaveBeenCalled();

		navigation.resolve({});
		await Promise.resolve();
		await Promise.resolve();
		expect(releaseTitleRunning).toHaveBeenCalledTimes(1);
	});
});
