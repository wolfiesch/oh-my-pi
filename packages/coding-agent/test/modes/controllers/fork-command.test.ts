import { beforeAll, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createForkContext() {
	const events: string[] = [];
	const sourceSessionFile = "/tmp/source-session.jsonl";
	const forkedSessionFile = "/tmp/forked-session.jsonl";
	const session = {
		isStreaming: false,
		sessionFile: sourceSessionFile,
		fork: vi.fn(async () => {
			session.sessionFile = forkedSessionFile;
			return true;
		}),
	};
	const ctx = {
		session,
		sessionManager: {
			getSessionId: () => "forked-session",
			getSessionFile: () => session.sessionFile,
			getSessionDir: () => undefined,
			getCwd: () => "/tmp/project",
		},
		loadingAnimation: undefined,
		statusContainer: { clear: vi.fn(), disposeChildren: vi.fn() },
		showWarning: vi.fn(),
		showError: vi.fn(),
		statusLine: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		rebuildChatFromMessages: vi.fn(() => {
			events.push(`rebuild:${session.sessionFile}`);
		}),
		present: vi.fn(() => {
			events.push("present");
		}),
	} as unknown as InteractiveModeContext;
	return { ctx, events, forkedSessionFile };
}

describe("CommandController /fork", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("rebuilds transcript links before presenting the fork card", async () => {
		const { ctx, events, forkedSessionFile } = createForkContext();
		const controller = new CommandController(ctx);

		await controller.handleForkCommand();

		expect(ctx.session.fork).toHaveBeenCalled();
		expect(ctx.rebuildChatFromMessages).toHaveBeenCalled();
		expect(ctx.present).toHaveBeenCalled();
		expect(events).toEqual([`rebuild:${forkedSessionFile}`, "present"]);
		expect(ctx.showError).not.toHaveBeenCalled();
	});
});
