import { describe, expect, it, vi } from "bun:test";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { CustomToolContext } from "../src/extensibility/custom-tools/types";
import type { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { RegisteredTool } from "../src/extensibility/extensions/types";
import { wrapRegisteredTool } from "../src/extensibility/extensions/wrapper";
import { MCPManager } from "../src/mcp/manager";
import { DeferredMCPTool, MCPTool } from "../src/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolDefinition } from "../src/mcp/types";
import { customToolToDefinition } from "../src/sdk";
import { createMCPProxyTools } from "../src/task/executor";
import { ToolAbortError } from "../src/tools/tool-errors";
import { createMockConnection, createMockTransport } from "./mcp-test-utils";

type CapturedRequest = { method: string; params: Record<string, unknown> | undefined };

const unusedContext = {} as CustomToolContext;

/** Strict MCP tool: `additionalProperties:false`, one required + one optional field. */
const STRICT_TOOL: MCPToolDefinition = {
	name: "comment",
	description: "Post a comment",
	inputSchema: {
		type: "object",
		properties: {
			body: { type: "string" },
			optional: { type: "string" },
		},
		required: ["body"],
		additionalProperties: false,
	},
};

function createCapturedConnection(calls: CapturedRequest[]): MCPServerConnection {
	const transport = createMockTransport(
		new Map([["tools/call", [{ content: [{ type: "text", text: "ok" }] }]]]),
		(method, params) => calls.push({ method, params }),
	);
	return createMockConnection({ tools: {} }, transport);
}

describe("MCP tool strict declaration", () => {
	it("declares strict:false on MCPTool", () => {
		const tool = new MCPTool(createCapturedConnection([]), STRICT_TOOL);
		expect(tool.strict).toBe(false);
	});

	it("declares strict:false on DeferredMCPTool", () => {
		const connection = createCapturedConnection([]);
		const tool = new DeferredMCPTool("srv", STRICT_TOOL, async () => connection);
		expect(tool.strict).toBe(false);
	});

	it("propagates strict:false onto Task proxy definitions", () => {
		const manager = new MCPManager(process.cwd());
		vi.spyOn(manager, "getTools").mockReturnValue([new MCPTool(createCapturedConnection([]), STRICT_TOOL)]);
		const [proxy] = createMCPProxyTools(manager);
		expect(proxy?.strict).toBe(false);
	});

	it("survives the custom-tool → definition bridge into the registered session tool", () => {
		const manager = new MCPManager(process.cwd());
		vi.spyOn(manager, "getTools").mockReturnValue([new MCPTool(createCapturedConnection([]), STRICT_TOOL)]);
		const [proxy] = createMCPProxyTools(manager);
		if (!proxy) {
			expect.unreachable("no proxy tool created");
			return;
		}
		const definition = customToolToDefinition(proxy);
		expect(definition.strict).toBe(false);
		const adapter = wrapRegisteredTool(
			{ definition, extensionPath: "<sdk>" } as RegisteredTool,
			{ createContext: () => ({}) } as unknown as ExtensionRunner,
		);
		expect(adapter.strict).toBe(false);
	});
});

describe("Task MCP proxy parity", () => {
	const NOISY_INPUT = { body: "x", optional: "", [INTENT_FIELD]: "js prelude" };
	const CLEAN_ARGS = { body: "x" };

	it("strips harness intent and empty placeholders on the parent direct path", async () => {
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), STRICT_TOOL);

		await tool.execute("call-1", NOISY_INPUT, undefined, unusedContext, undefined);

		expect(calls).toEqual([{ method: "tools/call", params: { name: "comment", arguments: CLEAN_ARGS } }]);
	});

	it("strips harness intent and empty placeholders through the Task proxy path", async () => {
		const calls: CapturedRequest[] = [];
		const manager = new MCPManager(process.cwd());
		vi.spyOn(manager, "getTools").mockReturnValue([new MCPTool(createCapturedConnection(calls), STRICT_TOOL)]);

		const [proxy] = createMCPProxyTools(manager);
		if (!proxy?.execute) {
			expect.unreachable("proxy tool missing execute");
			return;
		}

		await proxy.execute("call-1", NOISY_INPUT, undefined, unusedContext, undefined);

		// Identical outbound arguments to the parent path — no `i`, no empty optional.
		expect(calls).toEqual([{ method: "tools/call", params: { name: "comment", arguments: CLEAN_ARGS } }]);
	});

	it("preserves `i` through the Task proxy when the server declares it", async () => {
		const calls: CapturedRequest[] = [];
		const definition: MCPToolDefinition = {
			name: "echo",
			description: "Echo",
			inputSchema: { type: "object", properties: { i: { type: "string" } }, required: ["i"] },
		};
		const manager = new MCPManager(process.cwd());
		vi.spyOn(manager, "getTools").mockReturnValue([new MCPTool(createCapturedConnection(calls), definition)]);

		const [proxy] = createMCPProxyTools(manager);
		if (!proxy?.execute) {
			expect.unreachable("proxy tool missing execute");
			return;
		}

		await proxy.execute("call-1", { i: "hello" }, undefined, unusedContext, undefined);

		expect(calls).toEqual([{ method: "tools/call", params: { name: "echo", arguments: { i: "hello" } } }]);
	});

	it("re-resolves the source tool by MCP metadata so a reconnect replacement is honored", async () => {
		const staleCalls: CapturedRequest[] = [];
		const freshCalls: CapturedRequest[] = [];
		const manager = new MCPManager(process.cwd());

		const staleTool = new MCPTool(createCapturedConnection(staleCalls), STRICT_TOOL);
		const freshTool = new MCPTool(createCapturedConnection(freshCalls), STRICT_TOOL);

		const getTools = vi.spyOn(manager, "getTools").mockReturnValue([staleTool]);
		const [proxy] = createMCPProxyTools(manager); // captured while stale tool is current

		// Reconnect swaps the instance in getTools() before the proxy executes.
		getTools.mockReturnValue([freshTool]);

		if (!proxy?.execute) {
			expect.unreachable("proxy tool missing execute");
			return;
		}
		await proxy.execute("call-1", { body: "x" }, undefined, unusedContext, undefined);

		expect(freshCalls).toHaveLength(1);
		expect(staleCalls).toHaveLength(0);
	});

	it("normalizes structured text payloads before downstream rendering", async () => {
		const manager = new MCPManager(process.cwd());
		const source = {
			name: "mcp__srv_comment",
			label: "Comment",
			description: "Comment",
			parameters: STRICT_TOOL.inputSchema,
			strict: false,
			mcpServerName: "srv",
			mcpToolName: "comment",
			execute: vi.fn(async () => ({
				content: [{ type: "text", text: { answer: "ok" } }],
				details: {},
			})),
		};
		vi.spyOn(manager, "getTools").mockReturnValue([source as never]);

		const [proxy] = createMCPProxyTools(manager);
		if (!proxy?.execute) {
			expect.unreachable("proxy tool missing execute");
			return;
		}
		const result = await proxy.execute("call-1", { body: "x" }, undefined, unusedContext, undefined);

		expect(result.content).toEqual([{ type: "text", text: '{"answer":"ok"}' }]);
	});

	it("passes cancellation to the live MCP call and does not retry", async () => {
		const manager = new MCPManager(process.cwd());
		let receivedSignal: AbortSignal | undefined;
		const source = {
			name: "mcp__srv_comment",
			label: "Comment",
			description: "Comment",
			parameters: STRICT_TOOL.inputSchema,
			strict: false,
			mcpServerName: "srv",
			mcpToolName: "comment",
			execute: vi.fn(
				async (_toolCallId: string, _params: unknown, _onUpdate: unknown, _ctx: unknown, signal?: AbortSignal) => {
					receivedSignal = signal;
					return await new Promise<never>((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new ToolAbortError()), { once: true });
					});
				},
			),
		};
		vi.spyOn(manager, "getTools").mockReturnValue([source as never]);

		const [proxy] = createMCPProxyTools(manager);
		if (!proxy?.execute) {
			expect.unreachable("proxy tool missing execute");
			return;
		}
		const controller = new AbortController();
		const pending = proxy.execute("call-1", { body: "x" }, undefined, unusedContext, controller.signal);
		controller.abort();

		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
		expect(receivedSignal?.aborted).toBe(true);
		expect(source.execute).toHaveBeenCalledTimes(1);
	});
});
