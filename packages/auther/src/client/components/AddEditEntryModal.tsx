import { useState } from "react";
import { type AutherEntry, type AutherEntryCategory, type AutherSpendKind, addEntry, updateEntry } from "../api";
import { Modal } from "./Modal";

export interface AddEditEntryModalProps {
	/** When set, edits metadata of an existing credential; otherwise adds a key. */
	entry?: AutherEntry;
	onClose: () => void;
	onSaved: () => void;
	onSwitchToOAuth: () => void;
}

type CredKind = "api_key" | "oauth";
type SpendChoice = "none" | AutherSpendKind;

const CATEGORY_OPTIONS: Array<{ value: AutherEntryCategory; label: string }> = [
	{ value: "metered", label: "Metered" },
	{ value: "meterable_unconfigured", label: "Meterable (unconfigured)" },
	{ value: "not_applicable", label: "No metering" },
];

const SPEND_OPTIONS: Array<{ value: SpendChoice; label: string }> = [
	{ value: "none", label: "None" },
	{ value: "openrouter", label: "OpenRouter ($)" },
	{ value: "openai", label: "OpenAI ($, admin key)" },
];

function parseTags(raw: string): string[] {
	const seen = new Set<string>();
	const tags: string[] = [];
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			tags.push(trimmed);
		}
	}
	return tags;
}

export function AddEditEntryModal({ entry, onClose, onSaved, onSwitchToOAuth }: AddEditEntryModalProps) {
	const editing = Boolean(entry);
	const [kind, setKind] = useState<CredKind>("api_key");
	const [provider, setProvider] = useState(entry?.provider ?? "");
	const [key, setKey] = useState("");
	const [displayName, setDisplayName] = useState(entry?.displayName ?? "");
	const [tags, setTags] = useState((entry?.tags ?? []).join(", "));
	const [category, setCategory] = useState<AutherEntryCategory>(entry?.category ?? "meterable_unconfigured");
	const [spend, setSpend] = useState<SpendChoice>(entry?.spendKind ?? "none");
	const [notes, setNotes] = useState(entry?.notes ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const save = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			const spendKind: AutherSpendKind | null = spend === "none" ? null : spend;
			const tagList = parseTags(tags);
			if (editing && entry) {
				await updateEntry(entry.id, {
					displayName,
					tags: tagList,
					category,
					spendKind,
					notes: notes.trim() ? notes : null,
				});
			} else {
				await addEntry({
					provider,
					displayName,
					key,
					tags: tagList,
					category,
					spendKind,
					notes: notes.trim() ? notes : null,
				});
			}
			onSaved();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const canSave = editing
		? displayName.trim().length > 0
		: provider.trim().length > 0 && key.trim().length > 0 && displayName.trim().length > 0;

	return (
		<Modal title={editing ? `Edit ${entry?.displayName ?? "credential"}` : "Add credential"} onClose={onClose}>
			<div className="auther-form">
				{!editing && (
					<div className="auther-kind-toggle">
						<button
							type="button"
							className="home-segmented-control-btn"
							data-active={kind === "api_key"}
							onClick={() => setKind("api_key")}
						>
							API key
						</button>
						<button
							type="button"
							className="home-segmented-control-btn"
							data-active={kind === "oauth"}
							onClick={() => setKind("oauth")}
						>
							OAuth
						</button>
					</div>
				)}

				{!editing && kind === "oauth" ? (
					<div className="auther-oauth-switch">
						<p className="auther-field-hint">
							OAuth credentials are added through the provider login flow (device code or paste code).
						</p>
						<button type="button" className="home-button home-button-primary" onClick={onSwitchToOAuth}>
							Continue with OAuth login
						</button>
					</div>
				) : (
					<>
						{!editing && (
							<>
								<label className="auther-field">
									<span className="auther-field-label">Provider</span>
									<input
										className="auther-input"
										value={provider}
										placeholder="openrouter, anthropic, cloudflare…"
										onChange={event => setProvider(event.target.value)}
									/>
								</label>
								<label className="auther-field">
									<span className="auther-field-label">API key</span>
									<input
										className="auther-input"
										type="password"
										value={key}
										placeholder="sk-…"
										onChange={event => setKey(event.target.value)}
									/>
								</label>
							</>
						)}

						<label className="auther-field">
							<span className="auther-field-label">Display name</span>
							<input
								className="auther-input"
								value={displayName}
								onChange={event => setDisplayName(event.target.value)}
							/>
						</label>

						<label className="auther-field">
							<span className="auther-field-label">Tags (comma separated)</span>
							<input
								className="auther-input"
								value={tags}
								placeholder="infra, personal"
								onChange={event => setTags(event.target.value)}
							/>
						</label>

						<div className="auther-field-row">
							<label className="auther-field">
								<span className="auther-field-label">Category</span>
								<select
									className="auther-input"
									value={category}
									onChange={event => setCategory(event.target.value as AutherEntryCategory)}
								>
									{CATEGORY_OPTIONS.map(opt => (
										<option key={opt.value} value={opt.value}>
											{opt.label}
										</option>
									))}
								</select>
							</label>
							<label className="auther-field">
								<span className="auther-field-label">Spend tracking</span>
								<select
									className="auther-input"
									value={spend}
									onChange={event => setSpend(event.target.value as SpendChoice)}
								>
									{SPEND_OPTIONS.map(opt => (
										<option key={opt.value} value={opt.value}>
											{opt.label}
										</option>
									))}
								</select>
							</label>
						</div>

						<label className="auther-field">
							<span className="auther-field-label">Notes</span>
							<textarea
								className="auther-input auther-textarea"
								value={notes}
								rows={2}
								onChange={event => setNotes(event.target.value)}
							/>
						</label>
					</>
				)}

				{error && <p className="auther-card-error">{error}</p>}
			</div>

			{(editing || kind === "api_key") && (
				<div className="auther-modal-actions">
					<button type="button" className="home-button home-button-secondary" onClick={onClose}>
						Cancel
					</button>
					<button
						type="button"
						className="home-button home-button-primary"
						onClick={save}
						disabled={busy || !canSave}
					>
						{editing ? "Save changes" : "Add credential"}
					</button>
				</div>
			)}
		</Modal>
	);
}
