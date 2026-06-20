import type { AuthStorage, UsageReport } from "@oh-my-pi/pi-ai";
import type { AutherListEntry, AutherSecret } from "./store";

export type UsageFetchStatus = "ok" | "unavailable";
export type SpendFetchStatus = "ok" | "unavailable";
export type OpenAISpendStatus = SpendFetchStatus | "admin_key_required";

export interface UsageFetchResult {
	generatedAt: number;
	reports: UsageReport[];
	status: UsageFetchStatus;
	error?: string;
}

export interface OpenRouterSpendOkResult {
	kind: "openrouter";
	status: "ok";
	generatedAt: number;
	usageUsd: number;
	dailyUsd?: number;
	weeklyUsd?: number;
	monthlyUsd?: number;
	limitUsd?: number;
	limitRemainingUsd?: number;
	limitReset?: string;
	isFreeTier?: boolean;
}

export interface OpenRouterSpendUnavailableResult {
	kind: "openrouter";
	status: "unavailable";
	generatedAt: number;
	error: string;
}

export type OpenRouterSpendResult = OpenRouterSpendOkResult | OpenRouterSpendUnavailableResult;

export interface OpenAICostLineItem {
	lineItem?: string;
	amountUsd: number;
}

export interface OpenAICostBucket {
	startTime?: number;
	endTime?: number;
	totalUsd: number;
	lineItems: OpenAICostLineItem[];
}

export interface OpenAICostOkResult {
	kind: "openai";
	status: "ok";
	generatedAt: number;
	totalUsd: number;
	buckets: OpenAICostBucket[];
}

export interface OpenAICostUnavailableResult {
	kind: "openai";
	status: "unavailable";
	generatedAt: number;
	error: string;
}

export interface OpenAIAdminKeyRequiredResult {
	kind: "openai";
	status: "admin_key_required";
	generatedAt: number;
	error: string;
}

export type OpenAISpendResult = OpenAICostOkResult | OpenAICostUnavailableResult | OpenAIAdminKeyRequiredResult;
export type SpendResult = OpenRouterSpendResult | OpenAISpendResult;

const USAGE_CACHE_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENAI_COSTS_URL = "https://api.openai.com/v1/organization/costs";
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

let usageCache: { expiresAt: number; result: UsageFetchResult } | undefined;

export async function fetchUsage(storage?: AuthStorage): Promise<UsageFetchResult> {
	const now = Date.now();
	if (usageCache && usageCache.expiresAt > now) return usageCache.result;

	const result = await loadUsage(storage);
	usageCache = { expiresAt: now + USAGE_CACHE_MS, result };
	return result;
}

export async function fetchOpenRouterSpend(key: string): Promise<OpenRouterSpendResult> {
	const generatedAt = Date.now();
	try {
		const response = await fetch(OPENROUTER_KEY_URL, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) {
			return {
				kind: "openrouter",
				status: "unavailable",
				generatedAt,
				error: `OpenRouter returned HTTP ${response.status}`,
			};
		}
		const body: unknown = await response.json();
		const fields = isRecord(body) && isRecord(body.data) ? body.data : body;
		const usageUsd = numberField(fields, "usage");
		if (usageUsd === undefined) {
			return {
				kind: "openrouter",
				status: "unavailable",
				generatedAt,
				error: "OpenRouter response did not include numeric usage",
			};
		}
		return {
			kind: "openrouter",
			status: "ok",
			generatedAt,
			usageUsd,
			dailyUsd: numberField(fields, "usage_daily"),
			weeklyUsd: numberField(fields, "usage_weekly"),
			monthlyUsd: numberField(fields, "usage_monthly"),
			limitUsd: numberField(fields, "limit"),
			limitRemainingUsd: numberField(fields, "limit_remaining"),
			limitReset: stringField(fields, "limit_reset"),
			isFreeTier: booleanField(fields, "is_free_tier"),
		};
	} catch (error) {
		return {
			kind: "openrouter",
			status: "unavailable",
			generatedAt,
			error: describeError(error),
		};
	}
}

