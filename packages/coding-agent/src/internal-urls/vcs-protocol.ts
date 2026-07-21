import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { shortenPath } from "../tools/render-utils";
import * as git from "../utils/git";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext } from "./types";

type VcsOperation = "state" | "diff";

type ParsedVcsRequest = {
	operation: VcsOperation;
	pathScopes: string[];
	fileScopes: string[];
	base?: string;
	staged?: boolean;
};

const SUPPORTED_QUERY_PARAMS: Record<string, true> = { base: true, file: true, staged: true };

function requireSingleParam(params: URLSearchParams, name: "base" | "staged"): string | undefined {
	const values = params.getAll(name);
	if (values.length > 1) throw new Error(`vcs:// ${name} may be provided at most once.`);
	return values[0];
}

function decodePathScope(url: InternalUrl): string | undefined {
	const rawPath = url.rawPathname ?? url.pathname;
	if (!rawPath || rawPath === "/") return undefined;
	try {
		const decoded = decodeURIComponent(rawPath.slice(1));
		return decoded === "" ? undefined : decoded;
	} catch {
		throw new Error(`Invalid URL encoding in vcs:// path: ${url.href}`);
	}
}

function parseVcsUrl(url: InternalUrl): ParsedVcsRequest {
	const operation = url.rawHost || url.hostname;
	if (operation !== "state" && operation !== "diff") {
		throw new Error("Invalid vcs:// URL. Expected vcs://state or vcs://diff[/path].");
	}

	for (const key of url.searchParams.keys()) {
		if (!Object.hasOwn(SUPPORTED_QUERY_PARAMS, key)) {
			throw new Error(`Invalid vcs:// query parameter '${key}'. Supported: base, staged, file.`);
		}
	}

	const base = requireSingleParam(url.searchParams, "base");
	const stagedValue = requireSingleParam(url.searchParams, "staged");
	let staged: boolean | undefined;
	if (stagedValue !== undefined) {
		if (stagedValue === "true") staged = true;
		else if (stagedValue === "false") staged = false;
		else throw new Error(`Invalid vcs:// staged value '${stagedValue}'. Use true or false.`);
	}

	const fileScopes = url.searchParams.getAll("file").map(scope => {
		if (scope === "") throw new Error("vcs:// file query parameters must be non-empty.");
		return scope;
	});
	const pathScope = decodePathScope(url);
	return {
		operation,
		pathScopes: pathScope ? [pathScope] : [],
		fileScopes,
		...(base !== undefined ? { base } : {}),
		...(staged !== undefined ? { staged } : {}),
	};
}

function toGitPath(scope: string): string {
	return path.sep === "/" ? scope : scope.split(path.sep).join("/");
}

/**
 * Canonicalize an absolute path so containment checks compare physical paths,
 * matching the physical repo root Git reports. Symlinks are resolved segment by
 * segment BEFORE `..` is applied — `fs.realpath` (and `path.resolve`) collapse
 * `/repo/link/../x` lexically to `/repo/x`, which would mask a physical escape
 * when `link` points outside the repository. Nonexistent segments cannot be
 * symlinks, so they are appended verbatim and popped lexically by `..`; once
 * `..` backs out of the whole nonexistent suffix, the prefix is canonical and
 * existing again, and later segments resume symlink resolution.
 */
