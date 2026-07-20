import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnId } from "@oh-my-pi/app-wire";
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
		await expect(authority.filesDiff({ turnId: "turn-1" })).resolves.toMatchObject({
			turnId: "turn-1",
			changes: [
				{ path: "one.txt", state: "pending" },
				{ path: "three.txt", status: "untracked", state: "pending" },
				{ path: "two.txt", state: "pending" },
			],
			patch: { artifactId: "2001", kind: "patch" },
		});

		await expect(
			authority.reviewApply({ turnId: "turn-1", path: "one.txt", action: "discard" }),
		).resolves.toMatchObject({ state: "discarded" });
		expect(await readFile(join(root, "one.txt"), "utf8")).toBe("one before\n");
		await expect(authority.reviewApply({ turnId: "turn-1", path: "two.txt", action: "keep" })).resolves.toMatchObject(
			{ state: "applied" },
		);
		expect(await readFile(join(root, "two.txt"), "utf8")).toBe("two after\n");
		await expect(
			authority.reviewApply({ turnId: "turn-1", path: "three.txt", action: "discard" }),
		).resolves.toMatchObject({ state: "discarded" });
		await expect(readFile(join(root, "three.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

		await expect(authority.filesDiff({ turnId: "turn-1" })).resolves.toMatchObject({
			changes: [
				{ path: "one.txt", state: "discarded" },
				{ path: "three.txt", state: "discarded" },
				{ path: "two.txt", state: "applied" },
			],
		});
		const decisionCount = entries.length;
		await expect(authority.reviewApply({ turnId: "turn-1", path: "two.txt", action: "keep" })).resolves.toMatchObject(
			{ state: "applied" },
		);
		expect(entries).toHaveLength(decisionCount);
		await expect(
			authority.reviewApply({ turnId: "turn-1", path: "two.txt", action: "discard" }),
		).rejects.toMatchObject({ code: "stale_turn" });
	}, 30_000);
});
