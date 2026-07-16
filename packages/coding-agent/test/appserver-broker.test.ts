import { describe, expect, test } from "bun:test";
import { createAppserverBrokerStatus } from "../src/session/appserver-broker";
import type { AuthStorage } from "../src/session/auth-storage";

const authStorage = { getGeneration: () => 7 } as AuthStorage;
const signal = new AbortController().signal;

describe("appserver broker status", () => {
	test("reports local auth storage without inventing a broker endpoint", async () => {
		const status = createAppserverBrokerStatus({
			authStorage,
			resolveConfig: async () => null,
		});
		await expect(status(signal)).resolves.toEqual({ state: "local", generation: 7 });
	});

	test("redacts configured endpoints when the token is missing", async () => {
		const status = createAppserverBrokerStatus({
			authStorage,
			configuredUrl: "https://user:password@broker.example/path?token=secret#fragment",
			resolveConfig: async () => {
				throw new Error("missing token=must-not-cross-wire");
			},
		});
		const result = await status(signal);
		expect(result).toEqual({ state: "missing-token", endpoint: "https://broker.example/path", generation: 7 });
		expect(JSON.stringify(result)).not.toContain("password");
		expect(JSON.stringify(result)).not.toContain("secret");
	});

	test("proves a configured broker connection without returning its token", async () => {
		const token = "must-not-cross-wire";
		const status = createAppserverBrokerStatus({
			authStorage,
			resolveConfig: async () => ({ url: "https://broker.example/", token }),
			clientFactory: config => ({
				fetchSnapshot: async () => {
					expect(config.token).toBe(token);
					return { status: 304 as const, generation: 7 };
				},
			}),
		});
		const result = await status(signal);
		expect(result).toEqual({ state: "connected", endpoint: "https://broker.example/", generation: 7 });
		expect(JSON.stringify(result)).not.toContain(token);
	});

	test("propagates cancellation instead of reporting the broker unreachable", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled");
		const status = createAppserverBrokerStatus({
			authStorage,
			resolveConfig: async () => ({ url: "https://broker.example/", token: "secret" }),
			clientFactory: () => ({
				fetchSnapshot: async options => {
					const requestSignal = options?.signal;
					return await new Promise<never>((_resolve, reject) => {
						requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
					});
				},
			}),
		});
		const pending = status(controller.signal);
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
	});

	test("keeps a safe endpoint when the broker is unreachable", async () => {
		const status = createAppserverBrokerStatus({
			authStorage,
			resolveConfig: async () => ({ url: "http://broker.internal:8765", token: "secret" }),
			clientFactory: () => ({
				fetchSnapshot: async () => {
					throw new Error("offline token=must-not-cross-wire");
				},
			}),
		});
		const result = await status(signal);
		expect(result).toEqual({ state: "unreachable", endpoint: "http://broker.internal:8765/", generation: 7 });
		expect(JSON.stringify(result)).not.toContain("secret");
	});
});
