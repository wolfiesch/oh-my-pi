import { describe, expect, test } from "bun:test";
import { TranscriptEventTranslator } from "../src/transcript-events.ts";

describe("appserver transcript event translator", () => {
	test("maps one assistant/tool turn into stable dot events", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		const events = [
			...translator.translate({ type: "turn_start" }),
			...translator.translate({ type: "message_start", message: { role: "assistant", content: [] } }),
			...translator.translate({
				type: "message_update",
				message: {
					role: "assistant",
					timestamp: 10,
					content: [
						{ type: "thinking", thinking: "plan" },
						{ type: "text", text: "hello" },
					],
				},
			}),
			...translator.translate({
				type: "message_update",
				message: {
					role: "assistant",
					timestamp: 10,
					content: [
						{ type: "thinking", thinking: "plan" },
						{ type: "text", text: "hello" },
					],
				},
			}),
			...translator.translate({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "read",
				args: { path: "x" },
			}),
			...translator.translate({ type: "tool_execution_update", toolCallId: "call-1", partialResult: "working" }),
			...translator.translate({
				type: "tool_execution_end",
				toolCallId: "call-1",
				isError: false,
				result: { content: [{ type: "text", text: "done" }] },
			}),
			...translator.translate({
				type: "tool_execution_end",
				toolCallId: "call-1",
				isError: false,
				result: { content: [{ type: "text", text: "duplicate" }] },
			}),
			...translator.translate({
				type: "message_end",
				message: {
					role: "assistant",
					timestamp: 10,
					content: [
						{ type: "thinking", thinking: "plan" },
						{ type: "text", text: "hello" },
					],
				},
			}),
			...translator.translate({ type: "turn_end" }),
		];

		expect(events.map(event => event.type)).toEqual([
			"turn.start",
			"message.update",
			"tool.start",
			"tool.progress",
			"tool.result",
			"turn.end",
		]);
		const message = events.find(event => event.type === "message.update");
		expect(message).toMatchObject({
			entryId: "assistant:1",
			role: "assistant",
			text: "hello",
			reasoning: "plan",
			at: "1970-01-01T00:00:00.010Z",
		});
		const toolStart = events.find(event => event.type === "tool.start");
		expect(toolStart).toMatchObject({
			callId: "call-1",
			tool: "read",
			title: "read",
			args: { path: "x" },
			at: "1970-01-01T00:00:00.099Z",
		});
		expect(events.filter(event => event.type === "tool.result")).toHaveLength(1);
	});

	test("drops meta and future frames and does not let durable entries duplicate final state", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		translator.translate({ type: "turn_start" });
		translator.translate({ type: "message_start", message: { role: "assistant", content: [] } });
		translator.translate({
			type: "message_update",
			message: { role: "assistant", timestamp: 10, content: [{ type: "text", text: "done" }] },
		});
		translator.translate({
			type: "message_end",
			message: { role: "assistant", timestamp: 10, content: [{ type: "text", text: "done" }] },
		});
		translator.observeSessionEntry({
			type: "message",
			id: "durable-1",
			message: { role: "assistant", timestamp: 10, content: [{ type: "text", text: "done" }] },
		});
		expect(
			translator.translate({
				type: "message_end",
				message: { role: "assistant", timestamp: 10, content: [{ type: "text", text: "done" }] },
			}),
		).toEqual([]);
		expect(translator.translate({ type: "prompt_result", agentInvoked: true })).toEqual([]);
		expect(translator.translate({ type: "future_frame", payload: "ignored" })).toEqual([]);
	});
	test("maps RPC extension UI requests and resolves the matching pending kind", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		const select = translator.translate({
			type: "extension_ui_request",
			id: "ask-1",
			method: "select",
			title: "Pick",
			options: ["one", "two"],
		});
		const input = translator.translate({ type: "extension_ui_request", id: "ask-2", method: "input", title: "Name" });
		const confirm = translator.translate({
			type: "extension_ui_request",
			id: "approval-1",
			method: "confirm",
			title: "Allow",
			message: "Run it?",
		});
		expect(select[0]).toMatchObject({
			type: "ask.request",
			askId: "ask-1",
			question: "Pick",
			options: [
				{ id: "one", label: "one" },
				{ id: "two", label: "two" },
			],
			allowText: false,
			responseKind: "value",
			source: "rpc-ui",
			at: "1970-01-01T00:00:00.099Z",
		});
		expect(input[0]).toMatchObject({
			type: "ask.request",
			askId: "ask-2",
			question: "Name",
			allowText: true,
			responseKind: "value",
			source: "rpc-ui",
			at: "1970-01-01T00:00:00.099Z",
		});
		expect(confirm[0]).toMatchObject({
			type: "approval.request",
			approvalId: "approval-1",
			title: "Allow",
			message: "Run it?",
			responseKind: "confirmed",
			source: "rpc-ui",
			at: "1970-01-01T00:00:00.099Z",
		});
		expect(translator.pendingUiRequests()).toEqual([
			{ id: "ask-1", kind: "ask" },
			{ id: "ask-2", kind: "ask" },
			{ id: "approval-1", kind: "approval" },
		]);
		expect(translator.pendingUiRequest("ask-1")).toEqual({ id: "ask-1", kind: "ask" });
		expect(translator.resolveUiRequest("ask-1")).toEqual({
			type: "ask.resolved",
			askId: "ask-1",
			at: "1970-01-01T00:00:00.099Z",
		});
		expect(translator.resolveUiRequest("ask-1")).toBeUndefined();
		expect(
			translator.translate({
				type: "extension_ui_request",
				id: "cancel-1",
				method: "cancel",
				targetId: "approval-1",
			}),
		).toMatchObject([{ type: "approval.resolved", approvalId: "approval-1", at: "1970-01-01T00:00:00.099Z" }]);
		expect(
			translator.translate({ type: "extension_ui_request", id: "notify-1", method: "notify", message: "ignored" }),
		).toEqual([]);
	});
	test("falls back instead of throwing for timestamps outside the Date range", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		const events = translator.translate({
			type: "message_start",
			message: {
				role: "assistant",
				timestamp: Number.MAX_VALUE,
				content: [{ type: "text", text: "safe" }],
			},
		});
		expect(events[0]).toMatchObject({ type: "message.update", at: "1970-01-01T00:00:00.099Z" });
		const invalidClock = new TranscriptEventTranslator(() => Number.POSITIVE_INFINITY);
		expect(invalidClock.translate({ type: "turn_start" })).toEqual([
			{ type: "turn.start", at: "1970-01-01T00:00:00.000Z" },
		]);
	});
	test("dedupes timestamp-less repeated snapshots with stable active start time", () => {
		let now = 100;
		const translator = new TranscriptEventTranslator(() => now);
		translator.translate({ type: "message_start", message: { role: "assistant", content: [] } });
		const first = translator.translate({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "same" }] },
		});
		now = 200;
		const duplicate = translator.translate({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "same" }] },
		});
		expect(first[0]).toMatchObject({ at: "1970-01-01T00:00:00.100Z" });
		expect(duplicate).toEqual([]);
	});
});
