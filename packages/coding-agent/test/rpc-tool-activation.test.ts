import { describe, expect, test } from "bun:test";
import { RpcToolActivationValidationError } from "../src/modes/rpc/rpc-command-registry";
import {
	applyRpcToolActivation,
	RpcToolActivationBusyError,
	type RpcToolActivationSession,
} from "../src/modes/rpc/rpc-mode";
import {
	SessionTools,
	type SessionToolsHost,
	type ToolInventory,
	ToolInventoryUnavailableError,
} from "../src/session/session-tools";

class FakeActivationSession implements RpcToolActivationSession {
	activityPhase: "provider" | "maintenance" | "idle" = "idle";
	isStreaming = false;
	isCompacting = false;
	all = ["read", "write", "hidden_tool", "mcp__server_tool"];
	active = ["read"];
	mounted: string[] = [];
	applyCalls: string[][] = [];
	inventoryAvailable = true;
	reconcile: (requested: string[]) => { active: string[]; mounted: string[] } = requested => ({
		active: requested,
		mounted: [],
	});

	getAllToolNames(): string[] {
		return [...this.all];
	}

	getEnabledToolNames(): string[] {
		return [...this.active, ...this.mounted];
	}

	getActiveToolNames(): string[] {
		return [...this.active];
	}

	getMountedXdevToolNames(): string[] {
		return [...this.mounted];
	}

	async setActiveToolsByName(names: string[]): Promise<void> {
		this.applyCalls.push([...names]);
		const achieved = this.reconcile(names);
		this.active = achieved.active;
		this.mounted = achieved.mounted;
	}

	getToolInventory(applicationApiVersion: number): ToolInventory {
		if (!this.inventoryAvailable) throw new ToolInventoryUnavailableError();
		return {
			applicationApiVersion,
			tools: [],
			xdev: { prefix: "xd://", mountedCount: this.mounted.length },
		};
	}
}

