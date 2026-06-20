import { useEffect, useState } from "react";
import { getSpend, type SpendFetchResult } from "../api";
import { formatUsd } from "../format";
import { type MetricCardProps, MetricCluster } from "../ui";
import { Skeleton } from "../ui/Skeleton";

export interface SpendPanelProps {
	entryId: number;
}

function spendCards(result: SpendFetchResult): MetricCardProps[] {
	if (!("kind" in result)) return [];
	if (result.kind === "openrouter" && result.status === "ok") {
		const cards: MetricCardProps[] = [
			{ label: "Total spend", value: formatUsd(result.usageUsd), variant: "primary" },
		];
		if (result.limitRemainingUsd !== undefined) {
			cards.push({ label: "Remaining", value: formatUsd(result.limitRemainingUsd), variant: "primary" });
		}
		if (result.dailyUsd !== undefined)
			cards.push({ label: "Today", value: formatUsd(result.dailyUsd), variant: "secondary" });
		if (result.weeklyUsd !== undefined)
			cards.push({ label: "Week", value: formatUsd(result.weeklyUsd), variant: "secondary" });
		if (result.monthlyUsd !== undefined)
			cards.push({ label: "Month", value: formatUsd(result.monthlyUsd), variant: "secondary" });
		return cards;
	}
	if (result.kind === "openai" && result.status === "ok") {
		return [{ label: "30-day cost", value: formatUsd(result.totalUsd), variant: "primary" }];
	}
	return [];
}

function spendError(result: SpendFetchResult): string | null {
	if (!("kind" in result)) return result.error;
	if (result.kind === "openai" && result.status === "admin_key_required") {
		return "OpenAI cost data requires an sk-admin organization key.";
	}
	if (result.status === "unavailable") return result.error;
	return null;
}

export function SpendPanel({ entryId }: SpendPanelProps) {
	const [result, setResult] = useState<SpendFetchResult | null>(null);
	const [error, setError] = useState<Error | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		setResult(null);
		setError(null);
		getSpend(entryId, controller.signal)
			.then(value => {
				if (!controller.signal.aborted) setResult(value);
			})
			.catch(err => {
				if (!controller.signal.aborted) setError(err instanceof Error ? err : new Error(String(err)));
			});
		return () => controller.abort();
	}, [entryId]);

	if (error) return <p className="auther-meter-empty">Spend unavailable: {error.message}</p>;
	if (!result) return <Skeleton variant="rect" width="100%" height={56} />;

	const cards = spendCards(result);
	if (cards.length > 0) return <MetricCluster cards={cards} />;

	const message = spendError(result);
	return <p className="auther-meter-empty">{message ?? "Spend metering is not configured."}</p>;
}
