import { describe, expect, test } from "bun:test";
import { decodeUsageReadResult } from "@oh-my-pi/app-wire";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../src/config/model-registry";
import { createAppserverRuntime } from "../src/session/appserver-authority";
import { createAppserverUsageAuthority } from "../src/session/appserver-usage";
import type { AuthStorage } from "../src/session/auth-storage";

const report = {
	provider: "anthropic",
	fetchedAt: 1_800_000_000_000,
	limits: [
		{
			id: "five-hour",
			label: "5 Hour",
			scope: { provider: "anthropic", accountId: "account-1", windowId: "5h" },
			window: { id: "5h", label: "5 Hour", durationMs: 18_000_000 },
			amount: { usedFraction: 1.2, remainingFraction: 0, unit: "percent" },
		},
	],
	metadata: {
		email: "user@example.com",
		accountId: "account-1",
		endpoint: "https://api.anthropic.com/v1/organizations/me?token=must-not-cross-wire",
		apiKey: "must-not-cross-wire",
	},
	raw: { token: "must-not-cross-wire" },
} satisfies UsageReport;

describe("appserver usage authority", () => {
	test("projects provider metadata, strips secrets, and bounds overage capacity", async () => {
		const authStorage = {
			fetchUsageReports: async () => [report],
			getAll: () => ({
				anthropic: {
					type: "oauth",
					access: "secret-access",
					refresh: "secret-refresh",
					expires: 1_900_000_000_000,
					email: "user@example.com",
					accountId: "account-1",
				},
			}),
			usageProviderFor: (provider: string) =>
				provider === "anthropic" ? { fetchUsage: async () => null } : undefined,
		} as unknown as AuthStorage;
		const modelRegistry = {
			getProviderBaseUrl: () => undefined,
		} as Pick<ModelRegistry, "getProviderBaseUrl">;
		const authority = createAppserverUsageAuthority(authStorage, modelRegistry);
		const result = await authority.read(new AbortController().signal);

		expect(result.reports).toEqual(
			[
				{
					...report,
					metadata: { email: "user@example.com", accountId: "account-1" },
					raw: undefined,
				},
			].map(({ raw: _raw, ...safe }) => safe),
		);
		expect(result.accountsWithoutUsage).toEqual([]);
		expect(result.capacity).toEqual({
			anthropic: [{ window: "5h", durationMs: 18_000_000, accounts: 1, usedAccounts: 1, remainingAccounts: 0 }],
		});
		expect(JSON.stringify(result)).not.toContain("must-not-cross-wire");
		expect(JSON.stringify(result)).not.toContain("secret-access");
		expect(() => decodeUsageReadResult(result)).not.toThrow();
	});

	test("propagates cancellation to broker-backed usage collection", async () => {
		const controller = new AbortController();
		const authStorage = {
			fetchUsageReports: async ({ signal }: { signal?: AbortSignal }) => {
				expect(signal).toBe(controller.signal);
				throw signal?.reason;
			},
			getAll: () => ({}),
			usageProviderFor: () => undefined,
		} as unknown as AuthStorage;
		const authority = createAppserverUsageAuthority(authStorage, {
			getProviderBaseUrl: () => undefined,
		});
		controller.abort(new Error("cancelled"));
		await expect(authority.read(controller.signal)).rejects.toThrow("cancelled");
	});

	test("registers usage and broker authorities from the default runtime inputs", () => {
		const runtime = createAppserverRuntime({
			projectCatalog: false,
			sessionsDir: "/tmp/omp-appserver-authority-test-sessions",
			lifecycleMetadataPath: "/tmp/omp-appserver-authority-test-lifecycle.json",
			authStorage: {
				fetchUsageReports: async () => [],
				getAll: () => ({}),
				usageProviderFor: () => undefined,
				getGeneration: () => 0,
			} as unknown as AuthStorage,
			modelRegistry: {
				getAll: () => [],
				getAvailable: () => [],
				getProviderBaseUrl: () => undefined,
			},
		});

		expect(runtime.usageAuthority?.read).toBeFunction();
		expect(runtime.operationsAuthority.brokerStatus).toBeFunction();
	});
});
