import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CompactionCancelledError, type CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance, type Theme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Container, Spacer } from "@oh-my-pi/pi-tui";

/**
 * Contract under test: `CommandController.executeCompaction` must not leak
 * transient UI across either terminal state.
 *
 *  - A cancelled compaction (session.compact rejects with the real
 *    CompactionCancelledError the code branches on) must leave the chat
 *    transcript byte-for-byte as it was — no orphan Spacer pushed into
 *    chatContainer — and must drain the status container's loader.
 *  - A successful compaction must drain the status container's loader once it
 *    resolves.
 *
 * Exercised only through the public `executeCompaction` entrypoint with real
 * in-memory Container instances and a session stub whose `compact()` outcome we
 * drive.
 */
function buildCtx(compact: InteractiveModeContext["session"]["compact"], opts?: { sessionCompacting?: boolean }) {
	const chatContainer = new Container();
	const statusContainer = new Container();
	// Pre-existing transcript content. The regression we defend leaked an extra
	// Spacer into this container on the cancel path, so we seed it with real
	// children and require the count to survive the call untouched.
	chatContainer.addChild(new Spacer(1));
	chatContainer.addChild(new Spacer(1));

	// Record the status container's state at the instant the transcript rebuild
	// runs, so a test can prove cleanup happens BEFORE the rebuild (the fix) and
	// not merely in the finally that runs after it.
	let statusChildrenAtRebuild: number | undefined;
	const rebuildChatFromMessages = vi.fn(() => {
		statusChildrenAtRebuild = statusContainer.children.length;
	});
	const showError = vi.fn();
	const showWarning = vi.fn();
	const refreshTerminalTitle = vi.fn();
	const ctx = {
		loadingAnimation: undefined,
		compactionLoader: undefined,
		chatContainer,
		statusContainer,
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		session: { compact, isCompacting: opts?.sessionCompacting ?? false },
		viewSession: { isCompacting: false },
		rebuildChatFromMessages,
		refreshTerminalTitle,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		showError,
		showWarning,
		flushCompactionQueue: vi.fn(async () => undefined),
		// executeCompaction consults display.collapseCompacted on the ok path to
		// decide whether the rebuild replaces the terminal transcript.
		settings: { get: vi.fn(() => true) },
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		chatContainer,
		statusContainer,
		rebuildChatFromMessages,
		refreshTerminalTitle,
		showError,
		showWarning,
		statusAtRebuild: () => statusChildrenAtRebuild,
	};
}

