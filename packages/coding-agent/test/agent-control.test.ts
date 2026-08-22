import { describe, expect, test } from "bun:test";
import { settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentControlService } from "@oh-my-pi/pi-coding-agent/registry/agent-control";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

describe("AgentControlService", () => {
	test("excludes advisors by default and rejects advisor mutation", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
		});
		registry.register({
			id: "Advisor",
			displayName: "Advisor",
			kind: "advisor",
			parentId: "Main",
			session: null,
			status: "parked",
		});
		const service = new AgentControlService({
			session: { agentRegistry: registry } as ToolSession,
			registry,
			lifecycle: new AgentLifecycleManager(registry),
			settings,
		});
		expect(service.list().map(agent => agent.id)).toEqual(["Worker"]);
		expect(service.list({ includeAdvisors: true }).map(agent => agent.id)).toEqual(["Advisor", "Worker"]);
		expect(service.park("Advisor")).rejects.toThrow("read-only advisor");
	});

	test("bounds projected job results while preserving registry/job distinction", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
		});
		const service = new AgentControlService({
			session: { agentRegistry: registry } as ToolSession,
			registry,
			lifecycle: new AgentLifecycleManager(registry),
			settings,
			projectResult: () => ({ status: "completed", resultText: "x".repeat(600_000) }),
		});
		const result = service.getResult("Worker");
		expect(result.source).toBe("job");
		expect(result.jobStatus).toBe("completed");
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.resultText ?? "", "utf8")).toBeLessThanOrEqual(500_000);
	});

	test("rejects a same-id replacement captured before confirmation", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const session = { agentRegistry: registry, agentLifecycle: () => lifecycle } as ToolSession;
		const original = registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
		});
		const service = new AgentControlService({ session, registry, lifecycle, settings });
		const expected = service.captureMutationTarget("Worker");
		expect(expected).toBe(original);
		registry.unregister("Worker", original);
		registry.register({
			id: "Worker",
			displayName: "Replacement",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
		});
		expect((await service.cancel("Worker", expected)).status).toBe("not_found");
		expect(registry.get("Worker")?.displayName).toBe("Replacement");
	});

	test("cancels an owned transitive descendant through the shared lifecycle authority", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const session = { agentRegistry: registry, agentLifecycle: () => lifecycle } as ToolSession;
		registry.register({
			id: "Parent",
			displayName: "Parent",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
		});
		registry.register({
			id: "Grandchild",
			displayName: "Grandchild",
			kind: "sub",
			parentId: "Parent",
			session: null,
			status: "parked",
		});
		const service = new AgentControlService({ session, registry, lifecycle, senderId: "Parent", settings });
		expect((await service.cancel("Grandchild")).status).toBe("cancelled");
		expect(registry.get("Grandchild")).toBeUndefined();
	});

	test("does not report success when a running unadopted agent cannot be parked", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		registry.register({
			id: "Running",
			displayName: "Running",
			kind: "sub",
			parentId: "Main",
			session: {} as never,
			status: "running",
		});
		const service = new AgentControlService({
			session: { agentRegistry: registry, agentLifecycle: () => lifecycle } as ToolSession,
			registry,
			lifecycle,
			settings,
		});
		await expect(service.park("Running")).rejects.toThrow("not in an idle adopted state");
		expect(registry.get("Running")?.status).toBe("running");
	});
});
