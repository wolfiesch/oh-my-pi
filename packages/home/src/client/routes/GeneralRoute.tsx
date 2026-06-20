import { useEffect, useState } from "react";
import type { ResolvedConfig, SchemaMeta } from "../../api-types";
import { getConfig } from "../data/api";
import { useConfigEdits } from "../data/useConfigEdits";
import { useResource } from "../data/useResource";
import { AsyncBoundary, EditTray, Panel } from "../ui";

export interface GeneralRouteProps {
	active: boolean;
	profile: string | null;
}

function getConfigValue(values: Record<string, unknown>, path: string): unknown {
	if (Object.hasOwn(values, path)) return values[path];
	const parts = path.split(".");
	let current: unknown = values;
	for (const part of parts) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/** Determine the editor kind from the schema type string. */
function editorKind(meta: SchemaMeta): "boolean" | "number" | "enum" | "string" | "array" | "record" {
	if (meta.enumValues && meta.enumValues.length > 0) return "enum";
	if (meta.type === "boolean") return "boolean";
	if (meta.type === "number") return "number";
	if (meta.type === "array" || /\[\]$/.test(meta.type)) return "array";
	if (meta.type === "record" || /^Record<.+>$/.test(meta.type)) return "record";
	return "string";
}

function stringifyRecord(value: unknown): string {
	const obj = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	try {
		return JSON.stringify(obj, null, 2);
	} catch {
		return "{}";
	}
}

function ArrayInput({ currentValue, onEdit }: { currentValue: unknown; onEdit: (newValue: unknown) => void }) {
	const arrayValue = Array.isArray(currentValue) ? currentValue.filter(value => typeof value === "string") : [];
	const [text, setText] = useState(arrayValue.join(", "));

	useEffect(() => {
		setText(arrayValue.join(", "));
	}, [arrayValue.join("\u0000")]);

	return (
		<input
			className="home-input"
			value={text}
			placeholder="comma, separated, values"
			onChange={e => {
				const next = e.target.value;
				setText(next);
				const parts = next
					.split(",")
					.map(value => value.trim())
					.filter(Boolean);
				onEdit(parts);
			}}
		/>
	);
}

function RecordInput({ currentValue, onEdit }: { currentValue: unknown; onEdit: (newValue: unknown) => void }) {
	const [text, setText] = useState(() => stringifyRecord(currentValue));
	const [invalid, setInvalid] = useState(false);

	useEffect(() => {
		setText(stringifyRecord(currentValue));
		setInvalid(false);
	}, [currentValue]);

	return (
		<textarea
			className="home-input home-input-textarea"
			data-invalid={invalid ? "true" : "false"}
			rows={3}
			value={text}
			onChange={e => {
				const next = e.target.value;
				setText(next);
				try {
					const parsed = JSON.parse(next);
					setInvalid(!(parsed && typeof parsed === "object" && !Array.isArray(parsed)));
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) onEdit(parsed);
				} catch {
					setInvalid(true);
				}
			}}
		/>
	);
}

function SettingInput({
	meta,
	currentValue,
	onEdit,
}: {
	meta: SchemaMeta;
	currentValue: unknown;
	onEdit: (newValue: unknown) => void;
}) {
	const kind = editorKind(meta);

	switch (kind) {
		case "boolean": {
			const checked = currentValue === true;
			return (
				<button
					type="button"
					className="home-toggle"
					data-active={checked ? "true" : "false"}
					onClick={() => onEdit(!checked)}
					aria-pressed={checked}
				>
					{checked ? "On" : "Off"}
				</button>
			);
		}
		case "number": {
			const value = typeof currentValue === "number" && Number.isFinite(currentValue) ? currentValue : 0;
			return (
				<input
					className="home-input home-input-num"
					type="number"
					value={value}
					onChange={e => onEdit(e.target.value === "" ? 0 : Number(e.target.value))}
				/>
			);
		}
		case "enum": {
			const opts = meta.enumValues ?? [];
			const val = typeof currentValue === "string" ? currentValue : String(currentValue ?? "");
			return (
				<select className="home-input home-input-select" value={val} onChange={e => onEdit(e.target.value)}>
					{opts.map(option => (
						<option key={option} value={option}>
							{option}
						</option>
					))}
				</select>
			);
		}
		case "array":
			return <ArrayInput currentValue={currentValue} onEdit={onEdit} />;
		case "record":
			return <RecordInput currentValue={currentValue} onEdit={onEdit} />;
		default: {
			const val = typeof currentValue === "string" ? currentValue : String(currentValue ?? "");
			return <input className="home-input" value={val} onChange={e => onEdit(e.target.value)} />;
		}
	}
}

