import * as fs from "node:fs";
import * as path from "node:path";

const JSONL_SUFFIX = ".jsonl";

function rebaseExistingArtifactSuffix(linkPath: string, currentArtifactsDir: string): string | undefined {
	const normalized = path.normalize(linkPath);
	const parts = normalized.split(path.sep).filter(Boolean);
	for (let index = 0; index < parts.length; index += 1) {
		const candidate = path.join(currentArtifactsDir, ...parts.slice(index));
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}
/**
 * Rebase a persisted artifact-child link after `/move` relocates the owning
 * session's artifact directory, or after a copied/forked transcript keeps
 * source-session link paths. Completed-job and `/tan` breadcrumbs persist direct
 * children of `<session>.jsonl`'s sibling artifact directory; when that same
 * child exists beside the current session, prefer it over the stale source path.
 */
export function rebasePersistedArtifactLinkPath(
	linkPath: string | undefined,
	currentSessionFile: string | undefined,
): string | undefined {
	if (!linkPath) return undefined;
	const currentArtifactsDir = currentSessionFile?.endsWith(JSONL_SUFFIX)
		? currentSessionFile.slice(0, -JSONL_SUFFIX.length)
		: undefined;
	if (!currentArtifactsDir) return linkPath;
	if (!path.isAbsolute(linkPath)) return path.join(currentArtifactsDir, linkPath);
	const normalizedLinkPath = path.normalize(linkPath);
	if (path.dirname(normalizedLinkPath) === path.normalize(currentArtifactsDir)) return normalizedLinkPath;
	const rebasedSuffixPath = rebaseExistingArtifactSuffix(normalizedLinkPath, currentArtifactsDir);
	if (rebasedSuffixPath) return rebasedSuffixPath;
	const rebasedPath = path.join(currentArtifactsDir, path.basename(linkPath));
	if (fs.existsSync(rebasedPath)) return rebasedPath;
	if (fs.existsSync(linkPath)) return linkPath;
	if (path.basename(path.dirname(linkPath)) !== path.basename(currentArtifactsDir)) return linkPath;
	return rebasedPath;
}
