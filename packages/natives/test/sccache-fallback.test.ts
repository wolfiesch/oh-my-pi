import { describe, expect, it } from "bun:test";
import { shouldRetryNapiBuildWithoutSccache } from "../scripts/sccache-fallback";

const probe = (overrides: Partial<Parameters<typeof shouldRetryNapiBuildWithoutSccache>[0]> = {}) => ({
	exitCode: 101,
	rustcWrapper: "sccache",
	stdout: "",
	stderr: "",
	...overrides,
});

describe("native build sccache fallback", () => {
	it("recognizes sccache startup failures from either output stream", () => {
		expect(
			shouldRetryNapiBuildWithoutSccache(
				probe({
					stdout: "sccache: error: Timed out waiting for server startup. Maybe the remote service is unreachable?",
				}),
			),
		).toBe(true);
		expect(
			shouldRetryNapiBuildWithoutSccache(
				probe({ stderr: "sccache: error: cache storage failed: failed to lookup address information" }),
			),
		).toBe(true);
	});

	it("does not hide compiler failures or retry outside the sccache path", () => {
		expect(shouldRetryNapiBuildWithoutSccache(probe({ stderr: "error[E0308]: mismatched types" }))).toBe(false);
		expect(
			shouldRetryNapiBuildWithoutSccache(
				probe({ rustcWrapper: undefined, stderr: "sccache: error: Timed out waiting for server startup" }),
			),
		).toBe(false);
		expect(
			shouldRetryNapiBuildWithoutSccache(
				probe({ exitCode: 0, stdout: "sccache: error: stale diagnostic from an earlier command" }),
			),
		).toBe(false);
	});
});
