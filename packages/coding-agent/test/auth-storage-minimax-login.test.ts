import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { hookFetch, Snowflake } from "@oh-my-pi/pi-utils";

describe("AuthStorage MiniMax login", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let currentApiKey = "sk-old";

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-auth-minimax-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	test("replaces existing MiniMax OpenAI-compatible Token Plan API key on relogin", async () => {
		using _hook = hookFetch(
			() => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
		);

		const loginCallbacks = {
			onAuth: () => {},
			onPrompt: async () => currentApiKey,
		};

		await authStorage.login("minimax-code", loginCallbacks);
		currentApiKey = "sk-new";
		await authStorage.login("minimax-code", loginCallbacks);

		expect(authStorage.get("minimax-code")).toEqual({
			type: "api_key",
			key: "sk-new",
		});
		expect(authStorage.get("minimax")).toEqual({
			type: "api_key",
			key: "sk-new",
		});
		expect(authStorage.getAll()["minimax-code"]).toEqual({
			type: "api_key",
			key: "sk-new",
		});
	});

	test("MiniMax CN OpenAI-compatible login also unlocks the Anthropic Token Plan provider", async () => {
		using _hook = hookFetch(
			() => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
		);

		await authStorage.login("minimax-code-cn", {
			onAuth: () => {},
			onPrompt: async () => "sk-cn",
		});

		expect(authStorage.get("minimax-code-cn")).toEqual({
			type: "api_key",
			key: "sk-cn",
		});
		expect(authStorage.get("minimax-cn")).toEqual({
			type: "api_key",
			key: "sk-cn",
		});
		expect(await authStorage.getApiKey("minimax-cn")).toBe("sk-cn");
	});

	test("MiniMax CN Token Plan login validates the Anthropic endpoint", async () => {
		const validationUrls: string[] = [];
		let validationBody = "";
		using _hook = hookFetch((input, init) => {
			validationUrls.push(String(input));
			validationBody = String(init?.body ?? "");
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		});

		await authStorage.login("minimax-cn", {
			onAuth: () => {},
			onPrompt: async () => "sk-cn",
		});

		expect(validationUrls).toEqual(["https://api.minimaxi.com/anthropic/v1/messages"]);
		expect(JSON.parse(validationBody)).toMatchObject({ model: "MiniMax-M3", max_tokens: 1 });
		expect(authStorage.get("minimax-cn")).toEqual({
			type: "api_key",
			key: "sk-cn",
		});
		expect(authStorage.get("minimax-code-cn")).toEqual({
			type: "api_key",
			key: "sk-cn",
		});
		expect(await authStorage.getApiKey("minimax-code-cn")).toBe("sk-cn");
	});
});
