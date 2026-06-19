import { describe, expect, test } from "bun:test";
import modelsJson from "../src/models.json";

describe("bundled Ollama Cloud catalog", () => {
	test("every bundled Ollama Cloud row omits max output tokens", () => {
		const ollamaCloudModels = Object.values(modelsJson["ollama-cloud"] ?? {});

		expect(ollamaCloudModels.length).toBeGreaterThan(0);
		for (const model of ollamaCloudModels) {
			expect(model.provider).toBe("ollama-cloud");
			expect(model.api).toBe("ollama-chat");
			expect(model.baseUrl).toBe("https://ollama.com");
			expect(model.omitMaxOutputTokens).toBe(true);
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(model.maxTokens).toBeGreaterThan(0);
		}
	});
});
