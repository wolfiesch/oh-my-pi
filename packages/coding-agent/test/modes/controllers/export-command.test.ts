import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

const OSC8 = /\x1b\]8;[^;]*;([^\x1b\x07]+)(?:\x1b\\|\x07)/;

describe("CommandController /export", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		Settings.instance.override("tui.hyperlinks", "always");
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("hyperlinks the exported HTML file path in the status message", async () => {
		const showStatus = vi.fn();
		const exportToHtml = vi.fn().mockResolvedValue("/tmp/session-export.html");
		const openInBrowser = vi.fn();

		const ctx = {
			session: {
				exportToHtml,
			},
			showStatus,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;

		const controller = new CommandController(ctx);
		// Mock openInBrowser on the controller to avoid spawning actual processes
		vi.spyOn(controller, "openInBrowser").mockImplementation(openInBrowser);

		await controller.handleExportCommand("/export");

		expect(exportToHtml).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledTimes(1);

		const statusMessage = showStatus.mock.calls[0]?.[0] as string;
		expect(statusMessage).toContain("Session exported to:");
		expect(statusMessage).toMatch(OSC8);
		expect(statusMessage).toContain("session-export.html");
	});
});
