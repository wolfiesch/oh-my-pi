import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcOperationMessageOwnership } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcOperationManager } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-operations";
import type {
	RpcOperationStartedFrame,
	RpcOperationTerminalFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

describe("RpcOperationManager", () => {
	test("emits started at begin and exactly one terminal settlement", () => {
		const frames: Array<RpcOperationStartedFrame | RpcOperationTerminalFrame> = [];
		let now = 10;
		const manager = new RpcOperationManager(
			frame => frames.push(frame),
			() => "operation-1",
			() => ++now,
		);
		const operation = manager.start("request-1", "prompt");

		expect(frames).toEqual([]);
		expect(manager.begin(operation)).toBe(true);
		expect(manager.complete(operation, true)).toBe(true);
		expect(manager.fail(operation, new Error("late failure"))).toBe(false);
		expect(manager.complete(operation, false)).toBe(false);
		expect(frames.map(frame => frame.type)).toEqual(["operation_started", "operation_completed"]);
		expect(frames[1]).toMatchObject({
			operationId: "operation-1",
			requestId: "request-1",
			command: "prompt",
			agentInvoked: true,
		});
	});

	test("targeted cancellation is authoritative and idempotent across races", () => {
		const frames: Array<RpcOperationStartedFrame | RpcOperationTerminalFrame> = [];
		let sequence = 0;
		const manager = new RpcOperationManager(
			frame => frames.push(frame),
			() => `operation-${++sequence}`,
			() => 100,
		);
		const first = manager.start("request-1", "prompt");
		const second = manager.start("request-2", "prompt");
		manager.begin(first);

		const initial = manager.cancel(first.operationId);
		const repeated = manager.cancel(first.operationId);

		expect(initial.wasStarted).toBe(true);
		expect(initial.result).toEqual(repeated.result);
		expect(initial.result.status).toBe("cancelled");
		expect(manager.complete(first, true)).toBe(false);
		expect(manager.isActive(second)).toBe(true);
		expect(frames.filter(frame => frame.type === "operation_cancelled")).toHaveLength(1);
	});

	test("cancelling a queued follow-up never aborts the active operation", async () => {
		const frames: Array<RpcOperationStartedFrame | RpcOperationTerminalFrame> = [];
		let sequence = 0;
		const manager = new RpcOperationManager(
			frame => frames.push(frame),
			() => `operation-${++sequence}`,
			() => 100,
		);
		const active = manager.start("request-active", "prompt");
		const followUp = manager.start("request-follow-up", "prompt");
		manager.begin(active);
		manager.begin(followUp);

		const activeMessage: AgentMessage = { role: "user", content: "active", timestamp: 1 };
		const tags = new WeakMap<AgentMessage, string>([[activeMessage, active.operationId]]);
		const queuedTags = [followUp.operationId, "unrelated-operation"];
		let abortCount = 0;
		const ownership = new RpcOperationMessageOwnership({
			getMessageTag: message => tags.get(message),
			removeQueuedMessagesByTag: tag => {
				const index = queuedTags.indexOf(tag);
				if (index === -1) return 0;
				queuedTags.splice(index, 1);
				return 1;
			},
			abort: async () => {
				abortCount++;
			},
		});
		ownership.observeMessageStart(activeMessage);

		const followUpCancellation = await ownership.cancel(manager, followUp.operationId);
		expect(followUpCancellation.status).toBe("cancelled");
		expect(abortCount).toBe(0);
		expect(queuedTags).toEqual(["unrelated-operation"]);
		expect(manager.isActive(active)).toBe(true);

		const activeCancellation = await ownership.cancel(manager, active.operationId);
		expect(activeCancellation.status).toBe("cancelled");
		expect(abortCount).toBe(1);
		expect(frames.filter(frame => frame.type === "operation_cancelled")).toEqual([
			expect.objectContaining({ operationId: followUp.operationId }),
			expect.objectContaining({ operationId: active.operationId }),
		]);
	});

	test("an untagged message start clears stale active operation ownership", async () => {
		const manager = new RpcOperationManager(
			() => {},
			() => "operation-active",
		);
		const operation = manager.start("request-active", "prompt");
		manager.begin(operation);
		const tagged: AgentMessage = { role: "user", content: "tagged", timestamp: 1 };
		const untagged: AgentMessage = { role: "user", content: "untagged", timestamp: 2 };
		let abortCount = 0;
		const ownership = new RpcOperationMessageOwnership({
			getMessageTag: message => (message === tagged ? operation.operationId : undefined),
			removeQueuedMessagesByTag: () => 0,
			abort: async () => {
				abortCount++;
			},
		});

		ownership.observeMessageStart(tagged);
		ownership.observeMessageStart(untagged);
		expect((await ownership.cancel(manager, operation.operationId)).status).toBe("cancelled");
		expect(abortCount).toBe(0);
	});

	test("snapshot retains bounded recent outcomes and distinguishes accepted from started", () => {
		let sequence = 0;
		let now = 0;
		const manager = new RpcOperationManager(
			() => {},
			() => `operation-${++sequence}`,
			() => ++now,
		);
		const accepted = manager.start(undefined, "prompt");
		const started = manager.start(undefined, "abort_and_prompt");
		manager.begin(started);
		for (let index = 0; index < 130; index++) {
			const operation = manager.start(undefined, "prompt");
			manager.complete(operation, false);
		}

		const snapshot = manager.snapshot();
		expect(snapshot.active).toEqual([
			expect.objectContaining({ operationId: accepted.operationId, status: "accepted" }),
			expect.objectContaining({ operationId: started.operationId, status: "started" }),
		]);
		expect(snapshot.recent).toHaveLength(128);
	});
});
