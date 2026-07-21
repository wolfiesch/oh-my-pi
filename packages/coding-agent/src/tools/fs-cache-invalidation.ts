import { invalidateFsScanCache } from "@oh-my-pi/pi-natives";
import { clearSearchResultCache, type SearchResultCacheOwner } from "./search-result-cache";

/**
 * Invalidate shared filesystem scan caches after a content write/update.
 */
export function invalidateFsScanAfterWrite(path: string, owner: SearchResultCacheOwner): void {
	invalidateFsScanCache(path);
	clearSearchResultCache(owner);
}

/**
 * Invalidate shared filesystem scan caches after deleting a file.
 */
export function invalidateFsScanAfterDelete(path: string, owner: SearchResultCacheOwner): void {
	invalidateFsScanCache(path);
	clearSearchResultCache(owner);
}

/**
 * Invalidate shared filesystem scan caches after a rename/move.
 *
 * Some watchers care about the disappearance at the old path; others about the
 * appearance at the new one. Bust both to keep callers honest.
 */
export function invalidateFsScanAfterRename(oldPath: string, newPath: string, owner: SearchResultCacheOwner): void {
	invalidateFsScanCache(oldPath);
	if (newPath !== oldPath) {
		invalidateFsScanCache(newPath);
	}
	clearSearchResultCache(owner);
}
