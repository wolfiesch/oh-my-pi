import { describe, expect, it } from "bun:test";
import { ConfigValidationError, validateConfigEdit } from "@oh-my-pi/pi-coding-agent/home/config-service";

describe("home config validation", () => {
	it("accepts known setting values that match schema types", () => {
		validateConfigEdit("modelRoles", { default: "anthropic/claude-opus-4-8:high" });
		validateConfigEdit("cycleOrder", ["smol", "default", "slow"]);
		validateConfigEdit("tools.approvalMode", "write");
		validateConfigEdit("autoResume", false);
	});

	it("accepts record child paths used by focused editors", () => {
		validateConfigEdit("modelRoles.default", "anthropic/claude-opus-4-8:high");
		validateConfigEdit("task.agentModelOverrides.reviewer", "openai-codex/gpt-5.5:xhigh");
		validateConfigEdit("modelRoles.default", undefined);
	});

	it("rejects unknown paths before writes", () => {
		expect(() => validateConfigEdit("not.a.setting", true)).toThrow(ConfigValidationError);
	});

	it("rejects values that would change the persisted YAML type", () => {
		expect(() => validateConfigEdit("cycleOrder", ["smol", 123])).toThrow(/expected string array/);
		expect(() => validateConfigEdit("modelRoles", ["smol"])).toThrow(/expected a record/);
		expect(() => validateConfigEdit("tools.approvalMode", "sometimes")).toThrow(/must be one of/);
		expect(() => validateConfigEdit("autoResume", "false")).toThrow(/expected boolean/);
		expect(() => validateConfigEdit("retry.maxRetries", "3")).toThrow(/expected number/);
		expect(() => validateConfigEdit("modelRoles.default", ["smol"])).toThrow(/expected string/);
	});
});
