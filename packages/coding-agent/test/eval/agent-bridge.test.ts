import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalAgent } from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import type { LocalProtocolOptions } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp";
import * as taskDiscovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { IsolationContext } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { AgentDefinition, SingleResult, StructuredSubagentOutput } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function createResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "0-Task",
		agent: "task",
		agentSource: "bundled",
		task: "do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

describe("runEvalAgent", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards session-scoped MCP and local protocol options", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			options.beforeRun?.();
			return createResult();
		});

		const mcpManager = { sentinel: "mcp" } as unknown as MCPManager;
		const localProtocolOptions: LocalProtocolOptions = {
			getArtifactsDir: () => "/tmp/parent-artifacts",
			getSessionId: () => "parent-session",
		};
		const taskTreeBudget = new taskExecutor.TaskTreeBudget({ maxSpawns: 1 });
		const session = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
			mcpManager,
			localProtocolOptions,
			getAgentId: () => "BridgeParent",
			taskTreeBudget,
		} as unknown as ToolSession;

		await runEvalAgent({ prompt: "do work", agent: "task" }, { session });

		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		const options = runSubprocessSpy.mock.calls[0]?.[0];
		expect(options?.mcpManager).toBe(mcpManager);
		expect(options?.localProtocolOptions).toBe(localProtocolOptions);
		expect(options?.parentAgentId).toBe("BridgeParent");
		expect(options?.taskTreeBudget).toBe(taskTreeBudget);
		expect(taskTreeBudget.snapshot().spawns).toBe(1);
	});

	it("applies runtime task-tree limits before an eval agent spawn", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			options.beforeRun?.();
			return createResult();
		});
		const settings = Settings.isolated();
		settings.set("task.treeMaxSpawns", 1);
		const taskTreeBudget = new taskExecutor.TaskTreeBudget();
		const session = {
			cwd: "/tmp",
			settings,
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
			taskTreeBudget,
		} as unknown as ToolSession;

		await runEvalAgent({ prompt: "first", agent: "task" }, { session });
		await expect(runEvalAgent({ prompt: "second", agent: "task" }, { session })).rejects.toThrow(
			"Task tree spawn budget exceeded",
		);

		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		expect(taskTreeBudget.snapshot()).toMatchObject({ spawns: 1, maxSpawns: 1 });
	});

	it("keeps root task-tree limits authoritative for descendant eval sessions", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			options.beforeRun?.();
			return createResult();
		});
		const settings = Settings.isolated({ "task.treeMaxSpawns": 8 });
		const taskTreeBudget = new taskExecutor.TaskTreeBudget({ maxSpawns: 2 });
		const session = {
			cwd: "/tmp",
			settings,
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
			taskDepth: 1,
			taskTreeBudget,
		} as unknown as ToolSession;

		await runEvalAgent({ prompt: "first", agent: "task" }, { session });
		await runEvalAgent({ prompt: "second", agent: "task" }, { session });
		await expect(runEvalAgent({ prompt: "third", agent: "task" }, { session })).rejects.toThrow(
			"Task tree spawn budget exceeded",
		);

		expect(runSubprocessSpy).toHaveBeenCalledTimes(2);
		expect(taskTreeBudget.snapshot()).toMatchObject({ spawns: 2, maxSpawns: 2 });
	});

	it("releases an eval reservation cancelled before executor dispatch", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			if (options.signal?.aborted)
				return createResult({ aborted: true, exitCode: 1, error: "Cancelled before start" });
			options.beforeRun?.();
			return createResult();
		});
		const taskTreeBudget = new taskExecutor.TaskTreeBudget({ maxSpawns: 1 });
		const session = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
			taskTreeBudget,
		} as unknown as ToolSession;
		const controller = new AbortController();
		controller.abort();

		await expect(
			runEvalAgent({ prompt: "cancelled", agent: "task" }, { session, signal: controller.signal }),
		).rejects.toThrow("Cancelled before start");
		expect(taskTreeBudget.snapshot().spawns).toBe(0);

		await runEvalAgent({ prompt: "valid", agent: "task" }, { session });
		expect(runSubprocessSpy).toHaveBeenCalledTimes(2);
		expect(taskTreeBudget.snapshot().spawns).toBe(1);
	});

	it("does not consume spawn capacity when isolated setup fails before the child starts", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const isolationContext = { repoRoot: "/tmp", baseline: {} } as unknown as IsolationContext;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue(isolationContext);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockRejectedValue(new Error("setup failed"));

		const taskTreeBudget = new taskExecutor.TaskTreeBudget({ maxSpawns: 1 });
		const session = {
			cwd: "/tmp",
			settings: Settings.isolated({ "task.isolation.mode": "worktree" }),
			getSessionSpawns: () => "*",
			getSessionFile: () => "/tmp/eval-agent-test.jsonl",
			taskTreeBudget,
		} as unknown as ToolSession;

		await expect(
			runEvalAgent({ prompt: "do work", agent: "task", isolated: true, apply: false }, { session }),
		).rejects.toThrow("setup failed");
		expect(taskTreeBudget.snapshot().spawns).toBe(0);
	});

	it("returns executor-parsed structured data through the public eval bridge", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
			output: { type: "object" },
		};
		const structuredOutput: StructuredSubagentOutput = {
			source: "agent",
			mode: "strict",
			status: "valid",
			data: { status: "ok" },
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult({ output: "not JSON", structuredOutput }));
		const session = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		} as unknown as ToolSession;

		const result = await runEvalAgent({ prompt: "do work", agent: "task", schemaMode: "strict" }, { session });

		expect(result.data).toEqual({ status: "ok" });
		expect(result.details).toMatchObject({ structured: true, schemaSource: "agent", schemaMode: "strict" });
	});
});
