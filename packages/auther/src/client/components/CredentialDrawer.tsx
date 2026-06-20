import { Eye, RefreshCw, Trash2, X } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { type AutherEntry, type AutherSecret, getSecret } from "../api";
import { BrandLogo } from "../brands";
import { categoryLabel, categoryVariant, entryIdentity, entryStatus } from "../entry-status";
import { formatTimestamp } from "../format";
import { JsonBlock, StatusPill } from "../ui";

export interface CredentialDrawerProps {
	entry: AutherEntry;
	refreshing: boolean;
	onClose: () => void;
	onRefresh: (entry: AutherEntry) => void;
	onDelete: (entry: AutherEntry) => void;
	onEdit: (entry: AutherEntry) => void;
	onReauth: (entry: AutherEntry) => void;
}

interface DetailRow {
	label: string;
	value: string;
}

function detailRows(entry: AutherEntry): DetailRow[] {
	const rows: DetailRow[] = [
		{ label: "Provider", value: entry.provider },
		{ label: "Type", value: entry.credentialType },
		{ label: "Brand", value: entry.brandId },
	];
	const identity = entryIdentity(entry);
	if (identity) rows.push({ label: "Identity", value: identity });
	if (entry.projectId) rows.push({ label: "Project", value: entry.projectId });
	if (entry.expires !== null) rows.push({ label: "Token expires", value: formatTimestamp(entry.expires) });
	if (entry.disabledCause) rows.push({ label: "Disabled", value: entry.disabledCause });
	rows.push({ label: "Spend tracking", value: entry.spendKind ?? "none" });
	return rows;
}

export function CredentialDrawer({
	entry,
	refreshing,
	onClose,
	onRefresh,
	onDelete,
	onEdit,
	onReauth,
}: CredentialDrawerProps) {
	const [secret, setSecret] = useState<AutherSecret | null>(null);
	const [revealError, setRevealError] = useState<string | null>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const restoreRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		setSecret(null);
		setRevealError(null);
	}, [entry.id]);

	useEffect(() => {
		restoreRef.current = document.activeElement as HTMLElement | null;
		const timer = setTimeout(() => closeRef.current?.focus(), 30);
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("keydown", onKey);
			restoreRef.current?.focus();
		};
	}, [onClose]);

	const reveal = async (): Promise<void> => {
		setRevealError(null);
		try {
			setSecret(await getSecret(entry.id));
		} catch (err) {
			setRevealError(err instanceof Error ? err.message : String(err));
		}
	};

	const confirmDelete = (): void => {
		if (window.confirm(`Delete "${entry.displayName}"? This disables the credential.`)) onDelete(entry);
	};

	const onOverlay = (event: React.MouseEvent<HTMLDivElement>): void => {
		if (event.target === event.currentTarget) onClose();
	};

	const status = entryStatus(entry);

	return (
		<div className="auther-drawer-overlay" role="presentation" onClick={onOverlay}>
			<div className="auther-drawer" role="dialog" aria-modal="true" aria-label={`${entry.displayName} details`}>
				<div className="auther-drawer-header">
					<div className="auther-drawer-head-left">
						<BrandLogo provider={entry.provider} size={28} />
						<div>
							<div className="auther-card-name">{entry.displayName}</div>
							<div className="auther-card-provider">{entry.provider}</div>
						</div>
					</div>
					<button
						ref={closeRef}
						type="button"
						className="auther-icon-btn home-button home-button-secondary"
						onClick={onClose}
						aria-label="Close details"
					>
						<X size={16} />
					</button>
				</div>

				<div className="auther-drawer-body">
					<div className="auther-card-pills">
						<StatusPill variant={status.variant}>{status.label}</StatusPill>
						<StatusPill variant={categoryVariant(entry.category)}>{categoryLabel(entry.category)}</StatusPill>
					</div>

					<dl className="auther-detail-list">
						{detailRows(entry).map(row => (
							<div key={row.label} className="auther-detail-row">
								<dt className="auther-detail-label">{row.label}</dt>
								<dd className="auther-detail-value">{row.value}</dd>
							</div>
						))}
					</dl>

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

					<div className="auther-drawer-section">
						{secret ? (
							<JsonBlock data={secret} title="Secret (revealed)" />
						) : (
							<button type="button" className="home-button home-button-secondary" onClick={reveal}>
								<Eye size={14} /> Reveal secret
							</button>
						)}
						{revealError && <p className="auther-card-error">{revealError}</p>}
					</div>

					<JsonBlock data={entry} title="Raw entry" initialCollapsed />
				</div>

				<div className="auther-drawer-footer">
					<button type="button" className="home-button home-button-secondary" onClick={() => onEdit(entry)}>
						Edit metadata
					</button>
					{entry.isOAuth && (
						<>
							<button
								type="button"
								className="home-button home-button-secondary"
								onClick={() => onRefresh(entry)}
								disabled={refreshing}
							>
								<RefreshCw size={13} className={refreshing ? "auther-spin" : undefined} /> Refresh
							</button>
							<button type="button" className="home-button home-button-primary" onClick={() => onReauth(entry)}>
								Re-authenticate
							</button>
						</>
					)}
					<button type="button" className="home-button home-button-danger" onClick={confirmDelete}>
						<Trash2 size={13} /> Delete
					</button>
				</div>
			</div>
		</div>
	);
}
