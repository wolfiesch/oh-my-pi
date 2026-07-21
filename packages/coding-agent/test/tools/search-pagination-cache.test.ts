import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import {
	type InternalResource,
	type InternalUrl,
	InternalUrlRouter,
	type ProtocolHandler,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { invalidateRegisteredSearchCaches, registerSearchCacheOwner } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { applyWorkspaceEdit } from "@oh-my-pi/pi-coding-agent/lsp/edits";
import type { LspClient } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { BashTool, GrepTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstEditTool } from "@oh-my-pi/pi-coding-agent/tools/ast-edit";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { invalidateFsScanAfterWrite } from "@oh-my-pi/pi-coding-agent/tools/fs-cache-invalidation";
import { mergeGrepResults } from "@oh-my-pi/pi-coding-agent/tools/grep";
import {
	type CachedGroupedSearchResult,
	clearSearchResultCache,
	getSearchResultCache,
	isPathWithinWorkspace,
	type SearchResultCacheOwner,
	simulateWorkspaceOwnerCollectionForTests,
	suppressSearchResultCaches,
	workspaceRegistrySnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/search-result-cache";
import { ttsTool } from "@oh-my-pi/pi-coding-agent/tools/tts";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { ttsClient } from "@oh-my-pi/pi-coding-agent/tts/tts-client";
import type { GrepResult } from "@oh-my-pi/pi-natives";
import * as piNatives from "@oh-my-pi/pi-natives";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
		...overrides,
	};
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

async function createSearchFixture(rootDir: string): Promise<void> {
	for (let idx = 0; idx < 50; idx++) {
		const suffix = idx.toString().padStart(2, "0");
		await Bun.write(path.join(rootDir, `file-${suffix}.txt`), `NEEDLE file-${suffix}\n`);
	}

	await fs.mkdir(path.join(rootDir, "other"), { recursive: true });
	for (let idx = 0; idx < 5; idx++) {
		const suffix = idx.toString().padStart(2, "0");
		await Bun.write(path.join(rootDir, "other", `other-${suffix}.txt`), `NEEDLE other-${suffix}\n`);
	}

	await Bun.write(path.join(rootDir, "alternate.txt"), "OTHER\n");
}

const BACKING_SCHEME = "search-cache-backing";

describe("search pagination cache", () => {
	let cwd: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	afterAll(async () => {
		await disposeAllVmContexts();
	});

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-pagination-cache-"));
		await createSearchFixture(cwd);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		InternalUrlRouter.instance().unregister(BACKING_SCHEME);
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("reuses grouped filesystem results for skip pagination", async () => {
		const session = createTestSession(cwd);
		const grepSpy = spyOn(piNatives, "grep");

		await new GrepTool(session).execute("page-1", { pattern: "NEEDLE", path: "." });
		const pageTwo = await new GrepTool(session).execute("page-2", {
			pattern: "NEEDLE",
			path: ".",
			skip: 20,
		});
		const text = getText(pageTwo);

		expect(grepSpy).toHaveBeenCalledTimes(1);
		expect(text).toContain("file-20.txt");
		expect(text).toContain("file-39.txt");
		expect(text).toContain("Showing files 21-40 of 55");
		expect(text).not.toContain("file-19.txt");
		expect(text).not.toContain("file-40.txt");
	});

	it("falls back to grep when skip has no prior cache entry", async () => {
		const session = createTestSession(cwd);
		const grepSpy = spyOn(piNatives, "grep");

		const pageTwo = await new GrepTool(session).execute("page-2", {
			pattern: "NEEDLE",
			path: ".",
			skip: 20,
		});
		const text = getText(pageTwo);

		expect(grepSpy).toHaveBeenCalledTimes(1);
		expect(text).toContain("file-20.txt");
		expect(text).toContain("file-39.txt");
	});

	it("misses cache when pattern changes", async () => {
		const session = createTestSession(cwd);
		const grepSpy = spyOn(piNatives, "grep");

		await new GrepTool(session).execute("page-1", { pattern: "NEEDLE", path: "." });
		await new GrepTool(session).execute("page-2", { pattern: "OTHER", path: ".", skip: 20 });

		expect(grepSpy).toHaveBeenCalledTimes(2);
	});

	it("misses cache when path scope changes", async () => {
		const session = createTestSession(cwd);
		const grepSpy = spyOn(piNatives, "grep");

		await new GrepTool(session).execute("page-1", { pattern: "NEEDLE", path: "." });
		await new GrepTool(session).execute("page-2", { pattern: "NEEDLE", path: "other", skip: 20 });

		expect(grepSpy).toHaveBeenCalledTimes(2);
	});

	it("clears cached search results after a successful write tool mutation", async () => {
		const session = createTestSession(cwd);
		const grepSpy = spyOn(piNatives, "grep");

		await new GrepTool(session).execute("page-1", { pattern: "NEEDLE", path: "." });
		await new WriteTool(session).execute("mutate", {
			path: "file-49.txt",
			content: "NEEDLE file-49 changed\n",
		});
		await new GrepTool(session).execute("page-2", { pattern: "NEEDLE", path: ".", skip: 20 });

		expect(grepSpy).toHaveBeenCalledTimes(2);
	});

	it("fans out mutation invalidation to sibling sessions sharing the workspace", async () => {
		// A non-isolated task child shares the parent's cwd but owns a separate
		// ToolSession cache; its mutation must also drop the parent's pages.
		const parent = createTestSession(cwd);
		const child = createTestSession(cwd);
		const grepSpy = spyOn(piNatives, "grep");

		await new GrepTool(parent).execute("parent-page-1", { pattern: "NEEDLE", path: "." });
		await new WriteTool(child).execute("child-mutate", {
			path: "file-20.txt",
			content: "OTHER\n",
		});
		const pageTwo = await new GrepTool(parent).execute("parent-page-2", {
			pattern: "NEEDLE",
			path: ".",
			skip: 20,
		});

		expect(grepSpy).toHaveBeenCalledTimes(2);
		expect(getText(pageTwo)).not.toContain("file-20.txt");
	});

	it("does not evict cached pages of sessions in other workspaces", async () => {
		const otherCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-pagination-other-"));
		try {
			await createSearchFixture(otherCwd);
			const sessionA = createTestSession(cwd);
			const sessionB = createTestSession(otherCwd);
			const grepSpy = spyOn(piNatives, "grep");

			await new GrepTool(sessionA).execute("a-page-1", { pattern: "NEEDLE", path: "." });
			await new GrepTool(sessionB).execute("b-page-1", { pattern: "NEEDLE", path: "." });
			await new WriteTool(sessionB).execute("b-mutate", {
				path: "file-20.txt",
				content: "OTHER\n",
			});

			// Session A's workspace is untouched: its skip page stays cached.
			await new GrepTool(sessionA).execute("a-page-2", { pattern: "NEEDLE", path: ".", skip: 20 });
			expect(grepSpy).toHaveBeenCalledTimes(2);
			// Session B refetches after its own workspace mutation.
			await new GrepTool(sessionB).execute("b-page-2", { pattern: "NEEDLE", path: ".", skip: 20 });
			expect(grepSpy).toHaveBeenCalledTimes(3);
		} finally {
			await fs.rm(otherCwd, { recursive: true, force: true });
		}
	});

	it("clears cached search results after a Bash command completes", async () => {
		const session = createTestSession(cwd, {
			settings: Settings.isolated({
				"grep.contextBefore": 0,
				"grep.contextAfter": 0,
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
			}),
		});
		const grepSpy = spyOn(piNatives, "grep");

		await new GrepTool(session).execute("page-1", { pattern: "NEEDLE", path: "." });
		await new BashTool(session).execute("mutate", { command: "rm file-20.txt" });
		const pageTwo = await new GrepTool(session).execute("page-2", {
			pattern: "NEEDLE",
			path: ".",
			skip: 20,
		});

		expect(grepSpy).toHaveBeenCalledTimes(2);
		expect(getText(pageTwo)).not.toContain("file-20.txt");
	});

	it("clears cached search results after a successful internal URL write mutation", async () => {
		const session = createTestSession(cwd);
		const grepSpy = spyOn(piNatives, "grep");
		const handler: ProtocolHandler = {
			scheme: BACKING_SCHEME,
			immutable: false,
			async resolve(url: InternalUrl): Promise<InternalResource> {
				return {
					url: url.href,
					content: await Bun.file(path.join(cwd, "file-49.txt")).text(),
					contentType: "text/plain",
				};
			},
			async write(_url: InternalUrl, content: string): Promise<void> {
				await Bun.write(path.join(cwd, "file-49.txt"), content);
			},
		};
		InternalUrlRouter.instance().register(handler);

		await new GrepTool(session).execute("page-1", { pattern: "NEEDLE", path: "." });
		await new WriteTool(session).execute("mutate", {
			path: `${BACKING_SCHEME}://file-49`,
			content: "NEEDLE file-49 changed\n",
		});
		await new GrepTool(session).execute("page-2", { pattern: "NEEDLE", path: ".", skip: 20 });

		expect(grepSpy).toHaveBeenCalledTimes(2);
	});

	it("expires cached grouped results after the TTL window", async () => {
		const session = createTestSession(cwd);
		const grepSpy = spyOn(piNatives, "grep");
		let now = 1_700_000_000_000;
		spyOn(Date, "now").mockImplementation(() => now);

		await new GrepTool(session).execute("page-1", { pattern: "NEEDLE", path: "." });
		now += 61_000;
		await new GrepTool(session).execute("page-2", { pattern: "NEEDLE", path: ".", skip: 20 });

		expect(grepSpy).toHaveBeenCalledTimes(2);
	});

	it("keeps nested-scope searches cacheable but bypasses caching outside the session workspace", async () => {
		const outsideCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-pagination-outside-"));
		try {
			await createSearchFixture(outsideCwd);
			const session = createTestSession(cwd);
			const grepSpy = spyOn(piNatives, "grep");

			// Nested scope (subdir of the session workspace): cached — every
			// session-key mutation fans out to it.
			await new GrepTool(session).execute("nested-1", { pattern: "NEEDLE", path: "other" });
			await new GrepTool(session).execute("nested-2", { pattern: "NEEDLE", path: "other", skip: 1 });
			expect(grepSpy).toHaveBeenCalledTimes(1);

			// Sibling/outside scope (absolute path in another workspace): that
			// workspace's mutators cannot reach a cache owned by this session,
			// so pagination must recompute instead of caching.
			await new GrepTool(session).execute("outside-1", { pattern: "NEEDLE", path: outsideCwd });
			await new GrepTool(session).execute("outside-2", { pattern: "NEEDLE", path: outsideCwd, skip: 20 });
			expect(grepSpy).toHaveBeenCalledTimes(3);
		} finally {
			await fs.rm(outsideCwd, { recursive: true, force: true });
		}
	});

	it("bypasses caching for an in-workspace symlink that escapes to another workspace", async () => {
		const outsideCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-pagination-escape-"));
		try {
			await createSearchFixture(outsideCwd);
			// Lexically inside the session workspace, physically outside it: the
			// outside workspace's mutators can never invalidate this session's
			// cache, so pagination must recompute.
			await fs.symlink(outsideCwd, path.join(cwd, "escape-link"));
			const session = createTestSession(cwd);
			const grepSpy = spyOn(piNatives, "grep");

			await new GrepTool(session).execute("escape-1", { pattern: "NEEDLE", path: "escape-link" });
			await new GrepTool(session).execute("escape-2", { pattern: "NEEDLE", path: "escape-link", skip: 20 });
			expect(grepSpy).toHaveBeenCalledTimes(2);
		} finally {
			await fs.rm(outsideCwd, { recursive: true, force: true });
		}
	});

	it("keeps caching for a symlink alias inside the same physical workspace", async () => {
		// An alias to a directory of THIS workspace shares its physical root, so
		// session-key invalidation reaches the cache — no needless bypass.
		await fs.symlink(path.join(cwd, "other"), path.join(cwd, "other-alias"));
		const session = createTestSession(cwd);
		const grepSpy = spyOn(piNatives, "grep");

		await new GrepTool(session).execute("alias-1", { pattern: "NEEDLE", path: "other-alias" });
		await new GrepTool(session).execute("alias-2", { pattern: "NEEDLE", path: "other-alias", skip: 1 });
		expect(grepSpy).toHaveBeenCalledTimes(1);
	});

	it("re-evaluates containment after a symlink is retargeted outside the workspace", async () => {
		const outsideCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-pagination-retarget-"));
		try {
			await createSearchFixture(outsideCwd);
			const link = path.join(cwd, "swing-link");
			await fs.symlink(path.join(cwd, "other"), link);
			const session = createTestSession(cwd);
			const grepSpy = spyOn(piNatives, "grep");

			// Inside alias: cacheable (memoizing this verdict would be the bug).
			await new GrepTool(session).execute("swing-1", { pattern: "NEEDLE", path: "swing-link" });
			await new GrepTool(session).execute("swing-2", { pattern: "NEEDLE", path: "swing-link", skip: 1 });
			expect(grepSpy).toHaveBeenCalledTimes(1);

			// Retarget the same link outside: containment must be re-resolved
			// fresh, so pagination recomputes instead of caching an outside scope.
			await fs.rm(link);
			await fs.symlink(outsideCwd, link);
			await new GrepTool(session).execute("swing-3", { pattern: "NEEDLE", path: "swing-link" });
			await new GrepTool(session).execute("swing-4", { pattern: "NEEDLE", path: "swing-link", skip: 20 });
			expect(grepSpy).toHaveBeenCalledTimes(3);
		} finally {
			await fs.rm(outsideCwd, { recursive: true, force: true });
		}
	});

	it("workspace containment handles volume roots and dotted children", async () => {
		// Volume root: a `root + sep` prefix check would build `//` and never match.
		expect(isPathWithinWorkspace(path.parse(cwd).root, cwd)).toBe(true);
		// A child literally named `..foo` is inside; a bare startsWith("..")
		// escape test would wrongly reject it.
		const dotted = path.join(cwd, "..foo");
		await fs.mkdir(dotted);
		expect(isPathWithinWorkspace(cwd, dotted)).toBe(true);
		expect(isPathWithinWorkspace(cwd, path.dirname(cwd))).toBe(false);
	});

	it("finds late in-range lines for ranged multi-target searches", async () => {
		// A `:4000-4000` selector sits far past INTERNAL_TOTAL_CAP (2000) and the
		// unranged per-file budget (21): only the range-amplified native caps let
		// the JS range filter see the in-range line in each explicit target.
		const content = `${Array.from({ length: 3999 }, (_, idx) => `NEEDLE before-${idx}`).join("\n")}\nNEEDLE deep-in-range\n`;
		await Bun.write(path.join(cwd, "deep-a.txt"), content);
		await Bun.write(path.join(cwd, "deep-b.txt"), content);
		const session = createTestSession(cwd);

		const result = await new GrepTool(session).execute("deep-range", {
			pattern: "NEEDLE",
			path: "deep-a.txt:4000-4000; deep-b.txt:4000-4000",
		});
		const text = getText(result);

		expect(text).toContain("deep-a.txt");
		expect(text).toContain("deep-b.txt");
		expect(text.match(/deep-in-range/g)).toHaveLength(2);
	});

	it("bypasses cache for line-range selectors", async () => {
		const session = createTestSession(cwd);
		await Bun.write(path.join(cwd, "range-a.txt"), "NEEDLE a\n");
		await Bun.write(path.join(cwd, "range-b.txt"), "NEEDLE b\n");
		const grepSpy = spyOn(piNatives, "grep");

		await new GrepTool(session).execute("range-1", {
			pattern: "NEEDLE",
			path: "range-a.txt:1-1; range-b.txt:1-1",
		});
		await new GrepTool(session).execute("range-2", {
			pattern: "NEEDLE",
			path: "range-a.txt:1-1; range-b.txt:1-1",
			skip: 1,
		});

		expect(grepSpy).toHaveBeenCalledTimes(4);
	});
	it("scans past out-of-range matches for each file in a fan-out search", async () => {
		const session = createTestSession(cwd);
		const content = `${Array.from({ length: 30 }, (_, idx) => `NEEDLE before-${idx}`).join("\n")}\nNEEDLE in-range\n`;
		await Bun.write(path.join(cwd, "range-a.txt"), content);
		await Bun.write(path.join(cwd, "range-b.txt"), content);

		const result = await new GrepTool(session).execute("range-fanout", {
			pattern: "NEEDLE",
			path: "range-a.txt:31-31; range-b.txt:31-31",
		});
		const text = getText(result);

		expect(text).toContain("range-a.txt");
		expect(text).toContain("range-b.txt");
		expect(text.match(/in-range/g)).toHaveLength(2);
	});

	it("does not reuse cached pages while an async Bash job may still mutate files", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const session = createTestSession(cwd, {
			settings: Settings.isolated({
				"grep.contextBefore": 0,
				"grep.contextAfter": 0,
				"async.enabled": true,
				"bash.autoBackground.enabled": false,
			}),
			asyncJobManager: manager,
		});
		// Deterministic stand-in for the shell: mutate immediately, then stay
		// in-flight until released. No subprocess, no watcher, no wall-clock
		// dependence (a real `rm … && sleep` flaked under CI load).
		const bashStarted = Promise.withResolvers<void>();
		const finishBash = Promise.withResolvers<void>();
		const executeBashSpy = vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			await fs.rm(path.join(cwd, "file-20.txt"));
			bashStarted.resolve();
			await finishBash.promise;
			return {
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 0,
				totalBytes: 0,
				outputLines: 0,
				outputBytes: 0,
			};
		});
		try {
			const grepSpy = spyOn(piNatives, "grep");
			await new GrepTool(session).execute("page-1", { pattern: "NEEDLE", path: "." });

			// Completion-only invalidation would leave the stale first page
			// reusable during this window: the job has mutated but not settled.
			await new BashTool(session).execute("mutate", { command: "rm file-20.txt", async: true });
			await bashStarted.promise;

			const pageTwo = await new GrepTool(session).execute("page-2", {
				pattern: "NEEDLE",
				path: ".",
				skip: 20,
			});

			expect(grepSpy).toHaveBeenCalledTimes(2);
			expect(getText(pageTwo)).not.toContain("file-20.txt");
			expect(executeBashSpy).toHaveBeenCalledTimes(1);
		} finally {
			// Release the in-flight job BEFORE disposing so the runner settles
			// cleanly and no detached continuation outlives the test's cwd.
			finishBash.resolve();
			await manager.dispose({ timeoutMs: 1_000 });
		}
	});

	it("clears cached search results after an LSP workspace edit applies", async () => {
		const session = createTestSession(cwd);
		const grepSpy = spyOn(piNatives, "grep");

		await new GrepTool(session).execute("page-1", { pattern: "NEEDLE", path: "." });
		await applyWorkspaceEdit(
			{
				changes: {
					[pathToFileURL(path.join(cwd, "file-20.txt")).href]: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
							newText: "CHANGED",
						},
					],
				},
			},
			cwd,
			session,
		);
		const pageTwo = await new GrepTool(session).execute("page-2", { pattern: "NEEDLE", path: ".", skip: 20 });

		expect(grepSpy).toHaveBeenCalledTimes(2);
		expect(getText(pageTwo)).not.toContain("file-20.txt");
	});

	it("clears cached search results when a workspace edit partially fails", async () => {
		const session = createTestSession(cwd);
		const grepSpy = spyOn(piNatives, "grep");

		await new GrepTool(session).execute("page-1", { pattern: "NEEDLE", path: "." });
		// Operation one mutates file-20; operation two (text edits against a
		// missing file) throws. The partial mutation must still invalidate the
		// cache. (Resource ops are planned before trailing text edits, so the
		// failing op must also be a text edit to run second.)
		await expect(
			applyWorkspaceEdit(
				{
					documentChanges: [
						{
							textDocument: { uri: pathToFileURL(path.join(cwd, "file-20.txt")).href, version: null },
							edits: [
								{
									range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
									newText: "CHANGED",
								},
							],
						},
						{
							textDocument: { uri: pathToFileURL(path.join(cwd, "missing.txt")).href, version: null },
							edits: [
								{
									range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
									newText: "X",
								},
							],
						},
					],
				},
				cwd,
				session,
			),
		).rejects.toThrow();
		const pageTwo = await new GrepTool(session).execute("page-2", { pattern: "NEEDLE", path: ".", skip: 20 });

		expect(grepSpy).toHaveBeenCalledTimes(2);
		expect(getText(pageTwo)).not.toContain("file-20.txt");
	});

	it("keeps in-range and virtual matches when a widened ranged search merges with virtual results", async () => {
		const session = createTestSession(cwd);
		const handler: ProtocolHandler = {
			scheme: BACKING_SCHEME,
			immutable: false,
			async resolve(url: InternalUrl): Promise<InternalResource> {
				return { url: url.href, content: "NEEDLE virtual-hit\n", contentType: "text/plain" };
			},
		};
		InternalUrlRouter.instance().register(handler);
		// More pre-range matches than INTERNAL_TOTAL_CAP (2000): a merge that
		// truncates back to the unwidened cap drops both the in-range line and
		// the virtual match before the JS range filter runs.
		const before = Array.from({ length: 2100 }, (_, idx) => `NEEDLE before-${idx}`).join("\n");
		await Bun.write(path.join(cwd, "huge.txt"), `${before}\nNEEDLE in-range\n`);

		const result = await new GrepTool(session).execute("range-virtual", {
			pattern: "NEEDLE",
			path: `huge.txt:2101-2101; ${BACKING_SCHEME}://doc`,
		});
		const text = getText(result);

		expect(text).toContain("in-range");
		expect(text).toContain("virtual-hit");
	});

	it("merge cap keeps encounter order and applies to one-sided results", () => {
		const makeResult = (pathName: string, count: number): GrepResult => ({
			matches: Array.from({ length: count }, (_, idx) => ({
				path: pathName,
				lineNumber: idx + 1,
				line: `NEEDLE ${idx}`,
			})),
			totalMatches: count,
			filesWithMatches: 1,
			filesSearched: 1,
			limitReached: false,
		});

		// Two-sided over cap: filesystem matches fill the budget first and the
		// trailing virtual match is dropped with the limit flagged.
		const boundary = mergeGrepResults(makeResult("fs.txt", 4), makeResult("virtual://doc", 1), 4);
		expect(boundary.matches.map(match => match.path)).toEqual(["fs.txt", "fs.txt", "fs.txt", "fs.txt"]);
		expect(boundary.limitReached).toBe(true);
		expect(boundary.totalMatches).toBe(5);

		// Under cap: both sides survive in filesystem-then-virtual order.
		const merged = mergeGrepResults(makeResult("fs.txt", 2), makeResult("virtual://doc", 1), 4);
		expect(merged.matches.map(match => match.path)).toEqual(["fs.txt", "fs.txt", "virtual://doc"]);
		expect(merged.limitReached).toBe(false);

		// One-sided over cap must not bypass the ceiling: pre-fix the nonempty
		// side was returned unchanged and uncapped.
		const oneSided = mergeGrepResults(makeResult("fs.txt", 6), makeResult("virtual://doc", 0), 4);
		expect(oneSided.matches).toHaveLength(4);
		expect(oneSided.limitReached).toBe(true);
		expect(oneSided.totalMatches).toBe(6);
	});

	it("caps over-cap aggregated multi-target results even without virtual participation", async () => {
		const session = createTestSession(cwd);
		// Two directory targets: each native call stays under its own cap, but
		// the aggregate (102 files x 21 fetched matches = 2142) exceeds
		// INTERNAL_TOTAL_CAP, so the merged result must cap and flag the limit.
		for (const dir of ["cap-a", "cap-b"]) {
			await fs.mkdir(path.join(cwd, dir), { recursive: true });
			for (let idx = 0; idx < 51; idx++) {
				const body = Array.from({ length: 21 }, (_, line) => `NEEDLE ${dir}-${idx}-${line}`).join("\n");
				await Bun.write(path.join(cwd, dir, `f-${idx.toString().padStart(2, "0")}.txt`), `${body}\n`);
			}
		}

		const result = await new GrepTool(session).execute("over-cap", { pattern: "NEEDLE", path: "cap-a; cap-b" });
		const text = getText(result);

		// The "+" suffix marks the capped lower-bound file total.
		expect(text).toMatch(/of \d+\+/);
		expect(text).not.toContain("of 102");
	});

	it("maps virtual-only regex engine failures to Invalid regex", async () => {
		const session = createTestSession(cwd);
		const handler: ProtocolHandler = {
			scheme: BACKING_SCHEME,
			immutable: false,
			async resolve(url: InternalUrl): Promise<InternalResource> {
				return { url: url.href, content: "irrelevant\n", contentType: "text/plain" };
			},
		};
		InternalUrlRouter.instance().register(handler);
		// Whether native grep rejects a given pattern depends on the natives
		// build (newer builds fall back to a literal match instead of erroring),
		// so drive the error surface directly: a virtual-only scope's ONLY
		// native call is the scratch probe, and when that probe rejects with a
		// regex error the tool must surface `Invalid regex: ...`, never the raw
		// engine error.
		const grepSpy = spyOn(piNatives, "grep").mockRejectedValue(
			new Error("regex parse error: unclosed character class"),
		);
		await expect(
			new GrepTool(session).execute("bad-regex", { pattern: "[", path: `${BACKING_SCHEME}://doc` }),
		).rejects.toThrow(/^Invalid regex: /);

		// JS RegExp SyntaxError (oversized-content fallback path) maps the same way.
		grepSpy.mockRejectedValue(new SyntaxError("Invalid regular expression: /[/: Unterminated character class"));
		await expect(
			new GrepTool(session).execute("bad-regex-js", { pattern: "[", path: `${BACKING_SCHEME}://doc` }),
		).rejects.toThrow(/^Invalid regex: /);
	});

	it("clears cached search results after an eval cell completes", async () => {
		const session = createTestSession(cwd);
		const grepSpy = spyOn(piNatives, "grep");

		await new GrepTool(session).execute("page-1", { pattern: "NEEDLE", path: "." });
		// Eval cells can mutate the filesystem through arbitrary runtime APIs;
		// completion must conservatively invalidate cached pages.
		const target = path.join(cwd, "file-20.txt");
		await new EvalTool(session).execute("mutate", {
			language: "js",
			code: `await Bun.file(${JSON.stringify(target)}).delete();`,
		});
		const pageTwo = await new GrepTool(session).execute("page-2", { pattern: "NEEDLE", path: ".", skip: 20 });

		expect(grepSpy).toHaveBeenCalledTimes(2);
		expect(getText(pageTwo)).not.toContain("file-20.txt");
	});

	it("clears cached search results when an ast_edit preview is applied", async () => {
		const queue = new ToolChoiceQueue();
		const session = createTestSession(cwd, {
			getToolChoiceQueue: () => queue,
			buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
			steer: () => {},
		});
		await Bun.write(path.join(cwd, "legacy.ts"), "legacyWrap(x, value)\n");
		const grepSpy = spyOn(piNatives, "grep");

		await new GrepTool(session).execute("page-1", { pattern: "NEEDLE", path: "." });
		await new AstEditTool(session).execute("preview", {
			ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
			paths: ["legacy.ts"],
		});
		const invoker = queue.peekPendingInvoker()!;
		await invoker({ action: "apply", reason: "apply previewed AST edit" });
		const pageTwo = await new GrepTool(session).execute("page-2", { pattern: "NEEDLE", path: ".", skip: 20 });

		expect(grepSpy).toHaveBeenCalledTimes(2);
		expect(await Bun.file(path.join(cwd, "legacy.ts")).text()).toContain("modernWrap");
		expect(getText(pageTwo)).toContain("file-20.txt");
	});

	it("clears cached search results after a TTS write", async () => {
		const session = createTestSession(cwd);
		const grepSpy = spyOn(piNatives, "grep");
		spyOn(ttsClient, "synthesize").mockResolvedValue({ pcm: new Float32Array(16), sampleRate: 24_000 });
		// Force the local backend so no credential lookup or network is involved.
		const previousProvider = settings.get("providers.tts");
		settings.set("providers.tts", "local");
		try {
			await new GrepTool(session).execute("page-1", { pattern: "NEEDLE", path: "." });

			// Production wiring: sdk.ts binds `invalidateFileCaches` for built-in
			// write-capable custom tools to the owning tool session.
			const ttsContext = {
				sessionManager: { getCwd: () => cwd },
				isIdle: () => true,
				hasQueuedMessages: () => false,
				abort: () => {},
				invalidateFileCaches: (writtenPath: string) => invalidateFsScanAfterWrite(writtenPath, session),
			} as unknown as CustomToolContext;
			await ttsTool.execute(
				"tts-1",
				{ text: "hello", voice_id: "eve", language: "en", output_path: "speech.wav" },
				undefined,
				ttsContext,
				undefined,
			);
			expect(await Bun.file(path.join(cwd, "speech.wav")).exists()).toBe(true);

			const pageTwo = await new GrepTool(session).execute("page-2", { pattern: "NEEDLE", path: ".", skip: 20 });

			expect(grepSpy).toHaveBeenCalledTimes(2);
			expect(getText(pageTwo)).toContain("file-20.txt");
		} finally {
			settings.set("providers.tts", previousProvider);
		}
	});

	it("suppresses every same-workspace cache including mid-flight registrants", () => {
		const makeEntry = (): CachedGroupedSearchResult => ({
			fileOrder: [],
			matchesByPath: new Map(),
			perFileLimitReached: false,
			resultLimitReached: false,
			skippedOversizedCount: 0,
		});
		const ownerA: SearchResultCacheOwner = { cwd };
		const ownerB: SearchResultCacheOwner = { cwd };
		getSearchResultCache(ownerA).set("k", makeEntry());
		expect(getSearchResultCache(ownerA).get("k")).toBeDefined();

		// Sibling suppression: B's background job closes A's cache too.
		const release = suppressSearchResultCaches(ownerB);
		expect(getSearchResultCache(ownerA).get("k")).toBeUndefined();
		getSearchResultCache(ownerA).set("k", makeEntry());
		expect(getSearchResultCache(ownerA).get("k")).toBeUndefined();

		// Mid-flight registrant in the same workspace is suppressed as well.
		const ownerC: SearchResultCacheOwner = { cwd };
		getSearchResultCache(ownerC).set("k", makeEntry());
		expect(getSearchResultCache(ownerC).get("k")).toBeUndefined();

		// Nested suppression: the workspace reopens only after every release.
		const releaseNested = suppressSearchResultCaches(ownerA);
		release();
		getSearchResultCache(ownerA).set("k", makeEntry());
		expect(getSearchResultCache(ownerA).get("k")).toBeUndefined();
		releaseNested();
		releaseNested(); // double release is a no-op
		getSearchResultCache(ownerA).set("k", makeEntry());
		expect(getSearchResultCache(ownerA).get("k")).toBeDefined();
		expect(workspaceRegistrySnapshot(cwd)?.suppressions).toBe(0);
	});

	it("workspace registry dedups owners, relocates moved sessions, and drops empty buckets", async () => {
		const wsA = path.join(cwd, "reg-a");
		const wsB = path.join(cwd, "reg-b");
		await fs.mkdir(wsA, { recursive: true });
		await fs.mkdir(wsB, { recursive: true });

		const ownerA: SearchResultCacheOwner = { cwd: wsA };
		getSearchResultCache(ownerA);
		getSearchResultCache(ownerA);
		expect(workspaceRegistrySnapshot(wsA)).toEqual({ owners: 1, suppressions: 0 });

		const ownerB: SearchResultCacheOwner = { cwd: wsA };
		getSearchResultCache(ownerB);
		expect(workspaceRegistrySnapshot(wsA)?.owners).toBe(2);

		// A live session moving workspaces must leave the old bucket.
		ownerB.cwd = wsB;
		getSearchResultCache(ownerB);
		expect(workspaceRegistrySnapshot(wsA)?.owners).toBe(1);
		expect(workspaceRegistrySnapshot(wsB)).toEqual({ owners: 1, suppressions: 0 });

		// The last departure drops the empty bucket entirely.
		ownerA.cwd = wsB;
		getSearchResultCache(ownerA);
		expect(workspaceRegistrySnapshot(wsA)).toBeUndefined();
		expect(workspaceRegistrySnapshot(wsB)?.owners).toBe(2);

		// Old-workspace mutations no longer touch the moved session's cache.
		getSearchResultCache(ownerA).set("k", {
			fileOrder: [],
			matchesByPath: new Map(),
			perFileLimitReached: false,
			resultLimitReached: false,
			skippedOversizedCount: 0,
		});
		clearSearchResultCache({ cwd: wsA });
		expect(getSearchResultCache(ownerA).get("k")).toBeDefined();
	});

	it("canonicalizes workspace keys across symlinked aliases", async () => {
		const real = path.join(cwd, "real-ws");
		const alias = path.join(cwd, "alias-ws");
		await fs.mkdir(real, { recursive: true });
		await fs.symlink(real, alias);

		const ownerReal: SearchResultCacheOwner = { cwd: real };
		const ownerAlias: SearchResultCacheOwner = { cwd: alias };
		getSearchResultCache(ownerReal).set("k", {
			fileOrder: [],
			matchesByPath: new Map(),
			perFileLimitReached: false,
			resultLimitReached: false,
			skippedOversizedCount: 0,
		});
		getSearchResultCache(ownerAlias);
		expect(workspaceRegistrySnapshot(real)?.owners).toBe(2);
		expect(workspaceRegistrySnapshot(alias)?.owners).toBe(2);

		// A mutation reported through the alias clears the real-path sibling.
		clearSearchResultCache(ownerAlias);
		expect(getSearchResultCache(ownerReal).get("k")).toBeUndefined();
	});

	it("unifies case aliases only when the volume is actually case-insensitive", async () => {
		const real = path.join(cwd, "case-ws");
		await fs.mkdir(real, { recursive: true });
		const upperTail = path.join(cwd, "CASE-WS");
		// Runtime probe of THIS volume — platform name alone must not decide
		// (macOS supports case-sensitive APFS/HFS volumes).
		const volumeInsensitive = await fs.access(upperTail).then(
			() => true,
			() => false,
		);

		const ownerReal: SearchResultCacheOwner = { cwd: real };
		const ownerUpper: SearchResultCacheOwner = { cwd: upperTail };
		getSearchResultCache(ownerReal);
		getSearchResultCache(ownerUpper);
		expect(workspaceRegistrySnapshot(real)?.owners).toBe(volumeInsensitive ? 2 : 1);

		// Fallback contract: NOT-yet-existing paths differing only by case merge
		// only when the nearest existing ancestor's volume is case-insensitive —
		// never by a blind platform-wide lowercase.
		const missingLower: SearchResultCacheOwner = { cwd: path.join(cwd, "missing-ws") };
		const missingUpper: SearchResultCacheOwner = { cwd: path.join(cwd, "MISSING-WS") };
		getSearchResultCache(missingLower);
		getSearchResultCache(missingUpper);
		expect(workspaceRegistrySnapshot(path.join(cwd, "missing-ws"))?.owners).toBe(volumeInsensitive ? 2 : 1);
	});

	it("relocating to a cwd-less fallback retires the old workspace registration", async () => {
		const wsA = path.join(cwd, "fallback-a");
		await fs.mkdir(wsA, { recursive: true });
		const makeEntry = (): CachedGroupedSearchResult => ({
			fileOrder: [],
			matchesByPath: new Map(),
			perFileLimitReached: false,
			resultLimitReached: false,
			skippedOversizedCount: 0,
		});

		const owner: SearchResultCacheOwner = { cwd: wsA };
		getSearchResultCache(owner);
		expect(workspaceRegistrySnapshot(wsA)?.owners).toBe(1);

		owner.cwd = undefined;
		getSearchResultCache(owner).set("k", makeEntry());
		// Old bucket dropped entirely...
		expect(workspaceRegistrySnapshot(wsA)).toBeUndefined();
		// ...and old-workspace invalidation no longer evicts the fallback cache.
		clearSearchResultCache({ cwd: wsA });
		expect(getSearchResultCache(owner).get("k")).toBeDefined();
	});

	it("reconciles a moved owner when the first post-move call is a mutation", async () => {
		const wsA = path.join(cwd, "move-a");
		const wsB = path.join(cwd, "move-b");
		await fs.mkdir(wsA, { recursive: true });
		await fs.mkdir(wsB, { recursive: true });
		const makeEntry = (): CachedGroupedSearchResult => ({
			fileOrder: [],
			matchesByPath: new Map(),
			perFileLimitReached: false,
			resultLimitReached: false,
			skippedOversizedCount: 0,
		});

		const owner: SearchResultCacheOwner = { cwd: wsA };
		getSearchResultCache(owner);
		owner.cwd = wsB;
		// First post-move operation is a MUTATION, not a cache read.
		clearSearchResultCache(owner);

		expect(workspaceRegistrySnapshot(wsA)).toBeUndefined();
		expect(workspaceRegistrySnapshot(wsB)?.owners).toBe(1);
		getSearchResultCache(owner).set("k", makeEntry());
		clearSearchResultCache({ cwd: wsA });
		expect(getSearchResultCache(owner).get("k")).toBeDefined();
		clearSearchResultCache({ cwd: wsB });
		expect(getSearchResultCache(owner).get("k")).toBeUndefined();
	});

	it("finalized owners are reaped, with bucket drop deferred while suppressed", async () => {
		const wsX = path.join(cwd, "reap-x");
		await fs.mkdir(wsX, { recursive: true });

		// Plain collection: last owner reaped drops the bucket immediately.
		const collected: SearchResultCacheOwner = { cwd: wsX };
		getSearchResultCache(collected);
		expect(workspaceRegistrySnapshot(wsX)?.owners).toBe(1);
		simulateWorkspaceOwnerCollectionForTests(collected);
		expect(workspaceRegistrySnapshot(wsX)).toBeUndefined();

		// Suppression-active: the bucket must survive the reap until release.
		const holder: SearchResultCacheOwner = { cwd: wsX };
		getSearchResultCache(holder);
		const release = suppressSearchResultCaches(holder);
		simulateWorkspaceOwnerCollectionForTests(holder);
		expect(workspaceRegistrySnapshot(wsX)).toEqual({ owners: 0, suppressions: 1 });
		release();
		expect(workspaceRegistrySnapshot(wsX)).toBeUndefined();
	});

	it("async Bash cwd overrides suppress the effective command workspace", async () => {
		const jobWs = path.join(cwd, "job-ws");
		await fs.mkdir(jobWs, { recursive: true });
		for (let idx = 0; idx < 25; idx++) {
			const suffix = idx.toString().padStart(2, "0");
			await Bun.write(path.join(jobWs, `job-${suffix}.txt`), `NEEDLE job-${suffix}\n`);
		}
		const sibling = createTestSession(jobWs);
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const session = createTestSession(cwd, {
			settings: Settings.isolated({
				"grep.contextBefore": 0,
				"grep.contextAfter": 0,
				"async.enabled": true,
				"bash.autoBackground.enabled": false,
			}),
			asyncJobManager: manager,
		});
		const bashStarted = Promise.withResolvers<void>();
		const finishBash = Promise.withResolvers<void>();
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			await fs.rm(path.join(jobWs, "job-20.txt"));
			bashStarted.resolve();
			await finishBash.promise;
			return {
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 0,
				totalBytes: 0,
				outputLines: 0,
				outputBytes: 0,
			};
		});
		try {
			const grepSpy = spyOn(piNatives, "grep");
			await new GrepTool(sibling).execute("sibling-page-1", { pattern: "NEEDLE", path: "." });

			await new BashTool(session).execute("mutate", {
				command: "rm job-20.txt",
				cwd: "job-ws",
				async: true,
			});
			await bashStarted.promise;

			// The sibling rooted at the EFFECTIVE command cwd must refetch...
			const pageTwo = await new GrepTool(sibling).execute("sibling-page-2", {
				pattern: "NEEDLE",
				path: ".",
				skip: 20,
			});
			expect(grepSpy).toHaveBeenCalledTimes(2);
			expect(getText(pageTwo)).not.toContain("job-20.txt");
			// ...and must not repopulate while the job is still running.
			await new GrepTool(sibling).execute("sibling-page-3", { pattern: "NEEDLE", path: ".", skip: 20 });
			expect(grepSpy).toHaveBeenCalledTimes(3);
		} finally {
			finishBash.resolve();
			await manager.dispose({ timeoutMs: 1_000 });
		}
	});

	it("holds sibling caches closed during a foreground Bash run with a cwd override", async () => {
		const jobWs = path.join(cwd, "fg-ws");
		await fs.mkdir(jobWs, { recursive: true });
		for (let idx = 0; idx < 25; idx++) {
			const suffix = idx.toString().padStart(2, "0");
			await Bun.write(path.join(jobWs, `fg-${suffix}.txt`), `NEEDLE fg-${suffix}\n`);
		}
		const sibling = createTestSession(jobWs);
		const session = createTestSession(cwd, {
			settings: Settings.isolated({
				"grep.contextBefore": 0,
				"grep.contextAfter": 0,
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
			}),
		});
		const bashStarted = Promise.withResolvers<void>();
		const finishBash = Promise.withResolvers<void>();
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			await fs.rm(path.join(jobWs, "fg-20.txt"));
			bashStarted.resolve();
			await finishBash.promise;
			return {
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 0,
				totalBytes: 0,
				outputLines: 0,
				outputBytes: 0,
			};
		});
		const grepSpy = spyOn(piNatives, "grep");

		await new GrepTool(sibling).execute("fg-page-1", { pattern: "NEEDLE", path: "." });
		const bashPromise = new BashTool(session).execute("fg-mutate", { command: "rm fg-20.txt", cwd: "fg-ws" });
		try {
			await bashStarted.promise;

			// Mid-run: the sibling at the effective command cwd must refetch...
			const pageTwo = await new GrepTool(sibling).execute("fg-page-2", {
				pattern: "NEEDLE",
				path: ".",
				skip: 20,
			});
			expect(grepSpy).toHaveBeenCalledTimes(2);
			expect(getText(pageTwo)).not.toContain("fg-20.txt");
			// ...and must not repopulate while the command is still running.
			await new GrepTool(sibling).execute("fg-page-3", { pattern: "NEEDLE", path: ".", skip: 20 });
			expect(grepSpy).toHaveBeenCalledTimes(3);
		} finally {
			finishBash.resolve();
			await bashPromise;
		}

		// After settle the workspace reopens for normal caching.
		await new GrepTool(sibling).execute("fg-page-4", { pattern: "NEEDLE", path: "." });
		await new GrepTool(sibling).execute("fg-page-5", { pattern: "NEEDLE", path: ".", skip: 20 });
		expect(grepSpy).toHaveBeenCalledTimes(4);
	});

	it("holds sibling caches closed during a client-terminal Bash run with a cwd override", async () => {
		const termWs = path.join(cwd, "term-ws");
		await fs.mkdir(termWs, { recursive: true });
		for (let idx = 0; idx < 25; idx++) {
			const suffix = idx.toString().padStart(2, "0");
			await Bun.write(path.join(termWs, `term-${suffix}.txt`), `NEEDLE term-${suffix}\n`);
		}
		const sibling = createTestSession(termWs);
		const terminalCreated = Promise.withResolvers<void>();
		const exitGate = Promise.withResolvers<void>();
		const handle = {
			terminalId: "term-1",
			waitForExit: () => exitGate.promise.then(() => ({ exitCode: 0, signal: null })),
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge = {
			capabilities: { terminal: true },
			createTerminal: async () => {
				// The remote command mutates as soon as the terminal spawns.
				await fs.rm(path.join(termWs, "term-20.txt"));
				terminalCreated.resolve();
				return handle;
			},
		};
		const session = createTestSession(cwd, {
			settings: Settings.isolated({
				"grep.contextBefore": 0,
				"grep.contextAfter": 0,
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
			}),
			getClientBridge: (() => bridge) as unknown as ToolSession["getClientBridge"],
		});
		const grepSpy = spyOn(piNatives, "grep");

		await new GrepTool(sibling).execute("term-page-1", { pattern: "NEEDLE", path: "." });
		const bashPromise = new BashTool(session).execute("term-mutate", {
			command: "rm term-20.txt",
			cwd: "term-ws",
		});
		try {
			await terminalCreated.promise;

			// Mid-run: sibling at the terminal's cwd must refetch...
			const pageTwo = await new GrepTool(sibling).execute("term-page-2", {
				pattern: "NEEDLE",
				path: ".",
				skip: 20,
			});
			expect(grepSpy).toHaveBeenCalledTimes(2);
			expect(getText(pageTwo)).not.toContain("term-20.txt");
			// ...and must not repopulate while the terminal is still live.
			await new GrepTool(sibling).execute("term-page-3", { pattern: "NEEDLE", path: ".", skip: 20 });
			expect(grepSpy).toHaveBeenCalledTimes(3);
		} finally {
			exitGate.resolve();
			await bashPromise;
		}
	});

	it("releases suppression exactly once when client-terminal creation fails", async () => {
		const failWs = path.join(cwd, "fail-ws");
		await fs.mkdir(failWs, { recursive: true });
		const sibling: SearchResultCacheOwner = { cwd: failWs };
		getSearchResultCache(sibling);

		const bridge = {
			capabilities: { terminal: true },
			createTerminal: async () => {
				throw new Error("terminal create failed");
			},
		};
		const session = createTestSession(cwd, {
			settings: Settings.isolated({
				"grep.contextBefore": 0,
				"grep.contextAfter": 0,
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
			}),
			getClientBridge: (() => bridge) as unknown as ToolSession["getClientBridge"],
		});

		await expect(new BashTool(session).execute("fail-create", { command: "true", cwd: "fail-ws" })).rejects.toThrow(
			"terminal create failed",
		);

		// Suppression acquired before createTerminal must be released for BOTH
		// affected workspaces despite the rejection...
		expect(workspaceRegistrySnapshot(failWs)?.suppressions).toBe(0);
		expect(workspaceRegistrySnapshot(cwd)?.suppressions ?? 0).toBe(0);
		// ...so caching works again in the override workspace.
		getSearchResultCache(sibling).set("k", {
			fileOrder: [],
			matchesByPath: new Map(),
			perFileLimitReached: false,
			resultLimitReached: false,
			skippedOversizedCount: 0,
		});
		expect(getSearchResultCache(sibling).get("k")).toBeDefined();
	});

	it("kills and settles before reopening caches on a bridge transport error", async () => {
		const twWs = path.join(cwd, "tw-ws");
		await fs.mkdir(twWs, { recursive: true });
		const sibling: SearchResultCacheOwner = { cwd: twWs };
		getSearchResultCache(sibling);

		let killed = false;
		let suppressionAtKill: { session?: number; job?: number } | undefined;
		const handle = {
			terminalId: "tw-1",
			waitForExit: () => Promise.reject(new Error("transport lost")),
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => {
				killed = true;
				// The caches must STILL be held closed while the kill settles.
				suppressionAtKill = {
					session: workspaceRegistrySnapshot(cwd)?.suppressions,
					job: workspaceRegistrySnapshot(twWs)?.suppressions,
				};
			},
			release: async () => {},
		};
		const bridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const session = createTestSession(cwd, {
			settings: Settings.isolated({
				"grep.contextBefore": 0,
				"grep.contextAfter": 0,
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
			}),
			getClientBridge: (() => bridge) as unknown as ToolSession["getClientBridge"],
		});

		await expect(new BashTool(session).execute("transport-error", { command: "true", cwd: "tw-ws" })).rejects.toThrow(
			"transport lost",
		);

		expect(killed).toBe(true);
		expect(suppressionAtKill).toEqual({ session: 1, job: 1 });
		// Reopened exactly once after settlement — never negative, never stuck.
		expect(workspaceRegistrySnapshot(twWs)?.suppressions).toBe(0);
		expect(workspaceRegistrySnapshot(cwd)?.suppressions ?? 0).toBe(0);
	});

	it("holds suppression and the handle until an abort-initiated kill settles", async () => {
		const abWs = path.join(cwd, "ab-ws");
		await fs.mkdir(abWs, { recursive: true });
		const sibling: SearchResultCacheOwner = { cwd: abWs };
		getSearchResultCache(sibling);

		const terminalCreated = Promise.withResolvers<void>();
		const pollLoopEntered = Promise.withResolvers<void>();
		const killCalled = Promise.withResolvers<void>();
		const killGate = Promise.withResolvers<void>();
		let releaseCalls = 0;
		const handle = {
			terminalId: "ab-1",
			waitForExit: () => {
				// The tool registers its abort listener synchronously after this
				// call and then parks in the poll race; resolving here lets the
				// test abort MID-POLL (through the listener), the racy path.
				pollLoopEntered.resolve();
				return new Promise<never>(() => {});
			},
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: () => {
				killCalled.resolve();
				return killGate.promise;
			},
			release: async () => {
				releaseCalls++;
			},
		};
		const bridge = {
			capabilities: { terminal: true },
			createTerminal: async () => {
				terminalCreated.resolve();
				return handle;
			},
		};
		const session = createTestSession(cwd, {
			settings: Settings.isolated({
				"grep.contextBefore": 0,
				"grep.contextAfter": 0,
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
			}),
			getClientBridge: (() => bridge) as unknown as ToolSession["getClientBridge"],
		});

		const controller = new AbortController();
		const bashPromise = new BashTool(session).execute(
			"abort-kill",
			{ command: "true", cwd: "ab-ws" },
			controller.signal,
		);
		await terminalCreated.promise;
		await pollLoopEntered.promise;
		controller.abort();
		await killCalled.promise;
		// Give the abort path every microtask turn it could take: with the old
		// boolean guard the tool's finally ran to completion here (releasing
		// suppression and the handle) without waiting for the kill RPC. The
		// fixed code cannot pass `await killPromise`, so nothing below changes.
		for (let i = 0; i < 25; i++) await Promise.resolve();

		// While the kill RPC is still in flight, both workspaces stay closed and
		// the handle is not released — a boolean guard raced past this window.
		expect(workspaceRegistrySnapshot(cwd)?.suppressions).toBe(1);
		expect(workspaceRegistrySnapshot(abWs)?.suppressions).toBe(1);
		expect(releaseCalls).toBe(0);

		killGate.resolve();
		await expect(bashPromise).rejects.toThrow(/aborted/i);

		// Reopened exactly once after settlement.
		expect(workspaceRegistrySnapshot(cwd)?.suppressions ?? 0).toBe(0);
		expect(workspaceRegistrySnapshot(abWs)?.suppressions).toBe(0);
		expect(releaseCalls).toBe(1);
	});
});

