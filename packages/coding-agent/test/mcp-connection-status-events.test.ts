import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import type { MCPServerConfig, MCPServerConnection, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { createMockConnection, createMockTransport } from "./mcp-test-utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const BUN_EXEC = process.execPath;

describe("MCPManager connection status events", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-status-"));
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
		vi.restoreAllMocks();
	});

	it("emits connecting, connected, and failed updates for startup status", async () => {
		const manager = new MCPManager(workDir);
		const events: McpConnectionStatusEvent[] = [];
		const success: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};
		const invalid: MCPServerConfig = { type: "stdio", command: "" };

		try {
			const result = await manager.connectServers({ alpha: success, broken: invalid }, {}, event =>
				events.push(event),
			);

			expect(result.connectedServers).toContain("alpha");
			expect(result.errors.get("broken")).toBe('Server "broken": stdio server requires "command" field');
			expect(events).toEqual([
				{ type: "connecting", serverNames: ["alpha", "broken"] },
				{ type: "failed", serverName: "broken", error: 'Server "broken": stdio server requires "command" field' },
				{ type: "connected", serverName: "alpha" },
			]);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("preserves existing tools when a subset connect skips already-connected servers", async () => {
		const manager = new MCPManager(workDir);
		const config: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};

		try {
			await manager.connectServers({ alpha: config, beta: config }, {});
			const before = manager.getTools().map(tool => tool.name);
			expect(before.some(name => name.startsWith("mcp__alpha_"))).toBe(true);
			expect(before.some(name => name.startsWith("mcp__beta_"))).toBe(true);

			await manager.connectServers({ alpha: config }, {});

			const after = manager.getTools().map(tool => tool.name);
			expect(after.some(name => name.startsWith("mcp__alpha_"))).toBe(true);
			expect(after.some(name => name.startsWith("mcp__beta_"))).toBe(true);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("disconnects dashed server names using MCP server identity", async () => {
		const manager = new MCPManager(workDir);
		const config: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};

		try {
			await manager.connectServers({ "my-server": config }, {});
			const before = manager.getTools();
			expect(before.some(tool => tool.mcpServerName === "my-server")).toBe(true);

			await manager.disconnectServer("my-server");

			expect(manager.getTools().some(tool => tool.mcpServerName === "my-server")).toBe(false);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("disconnecting one server preserves prefix-overlap sibling tools", async () => {
		const manager = new MCPManager(workDir);
		const config: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};

		try {
			await manager.connectServers({ alpha: config, alpha_beta: config }, {});
			expect(manager.getTools().some(tool => tool.mcpServerName === "alpha")).toBe(true);
			expect(manager.getTools().some(tool => tool.mcpServerName === "alpha_beta")).toBe(true);

			await manager.disconnectServer("alpha");

			expect(manager.getTools().some(tool => tool.mcpServerName === "alpha")).toBe(false);
			expect(manager.getTools().some(tool => tool.mcpServerName === "alpha_beta")).toBe(true);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("preserves tools registered by a sibling connection that finishes during another connect", async () => {
		const manager = new MCPManager(workDir);
		const fastConfig: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};
		const slowConfig: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH, "--delay", "120"],
		};

		try {
			const slowConnect = manager.connectServers({ beta: slowConfig }, {});
			await Bun.sleep(20);
			await manager.connectServers({ alpha: fastConfig }, {});
			await slowConnect;

			expect(manager.getTools().some(tool => tool.mcpServerName === "alpha")).toBe(true);
			expect(manager.getTools().some(tool => tool.mcpServerName === "beta")).toBe(true);
		} finally {
			await manager.disconnectAll();
		}
	});
	it("closes a connection that resolves after its server was disconnected", async () => {
		const manager = new MCPManager(workDir);
		const deferred = Promise.withResolvers<MCPServerConnection>();
		const connectStarted = Promise.withResolvers<void>();
		const connect = spyOn(mcpClient, "connectToServer").mockImplementation(() => {
			connectStarted.resolve();
			return deferred.promise;
		});
		let closeCalls = 0;
		const transport: MCPTransport = createMockTransport(new Map());
		transport.close = async () => {
			closeCalls++;
		};
		const connection = createMockConnection({}, transport);
		const config: MCPServerConfig = { type: "stdio", command: "deferred-server" };

		const connecting = manager.connectServers({ deferred: config }, {});
		await connectStarted.promise;
		expect(connect).toHaveBeenCalledTimes(1);
		await manager.disconnectServer("deferred");
		deferred.resolve(connection);
		const result = await connecting;

		expect(closeCalls).toBe(1);
		expect(result.connectedServers).not.toContain("deferred");
		expect(manager.getConnectedServers()).not.toContain("deferred");
		expect(manager.getAllServerNames()).not.toContain("deferred");
		expect(await manager.reconnectServer("deferred")).toBeNull();
	});
	it("does not let a disabled server's stale reconnect replace a live re-enable", async () => {
		const manager = new MCPManager(workDir);
		const config: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};

		try {
			await manager.connectServers({ alpha: config }, {});
			const staleTools = Promise.withResolvers<{ tools: [] }>();
			const staleToolsStarted = Promise.withResolvers<void>();
			const staleTransport = createMockTransport(new Map());
			staleTransport.request = async <T>(method: string): Promise<T> => {
				if (method !== "tools/list") throw new Error(`Unexpected request: ${method}`);
				staleToolsStarted.resolve();
				return (await staleTools.promise) as T;
			};
			let staleCloseCalls = 0;
			staleTransport.close = async () => {
				staleCloseCalls++;
			};
			const staleConnection = createMockConnection({ tools: {} }, staleTransport);
			const currentTransport = createMockTransport(new Map([["tools/list", [{ tools: [] }]]]));
			const currentConnection = createMockConnection({ tools: {} }, currentTransport);
			let connectCalls = 0;
			spyOn(mcpClient, "connectToServer").mockImplementation(() => {
				connectCalls++;
				return Promise.resolve(connectCalls === 1 ? staleConnection : currentConnection);
			});

			const staleReconnect = manager.reconnectServer("alpha");
			await staleToolsStarted.promise;
			await manager.disconnectServer("alpha");
			const reenabled = await manager.connectServers({ alpha: config }, {});
			expect(reenabled.connectedServers).toContain("alpha");

			staleTools.resolve({ tools: [] });
			await expect(staleReconnect).resolves.toBeNull();
			expect(staleCloseCalls).toBe(1);
			expect(await manager.waitForConnection("alpha")).toBe(currentConnection);
		} finally {
			await manager.disconnectAll();
		}
	});
});