function realpathExisting(target: string): string {
	const root = path.parse(target).root;
	let resolved = root;
	let missingDepth = 0;
	// Windows path syntax accepts `/` and `\` interchangeably (URL-derived scopes
	// commonly use `/`); on POSIX a backslash is an ordinary filename byte and
	// must not split a segment.
	const segments =
		path.sep === "\\" ? target.slice(root.length).split(/[\\/]/) : target.slice(root.length).split(path.sep);
	for (const part of segments) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			// The parent of a canonical path is canonical; popping a missing
			// segment restores the deeper (possibly existing) prefix.
			resolved = path.dirname(resolved);
			if (missingDepth > 0) missingDepth--;
			continue;
		}
		const candidate = path.join(resolved, part);
		if (missingDepth === 0) {
			try {
				// `candidate` is a canonical prefix plus one plain segment (no `.`/`..`),
				// so realpath only has the final symlink hop left to resolve.
				resolved = fs.realpathSync(candidate);
				continue;
			} catch (err) {
				// Only a genuinely missing suffix (ENOENT) may be appended unresolved.
				// ENOTDIR means a prefix segment is a file — backing out with `..`
				// could collapse the scope onto its parent and broaden the pathspec.
				// EACCES/ELOOP/etc. mean the segment could not be canonicalized, so
				// containment cannot be proven — propagate all of them.
				if (!isEnoent(err)) throw err;
			}
		}
		missingDepth++;
		resolved = candidate;
	}
	return resolved;
}

function resolveGitCwd(repoRoot: string, cwdPrefix: string): string {
	const normalizedPrefix = cwdPrefix.replace(/\/+$/, "");
	if (normalizedPrefix === "") return repoRoot;
	return path.join(repoRoot, ...normalizedPrefix.split("/"));
}

function normalizePathspecs(cwdPrefix: string, repoRoot: string, scopes: readonly string[]): string[] | undefined {
	if (scopes.length === 0) return undefined;
	const result: string[] = [];
	const seen = new Set<string>();
	const normalizedPrefix = toGitPath(cwdPrefix).replace(/\/+$/, "");
	let physicalRoot: string | undefined;
	for (const scope of scopes) {
		let repoRelative: string;
		if (path.isAbsolute(scope)) {
			physicalRoot ??= realpathExisting(repoRoot);
			// Feed the raw absolute scope to realpath so symlinks resolve before
			// `..` collapses: a lexical `path.resolve` of `/repo/link/../x` with
			// `link -> /outside/dir` would yield `/repo/x` and mask a physical escape.
			const absolute = realpathExisting(scope);
			const fsRelative = path.relative(physicalRoot, absolute);
			if (fsRelative === ".." || fsRelative.startsWith(`..${path.sep}`) || path.isAbsolute(fsRelative)) {
				throw new Error(`Requested file resolves outside the repository: "${scope}".`);
			}
			repoRelative = fsRelative === "" ? "." : toGitPath(fsRelative);
		} else {
			repoRelative = path.posix.normalize(path.posix.join(normalizedPrefix, toGitPath(scope)));
			if (repoRelative === ".." || repoRelative.startsWith("../") || path.posix.isAbsolute(repoRelative)) {
				throw new Error(`Requested file resolves outside the repository: "${scope}".`);
			}
		}
		const pathspec = repoRelative === "." ? "." : `:(literal)${repoRelative}`;
		if (!seen.has(pathspec)) {
			seen.add(pathspec);
			result.push(pathspec);
		}
	}
	return result;
}

function dedupe<T>(items: readonly T[]): T[] {
	const result: T[] = [];
	const seen = new Set<T>();
	for (const item of items) {
		if (seen.has(item)) continue;
		seen.add(item);
		result.push(item);
	}
	return result;
}

function rebaseRepoPath(cwd: string, repoRoot: string, repoRelative: string): string {
	const absolute = path.join(repoRoot, repoRelative);
	const relative = path.relative(cwd, absolute);
	return (relative === "" ? "." : relative.split(path.sep).join("/")) || ".";
}

type RenameStatPath = {
	oldPath: string;
	newPath: string;
	braced: boolean;
};

