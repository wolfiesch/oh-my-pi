import { describe, expect, test } from "bun:test";
import {
	RpcPendingExtensionRequests,
	requestRpcPrivilegedConfirmation,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcExtensionUIRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

describe("RPC privileged confirmation", () => {
	test("binds privileged confirmations to the server-issued operation and command", async () => {
		const pending = new RpcPendingExtensionRequests();
		const frames: RpcExtensionUIRequest[] = [];
		const confirmation = requestRpcPrivilegedConfirmation(
			pending,
			frame => frames.push(frame as RpcExtensionUIRequest),
			"delete_session",
			"Delete session?",
			"Delete session-1?",
			{ timeout: 1000 },
		);
		const request = frames[0];
		expect(request).toMatchObject({
			method: "confirm",
			command: "delete_session",
		});
		if (request.method !== "confirm") throw new Error("missing confirmation request");
		expect(request.operationId).toBeString();
		pending.get(request.id)?.resolve({
			type: "extension_ui_response",
			id: request.id,
			confirmed: true,
			operationId: request.operationId,
		});
		expect(await confirmation).toBe(true);
	});

	test("rejects a privileged confirmation with a mismatched operation id", async () => {
		const pending = new RpcPendingExtensionRequests();
		const frames: RpcExtensionUIRequest[] = [];
		const confirmation = requestRpcPrivilegedConfirmation(
			pending,
			frame => frames.push(frame as RpcExtensionUIRequest),
			"delete_session",
			"Delete session?",
			"Delete session-1?",
			{ timeout: 1000 },
		);
		const request = frames[0];
		if (request.method !== "confirm") throw new Error("missing confirmation request");
		pending.get(request.id)?.resolve({
			type: "extension_ui_response",
			id: request.id,
			confirmed: true,
			operationId: "wrong-operation",
		});
		expect(await confirmation).toBe(false);
	});

	test("fails closed when the host never answers or disconnects", async () => {
		const expired = requestRpcPrivilegedConfirmation(
			new RpcPendingExtensionRequests(),
			() => {},
			"delete_session",
			"Delete session?",
			"Delete session-1?",
			{ timeout: 1 },
		);
		expect(await expired).toBe(false);

		const pending = new RpcPendingExtensionRequests();
		const disconnected = requestRpcPrivilegedConfirmation(
			pending,
			() => {},
			"delete_session",
			"Delete session?",
			"Delete session-1?",
			{ timeout: 1000 },
		);
		pending.rejectAll("disconnected");
		await expect(disconnected).rejects.toThrow("disconnected");
	});
});
