import { describe, expect, it } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";
import { registerRpcSessionTeardown } from "./rpc-session-teardown";

describe("registerRpcSessionTeardown", () => {
	it("uses one signal-safe teardown promise and preserves the first reason", async () => {
		const dispose = Promise.withResolvers<void>();
		const calls: string[] = [];
		let callback: ((reason: postmortem.Reason) => void | Promise<void>) | undefined;
		const handle = registerRpcSessionTeardown(
			{
				beginDispose: () => calls.push("begin"),
				cleanupProtocol: () => calls.push("protocol"),
				disposeSession: async reason => {
					calls.push(`dispose:${reason}`);
					await dispose.promise;
				},
			},
			(id, registered) => {
				expect(id).toBe("rpc-session-teardown");
				callback = registered;
				return () => calls.push("unregister");
			},
		);
		if (!callback) throw new Error("cleanup callback was not registered");

		const signal = callback(postmortem.Reason.SIGTERM) as Promise<void>;
		expect(calls).toEqual(["begin", "protocol", "dispose:sigterm"]);
		const concurrent = handle.shutdown(postmortem.Reason.MANUAL);
		expect(concurrent).toBe(signal);
		expect(calls).toEqual(["begin", "protocol", "dispose:sigterm", "unregister"]);

		dispose.resolve();
		await Promise.all([signal, concurrent]);
		expect(calls.filter(call => call === "begin")).toHaveLength(1);
		expect(calls.filter(call => call.startsWith("dispose:"))).toEqual(["dispose:sigterm"]);
	});

	it("unregisters before graceful EOF-style shutdown and still disposes after protocol cleanup fails", async () => {
		const calls: string[] = [];
		const handle = registerRpcSessionTeardown(
			{
				beginDispose: () => calls.push("begin"),
				cleanupProtocol: () => {
					calls.push("protocol");
					throw new Error("protocol cleanup failed");
				},
				disposeSession: async reason => {
					calls.push(`dispose:${String(reason)}`);
				},
			},
			() => () => calls.push("unregister"),
		);

		await expect(handle.shutdown()).rejects.toThrow("protocol cleanup failed");
		expect(calls).toEqual(["unregister", "begin", "protocol", "dispose:undefined"]);
	});
});