function parseRenameStatPath(pathColumn: string): RenameStatPath | undefined {
	const repoRelative = pathColumn.trimEnd();
	const braceStart = repoRelative.indexOf("{");
	if (braceStart !== -1) {
		const braceEnd = repoRelative.indexOf("}", braceStart + 1);
		if (braceEnd !== -1) {
			const inner = repoRelative.slice(braceStart + 1, braceEnd);
			const arrow = inner.indexOf(" => ");
			if (arrow !== -1) {
				const oldPart = inner.slice(0, arrow);
				const newPart = inner.slice(arrow + " => ".length);
				if (oldPart !== "" && newPart !== "") {
					const prefix = repoRelative.slice(0, braceStart);
					const suffix = repoRelative.slice(braceEnd + 1);
					return {
						oldPath: `${prefix}${oldPart}${suffix}`,
						newPath: `${prefix}${newPart}${suffix}`,
						braced: true,
					};
				}
			}
		}
	}

	const arrow = repoRelative.indexOf(" => ");
	if (arrow === -1) return undefined;
	const oldPath = repoRelative.slice(0, arrow);
	const newPath = repoRelative.slice(arrow + " => ".length);
	if (oldPath === "" || newPath === "") return undefined;
	return { oldPath, newPath, braced: false };
}

function formatBracedRenameStatPath(oldPath: string, newPath: string): string {
	const oldParts = oldPath.split("/");
	const newParts = newPath.split("/");
	let prefixLength = 0;
	while (
		prefixLength < oldParts.length &&
		prefixLength < newParts.length &&
		oldParts[prefixLength] === newParts[prefixLength]
	) {
		prefixLength++;
	}

	let oldEnd = oldParts.length;
	let newEnd = newParts.length;
	while (oldEnd > prefixLength && newEnd > prefixLength && oldParts[oldEnd - 1] === newParts[newEnd - 1]) {
		oldEnd--;
		newEnd--;
	}

	const oldMiddle = oldParts.slice(prefixLength, oldEnd).join("/");
	const newMiddle = newParts.slice(prefixLength, newEnd).join("/");
	if (oldMiddle === "" || newMiddle === "") return `${oldPath} => ${newPath}`;

	const prefix = prefixLength === 0 ? "" : `${oldParts.slice(0, prefixLength).join("/")}/`;
	const suffix = oldEnd === oldParts.length ? "" : `/${oldParts.slice(oldEnd).join("/")}`;
	return `${prefix}{${oldMiddle} => ${newMiddle}}${suffix}`;
}

function rebaseStatPaths(cwd: string, repoRoot: string, stat: string, repoPaths: readonly string[]): string {
	return stat
		.split(/\r?\n/)
		.map(line => rebaseStatPath(cwd, repoRoot, line, repoPaths))
		.join("\n");
}

function rebaseStatPath(cwd: string, repoRoot: string, line: string, repoPaths: readonly string[]): string {
	const separator = line.lastIndexOf(" | ");
	if (separator === -1) return line;
	const pathColumn = line.slice(0, separator);
	const rawRepoRelative = pathColumn.trimEnd();
	if (rawRepoRelative === "") return line;
	const unpaddedRepoRelative = rawRepoRelative.startsWith(" ") ? rawRepoRelative.slice(1) : rawRepoRelative;
	const exactRepoRelative = repoPaths.find(
		repoPath =>
			repoPath === rawRepoRelative ||
			repoPath === unpaddedRepoRelative ||
			repoPath.trimStart() === unpaddedRepoRelative,
	);
	const repoRelative = exactRepoRelative ?? unpaddedRepoRelative;
	const trailing = pathColumn.slice(rawRepoRelative.length);
	const rename = exactRepoRelative === undefined ? parseRenameStatPath(repoRelative) : undefined;
	if (rename) {
		const oldPath = rebaseRepoPath(cwd, repoRoot, rename.oldPath);
		const newPath = rebaseRepoPath(cwd, repoRoot, rename.newPath);
		const rebasedPath = rename.braced ? formatBracedRenameStatPath(oldPath, newPath) : `${oldPath} => ${newPath}`;
		return `${rebasedPath}${trailing}${line.slice(separator)}`;
	}
	return `${rebaseRepoPath(cwd, repoRoot, repoRelative)}${trailing}${line.slice(separator)}`;
}

function formatReadPath(file: string): string {
	const display = escapeControlChars(file);
	const quotedPath = JSON.stringify(file).replace(/[\x7f-\x9f]/g, char => {
		return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
	});
	return display === file ? display : `${display} [read path: ${quotedPath}]`;
}

