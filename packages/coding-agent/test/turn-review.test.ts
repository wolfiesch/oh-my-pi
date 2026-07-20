import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TURN_FILE_CHANGES, type TurnId } from "@oh-my-pi/app-wire";
import { CodingAgentDesktopAuthority } from "@oh-my-pi/pi-coding-agent/session/desktop-operations-authority";
import {
	appendTurnReview,
	prepareTurnReview,
	type TurnReviewSessionStore,
} from "@oh-my-pi/pi-coding-agent/session/turn-review";

const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr || `git ${args.join(" ")} failed`);
	return stdout.trim();
}

async function repository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "omp-turn-review-test-"));
	roots.push(root);
	await git(root, "init", "-q");
	await writeFile(join(root, "one.txt"), "one before\n");
	await writeFile(join(root, "two.txt"), "two before\n");
	await git(root, "add", "one.txt", "two.txt");
	await git(
		root,
		"-c",
		"user.name=Turn Review Test",
		"-c",
		"user.email=turn-review@example.invalid",
		"commit",
		"-qm",
		"baseline",
	);
	return root;
}

describe("turn-scoped file review", () => {
	test("captures a turn and persists independent keep and discard decisions", async () => {
		const root = await repository();
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		let artifact = "";
		const store: TurnReviewSessionStore = {
			getCwd: () => root,
			saveArtifact: async content => {
				artifact = content;
				return "2001";
			},
			appendCustomEntry: (customType, data) => {
				entries.push({ type: "custom", customType, data });
				return `entry-${entries.length}`;
			},
		};
		const prepared = await prepareTurnReview(store);
		expect(prepared).toBeDefined();
		await writeFile(join(root, "one.txt"), "one after\n");
		await writeFile(join(root, "two.txt"), "two after\n");
		await writeFile(join(root, "three.txt"), "three after\n");
		await appendTurnReview(store, prepared, "turn-1" as TurnId);
		expect(artifact).toContain("diff --git");
		expect(entries).toHaveLength(1);

		const authority = new CodingAgentDesktopAuthority({
			sessionManager: {
				getCwd: () => root,
				getSessionId: () => "session-1",
				getBranch: () => entries as never,
				appendCustomEntry: store.appendCustomEntry,
			},
			projectRootForSession: sessionId => {
				if (sessionId !== "session-1") throw new Error("unknown session");
				return root;
			},
		});
		const initial = await authority.filesDiff({ turnId: "turn-1" });
		expect(initial).toMatchObject({
			turnId: "turn-1",
			changes: [
				{ path: "one.txt", state: "pending" },
				{ path: "three.txt", status: "untracked", state: "pending" },
				{ path: "two.txt", state: "pending" },
			],
			patch: { artifactId: "2001", kind: "patch" },
		});
		let revision = String(initial.headTree);
		await expect(
			authority.reviewApply({
				turnId: "turn-1",
				path: "one.txt",
				action: "discard",
				expectedRevision: "0".repeat(40),
			}),
		).rejects.toMatchObject({ code: "STALE_REVISION" });

		const discardedOne = await authority.reviewApply({
			turnId: "turn-1",
			path: "one.txt",
			action: "discard",
			expectedRevision: revision,
		});
		expect(discardedOne).toMatchObject({ state: "discarded" });
		revision = String(discardedOne.resultingRevision);
		expect(await readFile(join(root, "one.txt"), "utf8")).toBe("one before\n");
		const keptTwo = await authority.reviewApply({
			turnId: "turn-1",
			path: "two.txt",
			action: "keep",
			expectedRevision: revision,
		});
		expect(keptTwo).toMatchObject({ state: "applied" });
		revision = String(keptTwo.resultingRevision);
		expect(await readFile(join(root, "two.txt"), "utf8")).toBe("two after\n");
		const discardedThree = await authority.reviewApply({
			turnId: "turn-1",
			path: "three.txt",
			action: "discard",
			expectedRevision: revision,
		});
		expect(discardedThree).toMatchObject({ state: "discarded" });
		revision = String(discardedThree.resultingRevision);
		await expect(readFile(join(root, "three.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

		await expect(authority.filesDiff({ turnId: "turn-1" })).resolves.toMatchObject({
			changes: [
				{ path: "one.txt", state: "discarded" },
				{ path: "three.txt", state: "discarded" },
				{ path: "two.txt", state: "applied" },
			],
		});
		const decisionCount = entries.length;
		await expect(
			authority.reviewApply({
				turnId: "turn-1",
				path: "two.txt",
				action: "keep",
				expectedRevision: revision,
			}),
		).resolves.toMatchObject({ state: "applied" });
		expect(entries).toHaveLength(decisionCount);
		await expect(
			authority.reviewApply({
				turnId: "turn-1",
				path: "two.txt",
				action: "discard",
				expectedRevision: revision,
			}),
		).rejects.toMatchObject({ code: "stale_turn" });
	}, 30_000);

	test("discards tracked additions and renames back to the turn base tree", async () => {
		const root = await repository();
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const store: TurnReviewSessionStore = {
			getCwd: () => root,
			saveArtifact: async () => undefined,
			appendCustomEntry: (customType, data) => {
				entries.push({ type: "custom", customType, data });
				return `entry-${entries.length}`;
			},
		};
		const prepared = await prepareTurnReview(store);
		expect(prepared).toBeDefined();
		await writeFile(join(root, "added.txt"), "tracked addition\n");
		await git(root, "add", "added.txt");
		await git(root, "mv", "one.txt", "renamed.txt");
		await appendTurnReview(store, prepared, "turn-2" as TurnId);
		const authority = new CodingAgentDesktopAuthority({
			sessionManager: {
				getCwd: () => root,
				getSessionId: () => "session-1",
				getBranch: () => entries as never,
				appendCustomEntry: store.appendCustomEntry,
			},
			projectRootForSession: () => root,
		});
		const initial = await authority.filesDiff({ turnId: "turn-2" });
		expect(initial.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "added.txt", status: "added" }),
				expect.objectContaining({ path: "renamed.txt", previousPath: "one.txt", status: "renamed" }),
			]),
		);
		const discardedAddition = await authority.reviewApply({
			turnId: "turn-2",
			path: "added.txt",
			action: "discard",
			expectedRevision: String(initial.headTree),
		});
		await expect(readFile(join(root, "added.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		await authority.reviewApply({
			turnId: "turn-2",
			path: "renamed.txt",
			action: "discard",
			expectedRevision: String(discardedAddition.resultingRevision),
		});
		expect(await readFile(join(root, "one.txt"), "utf8")).toBe("one before\n");
		await expect(readFile(join(root, "renamed.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	}, 30_000);

	test("drains oversized patch output and retains a patchless snapshot", async () => {
		const root = await repository();
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const store: TurnReviewSessionStore = {
			getCwd: () => root,
			saveArtifact: async () => {
				throw new Error("oversized patches must not be retained");
			},
			appendCustomEntry: (customType, data) => {
				entries.push({ type: "custom", customType, data });
				return `entry-${entries.length}`;
			},
		};
		const prepared = await prepareTurnReview(store);
		await writeFile(join(root, "one.txt"), `${"x".repeat(700 * 1024)}\n`);
		await appendTurnReview(store, prepared, "turn-large-patch" as TurnId);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.data).not.toHaveProperty("patch");
	}, 30_000);

	test("skips snapshots beyond the protocol file bound before per-file Git work", async () => {
		const root = await repository();
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const store: TurnReviewSessionStore = {
			getCwd: () => root,
			saveArtifact: async () => undefined,
			appendCustomEntry: (customType, data) => {
				entries.push({ type: "custom", customType, data });
				return `entry-${entries.length}`;
			},
		};
		const prepared = await prepareTurnReview(store);
		const directory = join(root, "many");
		await mkdir(directory);
		for (let start = 0; start <= MAX_TURN_FILE_CHANGES; start += 128) {
			await Promise.all(
				Array.from({ length: Math.min(128, MAX_TURN_FILE_CHANGES + 1 - start) }, (_, offset) =>
					writeFile(join(directory, `${start + offset}.txt`), "x"),
				),
			);
		}
		await appendTurnReview(store, prepared, "turn-many-files" as TurnId);
		expect(entries).toHaveLength(0);
	}, 30_000);
});
