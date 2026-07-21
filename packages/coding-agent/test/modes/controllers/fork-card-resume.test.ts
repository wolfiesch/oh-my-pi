import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildForkCard, type ForkCard } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const UUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;[^\x1b\x07]*(?:\x1b\\|\x07)/g;

function renderCard(card: ForkCard): string {
	// Render wide so a single resume command is never word-wrapped, strip
	// ANSI/OSC escapes, then collapse whitespace so the assertion matches the
	// logical card text regardless of layout padding.
	const raw = card.components.flatMap(component => component.render(2000)).join(" ");
	return raw.replace(ANSI, "").replace(/\s+/g, " ").trim();
}

describe("buildForkCard", () => {
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

	it("emits a bare-id resume command for a default-managed session", () => {
		const sessionFile = path.join("/home/me/.omp/sessions/project", `2026-01-01T00-00-00_${UUID}.jsonl`);
		const card = buildForkCard({ sessionFile, sessionId: UUID, idResolvable: true });

		expect(card.resumeCommand).toBe(`omp --resume ${UUID}`);
		const rendered = renderCard(card);
		expect(rendered).toContain("Session forked to");
		expect(rendered).toContain(`omp --resume ${UUID}`);
	});

	it("falls back to a POSIX-quoted path when the id is not resolvable", () => {
		const sessionFile = "/tmp/custom sessions/abc.jsonl";
		const card = buildForkCard({ sessionFile, sessionId: UUID, idResolvable: false });

		expect(card.resumeCommand).toBe(`omp --resume '${sessionFile}'`);
		const rendered = renderCard(card);
		expect(rendered).toContain(`omp --resume '${sessionFile}'`);
		expect(rendered).not.toContain(`omp --resume ${UUID}`);
	});

	it("renders a Windows session path with only its basename in the fork label", () => {
		const sessionFile = String.raw`C:\sessions\forked.jsonl`;
		const card = buildForkCard({ sessionFile, sessionId: UUID, idResolvable: true });

		const rendered = renderCard(card);
		expect(rendered).toContain("Session forked to forked.jsonl");
		expect(rendered).not.toContain(sessionFile);
	});

	it("omits the resume line for an in-memory session (no file)", () => {
		const card = buildForkCard({ sessionFile: undefined, sessionId: UUID, idResolvable: false });

		expect(card.resumeCommand).toBeUndefined();
		const rendered = renderCard(card);
		expect(rendered).toContain("Session forked to new session");
		expect(rendered).not.toContain("Resume in another terminal");
	});
});
