import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactDescriptor, TurnFileChange, TurnId } from "@oh-my-pi/app-wire";

const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface TurnReviewSessionStore {
	getCwd(): string;
	saveArtifact(content: string, toolType: string): Promise<string | undefined>;
	appendCustomEntry(customType: string, data?: unknown): string;
}

interface PreparedTurnReview {
	readonly cwd: string;
	readonly baseTree: string;
}

interface GitResult {
	readonly stdout: string;
	readonly overflowed: boolean;
	readonly ok: boolean;
}

async function readBounded(
	stream: ReadableStream<Uint8Array>,
	limit: number,
): Promise<{ text: string; overflowed: boolean }> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) return { text: "", overflowed: true };
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	return { text: new TextDecoder().decode(Buffer.concat(chunks)), overflowed: false };
}

async function git(
	cwd: string,
	args: readonly string[],
	options: { index?: string; limit?: number } = {},
): Promise<GitResult> {
	try {
		const child = Bun.spawn({
			cmd: ["git", ...args],
			cwd,
			env: options.index === undefined ? process.env : { ...process.env, GIT_INDEX_FILE: options.index },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [output, ignoredError, exitCode] = await Promise.all([
			readBounded(child.stdout, options.limit ?? MAX_GIT_OUTPUT_BYTES),
			readBounded(child.stderr, 64 * 1024),
			child.exited,
		]);
		void ignoredError;
		return { stdout: output.text, overflowed: output.overflowed, ok: exitCode === 0 && !output.overflowed };
	} catch {
		return { stdout: "", overflowed: false, ok: false };
	}
}

export async function captureWorktreeTree(cwd: string): Promise<string | undefined> {
	let directory: string | undefined;
	try {
		directory = await mkdtemp(join(tmpdir(), "omp-turn-index-"));
		const index = join(directory, "index");
		if (!(await git(cwd, ["read-tree", "HEAD"], { index })).ok) return undefined;
		if (!(await git(cwd, ["add", "-A"], { index })).ok) return undefined;
		const result = await git(cwd, ["write-tree"], { index, limit: 256 });
		const tree = result.stdout.trim();
		return result.ok && /^[a-f0-9]{40,64}$/u.test(tree) ? tree : undefined;
	} finally {
		if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
	}
}

function untrackedPaths(porcelain: string): Set<string> {
	const paths = new Set<string>();
	for (const record of porcelain.split("\0")) {
		if (record.startsWith("?? ")) paths.add(record.slice(3));
	}
	return paths;
}

interface RawChange {
	readonly status: string;
	readonly path: string;
	readonly previousPath?: string;
}

function rawChanges(value: string): RawChange[] {
	const parts = value.split("\0");
	const changes: RawChange[] = [];
	for (let index = 0; index < parts.length - 1; ) {
		const status = parts[index++]!;
		if (!status) continue;
		if (status.startsWith("R") || status.startsWith("C")) {
			const previousPath = parts[index++];
			const path = parts[index++];
			if (previousPath && path) changes.push({ status, path, previousPath });
			continue;
		}
		const path = parts[index++];
		if (path) changes.push({ status, path });
	}
	return changes;
}

async function changeSummary(
	cwd: string,
	baseTree: string,
	headTree: string,
	change: RawChange,
	untracked: ReadonlySet<string>,
): Promise<TurnFileChange | undefined> {
	if (change.path.startsWith("/") || change.path.split(/[\\/]/u).includes("..")) return undefined;
	const numstat = await git(cwd, ["diff", "--numstat", "--no-renames", baseTree, headTree, "--", change.path], {
		limit: 1024,
	});
	const [additionsRaw = "0", deletionsRaw = "0"] = numstat.stdout.trim().split("\t", 3);
	const additions = additionsRaw === "-" ? 0 : Number.parseInt(additionsRaw, 10);
	const deletions = deletionsRaw === "-" ? 0 : Number.parseInt(deletionsRaw, 10);
	const deleted = change.status.startsWith("D");
	let size: number | undefined;
	if (!deleted) {
		const result = await git(cwd, ["cat-file", "-s", `${headTree}:${change.path}`], { limit: 128 });
		const parsed = Number.parseInt(result.stdout.trim(), 10);
		if (result.ok && Number.isSafeInteger(parsed) && parsed >= 0) size = parsed;
	}
	const binary = additionsRaw === "-" || deletionsRaw === "-";
	return {
		path: change.path,
		...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }),
		status: untracked.has(change.path)
			? "untracked"
			: change.status.startsWith("A")
				? "added"
				: change.status.startsWith("D")
					? "deleted"
					: change.status.startsWith("R")
						? "renamed"
						: change.status.startsWith("C")
							? "copied"
							: "modified",
		kind: deleted ? "missing" : binary ? "binary" : (size ?? 0) > MAX_TEXT_FILE_BYTES ? "huge" : "text",
		state: "pending",
		additions: Number.isSafeInteger(additions) && additions >= 0 ? additions : 0,
		deletions: Number.isSafeInteger(deletions) && deletions >= 0 ? deletions : 0,
		...(size === undefined ? {} : { size }),
	};
}

