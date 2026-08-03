import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcOperationTerminalFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const MOCK_AGENT = path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts");
const clients: RpcClient[] = [];

afterEach(async () => {
	await Promise.all(clients.splice(0).map(client => client.stop()));
});

async function startClient(): Promise<RpcClient> {
	const client = new RpcClient({
		cliPath: MOCK_AGENT,
		env: { MOCK_RPC_OPERATIONS: "1" },
	});
	clients.push(client);
	await client.start();
	return client;
}

describe("RpcClient operation lifecycle", () => {
	test("returns local-only prompt operations without waiting for agent_end", async () => {
		const client = await startClient();
		const terminal: RpcOperationTerminalFrame[] = [];
		client.onOperationTerminal(frame => terminal.push(frame));

		expect(await client.promptAndWait("local", undefined, 1_000)).toEqual([]);
		expect(terminal).toHaveLength(1);
		expect(terminal[0]).toMatchObject({
			type: "operation_completed",
			command: "prompt",
			agentInvoked: false,
		});
	});

	test("waitForIdle follows local-only operation terminals", async () => {
		const client = await startClient();

		const accepted = await client.prompt("local");
		expect(accepted?.operationId).toBeString();
		await client.waitForIdle(1_000);
	});

	test("waits for its correlated terminal operation after nonterminal agent_end", async () => {
		const client = await startClient();

		const events = await client.promptAndWait("normal", undefined, 1_000);

		expect(events.map(event => event.type)).toEqual(["agent_start", "agent_end", "agent_end"]);
		expect(Reflect.get(events[1] ?? {}, "isTerminal")).toBe(false);
	});

	test("keeps post-accept failures observable without changing promptAndWait returns", async () => {
		const client = await startClient();
		const terminal: RpcOperationTerminalFrame[] = [];
		client.onOperationTerminal(frame => terminal.push(frame));

		expect(await client.promptAndWait("fail", undefined, 1_000)).toEqual([]);
		expect(terminal).toEqual([
			expect.objectContaining({
				type: "operation_failed",
				error: "fixture scheduling failure",
				code: "prompt_scheduling_failed",
			}),
		]);
	});

	test("observes acceptance before started and terminal frames", async () => {
		const client = await startClient();
		const order: string[] = [];
		client.onOperationStarted(() => order.push("started"));
		client.onOperationTerminal(() => order.push("terminal"));

		const accepted = await client.prompt("local");
		order.unshift(accepted?.accepted ? "accepted" : "missing");
		await client.waitForIdle(1_000);

		expect(order).toEqual(["accepted", "started", "terminal"]);
	});

	test("registers mode, plan approval, and provider auth operations before waitForIdle", async () => {
		const client = await startClient();
		const settledCommands: string[] = [];
		client.onOperationTerminal(frame => settledCommands.push(frame.command));

		const modeChange = await client.setMode("plan");
		expect(modeChange).toMatchObject({ accepted: true, deferred: false });
		await client.waitForIdle(1_000);
		expect(settledCommands).toEqual(["set_mode"]);

		const approval = await client.resolvePlanApproval("approval-1", { decision: "reject" });
		expect(approval.accepted).toBe(true);
		await client.waitForIdle(1_000);
		expect(settledCommands).toEqual(["set_mode", "resolve_plan_approval"]);

		const providerAuth = await client.beginProviderAuth("openrouter", "api_key");
		expect(providerAuth.accepted).toBe(true);
		await client.waitForIdle(1_000);
		expect(settledCommands).toEqual(["set_mode", "resolve_plan_approval", "begin_provider_auth"]);
	});

	test("cancels only the target idempotently and reconciles snapshots", async () => {
		const client = await startClient();
		const accepted = await client.prompt("hold");
		expect(accepted?.operationId).toBeString();
		const operationId = accepted!.operationId;

		const first = await client.cancelOperation(operationId);
		const second = await client.cancelOperation(operationId);
		expect(first).toEqual(second);
		expect(first.status).toBe("cancelled");
		const snapshot = await client.getOperations();
		expect(snapshot.active).toEqual([]);
		expect(snapshot.recent).toEqual([expect.objectContaining({ operationId, type: "operation_cancelled" })]);
	});
});
