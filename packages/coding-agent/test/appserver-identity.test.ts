import { describe, expect, test } from "bun:test";
import { getCodingAgentAppserverIdentity } from "@oh-my-pi/pi-coding-agent/cli/appserver-identity";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";

describe("coding-agent appserver identity", () => {
	test("publishes the canonical OMP version and distribution build identity", () => {
		expect(getCodingAgentAppserverIdentity({})).toEqual({
			ompVersion: VERSION,
			ompBuild: "source",
			appserverBuild: "source",
		});
		expect(getCodingAgentAppserverIdentity({ PI_BUNDLED: "true" })).toEqual({
			ompVersion: VERSION,
			ompBuild: "bundled",
			appserverBuild: "bundled",
		});
		expect(getCodingAgentAppserverIdentity({ PI_COMPILED: "true", PI_BUNDLED: "true" })).toEqual({
			ompVersion: VERSION,
			ompBuild: "compiled",
			appserverBuild: "compiled",
		});
		expect(Object.values(getCodingAgentAppserverIdentity({}))).not.toContain("local");
	});
});
