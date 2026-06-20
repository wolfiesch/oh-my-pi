import type { UsageLimit } from "@oh-my-pi/pi-ai";

/** Format a USD amount with adaptive precision for small balances. */
export function formatUsd(value: number): string {
	const abs = Math.abs(value);
	const fractionDigits = abs > 0 && abs < 1 ? 4 : 2;
	return `$${value.toLocaleString(undefined, {
		minimumFractionDigits: 2,
		maximumFractionDigits: fractionDigits,
	})}`;
}

/** Format a percentage (0..1 fraction) as a whole-ish number with a %. */
export function formatPercent(fraction: number): string {
	return `${(fraction * 100).toFixed(fraction >= 0.1 ? 0 : 1)}%`;
}

/** Compact human countdown from a millisecond duration (e.g. "4h 12m", "38s"). */
export function formatCountdown(ms: number): string {
	if (ms <= 0) return "now";
	const totalSeconds = Math.floor(ms / 1000);
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/** Format an absolute epoch-ms timestamp as a short local datetime. */
export function formatTimestamp(epochMs: number): string {
	return new Date(epochMs).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * Resolve a usage limit's used fraction (0..1; >1 = overage). Mirrors the
 * server-side `resolveUsedFraction` so the client need not pull the usage
 * module (and zod) into the bundle.
 */
export function usedFraction(limit: UsageLimit): number | undefined {
	const amount = limit.amount;
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
		return amount.used / amount.limit;
	}
	if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
	if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
	return undefined;
}
