import { describe, expect, it, vi } from "bun:test";
import { type PendingExtensionRequest, requestRpcDialog } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

describe("RPC extension UI", () => {
	it("cancels the remote dialog when its signal aborts", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const controller = new AbortController();
		const result = requestRpcDialog(
			pendingRequests,
			output,
			{ signal: controller.signal },
			false,
			{ method: "confirm", title: "High-risk command", message: "Allow this command?" },
			response => ("confirmed" in response ? response.confirmed : false),
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected the RPC dialog request to carry an id");
		}

		controller.abort();

		expect(await result).toBe(false);
		expect(output).toHaveBeenNthCalledWith(1, {
			type: "extension_ui_request",
			id: request.id,
			method: "confirm",
			title: "High-risk command",
			message: "Allow this command?",
		});
		expect(output).toHaveBeenNthCalledWith(2, {
			type: "extension_ui_request",
			id: expect.any(String),
			method: "cancel",
			targetId: request.id,
		});
		expect(pendingRequests.size).toBe(0);
	});

	it("routes confidential provider input through the generic response broker", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcDialog<string | undefined>(
			pendingRequests,
			output,
			undefined,
			undefined,
			{
				method: "input",
				title: "API key",
				placeholder: "sk-...",
				sensitive: true,
				operationId: "operation-auth",
				purpose: "provider_auth",
				providerId: "openrouter",
			},
			response => ("value" in response ? response.value : undefined),
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected the confidential input request to carry an id");
		}

		const requestFrame = request as Record<string, unknown>;
		expect(requestFrame.type).toBe("extension_ui_request");
		expect(requestFrame.method).toBe("input");
		expect(requestFrame.title).toBe("API key");
		expect(requestFrame.placeholder).toBe("sk-...");
		expect(requestFrame.sensitive).toBe(true);
		expect(requestFrame.operationId).toBe("operation-auth");
		expect(requestFrame.purpose).toBe("provider_auth");
		expect(requestFrame.providerId).toBe("openrouter");
		pendingRequests.get(request.id)?.resolve({
			type: "extension_ui_response",
			id: request.id,
			value: "secret-test-key",
		});

		expect(await result).toBe("secret-test-key");
		expect(pendingRequests.size).toBe(0);
		expect(JSON.stringify(output.mock.calls)).not.toContain("secret-test-key");
	});
});
