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

	test("surfaces operation failures instead of relying on a late response", async () => {
		const client = await startClient();

		await expect(client.promptAndWait("fail", undefined, 1_000)).rejects.toEqual(
			expect.objectContaining({
				name: "RpcCommandError",
				message: "fixture scheduling failure",
				command: "prompt",
				code: "prompt_scheduling_failed",
			}),
		);
	});
});