export async function prepareTurnReview(
	store: Pick<TurnReviewSessionStore, "getCwd">,
): Promise<PreparedTurnReview | undefined> {
	try {
		const cwd = store.getCwd();
		if (!(await git(cwd, ["rev-parse", "--is-inside-work-tree"], { limit: 64 })).ok) return undefined;
		const baseTree = await captureWorktreeTree(cwd);
		return baseTree === undefined ? undefined : { cwd, baseTree };
	} catch {
		return undefined;
	}
}

export async function appendTurnReview(
	store: TurnReviewSessionStore,
	prepared: PreparedTurnReview | undefined,
	turnId: TurnId,
): Promise<void> {
	if (!prepared) return;
	try {
		const headTree = await captureWorktreeTree(prepared.cwd);
		if (!headTree || headTree === prepared.baseTree) return;
		const [status, changes] = await Promise.all([
			git(prepared.cwd, ["status", "--porcelain=v1", "-z"]),
			git(prepared.cwd, [
				"diff",
				"--name-status",
				"-z",
				"--find-renames",
				"--find-copies",
				prepared.baseTree,
				headTree,
			]),
		]);
		if (!status.ok || !changes.ok) return;
		const summaries = (
			await Promise.all(
				rawChanges(changes.stdout).map(change =>
					changeSummary(prepared.cwd, prepared.baseTree, headTree, change, untrackedPaths(status.stdout)),
				),
			)
		).filter((change): change is TurnFileChange => change !== undefined);
		if (summaries.length === 0) return;
		const patch = await git(
			prepared.cwd,
			["diff", "--no-ext-diff", "--binary", "--find-renames", prepared.baseTree, headTree],
			{ limit: MAX_PATCH_BYTES },
		);
		let descriptor: ArtifactDescriptor | undefined;
		if (patch.ok && !patch.overflowed && patch.stdout.length > 0) {
			const id = await store.saveArtifact(patch.stdout, "turn-review");
			if (id) {
				descriptor = {
					artifactId: id as ArtifactDescriptor["artifactId"],
					kind: "patch",
					mediaType: "text/x-diff",
					size: Buffer.byteLength(patch.stdout),
					sha256: createHash("sha256").update(patch.stdout).digest("hex"),
					name: `${id}.turn-review.log`,
					disposition: "attachment",
					retention: "session",
				};
			}
		}
		store.appendCustomEntry("turn-review", {
			turnId,
			baseTree: prepared.baseTree,
			headTree,
			changes: summaries,
			...(descriptor === undefined ? {} : { patch: descriptor }),
			artifacts: descriptor === undefined ? [] : [descriptor],
		});
	} catch {
		// A review snapshot is observational; a non-git directory or git failure never rejects the prompt.
	}
}
