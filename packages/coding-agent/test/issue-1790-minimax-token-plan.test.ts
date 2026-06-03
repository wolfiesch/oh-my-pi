import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { hookFetch, Snowflake } from "@oh-my-pi/pi-utils";

describe("MiniMax Token Plan catalog availability (issue #1790)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-minimax-token-plan-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	test("a stored CN OpenAI-compatible Token Plan key makes the CN Anthropic M3 SKU selectable", async () => {
		await authStorage.set("minimax-code-cn", { type: "api_key", key: "sk-cn" });

		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));
		const model = registry
			.getAvailable()
			.find(candidate => candidate.provider === "minimax-cn" && candidate.id === "MiniMax-M3");

		expect(model).toMatchObject({
			api: "anthropic-messages",
			provider: "minimax-cn",
			baseUrl: "https://api.minimaxi.com/anthropic",
			contextWindow: 512000,
			maxTokens: 128000,
		});
	});

	test("a CN Anthropic-compatible Token Plan login makes the CN OpenAI-compatible M3 SKU selectable", async () => {
		using _hook = hookFetch(
			() => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		await authStorage.login("minimax-cn", {
			onAuth: () => {},
			onPrompt: async () => "sk-cn",
		});

		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));
		const model = registry
			.getAvailable()
			.find(candidate => candidate.provider === "minimax-code-cn" && candidate.id === "MiniMax-M3");

		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "minimax-code-cn",
			baseUrl: "https://api.minimaxi.com/v1",
			contextWindow: 512000,
			maxTokens: 128000,
		});
	});
});
