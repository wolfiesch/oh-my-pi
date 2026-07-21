import * as fs from "node:fs";
import * as path from "node:path";
import type { GrepMatch } from "@oh-my-pi/pi-natives";

export const SEARCH_RESULT_CACHE_TTL_MS = 45_000;
export const SEARCH_RESULT_CACHE_MAX_ENTRIES = 8;

export interface CachedGroupedSearchResult {
	fileOrder: string[];
	matchesByPath: Map<string, GrepMatch[]>;
	perFileLimitReached: boolean;
	resultLimitReached: boolean;
	skippedOversizedCount: number;
}

export interface SearchResultCacheOptions {
	ttlMs?: number;
	maxEntries?: number;
	now?: () => number;
}

interface SearchResultCacheEntry {
	createdAtMs: number;
	result: CachedGroupedSearchResult;
}

/**
 * Shared per-workspace state: the weakly-held owner set for fan-out
 * invalidation plus the workspace-wide suppression count. Attached to every
 * member cache so `get`/`set` observe suppression even for owners that
 * register mid-flight.
 */
interface WorkspaceCacheState {
	owners: Set<WeakRef<SearchResultCacheOwner>>;
	suppressions: number;
}

export class SearchResultCache {
	#entries = new Map<string, SearchResultCacheEntry>();
	#maxEntries: number;
	#now: () => number;
	#suppressions = 0;
	#ttlMs: number;
	#workspace: WorkspaceCacheState | undefined;

	constructor(options: SearchResultCacheOptions = {}) {
		this.#ttlMs = options.ttlMs ?? SEARCH_RESULT_CACHE_TTL_MS;
		this.#maxEntries = options.maxEntries ?? SEARCH_RESULT_CACHE_MAX_ENTRIES;
		this.#now = options.now ?? Date.now;
	}

	/** Bind this cache to its workspace's shared suppression/owner state. */
	setWorkspaceState(state: WorkspaceCacheState | undefined): void {
		this.#workspace = state;
	}

	#suppressed(): boolean {
		return this.#suppressions > 0 || (this.#workspace?.suppressions ?? 0) > 0;
	}

	get(key: string): CachedGroupedSearchResult | undefined {
		if (this.#suppressed()) return undefined;
		const entry = this.#entries.get(key);
		if (!entry) return undefined;

		if (this.#now() - entry.createdAtMs > this.#ttlMs) {
			this.#entries.delete(key);
			return undefined;
		}

		this.#entries.delete(key);
		this.#entries.set(key, entry);
		return entry.result;
	}

	set(key: string, result: CachedGroupedSearchResult): void {
		if (this.#suppressed()) return;
		this.#entries.delete(key);
		this.#entries.set(key, { createdAtMs: this.#now(), result });

		while (this.#entries.size > this.#maxEntries) {
			const oldestKey = this.#entries.keys().next().value;
			if (oldestKey === undefined) break;
			this.#entries.delete(oldestKey);
		}
	}

	/**
	 * Invalidate now and block reuse (`get`) and repopulation (`set`) until the
	 * returned release is called — used while a background job may still be
	 * mutating the workspace. Suppressions nest; the cache reopens once every
	 * holder has released. Instance-scoped: workspace-wide suppression goes
	 * through {@link suppressSearchResultCaches}.
	 */
	suppress(): () => void {
		this.#suppressions++;
		this.#entries.clear();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#suppressions--;
		};
	}

	clear(): void {
		this.#entries.clear();
	}
}

export interface SearchResultCacheOwner {
	searchResultCache?: SearchResultCache;
	/**
	 * Owning session's workspace root. Canonicalized (realpath with a
	 * nearest-existing-ancestor fallback) to key same-workspace fan-out
	 * invalidation and suppression.
	 */
	cwd?: string;
}

/**
 * Live cache owners grouped by canonical workspace root, held weakly so this
 * process-global registry never extends a session's lifetime. Non-isolated
 * task children share the parent's cwd but carry their own ToolSession cache;
 * a mutation observed by one session must also drop every sibling's cached
 * pages for the same workspace, while different-cwd sessions stay untouched.
 */