describe("lsp search cache owner registry", () => {
	it("deduplicates live owners and prunes dead refs on registration", () => {
		const client = {} as LspClient;
		const ownerA: { searchResultCache?: undefined } = {};
		const ownerB: { searchResultCache?: undefined } = {};

		registerSearchCacheOwner(client, ownerA);
		registerSearchCacheOwner(client, ownerA);
		expect(client.searchCacheOwners?.size).toBe(1);

		// A collected session's ref must be dropped instead of accumulating on
		// the process-global client for its whole lifetime.
		const deadRef = { deref: () => undefined } as unknown as WeakRef<typeof ownerA>;
		client.searchCacheOwners?.add(deadRef);
		registerSearchCacheOwner(client, ownerB);

		expect(client.searchCacheOwners?.has(deadRef)).toBe(false);
		expect(client.searchCacheOwners?.size).toBe(2);
		const held = Array.from(client.searchCacheOwners ?? [], ref => ref.deref());
		expect(held).toContain(ownerA);
		expect(held).toContain(ownerB);
	});

	it("invalidates live registered owners and prunes dead refs", () => {
		const client = {} as LspClient;
		const owner: { searchResultCache?: undefined } = {};
		registerSearchCacheOwner(client, owner);
		const cache = getSearchResultCache(owner);
		cache.set("key", {
			fileOrder: [],
			matchesByPath: new Map(),
			perFileLimitReached: false,
			resultLimitReached: false,
			skippedOversizedCount: 0,
		});
		const deadRef = { deref: () => undefined } as unknown as WeakRef<typeof owner>;
		client.searchCacheOwners?.add(deadRef);

		invalidateRegisteredSearchCaches(client);

		expect(cache.get("key")).toBeUndefined();
		expect(client.searchCacheOwners?.has(deadRef)).toBe(false);
	});
});
