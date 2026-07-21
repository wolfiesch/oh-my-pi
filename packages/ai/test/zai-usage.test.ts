import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { zaiUsageProvider } from "@oh-my-pi/pi-ai/usage/zai";

function makeCredential(): UsageFetchParams["credential"] {
	return {
		type: "api_key",
		apiKey: "zai-test-key",
	};
}

function makeCtx(payload: unknown): UsageFetchContext {
	const fetch: FetchImpl = async input => {
		const url = String(input);
		if (url.includes("/api/monitor/usage/model-usage")) {
			return new Response(JSON.stringify({ success: true, data: {} }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch };
}

describe("zai usage provider", () => {
	it("preserves Z.AI token quota windows instead of treating them as separate accounts", async () => {
		const report = await zaiUsageProvider.fetchUsage!(
			{ provider: "zai", credential: makeCredential(), signal: undefined },
			makeCtx({
				success: true,
				data: {
					limits: [
						{
							type: "TIME_LIMIT",
							usage: 100,
							currentValue: 0,
							percentage: 0,
							remaining: 100,
							nextResetTime: 1784547608994,
							unit: 5,
							number: 1,
							usageDetails: [
								{ modelCode: "search-prime", usage: 0 },
								{ modelCode: "web-reader", usage: 0 },
								{ modelCode: "zread", usage: 0 },
							],
						},
						{ type: "TOKENS_LIMIT", percentage: 82, nextResetTime: 1782656863894, unit: 3, number: 5 },
						{ type: "TOKENS_LIMIT", percentage: 38, nextResetTime: 1783165208993, unit: 6, number: 1 },
					],
				},
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits.map(limit => limit.id)).toEqual([
			"zai:features:web-search-reader-zread:1mo",
			"zai:tokens:5h",
			"zai:tokens:1w",
		]);
		expect(report!.limits.map(limit => limit.label)).toEqual([
			"ZAI Web Search / Reader / Zread Quota",
			"ZAI 5-hour Token Quota",
			"ZAI Weekly Token Quota",
		]);
		expect(report!.limits.map(limit => limit.scope.windowId)).toEqual(["1mo", "5h", "1w"]);
		expect(report!.limits.map(limit => limit.scope.shared)).toEqual([false, true, true]);
		expect(report!.limits[0]?.scope.tier).toBe("web-search-reader-zread");
		expect(report!.limits.map(limit => limit.window?.durationMs)).toEqual([
			30 * 24 * 60 * 60 * 1000,
			5 * 60 * 60 * 1000,
			7 * 24 * 60 * 60 * 1000,
		]);
	});

	it("treats numeric weekly token quota counts as the Z.AI rolling day window", async () => {
		const report = await zaiUsageProvider.fetchUsage!(
			{ provider: "zai", credential: makeCredential(), signal: undefined },
			makeCtx({
				success: true,
				data: {
					limits: [
						{ type: "TOKENS_LIMIT", percentage: 38, nextResetTime: 1783165208993, unit: 6, number: 7 },
						{ type: "TOKENS_LIMIT", percentage: 12, nextResetTime: 1783765208993, unit: "w", number: 7 },
					],
				},
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits.map(limit => limit.id)).toEqual(["zai:tokens:1w", "zai:tokens:7w"]);
		expect(report!.limits.map(limit => limit.label)).toEqual(["ZAI Weekly Token Quota", "ZAI 7-week Token Quota"]);
		expect(report!.limits.map(limit => limit.scope.windowId)).toEqual(["1w", "7w"]);
		expect(report!.limits.map(limit => limit.window?.durationMs)).toEqual([
			7 * 24 * 60 * 60 * 1000,
			7 * 7 * 24 * 60 * 60 * 1000,
		]);
	});

	it("keeps Z.AI quota window ids distinct when units are string-coded or omitted", async () => {
		const report = await zaiUsageProvider.fetchUsage!(
			{ provider: "zai", credential: makeCredential(), signal: undefined },
			makeCtx({
				success: true,
				data: {
					limits: [
						{ type: "TOKENS_LIMIT", percentage: 82, nextResetTime: 1782656863894, unit: "h", number: 5 },
						{ type: "TOKENS_LIMIT", percentage: 38, nextResetTime: 1783165208993, unit: "w", number: 1 },
						{ type: "TOKENS_LIMIT", percentage: 12, nextResetTime: 1783251608993 },
						{ type: "TOKENS_LIMIT", percentage: 18, nextResetTime: 1783338008993, unit: "rolling" },
					],
				},
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits.map(limit => limit.id)).toEqual([
			"zai:tokens:5h",
			"zai:tokens:1w",
			"zai:tokens:tokens-limit-reset-1783251608993",
			"zai:tokens:1urolling-tokens-limit-reset-1783338008993",
		]);
		expect(report!.limits.map(limit => limit.scope.windowId)).toEqual([
			"5h",
			"1w",
			"tokens-limit-reset-1783251608993",
			"1urolling-tokens-limit-reset-1783338008993",
		]);
	});

	it("disambiguates duplicate fallback window IDs sharing a reset time on collision", async () => {
		const report = await zaiUsageProvider.fetchUsage!(
			{ provider: "zai", credential: makeCredential(), signal: undefined },
			makeCtx({
				success: true,
				data: {
					limits: [
						{ type: "TOKENS_LIMIT", percentage: 12, nextResetTime: 1783251608993 },
						{ type: "TOKENS_LIMIT", percentage: 18, nextResetTime: 1783251608993 },
					],
				},
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits.map(limit => limit.id)).toEqual([
			"zai:tokens:tokens-limit-reset-1783251608993",
			"zai:tokens:tokens-limit-reset-1783251608993-row-2-1",
		]);
	});
});
