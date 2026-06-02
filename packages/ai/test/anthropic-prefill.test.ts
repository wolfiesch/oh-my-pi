import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai/types";

/**
 * Regression: some Anthropic-routed models reject "assistant prefill" requests
 * (messages ending with an assistant turn). We should automatically append a
 * synthetic user message to keep the request valid.
 */
describe("Anthropic assistant-prefill fallback", () => {
	const model: Model<"anthropic-messages"> = {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		name: "Claude 3.5 Sonnet",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	};

	it("appends a user Continue. message when the last turn is assistant", () => {
		const user: UserMessage = {
			role: "user",
			content: "Output JSON",
			timestamp: Date.now(),
		};
		const assistantPrefill: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "{" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const params = convertAnthropicMessages([user, assistantPrefill], model, false);
		expect(params.at(-1)?.role).toBe("user");
		expect(params.at(-1)?.content).toBe("Continue.");
	});

	it("does not append Continue. when the last turn is already user", () => {
		const params = convertAnthropicMessages(
			[
				{ role: "user", content: "hi", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
				{ role: "user", content: "what now?", timestamp: Date.now() },
			],
			model,
			false,
		);
		expect(params.at(-1)?.role).toBe("user");
		expect(params.at(-1)?.content).toBe("what now?");
	});

	it("coalesces parallel tool results into one user message", () => {
		const user: UserMessage = {
			role: "user",
			content: "Check weather and time.",
			timestamp: 1,
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "toolu_weather", name: "get_weather", arguments: { city: "Paris" } },
				{ type: "toolCall", id: "toolu_time", name: "get_time", arguments: { timezone: "Europe/Paris" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const weatherResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_weather",
			toolName: "get_weather",
			content: [{ type: "text", text: "clear" }],
			isError: false,
			timestamp: 3,
		};
		const timeResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_time",
			toolName: "get_time",
			content: [{ type: "text", text: "09:00" }],
			isError: false,
			timestamp: 4,
		};

		const params = convertAnthropicMessages([user, assistant, weatherResult, timeResult], model, false);
		const resultParam = params[2];
		expect(params.map(param => param.role)).toEqual(["user", "assistant", "user"]);
		expect(Array.isArray(resultParam?.content)).toBe(true);
		const blocks = resultParam?.content as unknown as Array<Record<string, unknown>>;
		expect(blocks.map(block => block.type)).toEqual(["tool_result", "tool_result"]);
		expect(blocks.map(block => block.tool_use_id)).toEqual(["toolu_weather", "toolu_time"]);
	});

	it("preserves unsigned thinking for custom non-signing Anthropic-compatible endpoints", () => {
		const customDeepseekModel: Model<"anthropic-messages"> = {
			...model,
			provider: "anthropic",
			baseUrl: "https://api.deepseek.com/anthropic",
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro via Anthropic-compatible custom endpoint",
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "provider-native reasoning" }],
			api: "anthropic-messages",
			provider: "deepseek",
			model: customDeepseekModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};

		const params = convertAnthropicMessages(
			[{ role: "user", content: "continue", timestamp: 1 }, assistant],
			customDeepseekModel,
			false,
		);
		const assistantParam = params.find(param => param.role === "assistant");
		expect(assistantParam).toBeDefined();
		const blocks = assistantParam?.content as unknown as Array<Record<string, unknown>>;
		expect(blocks[0]).toEqual({
			type: "thinking",
			thinking: "provider-native reasoning",
			signature: "",
		});
	});
});

it("preserves redacted thinking blocks in assistant replay payloads", () => {
	const model: Model<"anthropic-messages"> = {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		name: "Claude 3.5 Sonnet",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	};
	const user: UserMessage = {
		role: "user",
		content: "continue",
		timestamp: Date.now(),
	};
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
			{ type: "redactedThinking", data: "encrypted_payload" },
			{ type: "text", text: "Final answer" },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const params = convertAnthropicMessages([user, assistant], model, false);
	const assistantParam = params.find(m => m.role === "assistant");
	expect(assistantParam).toBeDefined();
	expect(Array.isArray(assistantParam?.content)).toBe(true);
	const blocks = assistantParam?.content as unknown as Array<Record<string, unknown>>;
	expect(blocks.map(block => block.type)).toEqual(["thinking", "redacted_thinking", "text"]);
	expect(blocks[0]?.signature).toBe("sig_1");
	expect(blocks[1]?.data).toBe("encrypted_payload");
});

it("preserves latest Anthropic thinking blocks even when model id changes", () => {
	const model: Model<"anthropic-messages"> = {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		name: "Claude 3.5 Sonnet",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	};
	const switchedModel: Model<"anthropic-messages"> = { ...model, id: "claude-opus-4-6-20251201" };
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "internal", thinkingSignature: "sig_2" },
			{ type: "redactedThinking", data: "encrypted_payload_2" },
			{ type: "text", text: "Answer" },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6-20251201",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const transformed = transformMessages(
		[{ role: "user", content: "continue", timestamp: Date.now() }, assistant],
		switchedModel,
	);
	const transformedAssistant = transformed.find(m => m.role === "assistant") as AssistantMessage | undefined;
	expect(transformedAssistant).toBeDefined();
	expect(transformedAssistant?.content[0]).toEqual(assistant.content[0]);
	expect(transformedAssistant?.content[1]).toEqual(assistant.content[1]);
});

it("strips invalid thinking signatures from aborted Anthropic replay messages", () => {
	const model: Model<"anthropic-messages"> = {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		name: "Claude 3.5 Sonnet",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	};
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "partial reasoning", thinkingSignature: "sig_partial" },
			{ type: "text", text: "partial answer" },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		timestamp: Date.now(),
	};

	const transformed = transformMessages(
		[{ role: "user", content: "continue", timestamp: Date.now() }, assistant],
		model,
	);
	const transformedAssistant = transformed.find(m => m.role === "assistant") as AssistantMessage | undefined;

	expect(transformedAssistant).toBeDefined();
	const thinkingBlock = transformedAssistant?.content[0];
	expect(thinkingBlock).toMatchObject({ type: "thinking", thinking: "partial reasoning" });
	expect(
		thinkingBlock && "thinkingSignature" in thinkingBlock ? thinkingBlock.thinkingSignature : undefined,
	).toBeUndefined();
});
