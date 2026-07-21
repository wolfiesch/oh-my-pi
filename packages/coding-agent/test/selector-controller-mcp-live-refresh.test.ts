import { describe, expect, test, vi } from "bun:test";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { MCPToolDetails } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import {
	type McpLiveRefreshContext,
	refreshMcpLiveTools,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { type } from "arktype";

function mcpTool(name: string): CustomTool<TSchema, MCPToolDetails> {
	return {
		name,
		label: name,
		description: name,
		parameters: type({}),
		mcpServerName: "alpha",
		mcpToolName: "search",
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	} as CustomTool<TSchema, MCPToolDetails>;
}

function makeContext(overrides: Partial<McpLiveRefreshContext["mcpManager"]> = {}): McpLiveRefreshContext {
	const tools = [mcpTool("mcp__alpha_search")];
	return {
		mcpManager: {
			getServerConfig: vi.fn((_name: string) => ({ type: "stdio", command: "alpha" }) as MCPServerConfig),
			getSource: vi.fn((_name: string): SourceMeta | undefined => undefined),
			resolveServerConfig: vi.fn(async (_name: string) => undefined),
			connectServers: vi.fn(
				async (_configs: Record<string, MCPServerConfig>, _sources: Record<string, SourceMeta>) => ({
					errors: new Map<string, string>(),
					connectedServers: ["alpha"],
					tools,
					exaApiKeys: [],
				}),
			),
			disconnectServer: vi.fn(async (_name: string) => {}),
			getConnectionStatus: vi.fn((_name: string): "connected" => "connected"),
			getTools: vi.fn(() => tools),
			...overrides,
		},
		session: {
			refreshMCPTools: vi.fn(async (_tools: CustomTool<TSchema, MCPToolDetails>[]) => {}),
		},
	};
}

describe("refreshMcpLiveTools", () => {
	test("throws instead of reporting live success when reconnect returns an error", async () => {
		const ctx = makeContext({
			connectServers: vi.fn(async () => ({
				errors: new Map([["alpha", "spawn failed"]]),
				connectedServers: [],
				tools: [],
				exaApiKeys: [],
			})),
			getConnectionStatus: vi.fn((_name: string): "disconnected" => "disconnected"),
		});

		await expect(refreshMcpLiveTools(ctx, "alpha", true)).rejects.toThrow("spawn failed");
		expect(ctx.session.refreshMCPTools).not.toHaveBeenCalled();
	});

	test("returns false when the target server is still disconnected after reconnect", async () => {
		const ctx = makeContext({
			getConnectionStatus: vi.fn((_name: string): "disconnected" => "disconnected"),
		});

		await expect(refreshMcpLiveTools(ctx, "alpha", true)).resolves.toBe(false);
		expect(ctx.session.refreshMCPTools).toHaveBeenCalledTimes(1);
		const refreshMock = ctx.session.refreshMCPTools as unknown as {
			mock: { calls: Array<[CustomTool<TSchema, MCPToolDetails>[]]> };
		};
		const [refreshed] = refreshMock.mock.calls[0]!;
		expect(refreshed.map(tool => tool.name)).toEqual(["mcp__alpha_search"]);
	});

	test("resolves and connects only a selected server missing from startup discovery", async () => {
		const config: MCPServerConfig = { type: "stdio", command: "alpha" };
		const source = { path: "/config/mcp.json", level: "user" } as SourceMeta;
		const connectServers = vi.fn(
			async (_configs: Record<string, MCPServerConfig>, _sources: Record<string, SourceMeta>) => ({
				errors: new Map<string, string>(),
				connectedServers: ["alpha"],
				tools: [mcpTool("mcp__alpha_search")],
				exaApiKeys: [],
			}),
		);
		const ctx = makeContext({
			getServerConfig: vi.fn((_name: string) => undefined),
			resolveServerConfig: vi.fn(async (_name: string) => ({ config, source })),
			connectServers,
			getConnectionStatus: vi.fn((_name: string): "connected" => "connected"),
		});

		await expect(refreshMcpLiveTools(ctx, "alpha", true)).resolves.toBe(true);
		expect(connectServers).toHaveBeenCalledWith({ alpha: config }, { alpha: source });
		expect(ctx.session.refreshMCPTools).toHaveBeenCalledTimes(1);
		const refreshMock = ctx.session.refreshMCPTools as unknown as {
			mock: { calls: Array<[CustomTool<TSchema, MCPToolDetails>[]]> };
		};
		const [refreshed] = refreshMock.mock.calls[0]!;
		expect(refreshed.map(tool => tool.name)).toEqual(["mcp__alpha_search"]);
	});

	test("returns false without reconnecting when the selected server is no longer configured", async () => {
		const connectServers = vi.fn(
			async (_configs: Record<string, MCPServerConfig>, _sources: Record<string, SourceMeta>) => ({
				errors: new Map<string, string>(),
				connectedServers: [],
				tools: [],
				exaApiKeys: [],
			}),
		);
		const ctx = makeContext({
			getServerConfig: vi.fn((_name: string) => undefined),
			resolveServerConfig: vi.fn(async (_name: string) => undefined),
			connectServers,
		});

		await expect(refreshMcpLiveTools(ctx, "alpha", true)).resolves.toBe(false);
		expect(connectServers).not.toHaveBeenCalled();
		expect(ctx.session.refreshMCPTools).not.toHaveBeenCalled();
	});
});