const workspaceStates = new Map<string, WorkspaceCacheState>();

/** Last registration per live owner so a cwd move relocates its entry. */
const ownerRegistrations = new WeakMap<SearchResultCacheOwner, { key: string; ref: WeakRef<SearchResultCacheOwner> }>();

/**
 * Shared cleanup for a collected (or simulated-collected) owner ref: run by
 * the FinalizationRegistry and by the deterministic test seam.
 */
function reapCollectedWorkspaceOwner(entry: { key: string; ref: WeakRef<SearchResultCacheOwner> }): void {
	const state = workspaceStates.get(entry.key);
	if (!state) return;
	state.owners.delete(entry.ref);
	for (const ref of state.owners) {
		if (!ref.deref()) state.owners.delete(ref);
	}
	dropWorkspaceStateIfUnused(entry.key, state);
}

/** Drop a collected owner's ref and its bucket once truly unused. */
const ownerFinalizer = new FinalizationRegistry<{ key: string; ref: WeakRef<SearchResultCacheOwner> }>(
	reapCollectedWorkspaceOwner,
);

/**
 * Deterministically exercise the finalizer path for a still-live owner.
 * Test-only: production collection goes through {@link ownerFinalizer}.
 */
export function simulateWorkspaceOwnerCollectionForTests(owner: SearchResultCacheOwner): void {
	const registration = ownerRegistrations.get(owner);
	if (!registration) return;
	ownerFinalizer.unregister(owner);
	ownerRegistrations.delete(owner);
	reapCollectedWorkspaceOwner(registration);
}

function dropWorkspaceStateIfUnused(key: string, state: WorkspaceCacheState): void {
	if (state.owners.size === 0 && state.suppressions === 0) workspaceStates.delete(key);
}

/**
 * Successful realpath results per raw cwd string. Failures (not-yet-existing
 * paths) are intentionally NOT memoized so a later-created directory converges
 * on its real canonical key.
 */
const canonicalKeyMemo = new Map<string, string>();
const CANONICAL_KEY_MEMO_LIMIT = 512;

/**
 * Whether the volume holding `existingDir` treats names case-insensitively,
 * probed at runtime (same dev+ino when the basename's case is toggled).
 * Platform alone is NOT trusted: macOS supports case-sensitive APFS/HFS
 * volumes. Inconclusive probes (no letters in the basename, stat failures)
 * report case-sensitive so distinct-case paths are never merged wrongly.
 */
const caseInsensitiveByDir = new Map<string, boolean>();
const CASE_PROBE_MEMO_LIMIT = 256;