export async function fetchOpenAICosts(
	key: string,
	options: { startTimeSec?: number } = {},
): Promise<OpenAISpendResult> {
	const generatedAt = Date.now();
	if (!key.startsWith("sk-admin-")) {
		return {
			kind: "openai",
			status: "admin_key_required",
			generatedAt,
			error: "OpenAI organization costs require an sk-admin key",
		};
	}

	const startTimeSec = options.startTimeSec ?? Math.floor(generatedAt / 1000) - THIRTY_DAYS_SECONDS;
	const url = new URL(OPENAI_COSTS_URL);
	url.searchParams.set("start_time", String(startTimeSec));
	url.searchParams.set("bucket_width", "1d");
	url.searchParams.set("group_by", "line_item");

	try {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) {
			return {
				kind: "openai",
				status: "unavailable",
				generatedAt,
				error: `OpenAI returned HTTP ${response.status}`,
			};
		}
		const body: unknown = await response.json();
		const buckets = parseOpenAIBuckets(body);
		if (buckets === null) {
			return {
				kind: "openai",
				status: "unavailable",
				generatedAt,
				error: "OpenAI response did not include cost buckets",
			};
		}
		let totalUsd = 0;
		for (const bucket of buckets) totalUsd += bucket.totalUsd;
		return { kind: "openai", status: "ok", generatedAt, totalUsd, buckets };
	} catch (error) {
		return {
			kind: "openai",
			status: "unavailable",
			generatedAt,
			error: describeError(error),
		};
	}
}

export async function fetchSpendForEntry(
	entry: AutherListEntry,
	secret: AutherSecret | null,
): Promise<SpendResult | null> {
	if (entry.category === "not_applicable" || !entry.isApiKey || secret?.type !== "api_key" || !secret.key) {
		return null;
	}
	if (entry.spendKind === "openrouter") return fetchOpenRouterSpend(secret.key);
	if (entry.spendKind === "openai") return fetchOpenAICosts(secret.key);
	return null;
}

async function loadUsage(storage: AuthStorage | undefined): Promise<UsageFetchResult> {
	const generatedAt = Date.now();
	if (!storage) {
		return { generatedAt, reports: [], status: "unavailable", error: "Auth storage is unavailable" };
	}
	try {
		const reports = await storage.fetchUsageReports({ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (reports === null) {
			return { generatedAt, reports: [], status: "unavailable", error: "Usage reports are unavailable" };
		}
		return {
			generatedAt,
			reports: reports.map(report => {
				const { raw: _raw, ...rest } = report;
				return rest;
			}),
			status: "ok",
		};
	} catch (error) {
		return { generatedAt, reports: [], status: "unavailable", error: describeError(error) };
	}
}

function parseOpenAIBuckets(body: unknown): OpenAICostBucket[] | null {
	if (!isRecord(body) || !Array.isArray(body.data)) return null;
	const data = body.data;
	const buckets: OpenAICostBucket[] = [];
	for (const rawBucket of data) {
		if (!isRecord(rawBucket)) continue;
		const lineItems: OpenAICostLineItem[] = [];
		const results = Array.isArray(rawBucket.results) ? rawBucket.results : [];
		let totalUsd = 0;
		for (const rawResult of results) {
			if (!isRecord(rawResult)) continue;
			const amount = rawResult.amount;
			if (!isRecord(amount)) continue;
			const amountUsd = numberField(amount, "value");
			if (amountUsd === undefined) continue;
			totalUsd += amountUsd;
			lineItems.push({ lineItem: stringField(rawResult, "line_item"), amountUsd });
		}
		buckets.push({
			startTime: numberField(rawBucket, "start_time"),
			endTime: numberField(rawBucket, "end_time"),
			totalUsd,
			lineItems,
		});
	}
	return buckets;
}

function numberField(value: unknown, key: string): number | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return typeof field === "string" && field.length > 0 ? field : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return typeof field === "boolean" ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	return "Unknown error";
}
