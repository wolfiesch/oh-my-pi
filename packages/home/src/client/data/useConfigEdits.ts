import { useCallback, useMemo, useState } from "react";
import type { ConfigEdit, ResolvedConfig } from "../../api-types";
import { putConfig } from "./api";

/**
 * Manages a set of pending config edits for a profile.
 *
 * Edits are keyed by their dotted path so repeated edits to the same key
 * overwrite (not stack). `value === undefined` means "delete this key".
 * `apply()` flushes all pending edits via PUT /api/profiles/:id/config and
 * returns the re-read config so the caller can update its resource cache.
 */
export interface PendingEdit {
	path: string;
	oldValue: unknown;
	newValue: unknown;
}

export interface UseConfigEditsResult {
	pending: PendingEdit[];
	hasPending: boolean;
	setEdit: (path: string, oldValue: unknown, newValue: unknown) => void;
	/** Remove a single pending edit by path (revert one row). */
	revertPath: (path: string) => void;
	/** Drop all pending edits. */
	revertAll: () => void;
	/** Flush pending edits to the server. Resolves to the re-read config. */
	apply: (profileId: string, signal?: AbortSignal) => Promise<ResolvedConfig>;
	applying: boolean;
	applyError: string | null;
}

function areConfigValuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

export function useConfigEdits(): UseConfigEditsResult {
	const [editMap, setEditMap] = useState<Map<string, PendingEdit>>(new Map());
	const [applying, setApplying] = useState(false);
	const [applyError, setApplyError] = useState<string | null>(null);

	const setEdit = useCallback((path: string, oldValue: unknown, newValue: unknown) => {
		setEditMap(prev => {
			const next = new Map(prev);
			if (areConfigValuesEqual(oldValue, newValue)) {
				next.delete(path);
			} else {
				next.set(path, { path, oldValue, newValue });
			}
			return next;
		});
	}, []);

	const revertPath = useCallback((path: string) => {
		setEditMap(prev => {
			const next = new Map(prev);
			next.delete(path);
			return next;
		});
	}, []);

	const revertAll = useCallback(() => {
		setEditMap(new Map());
		setApplyError(null);
	}, []);

	const pending = useMemo(() => [...editMap.values()], [editMap]);

	const apply = useCallback(
		async (profileId: string, signal?: AbortSignal): Promise<ResolvedConfig> => {
			if (editMap.size === 0) {
				throw new Error("No pending edits to apply");
			}
			const edits: ConfigEdit[] = [...editMap.values()].map(e => ({
				path: e.path,
				value: e.newValue,
			}));
			setApplying(true);
			setApplyError(null);
			try {
				const result = await putConfig(profileId, edits, signal);
				setEditMap(new Map());
				return result;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				setApplyError(msg);
				throw err;
			} finally {
				setApplying(false);
			}
		},
		[editMap],
	);

	return {
		pending,
		hasPending: editMap.size > 0,
		setEdit,
		revertPath,
		revertAll,
		apply,
		applying,
		applyError,
	};
}
