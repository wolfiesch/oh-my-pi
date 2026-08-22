import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { handleGetSettings } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-get-settings";

/**
 * Covers the command's response plumbing directly. The mock-agent client test
 * cannot catch a missing or wrong case here, and the snapshot tests stop at
 * the builder.
 */
describe("handleGetSettings", () => {
	it("rejects a tab the wire could carry but the schema does not define", () => {
		const hostileObject = {
			toString(): string {
				throw new Error("must not coerce");
			},
		};
		for (const tab of ["appearence", "", 7, null, {}, ["appearance"], hostileObject]) {
			const response = handleGetSettings(Settings.isolated(), "req-3", tab);
			expect(response).toMatchObject({
				id: "req-3",
				command: "get_settings",
				success: false,
				code: "invalid_tab",
			});
		}
	});
});
