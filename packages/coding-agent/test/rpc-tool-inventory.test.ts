import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import type { RegisteredTool } from "../src/extensibility/extensions";
import { MAX_RPC_FRAME_BYTES } from "../src/modes/rpc/rpc-frame";
import {
	projectToolInventory,
	SessionTools,
	type SessionToolsHost,
	ToolInventoryUnavailableError,
} from "../src/session/session-tools";

function tool(name: string, overrides: Record<string, unknown> = {}): AgentTool {
	return {
		name,
		label: `${name} label`,
		description: `${name} description`,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [] }),
		...overrides,
	} as unknown as AgentTool;
}

function registered(name: string, extensionPath: string): RegisteredTool {
	return {
		definition: { name },
		extensionPath,
	} as unknown as RegisteredTool;
}

describe("tool inventory projection", () => {
	it("projects live presentation, schemas, metadata, and source precedence", () => {
		const builtin = tool("read", {
			parameters: type({ path: "string" }),
			loadMode: "essential",
			strict: true,
		});
		const mounted = tool("extension_tool", { loadMode: "discoverable", summary: "mounted summary" });
		const inactive = tool("inactive_tool", { hidden: true, deferrable: false, customWireName: "wire_inactive" });
		const mcp = tool("mcp__server_remote", {
			mcpServerName: "server",
			mcpToolName: "remote",
			loadMode: "discoverable",
		});
		const rpcHostMcpName = tool("mcp__host_owned", { loadMode: "discoverable" });
		const inline = tool("inline_tool", { loadMode: "discoverable" });
		const inlineLoader = tool("inline_loader_tool", { loadMode: "discoverable" });
		const custom = tool("custom_tool", {
			description: `unsafe\n${"é".repeat(200)}`,
			loadMode: "discoverable",
		});
		const registry = new Map(
			[builtin, mounted, inactive, mcp, rpcHostMcpName, inline, inlineLoader, custom].map(value => [
				value.name,
				value,
			]),
		);

		const inventory = projectToolInventory({
			applicationApiVersion: 2,
			registry,
			activeNames: new Set(["read", "mcp__server_remote", "mcp__host_owned"]),
			mountedNames: new Set(["extension_tool"]),
			builtInNames: new Set(["read"]),
			rpcHostNames: new Set(["mcp__host_owned"]),
			registeredTools: [
				registered("extension_tool", "/extensions/example.ts"),
				registered("inline_tool", "<inline-0>"),
				registered("inline_loader_tool", "<inline-loader-1>"),
			],
		});

		expect(inventory.applicationApiVersion).toBe(2);
		expect(inventory.xdev).toEqual({ prefix: "xd://", mountedCount: 1 });
		expect(inventory.tools.find(entry => entry.name === "read")).toMatchObject({
			presentation: "active",
			loadMode: "essential",
			strict: true,
			source: { kind: "builtin" },
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		});
		expect(inventory.tools.find(entry => entry.name === "extension_tool")).toMatchObject({
			presentation: "mounted",
			source: { kind: "extension", extensionPath: "/extensions/example.ts" },
		});
		expect(inventory.tools.find(entry => entry.name === "inactive_tool")).toMatchObject({
			presentation: "registered",
			hidden: true,
			deferrable: false,
			customWireName: "wire_inactive",
			source: { kind: "custom" },
		});
		expect(inventory.tools.find(entry => entry.name === "mcp__server_remote")?.source).toEqual({
			kind: "mcp",
			serverName: "server",
			remoteName: "remote",
		});
		expect(inventory.tools.find(entry => entry.name === "mcp__host_owned")?.source).toEqual({
			kind: "rpc_host",
		});
		expect(inventory.tools.find(entry => entry.name === "inline_tool")?.source).toEqual({ kind: "inline" });
		expect(inventory.tools.find(entry => entry.name === "inline_loader_tool")?.source).toEqual({
			kind: "inline",
		});
		const customEntry = inventory.tools.find(entry => entry.name === "custom_tool");
		expect(customEntry?.source).toEqual({ kind: "custom" });
		expect(customEntry?.description).not.toContain("\n");
		expect(Buffer.byteLength(customEntry?.description ?? "", "utf8")).toBeLessThanOrEqual(200);
	});

	it("preserves semantic schema data and explicitly rejects unsafe or incomplete inventories", () => {
		const propertyName = `property_${"x".repeat(180)}`;
		const enumValue = `  ${"é".repeat(3000)}\n  `;
		const semanticParameters = {
			type: "object",
			properties: {
				[propertyName]: { type: "string", enum: [enumValue], pattern: "^  .+  $" },
			},
		};
		const semantic = tool("semantic", {
			label: `unsafe\n${"é".repeat(1000)}`,
			description: "description\u0000text",
			parameters: semanticParameters,
			loadMode: "discoverable",
		});
		const inventory = projectToolInventory({
			applicationApiVersion: 2,
			registry: new Map([["semantic", semantic]]),
			activeNames: new Set(["semantic"]),
			mountedNames: new Set(),
			builtInNames: new Set(),
			rpcHostNames: new Set(),
			registeredTools: [registered("semantic", "/extension/semantic.ts")],
		});
		const entry = inventory.tools[0];
		expect(entry.label).not.toContain("\n");
		expect(entry.description).not.toContain("\u0000");
		expect(entry.parameters).toEqual(semanticParameters);

		const cyclicSchema: Record<string, unknown> = { type: "object" };
		cyclicSchema.self = cyclicSchema;
		expect(() =>
			projectToolInventory({
				applicationApiVersion: 2,
				registry: new Map([["unsafe", tool("unsafe", { parameters: cyclicSchema })]]),
				activeNames: new Set(),
				mountedNames: new Set(),
				builtInNames: new Set(),
				rpcHostNames: new Set(),
				registeredTools: [],
			}),
		).toThrow();

		expect(() =>
			projectToolInventory({
				applicationApiVersion: 2,
				registry: new Map([
					[
						"oversized_schema",
						tool("oversized_schema", {
							parameters: { type: "string", enum: ["x".repeat(8193)] },
						}),
					],
				]),
				activeNames: new Set(),
				mountedNames: new Set(),
				builtInNames: new Set(),
				rpcHostNames: new Set(),
				registeredTools: [],
			}),
		).toThrow("oversized JSON string");

		expect(() =>
			projectToolInventory({
				applicationApiVersion: 2,
				registry: new Map([["unsafe", tool("unsafe")]]),
				activeNames: new Set(),
				mountedNames: new Set(),
				builtInNames: new Set(),
				rpcHostNames: new Set(),
				registeredTools: [registered("unsafe", `/extension/${"x".repeat(2000)}.ts`)],
			}),
		).toThrow("extension path is unsafe or exceeds inventory limits");

		const largeRegistry = new Map<string, AgentTool>();
		for (let index = 0; index < 300; index++) {
			largeRegistry.set(
				`large_${index}`,
				tool(`large_${index}`, {
					parameters: { type: "object", description: "x".repeat(8000) },
					loadMode: "discoverable",
				}),
			);
		}
		expect(() =>
			projectToolInventory({
				applicationApiVersion: 2,
				registry: largeRegistry,
				activeNames: new Set(),
				mountedNames: new Set(),
				builtInNames: new Set(),
				rpcHostNames: new Set(),
				registeredTools: [],
			}),
		).toThrow("serialized bytes");

		const completeRegistry = new Map<string, AgentTool>();
		for (let index = 0; index < 2048; index++) {
			completeRegistry.set(`tool_${index}`, tool(`tool_${index}`, { loadMode: "discoverable" }));
		}
		const complete = projectToolInventory({
			applicationApiVersion: 2,
			registry: completeRegistry,
			activeNames: new Set(),
			mountedNames: new Set(),
			builtInNames: new Set(),
			rpcHostNames: new Set(),
			registeredTools: [],
		});
		expect(complete.tools).toHaveLength(2048);
		const responseFrame = {
			id: "inventory-request",
			type: "response",
			command: "get_tool_inventory",
			success: true,
			data: complete,
		};
		expect(Buffer.byteLength(`${JSON.stringify(responseFrame)}\n`, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);

		const oversizedRegistry = new Map(completeRegistry);
		oversizedRegistry.set("tool_2048", tool("tool_2048", { loadMode: "discoverable" }));
		oversizedRegistry.set("tool_2049", tool("tool_2049", { loadMode: "discoverable" }));
		expect(() =>
			projectToolInventory({
				applicationApiVersion: 2,
				registry: oversizedRegistry,
				activeNames: new Set(),
				mountedNames: new Set(),
				builtInNames: new Set(),
				rpcHostNames: new Set(),
				registeredTools: [],
			}),
		).toThrow("exceeds 2048 tools");
	});

	it("signals once for a successful change and not for a no-op or failed reconciliation", async () => {
		const registry = new Map([["read", tool("read", { loadMode: "essential" })]]);
		const state = { tools: [] as AgentTool[], messages: [], systemPrompt: [] as string[] };
		let updates = 0;
		const host = {
			agent: {
				state,
				setTools: (tools: AgentTool[]) => {
					state.tools = tools;
				},
			},
			clientBridge: () => undefined,
			model: () => undefined,
			isDisposed: () => false,
			planModeEnabled: () => false,
			notifyToolInventoryChanged: () => {
				updates++;
			},
		} as unknown as SessionToolsHost;
		const tools = new SessionTools(host, {
			toolRegistry: registry,
			builtInToolNames: ["read"],
			baseSystemPrompt: [],
		});

		await tools.applyActiveToolsByName(["read"]);
		expect(updates).toBe(1);
		await tools.applyActiveToolsByName(["read"]);
		expect(updates).toBe(1);

		const failing = new SessionTools(host, {
			toolRegistry: registry,
			builtInToolNames: ["read"],
			baseSystemPrompt: [],
			rebuildSystemPrompt: async () => {
				throw new Error("rebuild failed");
			},
		});
		await expect(failing.applyActiveToolsByName([])).rejects.toThrow("rebuild failed");
		expect(updates).toBe(1);
	});

	it("keeps pre-apply registry mutations out of the committed inventory snapshot", async () => {
		const readTool = tool("read", { loadMode: "essential" });
		const registry = new Map([["read", readTool]]);
		const state = { tools: [readTool] as AgentTool[], messages: [], systemPrompt: [] as string[] };
		let updates = 0;
		const host = {
			agent: {
				state,
				setTools: (tools: AgentTool[]) => {
					state.tools = tools;
				},
			},
			clientBridge: () => undefined,
			model: () => undefined,
			isDisposed: () => false,
			planModeEnabled: () => false,
			notifyToolInventoryChanged: () => {
				updates++;
			},
		} as unknown as SessionToolsHost;
		const tools = new SessionTools(host, {
			toolRegistry: registry,
			builtInToolNames: ["read"],
			baseSystemPrompt: [],
		});

		registry.set(
			"mcp__server_pending",
			tool("mcp__server_pending", {
				mcpServerName: "server",
				mcpToolName: "pending",
				loadMode: "discoverable",
			}),
		);
		expect(tools.getToolInventory(2).tools.map(entry => entry.name)).toEqual(["read"]);
		await tools.applyActiveToolsByName(["read", "mcp__server_pending"]);
		expect(tools.getToolInventory(2).tools.map(entry => entry.name)).toEqual(["read", "mcp__server_pending"]);
		expect(updates).toBe(1);
	});

	it("keeps runtime tools committed when their exact inventory is unavailable", async () => {
		const readTool = tool("read", { loadMode: "essential" });
		const registry = new Map([["read", readTool]]);
		const state = { tools: [readTool] as AgentTool[], messages: [], systemPrompt: [] as string[] };
		let registeredTools: RegisteredTool[] = [];
		let updates = 0;
		const host = {
			agent: {
				state,
				setTools: (tools: AgentTool[]) => {
					state.tools = tools;
				},
			},
			extensionRunner: () => ({ getAllRegisteredTools: () => registeredTools }),
			clientBridge: () => undefined,
			model: () => undefined,
			isDisposed: () => false,
			planModeEnabled: () => false,
			notifyToolInventoryChanged: () => {
				updates++;
			},
		} as unknown as SessionToolsHost;
		const tools = new SessionTools(host, {
			toolRegistry: registry,
			builtInToolNames: ["read"],
			baseSystemPrompt: [],
		});

		const largeSchemaTool = tool("large_schema", {
			parameters: { type: "string", enum: ["x".repeat(8193)] },
			loadMode: "discoverable",
		});
		registry.set("large_schema", largeSchemaTool);
		await tools.applyActiveToolsByName(["read", "large_schema"]);
		expect(state.tools.map(entry => entry.name)).toEqual(["read", "large_schema"]);
		expect(() => tools.getToolInventory(2)).toThrow(ToolInventoryUnavailableError);

		registry.delete("large_schema");
		const longPathTool = tool("long_path", { loadMode: "discoverable" });
		registry.set("long_path", longPathTool);
		registeredTools = [registered("long_path", `/extension/${"x".repeat(2000)}.ts`)];
		await tools.applyActiveToolsByName(["read", "long_path"]);
		expect(state.tools.map(entry => entry.name)).toEqual(["read", "long_path"]);
		expect(() => tools.getToolInventory(2)).toThrow(ToolInventoryUnavailableError);

		registry.delete("long_path");
		registeredTools = [];
		for (let index = 0; index < 300; index++) {
			registry.set(
				`large_${index}`,
				tool(`large_${index}`, {
					parameters: { type: "object", description: "x".repeat(8000) },
					loadMode: "discoverable",
				}),
			);
		}
		await tools.applyActiveToolsByName(["read"]);
		expect(state.tools.map(entry => entry.name)).toEqual(["read"]);
		expect(() => tools.getToolInventory(2)).toThrow(ToolInventoryUnavailableError);
		expect(updates).toBe(3);
	});
});
