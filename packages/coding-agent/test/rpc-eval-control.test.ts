import { describe, expect, test } from "bun:test";
import { RPC_COMMAND_DEFINITIONS, validateRpcCommand } from "../src/modes/rpc/rpc-command-registry";
import { MAX_RPC_EVAL_OUTPUT_CHARACTERS, RpcEvalOutputStream } from "../src/modes/rpc/rpc-eval";
import {
	handleRpcSessionChange,
	RpcOperationMessageOwnership,
	type RpcSessionChangeSession,
	requestRpcDialog,
	requestRpcPrivilegedConfirmation,
} from "../src/modes/rpc/rpc-mode";
import { RpcOperationManager } from "../src/modes/rpc/rpc-operations";
import type { RpcEvalOutputFrame } from "../src/modes/rpc/rpc-types";
import { EvalRunner, type EvalRunnerHost } from "../src/session/eval-runner";

function createRunner(): EvalRunner {
	return new EvalRunner({} as EvalRunnerHost, { kernelOwnerId: "owner", parentSessionId: "session" });
}

describe("RPC eval control", () => {
	test("cancelling one execution leaves its sibling running", () => {
		const runner = createRunner();
		const first = new AbortController();
		const second = new AbortController();
		const pending = new Promise<void>(() => {});
		runner.trackExecution(pending, first, "rpc-eval-1");
		runner.trackExecution(pending, second, "rpc-eval-2");

		expect(runner.abortExecution("rpc-eval-1")).toBe(true);
		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(false);
		expect(runner.abortExecution("unknown")).toBe(false);
	});

	test("dispose-style abort retains all-execution semantics", () => {
		const runner = createRunner();
		const first = new AbortController();
		const second = new AbortController();
		const pending = new Promise<void>(() => {});
		runner.trackExecution(pending, first, "rpc-eval-1");
		runner.trackExecution(pending, second, "rpc-eval-2");

		runner.abort();
		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(true);
	});

	test("eval commands are bounded operation capabilities", () => {
		expect(RPC_COMMAND_DEFINITIONS.eval_execute.execution).toBe("operation");
		expect(RPC_COMMAND_DEFINITIONS.eval_execute.scheduling).toBe("concurrent");
		expect(validateRpcCommand({ type: "eval_execute", language: "py", code: "x" }).ok).toBe(true);
		expect(validateRpcCommand({ type: "eval_execute", language: "go", code: "x" }).ok).toBe(false);
		expect(validateRpcCommand({ type: "eval_execute", language: "py", code: "x".repeat(262_145) }).ok).toBe(false);
		expect(validateRpcCommand({ type: "get_eval_history", limit: 101 }).ok).toBe(false);
	});

	test("rolling-tail updates never resend output and mark the stream truncated", () => {
		const frames: RpcEvalOutputFrame[] = [];
		const stream = new RpcEvalOutputStream(
			"eval-1",
			() => true,
			frame => frames.push(frame),
		);
		stream.push("abcdef");
		stream.push("abcdefgh");
		stream.push("cdefghij");
		stream.push("defghijk");

		expect(frames.map(frame => frame.chunk)).toEqual(["abcdef", "gh", ""]);
		expect(frames.at(-1)?.truncated).toBe(true);
		expect(stream.truncated).toBe(true);
	});

	test("canonical final output tolerates a streamed trailing line break", () => {
		const frames: RpcEvalOutputFrame[] = [];
		const stream = new RpcEvalOutputStream(
			"eval-1",
			() => true,
			frame => frames.push(frame),
		);
		stream.push("4\n");
		stream.complete("4");
		expect(frames).toEqual([
			expect.objectContaining({
				chunk: "4\n",
				truncated: false,
			}),
		]);
		expect(stream.truncated).toBe(false);
	});

	test("eval output stops immediately when operation ownership is cancelled", () => {
		const frames: RpcEvalOutputFrame[] = [];
		let active = true;
		const stream = new RpcEvalOutputStream(
			"eval-1",
			() => active,
			frame => frames.push(frame),
		);
		stream.push("before");
		active = false;
		stream.push("before-after-cancel");
		expect(frames.map(frame => frame.chunk)).toEqual(["before"]);
	});

	test("eval output enforces a cumulative bound", () => {
		const frames: RpcEvalOutputFrame[] = [];
		const stream = new RpcEvalOutputStream(
			"eval-1",
			() => true,
			frame => frames.push(frame),
		);
		stream.push("x".repeat(MAX_RPC_EVAL_OUTPUT_CHARACTERS + 1));
		expect(frames.reduce((total, frame) => total + frame.chunk.length, 0)).toBe(MAX_RPC_EVAL_OUTPUT_CHARACTERS);
		expect(frames.at(-1)?.truncated).toBe(true);
	});

	test("operation cancellation is the last correlated frame and gates later output", () => {
		const frames: object[] = [];
		const manager = new RpcOperationManager(
			frame => frames.push(frame),
			() => "eval-1",
		);
		const operation = manager.start("request-1", "eval_execute");
		manager.begin(operation);
		const stream = new RpcEvalOutputStream(
			operation.operationId,
			() => manager.isActive(operation),
			frame => frames.push(frame),
		);
		stream.push("before");
		manager.cancel(operation.operationId);
		stream.push("after");
		expect(frames.at(-1)).toMatchObject({ type: "operation_cancelled", operationId: "eval-1" });
	});

	test("cancelling approval emits a correlated remote dialog cancellation", async () => {
		const pending = new Map();
		const output: object[] = [];
		const controller = new AbortController();
		const confirmation = requestRpcDialog(
			pending,
			frame => output.push(frame),
			{ signal: controller.signal },
			false,
			{ method: "confirm", title: "Run eval?", message: "code" },
			response => "confirmed" in response && response.confirmed,
		);
		const request = output[0];
		if (!request || !("id" in request) || typeof request.id !== "string") throw new Error("Missing request id");
		controller.abort();
		expect(await confirmation).toBe(false);
		expect(output[1]).toMatchObject({ method: "cancel", targetId: request.id });
		expect(pending.size).toBe(0);
	});
	test("privileged confirmations require the server-issued operation correlation", async () => {
		const pending = new Map();
		const output: object[] = [];
		const confirmation = requestRpcPrivilegedConfirmation(
			pending,
			frame => output.push(frame),
			"cancel_job",
			"Cancel job?",
			"job-1",
			{ operationId: "confirm-1", timeout: 1_000 },
		);
		const request = output[0];
		if (!request || !("id" in request) || typeof request.id !== "string") throw new Error("Missing request id");
		expect(request).toMatchObject({
			type: "extension_ui_request",
			method: "confirm",
			command: "cancel_job",
			operationId: "confirm-1",
		});
		pending.get(request.id)?.resolve({
			type: "extension_ui_response",
			id: request.id,
			confirmed: true,
			operationId: "wrong-operation",
		});
		expect(await confirmation).toBe(false);
	});

	test("session transition commit callback runs before authoritative mutation", async () => {
		const order: string[] = [];
		const session = {
			newSession: async (_options: unknown, beforeCommit?: () => void) => {
				beforeCommit?.();
				order.push("mutation");
				return true;
			},
		} as unknown as RpcSessionChangeSession;
		await handleRpcSessionChange(session, { type: "new_session" }, undefined, () => {
			order.push("cancel");
		});
		expect(order).toEqual(["cancel", "mutation"]);
	});
	test("session transition awaits asynchronous pre-commit cancellation", async () => {
		const order: string[] = [];
		const gate = Promise.withResolvers<void>();
		const session = {
			newSession: async (_options: unknown, beforeCommit?: () => void | Promise<void>) => {
				await beforeCommit?.();
				order.push("mutation");
				return true;
			},
		} as unknown as RpcSessionChangeSession;
		const transition = handleRpcSessionChange(session, { type: "new_session" }, undefined, async () => {
			order.push("cancel-start");
			await gate.promise;
			order.push("cancel-end");
		});
		await Bun.sleep(0);
		expect(order).toEqual(["cancel-start"]);
		gate.resolve();
		await transition;
		expect(order).toEqual(["cancel-start", "cancel-end", "mutation"]);
	});

	test("settling an older operation preserves newer active-turn ownership", async () => {
		const frames: object[] = [];
		let nextOperationId = 0;
		const manager = new RpcOperationManager(
			frame => frames.push(frame),
			() => `op-${nextOperationId++}`,
		);
		const first = manager.start("request-1", "prompt");
		const second = manager.start("request-2", "prompt");
		manager.begin(first);
		manager.begin(second);
		const aborts: unknown[] = [];
		const removed: string[] = [];
		const ownership = new RpcOperationMessageOwnership({
			getMessageTag: message => {
				if ("operationId" in message && typeof message.operationId === "string") return message.operationId;
				return undefined;
			},
			abort: async options => {
				aborts.push(options);
			},
			removeQueuedMessagesByTag: operationId => removed.push(operationId),
		});
		ownership.observeMessageStart({ operationId: first.operationId } as never);
		ownership.observeMessageStart({ operationId: second.operationId } as never);
		ownership.settle(first.operationId);
		await ownership.cancel(manager, second.operationId);
		expect(aborts).toHaveLength(1);
		expect(removed).toEqual([]);
	});

	test("completed evals remain visible while awaiting a safe transcript boundary", () => {
		const appended: object[] = [];
		const host = {
			isStreaming: () => true,
			appendSessionMessage: (message: object) => appended.push(message),
		} as unknown as EvalRunnerHost;
		const runner = new EvalRunner(host, { kernelOwnerId: "owner", parentSessionId: "session" });
		runner.recordEvalResult({
			language: "js",
			code: "1 + 1",
			output: "2",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		expect(runner.pendingMessages()).toHaveLength(1);
		expect(runner.pendingMessages()[0]).toMatchObject({ language: "js", output: "2" });
		expect(appended).toHaveLength(0);
		runner.flushPending();
		expect(appended).toHaveLength(1);
	});
});
