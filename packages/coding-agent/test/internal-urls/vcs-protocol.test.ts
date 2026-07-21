import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
	GIT_AUTHOR_NAME: "Test User",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test User",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

const tmpDirs: string[] = [];

function runGit(cwd: string, args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
	}
}

function textOfRead(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function session(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		hasEditTool: false,
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ readLineNumbers: false }),
	} as unknown as ToolSession;
}

async function mkTmp(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

async function makeRepo(): Promise<string> {
	const dir = await mkTmp("vcs-protocol-");
	runGit(dir, ["init", "-q", "-b", "main"]);
	await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
	runGit(dir, ["add", "-A"]);
	runGit(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

async function resolveVcs(cwd: string, url: string): Promise<string> {
	return (await InternalUrlRouter.instance().resolve(url, { cwd })).content;
}

function singleChangedPath(text: string): string {
	const match = text.match(/Changed files \(1\):\n {2}([^\n]+)/);
	if (!match) throw new Error(`Expected exactly one changed path in VCS state:\n${text}`);
	return match[1];
}

describe("vcs:// internal URL protocol", () => {
	afterEach(async () => {
		InternalUrlRouter.resetForTests();
		await Promise.all(tmpDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	it("vcs://state reports modified tracked files and untracked files", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
		await Bun.write(path.join(dir, "new.txt"), "fresh\n");

		const text = await resolveVcs(dir, "vcs://state");

		expect(text).toContain("view: working-tree + staged");
		expect(text).toContain("Changed files (1):\n  a.txt");
		expect(text).toContain("Unstaged:");
		expect(text).toContain("a.txt");
		expect(text).toContain("Untracked (1):\n  new.txt");
	});

	it("vcs://state/<path> scopes tracked changes and matching untracked files", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
		await Bun.write(path.join(dir, "b.txt"), "bee\n");
		runGit(dir, ["add", "b.txt"]);
		runGit(dir, ["commit", "-q", "-m", "add b"]);
		await Bun.write(path.join(dir, "b.txt"), "bee\nbuzz\n");
		await Bun.write(path.join(dir, "new.txt"), "fresh\n");
		await Bun.write(path.join(dir, "other.txt"), "ignore me\n");

		const text = await resolveVcs(dir, "vcs://state/a.txt?file=new.txt");

		expect(text).toContain("Changed files (1):\n  a.txt");
		expect(text).toContain("Untracked (1):\n  new.txt");
		expect(text).not.toContain("b.txt");
		expect(text).not.toContain("other.txt");
	});

	it("default vcs://state surfaces staged-only files", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
		runGit(dir, ["add", "a.txt"]);

		const text = await resolveVcs(dir, "vcs://state");

		expect(text).toContain("Changed files (1):\n  a.txt");
		expect(text).toContain("Staged:");
		expect(text).toContain("a.txt");
		expect(text).toContain("Unstaged:\nNo unstaged changes.");
	});

	it("default vcs://diff includes staged-only patches", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
		runGit(dir, ["add", "a.txt"]);

		const text = await resolveVcs(dir, "vcs://diff/a.txt");

		expect(text).toContain("diff --git a/a.txt b/a.txt");
		expect(text).toContain("+four");
	});

	it("vcs://diff/<path> returns patch text scoped to that path", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
		await Bun.write(path.join(dir, "b.txt"), "bee\n");

		const text = await resolveVcs(dir, "vcs://diff/a.txt");

		expect(text).toContain("diff --git a/a.txt b/a.txt");
		expect(text).toContain("+four");
		expect(text).not.toContain("b.txt");
	});

	it("vcs://diff and vcs://state return plain text when Git color is forced", async () => {
		const dir = await makeRepo();
		runGit(dir, ["config", "color.ui", "always"]);
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");

		const diffText = await resolveVcs(dir, "vcs://diff/a.txt");
		const stateText = await resolveVcs(dir, "vcs://state/a.txt");

		expect(diffText).toContain("+four");
		expect(stateText).toContain("a.txt |");
		expect(diffText).not.toMatch(/\x1B\[[0-9;]*m/);
		expect(stateText).not.toMatch(/\x1B\[[0-9;]*m/);
	});

	it("vcs://diff/<path> reports matching untracked files with a read hint", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "new.txt"), "fresh\n");
		await Bun.write(path.join(dir, "other.txt"), "ignore me\n");

		const text = await resolveVcs(dir, "vcs://diff/new.txt");

		expect(text).toContain("Untracked files are not included in git diff. Read them directly:");
		expect(text).toContain("  new.txt");
		expect(text).not.toContain("other.txt");
	});

	it("vcs://diff?base=main&staged=true diffs staged changes against a base ref", async () => {
		const dir = await makeRepo();
		runGit(dir, ["checkout", "-q", "-b", "feature"]);
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
		runGit(dir, ["add", "a.txt"]);

		const text = await resolveVcs(dir, "vcs://diff?base=main&staged=true");

		expect(text).toContain("+four");
	});

	it("rejects option-like base refs", async () => {
		const dir = await makeRepo();

		await expect(resolveVcs(dir, "vcs://diff?base=--output%3D%2Ftmp%2Fpwn")).rejects.toThrow("Invalid base ref");
	});

	it("rejects a base that exists only as a tracked path", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "nope"), "i am a file\n");
		runGit(dir, ["add", "nope"]);
		runGit(dir, ["commit", "-q", "-m", "add nope"]);

		await expect(resolveVcs(dir, "vcs://diff?base=nope")).rejects.toThrow("does not resolve to a commit");
	});

	it("rejects vcs://state outside a git repository", async () => {
		const dir = await mkTmp("vcs-nogit-");

		await expect(resolveVcs(dir, "vcs://state")).rejects.toThrow("Not inside a git repository");
	});

	it("resolves URL path scopes relative to a session cwd inside the repo", async () => {
		const dir = await makeRepo();
		await fs.mkdir(path.join(dir, "pkg"), { recursive: true });
		await Bun.write(path.join(dir, "pkg", "c.txt"), "see\n");
		await Bun.write(path.join(dir, "c.txt"), "root\n");
		runGit(dir, ["add", "-A"]);
		runGit(dir, ["commit", "-q", "-m", "add c files"]);
		await Bun.write(path.join(dir, "pkg", "c.txt"), "see\nsea\n");
		await Bun.write(path.join(dir, "c.txt"), "root\nwrong\n");

		const text = await resolveVcs(path.join(dir, "pkg"), "vcs://diff/c.txt");

		expect(text).toContain("+sea");
		expect(text).toContain("pkg/c.txt");
		expect(text).not.toContain("+wrong");
	});

	it("resolves URL path scopes relative to a symlinked session cwd inside the repo", async () => {
		const dir = await makeRepo();
		const linkDir = await mkTmp("vcs-symlink-parent-");
		await fs.mkdir(path.join(dir, "pkg"), { recursive: true });
		await Bun.write(path.join(dir, "pkg", "c.txt"), "see\n");
		await Bun.write(path.join(dir, "c.txt"), "root\n");
		runGit(dir, ["add", "-A"]);
		runGit(dir, ["commit", "-q", "-m", "add c files"]);
		await Bun.write(path.join(dir, "pkg", "c.txt"), "see\nsea\n");
		await Bun.write(path.join(dir, "c.txt"), "root\nwrong\n");
		const symlinkCwd = path.join(linkDir, "pkg-link");
		await fs.symlink(path.join(dir, "pkg"), symlinkCwd, "dir");

		const text = await resolveVcs(symlinkCwd, "vcs://diff/c.txt");

		expect(text).toContain("+sea");
		expect(text).toContain("pkg/c.txt");
		expect(text).not.toContain("+wrong");
	});

	it("vcs://state paths from a symlinked cwd round-trip to vcs://diff", async () => {
		const dir = await makeRepo();
		const linkDir = await mkTmp("vcs-symlink-state-parent-");
		await fs.mkdir(path.join(dir, "pkg"), { recursive: true });
		await Bun.write(path.join(dir, "pkg", "c.txt"), "see\n");
		runGit(dir, ["add", "-A"]);
		runGit(dir, ["commit", "-q", "-m", "add nested file"]);
		await Bun.write(path.join(dir, "pkg", "c.txt"), "see\nsea\n");
		const symlinkCwd = path.join(linkDir, "pkg-link");
		await fs.symlink(path.join(dir, "pkg"), symlinkCwd, "dir");

		const stateText = await resolveVcs(symlinkCwd, "vcs://state");
		const changedPath = singleChangedPath(stateText);
		const diffText = await resolveVcs(symlinkCwd, `vcs://diff/${encodeURIComponent(changedPath)}`);

		expect(changedPath).toBe("c.txt");
		expect(stateText).toContain("c.txt |");
		expect(diffText).toContain("+sea");
		expect(diffText).toContain("pkg/c.txt");
	});

	it("vcs://state and vcs://diff display non-ASCII paths literally", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "é.txt"), "accent\n");
		runGit(dir, ["add", "-A"]);
		runGit(dir, ["commit", "-q", "-m", "add unicode file"]);
		await Bun.write(path.join(dir, "é.txt"), "accent\nchanged\n");

		const stateText = await resolveVcs(dir, "vcs://state");
		const diffText = await resolveVcs(dir, "vcs://diff/%C3%A9.txt");

		expect(stateText).toContain("Changed files (1):\n  é.txt");
		expect(stateText).toContain("é.txt |");
		expect(diffText).toContain("diff --git a/é.txt b/é.txt");
		expect(stateText).not.toContain("\\303");
		expect(diffText).not.toContain("\\303");
	});

	it("vcs://state preserves leading whitespace in changed and untracked paths", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, " leading.txt"), "space\n");
		runGit(dir, ["add", "-A"]);
		runGit(dir, ["commit", "-q", "-m", "add leading-space file"]);
		await Bun.write(path.join(dir, " leading.txt"), "space\nchanged\n");
		await Bun.write(path.join(dir, " fresh.txt"), "new\n");

		const stateText = await resolveVcs(dir, "vcs://state");
		const diffText = await resolveVcs(dir, "vcs://diff/%20leading.txt");

		expect(stateText).toContain("Changed files (1):\n   leading.txt");
		expect(stateText).toContain(" leading.txt |");
		expect(stateText).toContain("Untracked (1):\n   fresh.txt");
		expect(diffText).toContain("diff --git a/ leading.txt b/ leading.txt");
		expect(diffText).toContain("+changed");
	});

	it("rebases vcs://state stat paths relative to a session cwd inside the repo", async () => {
		const dir = await makeRepo();
		await fs.mkdir(path.join(dir, "pkg"), { recursive: true });
		await Bun.write(path.join(dir, "pkg", "c.txt"), "see\n");
		runGit(dir, ["add", "-A"]);
		runGit(dir, ["commit", "-q", "-m", "add nested file"]);
		await Bun.write(path.join(dir, "pkg", "c.txt"), "see\nsea\n");

		const text = await resolveVcs(path.join(dir, "pkg"), "vcs://state");

		expect(text).toContain("Changed files (1):\n  c.txt");
		expect(text).toContain("c.txt |");
		expect(text).not.toContain("pkg/c.txt |");
	});

	it("rebases stat paths containing the stat delimiter sequence", async () => {
		const dir = await makeRepo();
		await fs.mkdir(path.join(dir, "pkg"), { recursive: true });
		await Bun.write(path.join(dir, "pkg", "a | b.txt"), "one\n");
		runGit(dir, ["add", "-A"]);
		runGit(dir, ["commit", "-q", "-m", "add delimiter path"]);
		await Bun.write(path.join(dir, "pkg", "a | b.txt"), "one\ntwo\n");

		const text = await resolveVcs(path.join(dir, "pkg"), "vcs://state");

		expect(text).toContain("Changed files (1):\n  a | b.txt");
		expect(text).toContain("a | b.txt |");
		expect(text).not.toContain("../a | b.txt");
	});

	it("rebases git rename stat paths relative to a session cwd inside the repo", async () => {
		const dir = await makeRepo();
		await fs.mkdir(path.join(dir, "pkg"), { recursive: true });
		await Bun.write(path.join(dir, "pkg", "old.txt"), "see\nsea\n");
		runGit(dir, ["add", "-A"]);
		runGit(dir, ["commit", "-q", "-m", "add nested file"]);
		await fs.rename(path.join(dir, "pkg", "old.txt"), path.join(dir, "pkg", "new.txt"));
		runGit(dir, ["add", "-A"]);

		const text = await resolveVcs(path.join(dir, "pkg"), "vcs://state");

		expect(text).toContain("Changed files (1):\n  new.txt");
		expect(text).toContain("{old.txt => new.txt} |");
		expect(text).not.toContain("pkg/{old.txt => new.txt} |");
	});

	it("vcs://state literal-arrow paths round-trip from a subdirectory cwd", async () => {
		const dir = await makeRepo();
		const pkg = path.join(dir, "pkg");
		const filename = "literal => arrow.txt";
		await fs.mkdir(pkg, { recursive: true });
		await Bun.write(path.join(pkg, filename), "before\n");
		runGit(dir, ["add", "-A"]);
		runGit(dir, ["commit", "-q", "-m", "add literal-arrow file"]);
		await Bun.write(path.join(pkg, filename), "before\nafter\n");

		const stateText = await resolveVcs(pkg, "vcs://state");
		const changedPath = singleChangedPath(stateText);
		const diffText = await resolveVcs(pkg, `vcs://diff/${encodeURIComponent(changedPath)}`);

		expect(changedPath).toBe(filename);
		expect(stateText).toContain(`${filename} |`);
		expect(stateText).not.toContain(`../literal => arrow.txt |`);
		expect(diffText).toContain(`diff --git a/pkg/${filename} b/pkg/${filename}`);
		expect(diffText).toContain("+after");
	});

	it("treats scoped paths as literal Git pathspecs", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, ":(exclude)b.txt"), "literal\n");
		runGit(dir, ["add", "-A"]);
		runGit(dir, ["commit", "-q", "-m", "add magic-looking path"]);
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nunrelated\n");
		await Bun.write(path.join(dir, ":(exclude)b.txt"), "literal\nsafe\n");

		const pathText = await resolveVcs(dir, "vcs://diff/%3A%28exclude%29b.txt");
		const queryText = await resolveVcs(dir, "vcs://state?file=%3A%28exclude%29b.txt");

		expect(pathText).toContain("+safe");
		expect(pathText).not.toContain("+unrelated");
		expect(queryText).toContain("Changed files (1):\n  :(exclude)b.txt");
		expect(queryText).not.toContain("a.txt");
	});

	it("rejects scopes that escape the repository", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");

		await expect(resolveVcs(dir, "vcs://diff/../../etc/passwd")).rejects.toThrow(
			"Requested file resolves outside the repository",
		);
		await expect(resolveVcs(dir, "vcs://diff?file=../../etc/passwd")).rejects.toThrow(
			"Requested file resolves outside the repository",
		);
	});

	it("base comparisons still surface untracked files in vcs://state and vcs://diff", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
		await Bun.write(path.join(dir, "new.txt"), "fresh\n");

		const state = await resolveVcs(dir, "vcs://state?base=main");
		expect(state).toContain("Changed files (1):\n  a.txt");
		expect(state).toContain("Untracked (1):\n  new.txt");

		const diff = await resolveVcs(dir, "vcs://diff?base=main");
		expect(diff).toContain("+four");
		expect(diff).toContain("Untracked files are not included in git diff.");
		expect(diff).toContain("new.txt");

		const stagedState = await resolveVcs(dir, "vcs://state?base=main&staged=true");
		expect(stagedState).not.toContain("Untracked");
		const stagedDiff = await resolveVcs(dir, "vcs://diff?base=main&staged=true");
		expect(stagedDiff).not.toContain("new.txt");
	});

	it("accepts absolute scopes that reach the repo through a symlink", async () => {
		const dir = await makeRepo();
		const linkParent = await mkTmp("vcs-abs-symlink-");
		const link = path.join(linkParent, "repo-link");
		await fs.symlink(dir, link);
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");

		const encoded = encodeURIComponent(path.join(link, "a.txt"));
		const text = await resolveVcs(dir, `vcs://diff?file=${encoded}`);
		expect(text).toContain("+four");

		await expect(
			resolveVcs(dir, `vcs://diff?file=${encodeURIComponent(path.join(link, "..", "outside.txt"))}`),
		).rejects.toThrow("Requested file resolves outside the repository");
	});

	it("accepts absolute scopes through a symlinked repo subdirectory", async () => {
		const dir = await makeRepo();
		const linkParent = await mkTmp("vcs-abs-subdir-symlink-");
		const link = path.join(linkParent, "pkg-link");
		await fs.mkdir(path.join(dir, "pkg"), { recursive: true });
		await Bun.write(path.join(dir, "pkg", "c.txt"), "see\n");
		runGit(dir, ["add", "-A"]);
		runGit(dir, ["commit", "-q", "-m", "add pkg"]);
		await fs.symlink(path.join(dir, "pkg"), link);
		await Bun.write(path.join(dir, "pkg", "c.txt"), "see\nsea\n");

		const encoded = encodeURIComponent(path.join(link, "c.txt"));
		const text = await resolveVcs(dir, `vcs://diff?file=${encoded}`);
		expect(text).toContain("+sea");
	});

	it("rejects absolute scopes whose `..` escapes through an in-repo symlink", async () => {
		const dir = await makeRepo();
		const outside = await mkTmp("vcs-escape-target-");
		await fs.mkdir(path.join(outside, "sub"), { recursive: true });
		await Bun.write(path.join(outside, "secret.txt"), "outside\n");
		await fs.symlink(path.join(outside, "sub"), path.join(dir, "link"));
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");

		// Raw `..` after a symlink must resolve physically (to `outside/`), not
		// collapse lexically back inside the repo.
		const escapePath = `${dir}${path.sep}link${path.sep}..${path.sep}secret.txt`;
		await expect(resolveVcs(dir, `vcs://diff?file=${encodeURIComponent(escapePath)}`)).rejects.toThrow(
			"Requested file resolves outside the repository",
		);

		// A symlink-free `..` that stays inside the repo is still accepted.
		const inside = `${dir}${path.sep}pkg${path.sep}..${path.sep}a.txt`;
		const text = await resolveVcs(dir, `vcs://diff?file=${encodeURIComponent(inside)}`);
		expect(text).toContain("+four");
	});

	it("re-resolves symlinks after `..` backs out of a nonexistent segment", async () => {
		const dir = await makeRepo();
		const outside = await mkTmp("vcs-escape-missing-");
		await fs.mkdir(path.join(outside, "sub"), { recursive: true });
		await Bun.write(path.join(outside, "sub", "file.txt"), "outside\n");
		await fs.symlink(path.join(outside, "sub"), path.join(dir, "link"));
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");

		// `missing` does not exist, so `..` pops it lexically and `link` must
		// then resolve physically (to `outside/sub`), not be appended verbatim.
		const escapePath = `${dir}${path.sep}missing${path.sep}..${path.sep}link${path.sep}file.txt`;
		await expect(resolveVcs(dir, `vcs://diff?file=${encodeURIComponent(escapePath)}`)).rejects.toThrow(
			"Requested file resolves outside the repository",
		);

		// Backing out of a nonexistent segment onto a real in-repo file still works.
		const inside = `${dir}${path.sep}missing${path.sep}..${path.sep}a.txt`;
		const text = await resolveVcs(dir, `vcs://diff?file=${encodeURIComponent(inside)}`);
		expect(text).toContain("+four");

		// An ordinary nonexistent trailing path is preserved and stays in scope.
		const gone = `${dir}${path.sep}nope${path.sep}gone.txt`;
		const noChanges = await resolveVcs(dir, `vcs://diff?file=${encodeURIComponent(gone)}`);
		expect(noChanges).toContain("No changes for the requested diff.");
	});

	it("accepts forward-slash absolute scopes on Windows", async () => {
		// Windows-only: URL-derived scopes commonly arrive with `/` separators,
		// which must still be canonicalized segment by segment.
		if (process.platform === "win32") {
			const dir = await makeRepo();
			await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");

			const forward = `${dir.replaceAll("\\", "/")}/a.txt`;
			const text = await resolveVcs(dir, `vcs://diff?file=${encodeURIComponent(forward)}`);
			expect(text).toContain("+four");

			const escapePath = `${dir.replaceAll("\\", "/")}/../outside.txt`;
			await expect(resolveVcs(dir, `vcs://diff?file=${encodeURIComponent(escapePath)}`)).rejects.toThrow(
				"Requested file resolves outside the repository",
			);
		}
	});

	it("preserves literal backslash filenames in absolute scopes on POSIX", async () => {
		// POSIX-only: backslash is an ordinary filename byte, not a separator.
		if (process.platform !== "win32") {
			const dir = await makeRepo();
			const filename = "back\\slash.txt";
			await Bun.write(path.join(dir, filename), "one\n");
			runGit(dir, ["add", "-A"]);
			runGit(dir, ["commit", "-q", "-m", "add backslash file"]);
			await Bun.write(path.join(dir, filename), "one\ntwo\n");

			const text = await resolveVcs(dir, `vcs://diff?file=${encodeURIComponent(path.join(dir, filename))}`);
			expect(text).toContain("+two");
		}
	});

	it("propagates non-missing canonicalization failures instead of passing containment", async () => {
		// POSIX-only: a self-referencing symlink makes realpath fail with ELOOP,
		// which must surface as an error rather than being appended unresolved.
		if (process.platform !== "win32") {
			const dir = await makeRepo();
			const loop = path.join(dir, "loop");
			await fs.symlink(loop, loop);

			const scope = `${dir}${path.sep}loop${path.sep}file.txt`;
			await expect(resolveVcs(dir, `vcs://diff?file=${encodeURIComponent(scope)}`)).rejects.toThrow(
				/ELOOP|too many/i,
			);
		}
	});

	it("rejects scopes that traverse a file as if it were a directory", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");

		// `a.txt` is a file, so `a.txt/missing/../..` must fail with ENOTDIR
		// rather than backing out to `.` and broadening the diff to the whole repo.
		const scope = `${dir}${path.sep}a.txt${path.sep}missing${path.sep}..${path.sep}..`;
		await expect(resolveVcs(dir, `vcs://diff?file=${encodeURIComponent(scope)}`)).rejects.toThrow(
			/ENOTDIR|not a directory/i,
		);
	});

	it("treats vcs://diff/. from the repo root as a whole-repo scope", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");

		const text = await resolveVcs(dir, "vcs://diff/.");

		expect(text).toContain("+four");
	});

	it("accepts base refs with plus signs and UTF-8 characters", async () => {
		const dir = await makeRepo();
		runGit(dir, ["checkout", "-q", "-b", "feature+api/日本語"]);
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
		runGit(dir, ["add", "a.txt"]);
		runGit(dir, ["commit", "-m", "add files"]);

		// Verify we can resolve it using the branch name containing + and UTF-8
		const text = await resolveVcs(dir, "vcs://diff?base=feature%2Bapi/%E6%97%A5%E6%9C%AC%E8%AA%9E");
		expect(text).toContain("No changes");
	});

	it("rejects base refs containing NUL bytes", async () => {
		const dir = await makeRepo();
		await expect(resolveVcs(dir, "vcs://diff?base=main%00")).rejects.toThrow("Invalid base ref");
	});

	it("escapes control characters in file paths in vcs://state", async () => {
		// Only run on non-Windows since newlines in filenames are POSIX-only
		if (process.platform !== "win32") {
			const dir = await makeRepo();
			const filename = "file\nwith\nnewline.txt";
			const filePath = path.join(dir, filename);
			await Bun.write(filePath, "new file content");

			const stateText1 = await resolveVcs(dir, "vcs://state");
			expect(stateText1).toContain('file\\nwith\\nnewline.txt [read path: "file\\nwith\\nnewline.txt"]');

			// Track and commit it
			runGit(dir, ["add", filename]);
			runGit(dir, ["commit", "-m", "commit newline file"]);

			// Modify it to create unstaged changes
			await Bun.write(filePath, "modified file content");

			const stateText2 = await resolveVcs(dir, "vcs://state");
			expect(stateText2).toContain("file\\nwith\\nnewline.txt [scope: vcs://diff?file=file%0Awith%0Anewline.txt]");
			const scopedDiff = await resolveVcs(dir, `vcs://diff?file=${encodeURIComponent(filename)}`);
			expect(scopedDiff).toContain("+modified file content");
		}
	});

	it("escapes control characters in vcs://diff untracked hints", async () => {
		// Only run on non-Windows since newlines in filenames are POSIX-only
		if (process.platform !== "win32") {
			const dir = await makeRepo();
			await Bun.write(path.join(dir, "new\twith\nctrl.txt"), "fresh\n");
			await Bun.write(path.join(dir, "del\u007fctrl.txt"), "del\n");

			const text = await resolveVcs(dir, "vcs://diff");
			expect(text).toContain("Untracked files are not included in git diff.");
			expect(text).toContain('new\\twith\\nctrl.txt [read path: "new\\twith\\nctrl.txt"]');
			expect(text).not.toContain("new\twith\nctrl.txt");
			expect(text).toContain('del\\x7fctrl.txt [read path: "del\\u007fctrl.txt"]');
			expect(text).not.toContain("del\u007fctrl.txt");
		}
	});

	it("escapes control characters in the vcs://state repository path", async () => {
		// Only run on non-Windows since control characters in directory names are POSIX-only
		if (process.platform !== "win32") {
			const parent = await mkTmp("vcs-ctrl-parent-");
			const dir = path.join(parent, "repo\twith\ttabs");
			await fs.mkdir(dir, { recursive: true });
			runGit(dir, ["init", "-q", "-b", "main"]);
			await Bun.write(path.join(dir, "a.txt"), "one\n");
			runGit(dir, ["add", "-A"]);
			runGit(dir, ["commit", "-q", "-m", "init"]);

			const text = await resolveVcs(dir, "vcs://state");
			const repoLine = text.split("\n").find(line => line.startsWith("repo: "));
			expect(repoLine).toBeDefined();
			expect(repoLine).toContain("repo\\twith\\ttabs");
			expect(repoLine).not.toContain("\t");
		}
	});

	it("rejects unknown query parameters", async () => {
		const dir = await makeRepo();

		await expect(resolveVcs(dir, "vcs://diff?files=a.txt")).rejects.toThrow(
			"Invalid vcs:// query parameter 'files'. Supported: base, staged, file.",
		);
		await expect(resolveVcs(dir, "vcs://diff?constructor=a.txt")).rejects.toThrow(
			"Invalid vcs:// query parameter 'constructor'. Supported: base, staged, file.",
		);
	});

	it("ReadTool routes vcs://diff selectors through the protocol", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
		const tool = new ReadTool(session(dir));

		const text = textOfRead(await tool.execute("read-vcs", { path: "vcs://diff/a.txt:raw" }));

		expect(text).toContain("+four");
		expect(text).toContain("diff --git a/a.txt b/a.txt");
	});
});