describe("executeCompaction UI lifecycle", () => {
	let priorTheme: Theme | undefined;

	beforeAll(async () => {
		// The compacting Loader colorizes through the active theme on construction.
		// Capture the prior global theme first so afterAll can restore it and not
		// couple later suites sharing this process to our dark override.
		priorTheme = theme;
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("Expected dark theme");
		setThemeInstance(dark);
	});

	afterAll(() => {
		if (priorTheme) setThemeInstance(priorTheme);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("refreshes the terminal title while the manual compaction loader is active", async () => {
		let ctx: InteractiveModeContext | undefined;
		let refreshTerminalTitle: { mock: { calls: unknown[][] } } | undefined;
		let loaderDuringCompact: unknown;
		let refreshCountDuringCompact = 0;
		const compact = vi.fn(async (): Promise<CompactionResult<unknown>> => {
			if (!ctx || !refreshTerminalTitle) throw new Error("Expected context");
			loaderDuringCompact = ctx.compactionLoader;
			refreshCountDuringCompact = refreshTerminalTitle.mock.calls.length;
			return { summary: "", firstKeptEntryId: "", tokensBefore: 0 };
		});
		const built = buildCtx(compact);
		ctx = built.ctx;
		refreshTerminalTitle = built.refreshTerminalTitle;

		const controller = new CommandController(ctx);
		const outcome = await controller.executeCompaction();

		expect(outcome).toBe("ok");
		expect(loaderDuringCompact).toBeDefined();
		expect(refreshCountDuringCompact).toBe(1);
		expect(ctx.compactionLoader).toBeUndefined();
		expect(built.refreshTerminalTitle).toHaveBeenCalledTimes(2);
	});

	it("leaves the transcript untouched and drains the loader when compaction is cancelled", async () => {
		const compact = vi.fn(async () => {
			throw new CompactionCancelledError();
		});
		const { ctx, chatContainer, statusContainer, rebuildChatFromMessages, showError } = buildCtx(compact);
		const childrenBefore = chatContainer.children.length;

		const controller = new CommandController(ctx);
		const outcome = await controller.executeCompaction();

		expect(outcome).toBe("cancelled");
		// No orphan Spacer leaked into the chat transcript on the cancel path.
		expect(chatContainer.children).toHaveLength(childrenBefore);
		// The compacting loader was removed from the status container.
		expect(statusContainer.children).toHaveLength(0);
		// Proof the cancel branch ran instead of the success branch.
		expect(showError).toHaveBeenCalledWith("Compaction cancelled");
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
	});

	it("drains the loader after a successful compaction resolves", async () => {
		const compact = vi.fn(
			async (): Promise<CompactionResult<unknown>> => ({ summary: "", firstKeptEntryId: "", tokensBefore: 0 }),
		);
		const { ctx, statusContainer, rebuildChatFromMessages, statusAtRebuild } = buildCtx(compact);

		const controller = new CommandController(ctx);
		const outcome = await controller.executeCompaction();

		expect(outcome).toBe("ok");
		// Status container is empty once compaction resolves.
		expect(statusContainer.children).toHaveLength(0);
		// Proof the success branch ran (rebuild happens only on the ok path).
		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		// The loader was drained BEFORE the transcript rebuild, not only by the
		// finally that runs afterward: the status container was already empty at
		// the instant rebuildChatFromMessages ran (1 leaked loader without the fix).
		expect(statusAtRebuild()).toBe(0);
	});

	it("stops and releases a stale compaction loader before installing a new one", async () => {
		const compact = vi.fn(
			async (): Promise<CompactionResult<unknown>> => ({ summary: "", firstKeptEntryId: "", tokensBefore: 0 }),
		);
		const { ctx } = buildCtx(compact);
		const staleStop = vi.fn();
		// A loader left behind by an aborted flow: no compaction is running, so
		// executeCompaction must reclaim ownership instead of leaking its ticker.
		const staleLoader = { stop: staleStop } as unknown as InteractiveModeContext["compactionLoader"];
		ctx.compactionLoader = staleLoader;

		const controller = new CommandController(ctx);
		const outcome = await controller.executeCompaction();

		expect(outcome).toBe("ok");
		expect(staleStop).toHaveBeenCalledTimes(1);
		expect(compact).toHaveBeenCalledTimes(1);
		expect(ctx.compactionLoader).toBeUndefined();
	});

	it("rejects a second compaction while an active one owns the loader", async () => {
		const compact = vi.fn(
			async (): Promise<CompactionResult<unknown>> => ({ summary: "", firstKeptEntryId: "", tokensBefore: 0 }),
		);
		const { ctx, showWarning } = buildCtx(compact, { sessionCompacting: true });
		const activeStop = vi.fn();
		const activeLoader = { stop: activeStop } as unknown as InteractiveModeContext["compactionLoader"];
		ctx.compactionLoader = activeLoader;

		const controller = new CommandController(ctx);
		const outcome = await controller.executeCompaction();

		expect(outcome).toBe("failed");
		expect(showWarning).toHaveBeenCalledWith("Compaction already in progress.");
		// The in-flight compaction keeps its loader: not stopped, not replaced.
		expect(activeStop).not.toHaveBeenCalled();
		expect(ctx.compactionLoader).toBe(activeLoader);
		expect(compact).not.toHaveBeenCalled();
	});
});
