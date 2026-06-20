import { describe, expect, test } from "bun:test";
import { modelFamilyToken } from "@oh-my-pi/pi-catalog/identity/family";

describe("mechanism model family tokens", () => {
	test.each([
		["anthropic/claude-opus-4-8", "anthropic"],
		["openai/gpt-5.5", "openai"],
		["google/gemini-3-pro", "gemini"],
		["zai/glm-5.2", "glm"],
		["moonshot/kimi-k2", "kimi"],
		["deepseek/deepseek-v4-pro", "deepseek"],
		["xai/grok-4", ""],
	])("classifies %s as %s", (model, family) => {
		expect(modelFamilyToken(model)).toBe(family);
	});
});
