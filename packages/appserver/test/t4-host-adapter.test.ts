import { describe, expect, test } from "bun:test";
import { appserverSupportedFeatures, createAppserver } from "@oh-my-pi/appserver";

describe("T4 host adapter", () => {
	test("re-exports the T4 host and its transcript paging feature", () => {
		expect(typeof createAppserver).toBe("function");
		expect(
			appserverSupportedFeatures({
				discovery: {
					list: async () => [],
					page: async () => ({ entries: [], generation: "test", hasMore: false }),
				},
			}),
		).toContain("transcript.page");
	});
});
