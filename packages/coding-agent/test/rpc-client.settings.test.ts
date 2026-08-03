import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { SettingsSnapshot } from "@oh-my-pi/pi-coding-agent/config/settings-snapshot";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

const MOCK_AGENT = path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts");

/** The mock echoes the requested tab so the argument itself can be asserted. */
type MockSnapshot = SettingsSnapshot & { requestedTab: string | null };

/**
 * Exercises the public client method against the mock agent, so the wire shape
 * is covered without provider credentials. The disclosure decision itself is
 * covered by the snapshot tests against the real schema.
 */
describe("RpcClient.getSettings", () => {
	test("round-trips disclosed and redacted entries", async () => {
		using client = new RpcClient({ cliPath: MOCK_AGENT });
		await client.start();

		const snapshot = (await client.getSettings()) as MockSnapshot;
		expect(snapshot.requestedTab).toBeNull();

		const disclosed = snapshot.settings.find(entry => entry.path === "colorBlindMode");
		expect(disclosed?.value).toBe(true);
		expect(disclosed?.configured).toBe(true);
		expect(disclosed?.default).toBe(false);

		const redacted = snapshot.settings.find(entry => entry.path === "auth.broker.token");
		expect(redacted?.redacted).toBe(true);
		expect(redacted).not.toHaveProperty("value");
		expect(redacted).not.toHaveProperty("configured");
	}, 20_000);

	test("sends the requested tab to the server", async () => {
		using client = new RpcClient({ cliPath: MOCK_AGENT });
		await client.start();
		const scoped = (await client.getSettings("appearance")) as MockSnapshot;
		expect(scoped.requestedTab).toBe("appearance");
	}, 20_000);
});