function isCaseInsensitiveDir(existingDir: string): boolean {
	const memoized = caseInsensitiveByDir.get(existingDir);
	if (memoized !== undefined) return memoized;
	let insensitive = false;
	const base = path.basename(existingDir);
	const toggled = base
		.split("")
		.map(ch => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
		.join("");
	if (toggled !== base) {
		try {
			const original = fs.statSync(existingDir);
			const alias = fs.statSync(path.join(path.dirname(existingDir), toggled));
			insensitive = original.dev === alias.dev && original.ino === alias.ino;
		} catch {
			insensitive = false;
		}
	}
	if (caseInsensitiveByDir.size >= CASE_PROBE_MEMO_LIMIT) caseInsensitiveByDir.clear();
	caseInsensitiveByDir.set(existingDir, insensitive);
	return insensitive;
}

/**
 * Uncached canonical form of a path: realpath (collapsing symlink aliases and
 * yielding on-disk casing) with a nearest-existing-ancestor fallback whose
 * missing tail folds case only when a runtime probe proves the ancestor's
 * volume case-insensitive.
 */
function canonicalizePath(input: string): string {
	const resolved = path.resolve(input);
	try {
		// Collapses symlink aliases (macOS `/tmp` -> `/private/tmp`) and yields
		// on-disk casing on case-insensitive filesystems.
		return fs.realpathSync.native(resolved);
	} catch {
		// Not-yet-existing path: canonicalize through the nearest existing
		// ancestor and keep the missing tail. The tail's case folds only when a
		// runtime probe proves the ancestor's volume is case-insensitive —
		// never from the platform name alone.
		let ancestor = resolved;
		const tail: string[] = [];
		while (true) {
			const parent = path.dirname(ancestor);
			if (parent === ancestor) return resolved;
			tail.unshift(path.basename(ancestor));
			ancestor = parent;
			try {
				const realAncestor = fs.realpathSync.native(ancestor);
				const joinedTail = tail.join(path.sep);
				const foldedTail = isCaseInsensitiveDir(realAncestor) ? joinedTail.toLowerCase() : joinedTail;
				return path.join(realAncestor, foldedTail);
			} catch {
				// keep walking up
			}
		}
	}
}

function canonicalWorkspaceKey(cwd: string): string {
	const memoized = canonicalKeyMemo.get(cwd);
	if (memoized !== undefined) return memoized;
	const resolved = path.resolve(cwd);
	const key = canonicalizePath(resolved);
	// Memoize only paths that exist NOW (realpath succeeded): fallback keys
	// for missing paths must converge once the directory is created. Workspace
	// roots are stable, so memoizing them is safe; arbitrary search targets go
	// through the uncached canonicalizePath instead.
	if (fs.existsSync(resolved)) {
		if (canonicalKeyMemo.size >= CANONICAL_KEY_MEMO_LIMIT) canonicalKeyMemo.clear();
		canonicalKeyMemo.set(cwd, key);
	}
	return key;
}

/**
 * Whether `target` physically resolves inside the workspace rooted at
 * `workspaceCwd`, using the SAME canonicalization as workspace cache keys
 * (realpath with nearest-existing-ancestor fallback and probed case
 * semantics). Lexical containment is not enough: an in-workspace symlink can
 * escape to another workspace (must NOT count as inside), while an alias path
 * to the same physical workspace must still count as inside. The TARGET is
 * canonicalized fresh on every call — memoizing it would let a retargeted
 * symlink keep its stale containment verdict; only the stable workspace root
 * goes through the memoized key.
 */
export function isPathWithinWorkspace(workspaceCwd: string, target: string): boolean {
	const root = canonicalWorkspaceKey(workspaceCwd);
	const candidate = canonicalizePath(target);
	// path.relative instead of a `root + sep` prefix check: a canonical root
	// that already ends with a separator (filesystem root, Windows drive root)
	// would otherwise build a double-separator prefix and never match. The
	// escape test is exactly `..` or a `../` prefix — a bare startsWith("..")
	// would wrongly reject an in-root child literally named `..foo`.
	const rel = path.relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Retire an owner's current registration (finalizer token, bucket ref,
 * WeakMap entry), dropping the old bucket when it becomes unused.
 */
function retireOwnerRegistration(owner: SearchResultCacheOwner): void {
	const prior = ownerRegistrations.get(owner);
	if (!prior) return;
	ownerFinalizer.unregister(owner);
	ownerRegistrations.delete(owner);
	const priorState = workspaceStates.get(prior.key);
	if (priorState) {
		priorState.owners.delete(prior.ref);
		dropWorkspaceStateIfUnused(prior.key, priorState);
	}
}

/**
 * Reconcile an owner's registration with its CURRENT cwd — registering,
 * relocating (including to the cwd-less fallback), or leaving it in place —
 * and return the current workspace state, if any. Shared by every entry point
 * so a cwd change is honored even when the first post-move operation is a
 * mutation rather than a cache read.
 */
function reconcileWorkspaceOwner(
	owner: SearchResultCacheOwner,
	cache: SearchResultCache,
): WorkspaceCacheState | undefined {
	if (!owner.cwd) {
		retireOwnerRegistration(owner);
		cache.setWorkspaceState(undefined);
		return undefined;
	}
	const key = canonicalWorkspaceKey(owner.cwd);
	const prior = ownerRegistrations.get(owner);
	if (prior?.key === key) return workspaceStates.get(key);
	retireOwnerRegistration(owner);
	let state = workspaceStates.get(key);
	if (!state) {
		state = { owners: new Set(), suppressions: 0 };
		workspaceStates.set(key, state);
	}
	for (const ref of state.owners) {
		if (!ref.deref()) state.owners.delete(ref);
	}
	const ref = new WeakRef(owner);
	state.owners.add(ref);
	ownerRegistrations.set(owner, { key, ref });
	ownerFinalizer.register(owner, { key, ref }, owner);
	cache.setWorkspaceState(state);
	return state;
}

export function getSearchResultCache(owner: SearchResultCacheOwner): SearchResultCache {
	owner.searchResultCache ??= new SearchResultCache();
	// Any session that can hold cached pages participates in same-workspace
	// fan-out invalidation and suppression from that point on.
	reconcileWorkspaceOwner(owner, owner.searchResultCache);
	return owner.searchResultCache;
}

function clearWorkspaceKey(key: string): void {
	const state = workspaceStates.get(key);
	if (!state) return;
	for (const ref of state.owners) {
		const held = ref.deref();
		if (!held) {
			state.owners.delete(ref);
			continue;
		}
		held.searchResultCache?.clear();
	}
	dropWorkspaceStateIfUnused(key, state);
}

export function clearSearchResultCache(owner: SearchResultCacheOwner): void {
	owner.searchResultCache?.clear();
	// A mutation can be the first operation after a cwd change: reconcile the
	// owner's registration before fanning out so the old workspace stops
	// evicting it and the stale bucket can retire.
	if (owner.searchResultCache) reconcileWorkspaceOwner(owner, owner.searchResultCache);
	if (!owner.cwd) return;
	clearWorkspaceKey(canonicalWorkspaceKey(owner.cwd));
}

function suppressWorkspaceKey(key: string): () => void {
	let state = workspaceStates.get(key);
	if (!state) {
		// Suppressing a workspace nobody has cached in yet still matters:
		// owners registering mid-flight attach to this state and stay blocked.
		state = { owners: new Set(), suppressions: 0 };
		workspaceStates.set(key, state);
	}
	state.suppressions++;
	for (const ref of state.owners) {
		const held = ref.deref();
		if (!held) {
			state.owners.delete(ref);
			continue;
		}
		held.searchResultCache?.clear();
	}
	return () => {
		state.suppressions--;
		dropWorkspaceStateIfUnused(key, state);
	};
}

/**
 * Invalidate and hold closed EVERY cache in the affected workspaces —
 * including owners that register mid-flight — until the returned release is
 * called. Used while a background job may still be mutating shared files: a
 * sibling session (e.g. the parent of a non-isolated task child) must neither
 * serve nor repopulate cached pages during the window. Suppressions nest
 * across holders.
 *
 * `mutationCwd` names the effective working directory of the job when it
 * differs from the owner's session cwd (e.g. a Bash `cwd` override); its
 * workspace is suppressed as well WITHOUT relocating the owner's own
 * registration. The initiating instance cache is always held closed, so
 * cwd-less owners remain covered.
 */
export function suppressSearchResultCaches(owner: SearchResultCacheOwner, mutationCwd?: string): () => void {
	const cache = getSearchResultCache(owner);
	const releases: Array<() => void> = [cache.suppress()];
	const keys = new Set<string>();
	if (owner.cwd) keys.add(canonicalWorkspaceKey(owner.cwd));
	if (mutationCwd) keys.add(canonicalWorkspaceKey(mutationCwd));
	for (const key of keys) {
		releases.push(suppressWorkspaceKey(key));
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		for (const release of releases) release();
	};
}

/**
 * Test-only introspection: live-owner count and suppression depth for a cwd,
 * or undefined once the bucket has been dropped.
 */
export function workspaceRegistrySnapshot(cwd: string): { owners: number; suppressions: number } | undefined {
	const state = workspaceStates.get(canonicalWorkspaceKey(cwd));
	if (!state) return undefined;
	let owners = 0;
	for (const ref of state.owners) {
		if (ref.deref()) owners++;
	}
	return { owners, suppressions: state.suppressions };
}
