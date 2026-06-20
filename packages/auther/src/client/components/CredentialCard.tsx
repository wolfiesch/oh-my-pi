import type { UsageReport } from "@oh-my-pi/pi-ai";
import { Eye, EyeOff, KeyRound, RefreshCw } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { type AutherEntry, type AutherSecret, getSecret } from "../api";
import { BrandLogo } from "../brands";
import { categoryLabel, categoryVariant, entryIdentity, entryStatus } from "../entry-status";
import { formatCountdown } from "../format";
import { Panel, StatusPill } from "../ui";
import type { RotationState } from "../useBrokerStream";
import { CountdownRing } from "./CountdownRing";
import { SpendPanel } from "./SpendPanel";
import { UsageMeter } from "./UsageMeter";

export interface CredentialCardProps {
	entry: AutherEntry;
	reports: UsageReport[];
	rotation?: RotationState;
	pulse: boolean;
	now: number;
	refreshing: boolean;
	onActivate: (entry: AutherEntry) => void;
	onRefresh: (entry: AutherEntry) => void;
	onReauth: (entry: AutherEntry) => void;
}

function revealedSecret(secret: AutherSecret): string {
	return secret.key ?? secret.access ?? "(no secret)";
}

export function CredentialCard({
	entry,
	reports,
	rotation,
	pulse,
	now,
	refreshing,
	onActivate,
	onRefresh,
	onReauth,
}: CredentialCardProps) {
	const [secret, setSecret] = useState<AutherSecret | null>(null);
	const [revealing, setRevealing] = useState(false);
	const [revealError, setRevealError] = useState<string | null>(null);

	// Drop a revealed secret whenever the underlying credential changes.
	useEffect(() => {
		setSecret(null);
		setRevealing(false);
		setRevealError(null);
	}, [entry.id, entry.secretPreview]);

	const status = entryStatus(entry);
	const identity = entryIdentity(entry);

	const toggleReveal = async (): Promise<void> => {
		if (secret) {
			setSecret(null);
			return;
		}
		setRevealing(true);
		setRevealError(null);
		try {
			setSecret(await getSecret(entry.id));
		} catch (err) {
			setRevealError(err instanceof Error ? err.message : String(err));
		} finally {
			setRevealing(false);
		}
	};

	const stop = (event: React.MouseEvent): void => event.stopPropagation();
	const handleKeyDown = (event: React.KeyboardEvent): void => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			onActivate(entry);
		}
	};

	const rotatesRemaining =
		rotation && rotation.rotatesInMs !== null ? rotation.rotatesInMs - (now - rotation.receivedAt) : null;
	const expiresRemaining = entry.expires !== null ? entry.expires - now : null;

	const showMeter = entry.category === "metered";
	const showSpend = entry.isApiKey && entry.spendKind !== null && entry.category !== "not_applicable";

	return (
		<Panel
			className={`auther-card auther-card-${status.variant}${pulse ? " auther-card-pulse" : ""}`}
			role="button"
			tabIndex={0}
			aria-label={`${entry.displayName} details`}
			onClick={() => onActivate(entry)}
			onKeyDown={handleKeyDown}
		>
			<div className="auther-card-head">
				<BrandLogo provider={entry.provider} size={28} className="auther-card-logo" />
				<div className="auther-card-titles">
					<div className="auther-card-name">{entry.displayName}</div>
					<div className="auther-card-provider">
						{entry.provider}
						{identity && <span className="auther-card-identity"> · {identity}</span>}
					</div>
				</div>
				{rotatesRemaining !== null && rotation?.rotatesInMs ? (
					<CountdownRing totalMs={rotation.rotatesInMs} remainingMs={rotatesRemaining} />
				) : null}
			</div>

			<div className="auther-card-pills">
				<StatusPill variant={status.variant}>{status.label}</StatusPill>
				<StatusPill variant={categoryVariant(entry.category)}>{categoryLabel(entry.category)}</StatusPill>
				{rotatesRemaining === null && expiresRemaining !== null && expiresRemaining > 0 && (
					<span className="auther-card-expiry">expires in {formatCountdown(expiresRemaining)}</span>
				)}
			</div>

			<div className="auther-card-secret" onClick={stop} role="presentation">
				<KeyRound size={13} className="auther-card-secret-icon" aria-hidden="true" />
				<code className="auther-card-secret-text">
					{secret ? revealedSecret(secret) : (entry.secretPreview ?? "—")}
				</code>
				{entry.hasSecret && (
					<button
						type="button"
						className="home-button home-button-secondary auther-icon-btn"
						onClick={toggleReveal}
						disabled={revealing}
						aria-label={secret ? "Hide secret" : "Reveal secret"}
						title={secret ? "Hide secret" : "Reveal secret"}
					>
						{secret ? <EyeOff size={14} /> : <Eye size={14} />}
					</button>
				)}
			</div>
			{revealError && <p className="auther-card-error">{revealError}</p>}

			{entry.tags.length > 0 && (
				<div className="auther-card-tags">
					{entry.tags.map(tag => (
						<span key={tag} className="auther-tag">
							{tag}
						</span>
					))}
				</div>
			)}

			{entry.notes && <p className="auther-card-notes">{entry.notes}</p>}

			<div className="auther-card-metering">
				{showMeter && <UsageMeter entry={entry} reports={reports} />}
				{showSpend && <SpendPanel entryId={entry.id} />}
				{!showMeter && !showSpend && <p className="auther-meter-empty">No usage metering configured.</p>}
			</div>

			{entry.isOAuth && (
				<div className="auther-card-actions" onClick={stop} role="presentation">
					<button
						type="button"
						className="home-button home-button-secondary"
						onClick={() => onRefresh(entry)}
						disabled={refreshing}
					>
						<RefreshCw size={13} className={refreshing ? "auther-spin" : undefined} />
						Refresh
					</button>
					<button type="button" className="home-button home-button-primary" onClick={() => onReauth(entry)}>
						Re-authenticate
					</button>
				</div>
			)}
		</Panel>
	);
}
