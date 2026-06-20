import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import type { AutherEntry } from "../api";
import { formatCountdown, formatPercent, usedFraction } from "../format";

export interface UsageMeterProps {
	entry: AutherEntry;
	reports: UsageReport[];
}

/** Limits whose provider (and account, when known) match this credential. */
function matchingLimits(entry: AutherEntry, reports: UsageReport[]): UsageLimit[] {
	const limits: UsageLimit[] = [];
	for (const report of reports) {
		if (report.provider !== entry.provider) continue;
		for (const limit of report.limits) {
			if (entry.accountId && limit.scope.accountId && limit.scope.accountId !== entry.accountId) continue;
			limits.push(limit);
		}
	}
	return limits;
}

function meterVariant(fraction: number): string {
	if (fraction >= 0.9) return "danger";
	if (fraction >= 0.7) return "warning";
	return "success";
}

export function UsageMeter({ entry, reports }: UsageMeterProps) {
	const limits = matchingLimits(entry, reports);
	if (limits.length === 0) {
		return <p className="auther-meter-empty">No usage data reported for this account.</p>;
	}

	return (
		<div className="auther-meter-list">
			{limits.map(limit => {
				const fraction = usedFraction(limit);
				const pct = fraction === undefined ? 0 : Math.min(100, Math.max(0, fraction * 100));
				const resetsAt = limit.window?.resetsAt;
				const resetsIn = resetsAt !== undefined ? resetsAt - Date.now() : undefined;
				return (
					<div key={limit.id} className="auther-meter">
						<div className="auther-meter-head">
							<span className="auther-meter-label">{limit.label}</span>
							<span className="auther-meter-value">
								{fraction === undefined ? "—" : formatPercent(fraction)}
							</span>
						</div>
						<div className="stats-progress-bar-track">
							<div
								className="stats-progress-bar-fill"
								data-variant={fraction === undefined ? "default" : meterVariant(fraction)}
								style={{ width: `${pct}%` }}
							/>
						</div>
						{resetsIn !== undefined && resetsIn > 0 && (
							<div className="auther-meter-reset">resets in {formatCountdown(resetsIn)}</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