export function GeneralRoute({ active, profile }: GeneralRouteProps) {
	const enabled = active && !!profile;
	const { data, error, loading, refetch } = useResource<ResolvedConfig>(
		["config", profile ?? ""],
		signal => getConfig(profile!, signal),
		{ enabled },
	);

	const edits = useConfigEdits();
	const [localValues, setLocalValues] = useState<Record<string, unknown>>({});

	// Sync local editing state when fresh server data arrives.
	useEffect(() => {
		if (data) {
			setLocalValues({ ...data.values });
			edits.revertAll();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [data]);

	const schema: SchemaMeta[] = data?.schema ?? [];

	// Group schema rows by tab.
	const tabs = new Map<string, SchemaMeta[]>();
	for (const meta of schema) {
		const tab = meta.tab || "General";
		const rows = tabs.get(tab) ?? [];
		rows.push(meta);
		tabs.set(tab, rows);
	}

	function handleEdit(meta: SchemaMeta, newValue: unknown) {
		const oldValue = getConfigValue(data?.values ?? {}, meta.path);
		setLocalValues(prev => ({ ...prev, [meta.path]: newValue }));
		edits.setEdit(meta.path, oldValue, newValue);
	}

	async function handleApply() {
		if (!profile) return;
		try {
			await edits.apply(profile);
			await refetch();
		} catch {
			// applyError is surfaced in the tray.
		}
	}

	function handleRevertPath(path: string) {
		const pending = edits.pending.find(edit => edit.path === path);
		edits.revertPath(path);
		if (!pending) return;
		setLocalValues(prev => ({ ...prev, [path]: pending.oldValue }));
	}

	return (
		<AsyncBoundary loading={loading} error={error} data={data} onRetry={() => void refetch()}>
			{tabs.size === 0 && (
				<Panel title="General">
					<div className="home-edit-table-empty">No editable settings discovered for this profile.</div>
				</Panel>
			)}
			{[...tabs.entries()].map(([tab, rows]) => (
				<Panel key={tab} title={tab} subtitle="Edit settings inline, then Apply to persist to config.yml.">
					<div className="home-settings-list">
						{rows.map(meta => {
							const currentValue = getConfigValue(localValues, meta.path);
							return (
								<div key={meta.path} className="home-setting-row">
									<div className="home-setting-row-info">
										<div className="home-setting-row-label">{meta.label || meta.path}</div>
										<code className="home-setting-row-path">{meta.path}</code>
										{meta.description && <div className="home-setting-row-desc">{meta.description}</div>}
									</div>
									<div className="home-setting-row-input">
										<SettingInput
											meta={meta}
											currentValue={currentValue}
											onEdit={newValue => handleEdit(meta, newValue)}
										/>
									</div>
								</div>
							);
						})}
						{rows.length === 0 && <div className="home-edit-table-empty">No settings in this group.</div>}
					</div>
				</Panel>
			))}

			<EditTray
				pending={edits.pending}
				applying={edits.applying}
				applyError={edits.applyError}
				onApply={() => void handleApply()}
				onRevert={() => {
					edits.revertAll();
					if (data) setLocalValues({ ...data.values });
				}}
				onRevertPath={handleRevertPath}
			/>
		</AsyncBoundary>
	);
}
