import { describe, expect, test } from "bun:test";
import { RpcOperationManager } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-operations";
import type { RpcOperationTerminalFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

describe("RpcOperationManager", () => {
	test("emits exactly one correlated terminal frame", () => {
		const frames: RpcOperationTerminalFrame[] = [];
		const manager = new RpcOperationManager(
			frame => frames.push(frame),
			() => "operation-1",
		);
		const operation = manager.start("request-1", "prompt");

		expect(manager.complete(operation, true)).toBe(true);
		expect(manager.fail(operation, new Error("late failure"))).toBe(false);
		expect(manager.complete(operation, false)).toBe(false);
		expect(manager.activeCount).toBe(0);
		expect(frames).toEqual([
			{
				type: "operation_completed",
				operationId: "operation-1",
				requestId: "request-1",
				command: "prompt",
				agentInvoked: true,
			},
		]);
	});

	test("aborts every active operation once", () => {
		const frames: RpcOperationTerminalFrame[] = [];
		let sequence = 0;
		const manager = new RpcOperationManager(
			frame => frames.push(frame),
			() => `operation-${++sequence}`,
		);
		const first = manager.start("request-1", "prompt");
		manager.start(undefined, "abort_and_prompt");

		manager.abortAll("user");
		manager.abortAll("duplicate");

		expect(manager.activeCount).toBe(0);
		expect(frames).toEqual([
			{
				type: "operation_aborted",
				operationId: "operation-1",
				requestId: "request-1",
				command: "prompt",
				reason: "user",
			},
			{
				type: "operation_aborted",
				operationId: "operation-2",
				requestId: undefined,
				command: "abort_and_prompt",
				reason: "user",
			},
		]);
		expect(manager.complete(first, true)).toBe(false);
	});
});
