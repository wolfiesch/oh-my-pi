import { describe, expect, test } from "bun:test";
import { cancelRpcSubagent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";

function registryAndLifecycle(): { registry: AgentRegistry; lifecycle: AgentLifecycleManager } {
	const registry = new AgentRegistry();
	return { registry, lifecycle: new AgentLifecycleManager(registry) };
}

describe("cancelRpcSubagent", () => {
	test("aborts a running subagent with the user-interrupt reason before releasing it", async () => {
		const { registry, lifecycle } = registryAndLifecycle();
		const calls: string[] = [];
		const session = {
			abort: async ({ reason }: { reason: string }) => {
				calls.push(`abort:${reason}`);
			},
			dispose: async () => {
				calls.push("dispose");
			},
		} as unknown as AgentSession;
		registry.register({ id: "Worker", displayName: "Worker", kind: "sub", session, status: "running" });

		await expect(cancelRpcSubagent("Worker", registry, lifecycle)).resolves.toBe(true);
		expect(calls).toEqual([`abort:${USER_INTERRUPT_LABEL}`, "dispose"]);
		expect(registry.get("Worker")).toBeUndefined();
	});

	test("returns false for missing or already-aborted subagents", async () => {
		const { registry, lifecycle } = registryAndLifecycle();
		registry.register({ id: "Gone", displayName: "Gone", kind: "sub", session: null, status: "aborted" });

		await expect(cancelRpcSubagent("Unknown", registry, lifecycle)).resolves.toBe(false);
		await expect(cancelRpcSubagent("Gone", registry, lifecycle)).resolves.toBe(false);
		expect(registry.get("Gone")).toBeDefined();
	});

	test("rejects main, advisor, and unbounded agent IDs", async () => {
		const { registry, lifecycle } = registryAndLifecycle();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "idle" });
		registry.register({ id: "Advisor", displayName: "Advisor", kind: "advisor", session: null, status: "idle" });

		await expect(cancelRpcSubagent("Main", registry, lifecycle)).rejects.toThrow("only subagents");
		await expect(cancelRpcSubagent("Advisor", registry, lifecycle)).rejects.toThrow("only subagents");
		await expect(cancelRpcSubagent("x".repeat(257), registry, lifecycle)).rejects.toThrow("subagent ID is invalid");
		expect(registry.get("Main")).toBeDefined();
		expect(registry.get("Advisor")).toBeDefined();
	});
});
