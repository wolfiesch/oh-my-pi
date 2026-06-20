import type { PendingEdit } from "../data/useConfigEdits";

export interface EditTrayProps {
	pending: PendingEdit[];
	applying: boolean;
	applyError: string | null;
	onApply: () => void;
	onRevert: () => void;
	onRevertPath: (path: string) => void;
}

function formatVal(value: unknown): string {
	if (value === undefined) return "(delete)";
	if (value === null) return "null";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

export function EditTray({ pending, applying, applyError, onApply, onRevert, onRevertPath }: EditTrayProps) {
	if (pending.length === 0 && !applyError) return null;

	return (
		<div className="home-edit-tray">
			<div className="home-edit-tray-header">
				<span className="home-edit-tray-title">
					Unsaved changes{pending.length > 0 ? ` (${pending.length})` : ""}
				</span>
				<div className="home-edit-tray-actions">
					<button
						type="button"
						className="home-button home-button-secondary home-edit-tray-btn"
						onClick={onRevert}
						disabled={applying || pending.length === 0}
					>
						Revert all
					</button>
					<button
						type="button"
						className="home-button home-button-primary home-edit-tray-btn"
						onClick={onApply}
						disabled={applying || pending.length === 0}
					>
						{applying ? "Applying…" : "Apply"}
					</button>
				</div>
			</div>
			{applyError && <div className="home-edit-tray-error">{applyError}</div>}
			{pending.length > 0 && (
				<div className="home-edit-tray-list">
					{pending.map(edit => (
						<div key={edit.path} className="home-edit-tray-row">
							<code className="home-edit-tray-path">{edit.path}</code>
							<span className="home-edit-tray-arrow">
								<span className="home-edit-tray-old">{formatVal(edit.oldValue)}</span>
								<span className="home-edit-tray-sep">→</span>
								<span className="home-edit-tray-new">{formatVal(edit.newValue)}</span>
							</span>
							<button
								type="button"
								className="home-edit-tray-revert"
								onClick={() => onRevertPath(edit.path)}
								disabled={applying}
								aria-label={`Revert ${edit.path}`}
							>
								×
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
