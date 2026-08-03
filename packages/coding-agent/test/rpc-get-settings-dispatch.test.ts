import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, readJsonl, removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Drives `get_settings` through the real RPC server.
 *
 * The other tests stop short of the server: `rpc-get-settings.test.ts` calls
 * `handleGetSettings()` directly and the client test talks to a mock agent that
 * accepts the command through its own implementation. Deleting the dispatcher's
 * `case "get_settings"` leaves both of those green, so only a round trip over
 * real stdio protects the public wiring.
 */
describe("get_settings over the RPC server", () => {
	test("answers real frames, including malformed tab input, without widening disclosure", async () => {
		// A private agent directory: this command reads configured values, so an
		// inherited config would make the assertions depend on whoever runs them
		// and would print their settings into test output.
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-settings-${Snowflake.next()}-`));
		const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
		const child = Bun.spawn(
			["bun", cliPath, "--mode", "rpc", "--provider", "anthropic", "--model", "claude-sonnet-4-5"],
			{
				cwd: path.join(import.meta.dir, ".."),
				env: { ...Bun.env, PI_NO_TITLE: "1", PI_CODING_AGENT_DIR: agentDir },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		let unscoped: Record<string, unknown> | undefined;
		let scoped: Record<string, unknown> | undefined;
		let invalidTab: Record<string, unknown> | undefined;
		// This bounds a real child-process stream; aborting the read also cancels
		// its reader so the finally block can terminate the child immediately.
		const responseSignal = AbortSignal.timeout(10_000);
		// A parse error or a timeout inside the read loop must not leave the child
		// or its directory behind for the rest of the run.
		try {
			child.stdin.write(`${JSON.stringify({ type: "get_settings", id: "settings-probe" })}\n`);
			child.stdin.write(`${JSON.stringify({ type: "get_settings", id: "tab-probe", tab: "appearance" })}\n`);
			child.stdin.write(
				`${JSON.stringify({ type: "get_settings", id: "invalid-tab-probe", tab: { toString: null } })}\n`,
			);
			await child.stdin.flush();

			for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>, responseSignal)) {
				if (!isRecord(frame) || frame.type !== "response") continue;
				if (frame.id === "settings-probe") unscoped = frame;
				if (frame.id === "tab-probe") scoped = frame;
				if (frame.id === "invalid-tab-probe") invalidTab = frame;
				if (unscoped && scoped && invalidTab) break;
			}
			if (!unscoped || !scoped || !invalidTab) {
				throw new Error("the RPC server did not answer all get_settings probes before the response deadline");
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited.catch(() => {});
			await removeWithRetries(agentDir).catch(() => {});
		}

		expect(unscoped).toMatchObject({ success: true, command: "get_settings" });
		expect(invalidTab).toMatchObject({
			id: "invalid-tab-probe",
			success: false,
			command: "get_settings",
			code: "invalid_request",
			error: 'RPC command field "tab" must be a string',
		});
		interface Entry {
			path: string;
			type: string;
			value?: unknown;
			redacted?: true;
			description?: string;
			ui?: { tab?: string; options?: unknown; ordered?: boolean };
		}
		if (!unscoped) throw new Error("the server never answered the unscoped get_settings frame");
		const data = unscoped.data as {
			settings: Entry[];
			tabs: Array<{ id: string; label: string; icon: string; groups: string[] }>;
		};
		const settings = data.settings;
		expect(settings.length).toBeGreaterThan(0);

		const byPath = new Map(settings.map(entry => [entry.path, entry]));
		// An allowlisted setting arrives with its value.
		expect(byPath.get("tui.tight")).not.toHaveProperty("redacted");
		expect(byPath.get("tui.tight")).toHaveProperty("value");
		// Everything outside the allowlist is withheld, with no value at all.
		expect(byPath.get("auth.broker.token")).toMatchObject({ redacted: true });
		expect(byPath.get("auth.broker.token")).not.toHaveProperty("value");
		// Rendering metadata survives the wire, which is the reason to call this
		// command instead of duplicating the schema.
		expect(byPath.get("theme.dark")?.ui?.options).toBe("runtime");
		expect(byPath.get("providers.webSearchOrder")?.ui?.ordered).toBe(true);
		expect(byPath.get("tui.maxInlineImageColumns")?.description).toContain("inline images");
		expect(data.tabs.find(tab => tab.id === "appearance")).toEqual({
			id: "appearance",
			label: "Appearance",
			icon: "tab.appearance",
			groups: ["Theme", "Status Line", "Display", "Images"],
		});

		// The tab argument reaches the server rather than being dropped.
		expect(scoped).toMatchObject({ success: true });
		if (!scoped) throw new Error("the server never answered the tab-scoped get_settings frame");
		const scopedSettings = (scoped.data as { settings: Entry[] }).settings;
		expect(scopedSettings.length).toBeGreaterThan(0);
		expect(scopedSettings.length).toBeLessThan(settings.length);
		for (const entry of scopedSettings) expect(entry.ui?.tab).toBe("appearance");
	}, 60000);
});