function formatVcsScope(file: string): string {
	const display = escapeControlChars(file);
	return display === file ? display : `${display} [scope: vcs://diff?file=${encodeURIComponent(file)}]`;
}

function formatUntrackedDiffHint(cwd: string, repoRoot: string, untracked: readonly string[]): string {
	return [
		"Untracked files are not included in git diff. Read them directly:",
		...untracked.map(file => `  ${formatReadPath(rebaseRepoPath(cwd, repoRoot, file))}`),
	].join("\n");
}

function trimStat(stat: string, empty: string): string {
	const lines = stat.split(/\r?\n/);
	while (lines[0] === "") lines.shift();
	while (lines.at(-1) === "") lines.pop();
	return lines.length === 0 ? empty : lines.join("\n");
}

async function resolveBaseCommit(
	repoRoot: string,
	base: string | undefined,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (base === undefined) return undefined;
	if (base.length === 0 || base.length > 256 || base.startsWith("-") || base.includes("\0")) {
		throw new Error(
			`Invalid base ref "${base}". Provide a plain branch, tag, or commit (no leading '-' or option-like values).`,
		);
	}
	const commit = await git.ref.commit(repoRoot, base, signal);
	if (!commit) throw new Error(`Base "${base}" does not resolve to a commit, tag, or branch in this repository.`);
	return commit;
}

function viewLabel(baseCommit: string | undefined, staged: boolean | undefined): string {
	if (baseCommit) return staged ? `staged vs base ${baseCommit.slice(0, 12)}` : `base ${baseCommit.slice(0, 12)}`;
	if (staged === true) return "staged";
	if (staged === false) return "working-tree";
	return "working-tree + staged";
}

export class VcsProtocolHandler implements ProtocolHandler {
	readonly scheme = "vcs";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const cwd = context?.cwd ?? process.cwd();
		const signal = context?.signal;
		const request = parseVcsUrl(url);
		const repoRoot = await git.repo.root(cwd, signal);
		if (!repoRoot) throw new Error("Not inside a git repository.");

		const cwdPrefix = await git.show.prefix(cwd, signal);
		const displayCwd = resolveGitCwd(repoRoot, cwdPrefix);
		const baseCommit = await resolveBaseCommit(repoRoot, request.base, signal);
		const files = normalizePathspecs(cwdPrefix, repoRoot, [...request.pathScopes, ...request.fileScopes]);
		const diffOptions: git.DiffOptions = {
			noExternal: true,
			literalPaths: true,
			cached: request.staged,
			...(baseCommit ? { base: baseCommit } : {}),
			...(files ? { files } : {}),
			signal,
		};

		const content =
			request.operation === "state"
				? await this.#resolveState(displayCwd, repoRoot, baseCommit, request.staged, files, diffOptions, signal)
				: await this.#resolveDiff(displayCwd, repoRoot, baseCommit, request.staged, files, diffOptions, signal);