describe("RPC tool activation", () => {
	test("rejects unknown, duplicate, overlap, and empty batches atomically", async () => {
		for (const command of [
			{ type: "set_tool_activation" as const, activate: ["missing"] },
			{ type: "set_tool_activation" as const, activate: ["read", "read"] },
			{ type: "set_tool_activation" as const, activate: ["read"], deactivate: ["read"] },
			{ type: "set_tool_activation" as const, activate: [], deactivate: [] },
			{ type: "set_tool_activation" as const, activate: [" unsafe"] },
			{ type: "set_tool_activation" as const, activate: ["😀".repeat(65)] },
			{
				type: "set_tool_activation" as const,
				activate: Array.from({ length: 2049 }, (_, index) => `tool_${index}`),
			},
		]) {
			const session = new FakeActivationSession();
			await expect(applyRpcToolActivation(session, command)).rejects.toBeInstanceOf(
				RpcToolActivationValidationError,
			);
			expect(session.applyCalls).toEqual([]);
			expect(session.getEnabledToolNames()).toEqual(["read"]);
		}
	});

	test("refuses busy sessions before mutation", async () => {
		for (const busy of [
			{ activityPhase: "provider" as const },
			{ activityPhase: "maintenance" as const },
			{ isCompacting: true },
		]) {
			const session = new FakeActivationSession();
			if ("activityPhase" in busy && busy.activityPhase !== undefined) session.activityPhase = busy.activityPhase;
			if ("isCompacting" in busy && busy.isCompacting !== undefined) session.isCompacting = busy.isCompacting;
			await expect(
				applyRpcToolActivation(session, { type: "set_tool_activation", activate: ["write"] }),
			).rejects.toBeInstanceOf(RpcToolActivationBusyError);
			expect(session.applyCalls).toEqual([]);
		}
		const acceptedPromptSession = new FakeActivationSession();
		await expect(
			applyRpcToolActivation(acceptedPromptSession, { type: "set_tool_activation", activate: ["write"] }, true),
		).rejects.toBeInstanceOf(RpcToolActivationBusyError);
		expect(acceptedPromptSession.applyCalls).toEqual([]);
	});

	test("accepts a non-ASCII tool name at the advertised UTF-8 byte boundary", async () => {
		const session = new FakeActivationSession();
		const boundaryName = "😀".repeat(64);
		session.all.push(boundaryName);
		const result = await applyRpcToolActivation(session, {
			type: "set_tool_activation",
			activate: [boundaryName],
		});
		expect(result.activated).toEqual([boundaryName]);
	});

	test("reports achieved active, mounted, and actual delta after one authoritative apply", async () => {
		const session = new FakeActivationSession();
		session.active = ["read"];
		session.mounted = ["mcp__server_tool"];
		session.reconcile = requested => ({
			active: [...requested, "write"],
			mounted: [],
		});

		const result = await applyRpcToolActivation(session, {
			type: "set_tool_activation",
			activate: ["hidden_tool"],
			deactivate: ["mcp__server_tool"],
		});

		expect(session.applyCalls).toEqual([["read", "hidden_tool"]]);
		expect(result).toMatchObject({
			enabledToolNames: ["read", "hidden_tool", "write"],
			activeToolNames: ["read", "hidden_tool", "write"],
			mountedToolNames: [],
			activated: ["hidden_tool", "write"],
			deactivated: ["mcp__server_tool"],
			inventoryAvailable: true,
		});
		expect(result.inventory?.applicationApiVersion).toBe(2);
	});

	test("allows explicit activation of a registered hidden tool", async () => {
		const session = new FakeActivationSession();
		const result = await applyRpcToolActivation(session, {
			type: "set_tool_activation",
			activate: ["hidden_tool"],
		});
		expect(result.activated).toEqual(["hidden_tool"]);
		expect(result.enabledToolNames).toEqual(["read", "hidden_tool"]);
	});

	test("returns achieved mutation without stale inventory when inventory is unavailable", async () => {
		const session = new FakeActivationSession();
		session.inventoryAvailable = false;
		const result = await applyRpcToolActivation(session, {
			type: "set_tool_activation",
			activate: ["write"],
		});
		expect(result).toMatchObject({
			enabledToolNames: ["read", "write"],
			activated: ["write"],
			inventoryAvailable: false,
		});
		expect(result).not.toHaveProperty("inventory");
	});

	test("truthfully reports an achieved no-state-change apply", async () => {
		const session = new FakeActivationSession();
		const result = await applyRpcToolActivation(session, {
			type: "set_tool_activation",
			activate: ["read"],
		});
		expect(session.applyCalls).toEqual([["read"]]);
		expect(result.activated).toEqual([]);
		expect(result.deactivated).toEqual([]);
	});

	test("does not lazy-register transport tools during activation reconciliation", async () => {
		const read = {
			name: "read",
			label: "Read",
			description: "Read",
			parameters: { type: "object" },
			execute: async () => ({ content: [] }),
		};
		const deferred = {
			name: "deferred",
			label: "Deferred",
			description: "Deferred",
			parameters: { type: "object" },
			deferrable: true,
			execute: async () => ({ content: [] }),
		};
		const state = { tools: [read], messages: [], systemPrompt: [] as string[] };
		let registrations = 0;
		const host = {
			agent: {
				state,
				setTools: (tools: typeof state.tools) => {
					state.tools = tools;
				},
			},
			clientBridge: () => undefined,
			model: () => undefined,
			isDisposed: () => false,
			planModeEnabled: () => false,
			notifyToolInventoryChanged: () => {},
		} as unknown as SessionToolsHost;
		const tools = new SessionTools(host, {
			toolRegistry: new Map([
				["read", read],
				["deferred", deferred],
			]),
			builtInToolNames: ["read"],
			baseSystemPrompt: [],
			ensureWriteRegistered: async () => {
				registrations++;
				return true;
			},
		});

		await tools.setActiveToolsByName(["read", "deferred"], false);
		expect(registrations).toBe(0);
		expect(tools.getEnabledToolNames()).toEqual(["read", "deferred"]);
	});

	test("propagates apply failures without constructing a success result", async () => {
		const session = new FakeActivationSession();
		session.reconcile = () => {
			throw new Error("apply failed");
		};
		await expect(
			applyRpcToolActivation(session, { type: "set_tool_activation", activate: ["write"] }),
		).rejects.toThrow("apply failed");
	});
});
