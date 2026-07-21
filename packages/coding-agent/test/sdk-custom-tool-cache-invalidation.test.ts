/**
 * SDK-supplied custom tools (options.customTools) must receive the
 * `invalidateFileCaches` seam bound to the OWNING session's tool session, so a
 * workspace write through a custom tool drops that session's cached grouped
 * search pages — and only that session's.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool, CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as piNatives from "@oh-my-pi/pi-natives";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

describe("SDK custom tool search-cache invalidation", () => {
	const tempDirs: string[] = [];
	let sharedTempDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-custom-cache-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedTempDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedTempDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedTempDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
		AsyncJobManager.resetForTests();
	});

	function makeMarkerTool(captured: { ctx?: CustomToolContext }): CustomTool {
		return {
			name: "write_marker",
			label: "Write Marker",
			description: "Writes a marker file into the workspace (test-only write-capable custom tool).",
			parameters: type({ file_name: "string", content: "string" }),
			loadMode: "essential",
			async execute(_toolCallId, params: { file_name: string; content: string }, _onUpdate, ctx) {
				const target = path.join(ctx.sessionManager.getCwd(), params.file_name);
				await Bun.write(target, params.content);
				captured.ctx = ctx;
				ctx.invalidateFileCaches?.(target);
				return { content: [{ type: "text", text: `wrote ${params.file_name}` }] };
			},
		} as CustomTool;
	}

	async function spawnSession(customTools: CustomTool[]) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-custom-cache-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		for (let idx = 0; idx < 25; idx++) {
			fs.writeFileSync(path.join(cwd, `file-${idx.toString().padStart(2, "0")}.txt`), `NEEDLE ${idx}\n`);
		}
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			settings: Settings.isolated({
				"tools.approvalMode": "yolo",
				"tools.xdev": false,
				"grep.contextBefore": 0,
				"grep.contextAfter": 0,
			}),
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: sharedModelRegistry,
			customTools,
		});
		const grepTool = session.agent.state.tools.find(tool => tool.name === "grep");
		if (!grepTool) throw new Error("grep tool not registered");
		return { session, cwd, grepTool };
	}

	it("invalidates only the owning session's cached pages after a custom tool write", async () => {
		const captured: { ctx?: CustomToolContext } = {};
		const owning = await spawnSession([makeMarkerTool(captured)]);
		const other = await spawnSession([]);
		try {
			const grepSpy = spyOn(piNatives, "grep");

			await owning.grepTool.execute("owning-page-1", { pattern: "NEEDLE", path: "." });
			await other.grepTool.execute("other-page-1", { pattern: "NEEDLE", path: "." });
			expect(grepSpy).toHaveBeenCalledTimes(2);

			const markerTool = owning.session.agent.state.tools.find(tool => tool.name === "write_marker");
			expect(markerTool).toBeDefined();
			await markerTool!.execute("marker-1", { file_name: "marker.txt", content: "NEEDLE marker\n" });

			// The seam must be wired for SDK-supplied custom tools.
			expect(captured.ctx?.invalidateFileCaches).toBeDefined();
			expect(fs.existsSync(path.join(owning.cwd, "marker.txt"))).toBe(true);

			// Owning session: stale page dropped, skip refetches.
			await owning.grepTool.execute("owning-page-2", { pattern: "NEEDLE", path: ".", skip: 20 });
			expect(grepSpy).toHaveBeenCalledTimes(3);

			// Other session: untouched cache still serves its skip page.
			await other.grepTool.execute("other-page-2", { pattern: "NEEDLE", path: ".", skip: 20 });
			expect(grepSpy).toHaveBeenCalledTimes(3);
		} finally {
			await owning.session.dispose();
			await other.session.dispose();
		}
	}, 60_000);
});
