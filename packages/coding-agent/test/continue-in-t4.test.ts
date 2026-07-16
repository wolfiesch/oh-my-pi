import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "../src/modes/types";
import { getTuiTransferRefusal, transferToT4Handler } from "../src/slash-commands/builtin-registry";

function context(overrides: Partial<InteractiveModeContext> = {}): InteractiveModeContext {
	return {
		isShuttingDown: false,
		session: { isStreaming: false, queuedMessageCount: 0 } as InteractiveModeContext["session"],
		streamingComponent: undefined,
		autoCompactionLoader: undefined,
		compactionQueuedMessages: [],
		hookSelector: undefined,
		hookInput: undefined,
		hookEditor: undefined,
		editor: { setText: vi.fn() } as unknown as InteractiveModeContext["editor"],
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		shutdown: vi.fn(async () => undefined),
		...overrides,
	} as unknown as InteractiveModeContext;
}

describe("/continue-in-t4", () => {
	it.each([
		["shutdown", { isShuttingDown: true }],
		["streaming", { session: { isStreaming: true, queuedMessageCount: 0 } }],
		["streaming UI", { streamingComponent: {} }],
		["compacting", { autoCompactionLoader: {} }],
		["queued compaction", { compactionQueuedMessages: [{}] }],
		["queued work", { session: { isStreaming: false, queuedMessageCount: 1 } }],
		["approval selector", { hookSelector: {} }],
		["approval input", { hookInput: {} }],
		["approval editor", { hookEditor: {} }],
	])("refuses while %s", (_label, overrides) => {
		expect(getTuiTransferRefusal(context(overrides as Partial<InteractiveModeContext>))).toBeTruthy();
	});

	it("uses normal shutdown after the session is idle and persisted by teardown", async () => {
		const shutdown = vi.fn(async () => undefined);
		const ctx = context({ shutdown });
		const result = transferToT4Handler({ name: "continue-in-t4", args: "", text: "/continue-in-t4" }, { ctx });
		expect(result).toEqual({ consumed: true });
		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(ctx.editor.setText).toHaveBeenCalledWith("");
		expect(ctx.showStatus).toHaveBeenCalledWith("Continuing in T4…");
		expect(ctx.showWarning).not.toHaveBeenCalled();
	});
});