		return {
			url: url.href,
			content,
			contentType: "text/plain",
		};
	}

	async #resolveDiff(
		cwd: string,
		repoRoot: string,
		baseCommit: string | undefined,
		staged: boolean | undefined,
		files: string[] | undefined,
		diffOptions: git.DiffOptions,
		signal?: AbortSignal,
	): Promise<string> {
		const sections: string[] = [];
		if (!baseCommit && staged === undefined) {
			const [stagedDiff, unstagedDiff, untracked] = await Promise.all([
				git.diff(repoRoot, { ...diffOptions, cached: true }),
				git.diff(repoRoot, { ...diffOptions, cached: false }),
				git.ls.untracked(repoRoot, { files, literalPaths: true, signal, z: true }),
			]);
			if (stagedDiff.trim() !== "") sections.push(stagedDiff.trimEnd());
			if (unstagedDiff.trim() !== "") sections.push(unstagedDiff.trimEnd());
			if (untracked.length > 0) sections.push(formatUntrackedDiffHint(cwd, repoRoot, untracked));
			return sections.length === 0 ? "No changes for the requested diff." : sections.join("\n\n");
		}

		const diffText = await git.diff(repoRoot, diffOptions);
		if (diffText.trim() !== "") sections.push(diffText.trimEnd());
		if (staged !== true) {
			const untracked = await git.ls.untracked(repoRoot, { files, literalPaths: true, signal, z: true });
			if (untracked.length > 0) sections.push(formatUntrackedDiffHint(cwd, repoRoot, untracked));
		}
		return sections.length === 0 ? "No changes for the requested diff." : sections.join("\n\n");
	}

	async #resolveState(
		cwd: string,
		repoRoot: string,
		baseCommit: string | undefined,
		staged: boolean | undefined,
		files: string[] | undefined,
		diffOptions: git.DiffOptions,
		signal?: AbortSignal,
	): Promise<string> {
		const headState = await git.head.resolve(repoRoot, signal);
		let changedFiles: string[];
		let statSection: string[];

		if (baseCommit || staged !== undefined) {
			const [names, stat] = await Promise.all([
				git.diff(repoRoot, { ...diffOptions, nameOnly: true, z: true }),
				git.diff(repoRoot, { ...diffOptions, stat: true }),
			]);
			const changedNames = gitSplitLines(names);
			changedFiles = changedNames.map(name => rebaseRepoPath(cwd, repoRoot, name));
			statSection = [trimStat(rebaseStatPaths(cwd, repoRoot, stat, changedNames), "No tracked changes.")];
		} else {
			const [unstagedNamesText, unstagedStat, stagedNamesText, stagedStat] = await Promise.all([
				git.diff(repoRoot, { ...diffOptions, cached: false, nameOnly: true, z: true }),
				git.diff(repoRoot, { ...diffOptions, cached: false, stat: true }),
				git.diff(repoRoot, { ...diffOptions, cached: true, nameOnly: true, z: true }),
				git.diff(repoRoot, { ...diffOptions, cached: true, stat: true }),
			]);
			const unstagedNames = gitSplitLines(unstagedNamesText);
			const stagedNames = gitSplitLines(stagedNamesText);
			changedFiles = dedupe([...stagedNames, ...unstagedNames]).map(name => rebaseRepoPath(cwd, repoRoot, name));
			statSection = [
				"Staged:",
				trimStat(rebaseStatPaths(cwd, repoRoot, stagedStat, stagedNames), "No staged changes."),
				"Unstaged:",
				trimStat(rebaseStatPaths(cwd, repoRoot, unstagedStat, unstagedNames), "No unstaged changes."),
			];
		}

		const untracked =
			staged === true
				? []
				: (await git.ls.untracked(repoRoot, { files, literalPaths: true, signal, z: true })).map(name =>
						rebaseRepoPath(cwd, repoRoot, name),
					);

		const lines = [`repo: ${escapeControlChars(shortenPath(repoRoot))}`];
		if (headState?.kind === "ref" && headState.branchName) lines.push(`branch: ${headState.branchName}`);
		if (headState?.commit) lines.push(`head: ${headState.commit.slice(0, 12)}`);
		lines.push(`view: ${viewLabel(baseCommit, staged)}`, "", `Changed files (${changedFiles.length}):`);
		lines.push(
			...(changedFiles.length === 0 ? ["  (none)"] : changedFiles.map(file => `  ${formatVcsScope(file)}`)),
			"Stat:",
			...statSection,
		);
		if (untracked.length > 0) {
			lines.push("", `Untracked (${untracked.length}):`, ...untracked.map(file => `  ${formatReadPath(file)}`));
		}
		return lines.join("\n");
	}
}

function gitSplitLines(text: string): string[] {
	const records = text.includes("\0") ? text.split("\0") : text.split(/\r?\n/);
	return records.filter(record => record.length > 0);
}
function escapeControlChars(p: string): string {
	return p.replace(/[\x00-\x1f\x7f-\x9f]/g, c => {
		const map: Record<string, string> = {
			"\b": "\\b",
			"\f": "\\f",
			"\n": "\\n",
			"\r": "\\r",
			"\t": "\\t",
			"\v": "\\v",
		};
		return map[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
	});
}
