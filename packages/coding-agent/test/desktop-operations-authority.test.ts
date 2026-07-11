import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodingAgentDesktopAuthority } from "@oh-my-pi/pi-coding-agent/session/desktop-operations-authority";

const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function authority(): Promise<{ root: string; value: CodingAgentDesktopAuthority }> {
	const root = await mkdtemp(join(process.cwd(), ".desktop-authority-"));
	roots.push(root);
	return {
		root,
		value: new CodingAgentDesktopAuthority({
			sessionManager: {
				getCwd: () => root,
				getSessionId: () => "session-test",
			},
		}),
	};
}

describe("CodingAgentDesktopAuthority", () => {
	test("fails closed for path reads and listings without secure openat", async () => {
		const { value } = await authority();
		await expect(value.filesRead({ path: "../outside.txt" })).rejects.toThrow("secure openat");
		await expect(value.filesList()).rejects.toThrow("secure openat");
		await expect(value.filesDiff({ path: "inside.txt" })).rejects.toThrow("secure openat");
	});

	test("does not inherit provider secrets into bash", async () => {
		const previous = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "sentinel-secret";
		try {
			const { value } = await authority();
			const result = await value.runBash({ command: "printf '%s' \"${OPENAI_API_KEY-}\"" });
			expect(result.output).toBe("");
		} finally {
			if (previous === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previous;
		}
	});

	test("returns honest pre-abort and timeout outcomes", async () => {
		const { value } = await authority();
		const controller = new AbortController();
		controller.abort();
		const cancelled = await value.runBash({ command: "sleep 1", signal: controller.signal });
		expect(cancelled.cancelled).toBe(true);
		const timedOut = await value.runBash({ command: "sleep 1", timeout: 10 });
		expect(timedOut.timedOut).toBe(true);
	});

	test("reports unavailable settings instead of guessing", async () => {
		const { value } = await authority();
		await expect(value.settingsRead()).rejects.toThrow("settings authority unavailable");
		await expect(value.settingsWrite("theme.dark", {})).rejects.toThrow("settings authority unavailable");
	});

	test("projects and validates catalog item schema", async () => {
		const catalog = new CodingAgentDesktopAuthority({
			sessionManager: { getCwd: () => process.cwd(), getSessionId: () => "s" },
			catalogAuthority: { list: () => [
				{ id: "tool-x", kind: "tool", name: "Read", capabilities: ["read"] },
				{ id: "model-x", kind: "model", name: "Model" },
				{ id: "setting-x", kind: "setting", name: "Theme" },
			] },
		});
		expect((await catalog.catalogGet()).items).toHaveLength(3);
		catalog.disconnect();
		const malformed = new CodingAgentDesktopAuthority({
			sessionManager: { getCwd: () => process.cwd(), getSessionId: () => "s" },
			catalogAuthority: { list: () => [{ kind: "tool", name: "missing id" }] },
		});
		await expect(malformed.catalogGet()).rejects.toThrow("required fields");
	});
});
