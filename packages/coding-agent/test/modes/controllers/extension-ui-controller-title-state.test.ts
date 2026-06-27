import { beforeAll, describe, expect, it, vi } from "bun:test";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createContext() {
	const editor = { id: "core-editor" };
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
});
