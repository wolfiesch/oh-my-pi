import type { UsageReadResult, UsageWireMetadata, UsageWireReport } from "@oh-my-pi/app-wire";
import type { AuthStorage, UsageReport } from "@oh-my-pi/pi-ai";
import {
	collectStoredAccounts,
	collectUnreportedAccounts,
	computeProviderWindowStats,
	selectReportableAccounts,
} from "../cli/usage-cli";

const METADATA_STRING_KEYS = [
	"email",
	"accountId",
	"projectId",
	"orgId",
	"orgName",
	"planType",
	"plan",
	"currentTierId",
	"currentTierName",
	"source",
	"period",
	"quotaResetDate",
] as const satisfies readonly (keyof UsageWireMetadata)[];
const METADATA_BOOLEAN_KEYS = ["allowed", "limitReached"] as const satisfies readonly (keyof UsageWireMetadata)[];

function projectMetadata(metadata: Record<string, unknown> | undefined): UsageWireMetadata | undefined {
	if (!metadata) return undefined;
	const result: Record<string, string | boolean> = {};
	for (const key of METADATA_STRING_KEYS) {
		const value = metadata[key];
		if (typeof value === "string") result[key] = value;
	}
	for (const key of METADATA_BOOLEAN_KEYS) {
		const value = metadata[key];
		if (typeof value === "boolean") result[key] = value;
	}
	return Object.keys(result).length > 0 ? (result as UsageWireMetadata) : undefined;
}

function projectReport(report: UsageReport): UsageWireReport {
	const { raw: _raw, metadata, ...safe } = report;
	const projectedMetadata = projectMetadata(metadata);
	return {
		...safe,
		...(projectedMetadata ? { metadata: projectedMetadata } : {}),
	};
}

export function createAppserverUsageAuthority(
	authStorage: AuthStorage,
	modelRegistry: { getProviderBaseUrl(provider: string): string | undefined },
) {
	return {
		read: async (signal: AbortSignal): Promise<UsageReadResult> => {
			const reports: UsageReport[] =
				(await authStorage.fetchUsageReports({
					baseUrlResolver: provider => modelRegistry.getProviderBaseUrl(provider),
					signal,
				})) ?? [];
			const accounts = collectStoredAccounts(authStorage);
			const reportable = selectReportableAccounts(
				accounts,
				provider => authStorage.usageProviderFor(provider) !== undefined,
			);
			const without = collectUnreportedAccounts(reports, reportable);
			const capacity: Record<string, ReturnType<typeof computeProviderWindowStats>> = {};
			for (const provider of new Set(reports.map(report => report.provider))) {
				const stats = computeProviderWindowStats(reports.filter(report => report.provider === provider));
				if (stats.length > 0) capacity[provider] = stats;
			}
			return {
				generatedAt: Date.now(),
				reports: reports.map(projectReport),
				accountsWithoutUsage: without,
				capacity,
			};
		},
	};
}
