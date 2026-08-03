import type { Settings } from "../../config/settings";
import { type SettingChange, validateRpcSettingValue } from "../../config/settings-schema";
import { buildSettingsSnapshotForPaths, type SettingsSnapshot } from "../../config/settings-snapshot";
import type { RpcResponse, RpcSettingsChange } from "./rpc-types";

export const MAX_RPC_SETTINGS_CHANGES = 100;

type ValidatedChange = SettingChange;

function failure(id: string | undefined, error: string, code: string): RpcResponse {
	return { id, type: "response", command: "set_settings", success: false, error, code };
}

/** Validate the complete batch before allowing the first Settings.set call. */
export function validateSettingsChanges(
	changes: unknown,
): { ok: true; changes: ValidatedChange[] } | { ok: false; code: string; error: string } {
	if (!Array.isArray(changes) || changes.length === 0) {
		return { ok: false, code: "invalid_changes", error: "changes must be a nonempty array" };
	}
	if (changes.length > MAX_RPC_SETTINGS_CHANGES) {
		return {
			ok: false,
			code: "too_many_changes",
			error: `changes must contain at most ${MAX_RPC_SETTINGS_CHANGES} entries`,
		};
	}

	const paths = new Set<string>();
	const validated: ValidatedChange[] = [];
	for (let index = 0; index < changes.length; index += 1) {
		const change = changes[index];
		if (
			typeof change !== "object" ||
			change === null ||
			Array.isArray(change) ||
			(Object.getPrototypeOf(change) !== Object.prototype && Object.getPrototypeOf(change) !== null)
		) {
			return { ok: false, code: "invalid_changes", error: `changes[${index}] must be a plain object` };
		}
		const descriptors = Object.getOwnPropertyDescriptors(change);
		const keys = Object.keys(descriptors);
		if (
			keys.length !== 2 ||
			!Object.hasOwn(descriptors, "path") ||
			!Object.hasOwn(descriptors, "value") ||
			descriptors.path.get ||
			descriptors.path.set ||
			descriptors.value.get ||
			descriptors.value.set
		) {
			return { ok: false, code: "invalid_changes", error: `changes[${index}] requires only path and value` };
		}
		const path = descriptors.path.value;
		const value = descriptors.value.value;
		if (typeof path === "string" && paths.has(path)) {
			return { ok: false, code: "duplicate_path", error: `Duplicate settings path: ${path}` };
		}
		const result = validateRpcSettingValue(path, value);
		if (!result.ok) return result;
		paths.add(result.path);
		validated.push({ path: result.path, value: result.value } as SettingChange);
	}
	return { ok: true, changes: validated };
}

export async function handleSetSettings(
	settings: Settings,
	id: string | undefined,
	changes: readonly RpcSettingsChange[] | unknown,
): Promise<RpcResponse> {
	const validation = validateSettingsChanges(changes);
	if (!validation.ok) return failure(id, validation.error, validation.code);

	try {
		await settings.setPersistedBatch(validation.changes);
	} catch (error) {
		return failure(id, error instanceof Error ? error.message : String(error), "persistence_failed");
	}

	const snapshot: SettingsSnapshot = buildSettingsSnapshotForPaths(
		settings,
		validation.changes.map(change => change.path),
	);
	return { id, type: "response", command: "set_settings", success: true, data: snapshot };
}
