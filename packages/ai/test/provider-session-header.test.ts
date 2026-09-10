/**
 * Console Go routes on `x-opencode-session` and 400s every request without it
 * (`MissingSessionID`), so the `promptCacheSessionHeader` axis declared for
 * `opencode-go` must reach the wire on each transport that provider serves —
 * including requests that disabled prompt caching.
 */
import { describe, expect, it } from "bun:test";
import { buildAnthropicClientOptions } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const SESSION_ID = "session-abc";

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
};

function sseResponse(events: ReadonlyArray<unknown | "[DONE]">): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chatCompletionChunks(): ReadonlyArray<unknown | "[DONE]"> {
	return [
		{
			id: "chatcmpl-session-header",
			object: "chat.completion.chunk",
			created: 0,
			model: "kimi-k3",
			choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
		},
		"[DONE]",
	];
}

function responsesEvents(): ReadonlyArray<unknown | "[DONE]"> {
	return [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", delta: "ok" },
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: 5,
					output_tokens: 1,
					total_tokens: 6,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
}

function capturingFetch(events: ReadonlyArray<unknown | "[DONE]">): {
	fetch: FetchImpl;
	headers: () => Headers;
} {
	let last = new Headers();
	const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
		last = new Headers(init?.headers);
		return sseResponse(events);
	}) as FetchImpl;
	return { fetch: fetchImpl, headers: () => last };
}

describe("opencode-go session header", () => {
	it("rides the chat-completions route", async () => {
		const { fetch, headers } = capturingFetch(chatCompletionChunks());
		const stream = streamOpenAICompletions(getBundledModel<"openai-completions">("opencode-go", "kimi-k3"), context, {
			apiKey: "test-key",
			sessionId: SESSION_ID,
			fetch,
		});
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(headers().get("x-opencode-session")).toBe(SESSION_ID);
	});

	it("rides the chat-completions route with prompt caching disabled", async () => {
		const { fetch, headers } = capturingFetch(chatCompletionChunks());
		const stream = streamOpenAICompletions(getBundledModel<"openai-completions">("opencode-go", "kimi-k3"), context, {
			apiKey: "test-key",
			sessionId: SESSION_ID,
			cacheRetention: "none",
			fetch,
		});
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(headers().get("x-opencode-session")).toBe(SESSION_ID);
	});

	it("rides the responses route", async () => {
		const { fetch, headers } = capturingFetch(responsesEvents());
		const stream = streamOpenAIResponses(
			getBundledModel<"openai-responses">("opencode-go", "deepseek-v4-flash"),
			context,
			{ apiKey: "test-key", sessionId: SESSION_ID, fetch },
		);
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(headers().get("x-opencode-session")).toBe(SESSION_ID);
	});

	it("rides the anthropic-compatible route", () => {
		const { defaultHeaders } = buildAnthropicClientOptions({
			model: getBundledModel<"anthropic-messages">("opencode-go", "minimax-m2.5"),
			apiKey: "test-key",
			promptCacheSessionId: SESSION_ID,
		});

		expect(defaultHeaders["x-opencode-session"]).toBe(SESSION_ID);
	});

	it("stays off providers that do not declare the axis", async () => {
		const { fetch, headers } = capturingFetch(chatCompletionChunks());
		const stream = streamOpenAICompletions(
			getBundledModel<"openai-completions">("openrouter", "moonshotai/kimi-k2"),
			context,
			{ apiKey: "test-key", sessionId: SESSION_ID, fetch },
		);
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(headers().get("x-opencode-session")).toBeNull();
	});
});
