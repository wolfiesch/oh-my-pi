import { useEffect, useState } from "react";
import type { ResolvedConfig } from "../../api-types";
import { getConfig } from "../data/api";
import { useConfigEdits } from "../data/useConfigEdits";
import { useResource } from "../data/useResource";
import { AsyncBoundary, EditTray, Panel } from "../ui";

export interface RolesRouteProps {
	active: boolean;
	profile: string | null;
}

interface RoleEntry {
	role: string;
	model: string;
}

function readModelRoles(values: Record<string, unknown>): RoleEntry[] {
	const raw = (values.modelRoles as Record<string, unknown> | undefined) ?? {};
	return Object.entries(raw).map(([role, model]) => ({
		role,
		model: typeof model === "string" ? model : String(model ?? ""),
	}));
}

function readCycleOrder(values: Record<string, unknown>): string[] {
	const raw = (values.cycleOrder as unknown[] | undefined) ?? [];
	return raw.filter((r): r is string => typeof r === "string");
}

export function RolesRoute({ active, profile }: RolesRouteProps) {
	const enabled = active && !!profile;
	const { data, error, loading, refetch } = useResource<ResolvedConfig>(
		["config", profile ?? ""],
		signal => getConfig(profile!, signal),
		{ enabled },
	);

	const edits = useConfigEdits();
	const [roles, setRoles] = useState<RoleEntry[]>([]);
	const [cycle, setCycle] = useState<string[]>([]);
	const [newRoleName, setNewRoleName] = useState("");
	const [newRoleModel, setNewRoleModel] = useState("");
	const [newCycleRole, setNewCycleRole] = useState("");

	// Sync local editing state whenever fresh server data arrives.
	useEffect(() => {
		if (data) {
			setRoles(readModelRoles(data.values));
			setCycle(readCycleOrder(data.values));
			edits.revertAll();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [data]);

	const values = data?.values ?? {};

	// ---- modelRoles editing ----

	const roleModels = roles.map(r => r.model);

	function updateRoleModel(role: string, model: string) {
		setRoles(prev => prev.map(r => (r.role === role ? { ...r, model } : r)));
		const oldRecord = (values.modelRoles as Record<string, unknown> | undefined) ?? {};
		const oldModel = typeof oldRecord[role] === "string" ? (oldRecord[role] as string) : "";
		edits.setEdit(`modelRoles.${role}`, oldModel, model);
	}

	function removeRole(role: string) {
		setRoles(prev => prev.filter(r => r.role !== role));
		const oldRecord = (values.modelRoles as Record<string, unknown> | undefined) ?? {};
		const oldModel = typeof oldRecord[role] === "string" ? (oldRecord[role] as string) : "";
		edits.setEdit(`modelRoles.${role}`, oldModel, undefined);
	}

	function addRole() {
		const name = newRoleName.trim();
		if (!name || roles.some(r => r.role === name)) return;
		const model = newRoleModel.trim();
		setRoles(prev => [...prev, { role: name, model }]);
		edits.setEdit(`modelRoles.${name}`, undefined, model);
		setNewRoleName("");
		setNewRoleModel("");
	}

	// ---- cycleOrder editing ----

	function moveCycle(index: number, dir: -1 | 1) {
		const target = index + dir;
		if (target < 0 || target >= cycle.length) return;
		const next = [...cycle];
		[next[index], next[target]] = [next[target], next[index]];
		setCycle(next);
		edits.setEdit("cycleOrder", (values.cycleOrder as string[] | undefined) ?? [], next);
	}

	function removeCycleItem(index: number) {
		const next = cycle.filter((_, i) => i !== index);
		setCycle(next);
		edits.setEdit("cycleOrder", (values.cycleOrder as string[] | undefined) ?? [], next);
	}

	function addCycleItem() {
		const item = newCycleRole.trim();
		if (!item) return;
		const next = [...cycle, item];
		setCycle(next);
		edits.setEdit("cycleOrder", (values.cycleOrder as string[] | undefined) ?? [], next);
		setNewCycleRole("");
	}

	// ---- Apply ----

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
		if (path === "cycleOrder") {
			setCycle(readCycleOrder({ cycleOrder: pending.oldValue }));
			return;
		}
		if (!path.startsWith("modelRoles.")) return;
		const role = path.slice("modelRoles.".length);
		if (pending.oldValue === undefined) {
			setRoles(prev => prev.filter(entry => entry.role !== role));
			return;
		}
		const model = typeof pending.oldValue === "string" ? pending.oldValue : String(pending.oldValue ?? "");
		setRoles(prev =>
			prev.some(entry => entry.role === role)
				? prev.map(entry => (entry.role === role ? { ...entry, model } : entry))
				: [...prev, { role, model }],
		);
	}

	return (
		<AsyncBoundary loading={loading} error={error} data={data} onRetry={() => void refetch()}>
			<Panel
				title="Model Roles"
				subtitle="Maps each Ctrl+P cycle role to its model selector. Edit inline, then Apply to persist to config.yml."
			>
				<div className="home-edit-table">
					<div className="home-edit-table-header">
						<span className="home-edit-table-col-role">Role</span>
						<span className="home-edit-table-col-model">Model selector</span>
						<span className="home-edit-table-col-actions">{""}</span>
					</div>
					{roles.map(r => (
						<div key={r.role} className="home-edit-table-row">
							<span className="home-edit-table-col-role home-edit-table-label">{r.role}</span>
							<span className="home-edit-table-col-model">
								<input
									className="home-input"
									value={r.model}
									onChange={e => updateRoleModel(r.role, e.target.value)}
									placeholder="provider/model:level"
									list="home-model-list"
								/>
							</span>
							<span className="home-edit-table-col-actions">
								<button
									type="button"
									className="home-icon-btn"
									onClick={() => removeRole(r.role)}
									aria-label={`Remove role ${r.role}`}
									title="Remove role"
								>
									×
								</button>
							</span>
						</div>
					))}
					{roles.length === 0 && <div className="home-edit-table-empty">No roles defined. Add one below.</div>}
					<div className="home-edit-table-row home-edit-table-add">
						<span className="home-edit-table-col-role">
							<input
								className="home-input"
								value={newRoleName}
								onChange={e => setNewRoleName(e.target.value)}
								placeholder="new role name"
							/>
						</span>
						<span className="home-edit-table-col-model">
							<input
								className="home-input"
								value={newRoleModel}
								onChange={e => setNewRoleModel(e.target.value)}
								placeholder="provider/model:level"
								list="home-model-list"
							/>
						</span>
						<span className="home-edit-table-col-actions">
							<button
								type="button"
								className="home-button home-button-secondary"
								onClick={addRole}
								disabled={!newRoleName.trim()}
							>
								Add
							</button>
						</span>
					</div>
				</div>
				<datalist id="home-model-list">
					{roleModels.map((m, i) => (
						<option key={`${m}-${i}`} value={m} />
					))}
				</datalist>
			</Panel>

			<Panel
				title="Cycle Order"
				subtitle="The ordered sequence of roles in the Ctrl+P planning cycle. Use ↑/↓ to reorder."
			>
				<div className="home-edit-table">
					<div className="home-edit-table-header">
						<span className="home-edit-table-col-index">#</span>
						<span className="home-edit-table-col-role">Role</span>
						<span className="home-edit-table-col-actions">{""}</span>
					</div>
					{cycle.map((role, i) => (
						<div key={`${role}-${i}`} className="home-edit-table-row">
							<span className="home-edit-table-col-index home-edit-table-label">{i + 1}</span>
							<span className="home-edit-table-col-role home-edit-table-label">{role}</span>
							<span className="home-edit-table-col-actions">
								<button
									type="button"
									className="home-icon-btn"
									onClick={() => moveCycle(i, -1)}
									disabled={i === 0}
									aria-label="Move up"
									title="Move up"
								>
									↑
								</button>
								<button
									type="button"
									className="home-icon-btn"
									onClick={() => moveCycle(i, 1)}
									disabled={i === cycle.length - 1}
									aria-label="Move down"
									title="Move down"
								>
									↓
								</button>
								<button
									type="button"
									className="home-icon-btn"
									onClick={() => removeCycleItem(i)}
									aria-label="Remove from cycle"
									title="Remove"
								>
									×
								</button>
							</span>
						</div>
					))}
					{cycle.length === 0 && <div className="home-edit-table-empty">No cycle order defined.</div>}
					<div className="home-edit-table-row home-edit-table-add">
						<span className="home-edit-table-col-index">{""}</span>
						<span className="home-edit-table-col-role">
							<input
								className="home-input"
								value={newCycleRole}
								onChange={e => setNewCycleRole(e.target.value)}
								placeholder="role name"
								onKeyDown={e => {
									if (e.key === "Enter") addCycleItem();
								}}
							/>
						</span>
						<span className="home-edit-table-col-actions">
							<button
								type="button"
								className="home-button home-button-secondary"
								onClick={addCycleItem}
								disabled={!newCycleRole.trim()}
							>
								Add
							</button>
						</span>
					</div>
				</div>
			</Panel>

			<EditTray
				pending={edits.pending}
				applying={edits.applying}
				applyError={edits.applyError}
				onApply={() => void handleApply()}
				onRevert={() => {
					edits.revertAll();
					if (data) {
						setRoles(readModelRoles(data.values));
						setCycle(readCycleOrder(data.values));
					}
				}}
				onRevertPath={handleRevertPath}
			/>
		</AsyncBoundary>
	);
}
