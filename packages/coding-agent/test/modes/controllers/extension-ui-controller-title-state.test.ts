import { beforeAll, describe, expect, it, vi } from "bun:test";
import type {
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { type Component, Container } from "@oh-my-pi/pi-tui";

function createContext() {
	const editor = { id: "core-editor", getText: vi.fn(() => "draft"), setText: vi.fn() };
	const editorContainer = {
		children: [] as unknown[],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
	const release = vi.fn();
	const pushTerminalTitleAttention = vi.fn(() => release);
	const ctx = {
		editor,
		editorContainer,
		ui: {
			requestRender: vi.fn(),
			setFocus: vi.fn(),
			terminal: { rows: 40, columns: 120 },
		},
		hookSelector: undefined,
		pushTerminalTitleAttention,
	} as unknown as InteractiveModeContext & {
		pushTerminalTitleAttention: () => () => void;
	};
	return { ctx, release, pushTerminalTitleAttention };
}

describe("ExtensionUiController terminal title attention", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("marks hook selectors as needing attention until they close", async () => {
		const { ctx, release, pushTerminalTitleAttention } = createContext();
		const controller = new ExtensionUiController(ctx);
		const abortController = new AbortController();

		const promise = controller.showHookSelector("Approval required", ["Approve", "Deny"], {
			signal: abortController.signal,
		});

		expect(pushTerminalTitleAttention).toHaveBeenCalledTimes(1);

		abortController.abort();
		await promise;

		expect(release).toHaveBeenCalledTimes(1);
	});

	it("holds the attention token across a deferred custom UI until done() fires", async () => {
		const { ctx, release, pushTerminalTitleAttention } = createContext();
		const controller = new ExtensionUiController(ctx);
		const mounted = Promise.withResolvers<void>();
		const dispose = vi.fn();
		// Minimal stand-in for a mounted extension component; only dispose is
		// exercised by the close path under test.
		const component = { dispose } as unknown as Component & { dispose?(): void };
		let done: ((result: string) => void) | undefined;

		const promise = controller.showHookCustom<string>(async (_tui, _theme, _keybindings, doneFn) => {
			done = doneFn;
			await mounted.promise;
			return component;
		});

		// needs_attention is claimed synchronously, before the component mounts.
		expect(pushTerminalTitleAttention).toHaveBeenCalledTimes(1);
		expect(release).not.toHaveBeenCalled();

		mounted.resolve();
		await Promise.resolve();
		if (!done) throw new Error("Expected done callback");
		done("picked");

		expect(await promise).toBe("picked");
		expect(release).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("releases the attention token when the custom UI factory rejects", async () => {
		const { ctx, release, pushTerminalTitleAttention } = createContext();
		const controller = new ExtensionUiController(ctx);
		const failure = new Error("factory exploded");

		const promise = controller.showHookCustom<string>(async () => {
			throw failure;
		});

		expect(pushTerminalTitleAttention).toHaveBeenCalledTimes(1);
		await expect(promise).rejects.toBe(failure);
		expect(release).toHaveBeenCalledTimes(1);
	});

	it("settles done() and releases the token exactly once when component dispose throws", async () => {
		const { ctx, release, pushTerminalTitleAttention } = createContext();
		const controller = new ExtensionUiController(ctx);
		const dispose = vi.fn(() => {
			throw new Error("dispose exploded");
		});
		const component = { dispose } as unknown as Component & { dispose?(): void };
		let done: ((result: string) => void) | undefined;

		const promise = controller.showHookCustom<string>((_tui, _theme, _keybindings, doneFn) => {
			done = doneFn;
			return component;
		});
		await Promise.resolve();
		expect(pushTerminalTitleAttention).toHaveBeenCalledTimes(1);
		if (!done) throw new Error("Expected done callback");

		// A throwing extension dispose is contained: the promise still resolves
		// with the done() result and the attention token is released exactly once.
		done("survived");

		expect(await promise).toBe("survived");
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
	});

	it("contains a throwing dispose from a late component after done() won the race", async () => {
		const { ctx, release } = createContext();
		const controller = new ExtensionUiController(ctx);
		const mounted = Promise.withResolvers<void>();
		const disposed = Promise.withResolvers<void>();
		const lateDispose = vi.fn(() => {
			disposed.resolve();
			throw new Error("late dispose exploded");
		});
		const lateComponent = { dispose: lateDispose } as unknown as Component & { dispose?(): void };

		const promise = controller.showHookCustom<string>(async (_tui, _theme, _keybindings, doneFn) => {
			// Settle before the component ever materializes.
			doneFn("early");
			await mounted.promise;
			return lateComponent;
		});

		expect(await promise).toBe("early");
		expect(release).toHaveBeenCalledTimes(1);

		// The component arrives after settlement; its throwing dispose is
		// contained and must not double-release or produce an unhandled rejection.
		mounted.resolve();
		await disposed.promise;

		expect(lateDispose).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
	});
	for (const initializer of ["hooks", "custom-tools"] as const) {
		it(`refreshes the terminal title when ${initializer} new-session setup is cancelled`, async () => {
			let commandActions: ExtensionCommandContextActions | undefined;
			const refreshTerminalTitle = vi.fn();
			const extensionRunner = {
				initialize(
					_actions: unknown,
					_contextActions: unknown,
					capturedCommandActions: ExtensionCommandContextActions,
				): void {
					commandActions = capturedCommandActions;
				},
				onError: vi.fn(),
				emit: vi.fn(async () => {}),
			};
			const ctx = {
				session: {
					extensionRunner,
					newSession: vi.fn(async () => false),
				},
				setToolUIContext: vi.fn(),
				clearTransientSessionUi: vi.fn(),
				refreshTerminalTitle,
				hookWidgetContainerAbove: new Container(),
				hookWidgetContainerBelow: new Container(),
				ui: { requestRender: vi.fn() },
				editor: {
					setText: vi.fn(),
					handleInput: vi.fn(),
					getText: vi.fn(() => ""),
				},
				setWorkingMessage: vi.fn(),
				setEditorComponent: vi.fn(),
				toolOutputExpanded: false,
				setToolsExpanded: vi.fn(),
			} as unknown as InteractiveModeContext;
			const controller = new ExtensionUiController(ctx);

			if (initializer === "hooks") {
				controller.initializeHookRunner({} as ExtensionUIContext, false);
			} else {
				await controller.initHooksAndCustomTools();
			}
			if (!commandActions) throw new Error("Expected extension command actions");

			await commandActions.newSession();

			expect(refreshTerminalTitle).toHaveBeenCalledTimes(1);
		});
	}

	for (const settle of ["resolves", "rejects"] as const) {
		it(`refreshes the terminal title immediately and after extension compact ${settle}`, async () => {
			let contextActions: ExtensionContextActions | undefined;
			const refreshTerminalTitle = vi.fn();
			const compaction = Promise.withResolvers<void>();
			const extensionRunner = {
				initialize(
					_actions: unknown,
					capturedContextActions: ExtensionContextActions,
					_commandActions: unknown,
				): void {
					contextActions = capturedContextActions;
				},
				onError: vi.fn(),
				emit: vi.fn(async () => {}),
			};
			const ctx = {
				session: {
					extensionRunner,
					compact: vi.fn(() => compaction.promise),
				},
				setToolUIContext: vi.fn(),
				refreshTerminalTitle,
				hookWidgetContainerAbove: new Container(),
				hookWidgetContainerBelow: new Container(),
				ui: { requestRender: vi.fn() },
				editor: {
					setText: vi.fn(),
					handleInput: vi.fn(),
					getText: vi.fn(() => ""),
				},
				setWorkingMessage: vi.fn(),
				setEditorComponent: vi.fn(),
				toolOutputExpanded: false,
				setToolsExpanded: vi.fn(),
			} as unknown as InteractiveModeContext;
			const controller = new ExtensionUiController(ctx);
			await controller.initHooksAndCustomTools();
			if (!contextActions) throw new Error("Expected extension context actions");

			const run = contextActions.compact("shrink it");
			// The title flips before the compaction settles: the promise is captured
			// and the refresh fires synchronously.
			expect(refreshTerminalTitle).toHaveBeenCalledTimes(1);

			if (settle === "resolves") {
				compaction.resolve();
				await run;
			} else {
				const failure = new Error("compaction exploded");
				compaction.reject(failure);
				await expect(run).rejects.toBe(failure);
			}

			// Settled either way: the finally-refresh clears the compacting title.
			expect(refreshTerminalTitle).toHaveBeenCalledTimes(2);
		});
	}
});
