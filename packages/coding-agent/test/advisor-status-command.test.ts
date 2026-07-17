import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance, type Theme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AdvisorStats } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { Component } from "@oh-my-pi/pi-tui";

const EMPTY_TOKENS = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
let priorTheme: Theme | undefined;
const EMPTY_MESSAGES = { user: 0, assistant: 0, total: 0 };

function renderStatus(stats: AdvisorStats, formattedStatus: string): Promise<string> {
	let presented: Component[] = [];
	const controller = new CommandController({
		session: {
			getAdvisorStats: () => stats,
			formatAdvisorStatus: () => formattedStatus,
		},
		present: (components: Component[]) => {
			presented = components;
		},
	} as unknown as InteractiveModeContext);

	return controller
		.handleAdvisorStatusCommand()
		.then(() => Bun.stripANSI(presented.flatMap(component => component.render(120)).join("\n")));
}

beforeAll(async () => {
	priorTheme = theme;
	const testTheme = await getThemeByName("dark");
	if (!testTheme) throw new Error("Failed to load dark theme for advisor status test");
	setThemeInstance(testTheme);
});

afterAll(() => {
	if (priorTheme) setThemeInstance(priorTheme);
});

describe("TUI advisor status command", () => {
	it("explains an unmatched automatic activation policy", async () => {
		const rendered = await renderStatus(
			{
				configured: false,
				active: false,
				contextWindow: 0,
				contextTokens: 0,
				tokens: EMPTY_TOKENS,
				cost: 0,
				messages: EMPTY_MESSAGES,
				advisors: [],
			},
			"Advisor is automatic; no rule matches openai/gpt-5.6:high.",
		);

		expect(rendered).toContain("Advisor is automatic; no rule matches openai/gpt-5.6:high.");
	});

	it("preserves the manual session-off status", async () => {
		const rendered = await renderStatus(
			{
				configured: false,
				active: false,
				contextWindow: 0,
				contextTokens: 0,
				tokens: EMPTY_TOKENS,
				cost: 0,
				messages: EMPTY_MESSAGES,
				advisors: [],
			},
			"Advisor is disabled for this session.",
		);

		expect(rendered).toContain("Advisor is disabled for this session.");
	});

	it("shows the selector that activated the advisor", async () => {
		const automaticMatch = "pi/smol:low";
		const rendered = await renderStatus(
			{
				configured: true,
				active: true,
				automaticMatch,
				contextWindow: 0,
				contextTokens: 0,
				tokens: EMPTY_TOKENS,
				cost: 0,
				messages: EMPTY_MESSAGES,
				advisors: [
					{
						name: "default",
						status: "running",
						contextWindow: 0,
						contextTokens: 0,
						tokens: EMPTY_TOKENS,
						cost: 0,
						messages: EMPTY_MESSAGES,
					},
				],
			},
			"Advisor is enabled.",
		);

		expect(rendered).toContain(`Automatic match: ${automaticMatch}`);
	});
});
