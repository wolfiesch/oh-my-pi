import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("AsyncJobManager singleton across concurrent top-level sessions", () => {
	const tempDirs: string[] = [];
	// Building a ModelRegistry per session is the dominant cost here: createAgentSession
	// otherwise runs discoverAuthStorage (a fresh AuthStorage DB create+reload) and a
	// background online model refresh for every spawn (~450ms each). The singleton
	// ownership behavior under test is independent of model resolution, so we hand every
	// session one shared, network-free registry built once (~10ms/session instead).
	let sharedTempDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-async-singleton-shared-"));
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

	async function spawnTopLevelSession(
		extraSettings?: Record<string, unknown>,
		agentRegistry?: AgentRegistry,
		identity?: { agentId: string; parentAgentId: string; parentTaskPrefix: string; taskDepth: number },
	) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-singleton-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settings: Settings.isolated({ "bash.autoBackground.enabled": true, ...(extraSettings ?? {}) }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: sharedModelRegistry,
			agentRegistry,
			...identity,
		});
		return session;
	}

	it("keeps the primary session's manager installed after a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			const secondary = await spawnTopLevelSession();
			try {
				// While the secondary is alive the global instance MUST still point at
				// the primary's manager so background tools keep delivering completions
				// to the primary session that owns them.
				expect(AsyncJobManager.instance()).toBe(primaryManager);
			} finally {
				await secondary.dispose();
			}

			// After the secondary disposes, the primary's manager MUST still be the
			// reachable singleton — otherwise the `task` async path errors with
			// "Async execution is enabled but no async job manager is available".
			expect(AsyncJobManager.instance()).toBe(primaryManager);
		} finally {
			await primary.dispose();
		}

		// Once the owning primary session disposes the singleton clears, matching
		// the documented single-owner invariant.
		expect(AsyncJobManager.instance()).toBeUndefined();
	}, 60000);

	it("does not cancel the primary session's running jobs when a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			// Register a long-running job on the primary's manager under the
			// MAIN_AGENT_ID owner — the same owner the secondary would inherit by
			// default. The secondary's dispose-time `cancelOwnAsyncJobs` must NOT
			// cancel this job (issue #1923).
			const release = Promise.withResolvers<string>();
			const jobId = primaryManager!.register(
				"bash",
				"sleep",
				async ({ signal }) => {
					const aborted = Promise.withResolvers<void>();
					signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					await Promise.race([release.promise, aborted.promise]);
					return signal.aborted ? "aborted" : "completed";
				},
				{ ownerId: "Main" },
			);
			expect(primary.getAsyncJobSnapshot()?.running.some(job => job.id === jobId)).toBe(true);

			const secondary = await spawnTopLevelSession();
			try {
				expect(secondary.getAsyncJobSnapshot()).toBeNull();
			} finally {
				await secondary.dispose();
			}

			const job = primaryManager!.getJob(jobId);
			expect(job?.status).toBe("running");

			release.resolve("done");
			await primaryManager!.waitForAll();
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("refuses async bash from a secondary session instead of routing it to the primary's manager", async () => {
		const primary = await spawnTopLevelSession({ "async.enabled": true });
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();
			const primaryJobCountBefore = primaryManager!.getAllJobs().length;

			const secondary = await spawnTopLevelSession({ "async.enabled": true });
			try {
				const bashTool = secondary.getToolByName("bash");
				expect(bashTool).toBeDefined();
				await expect(bashTool!.execute("call-1", { command: "echo hi", async: true })).rejects.toThrow(
					/Async job manager unavailable/,
				);
			} finally {
				await secondary.dispose();
			}

			// The secondary's failed async attempt must not have leaked a job into
			// the primary's manager.
			expect(primaryManager!.getAllJobs().length).toBe(primaryJobCountBefore);
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("routes wakeup completion to the registered owning session", async () => {
		const registry = new AgentRegistry();
		const primary = await spawnTopLevelSession(undefined, registry);
		// A REAL subagent session: it inherits the shared manager as its scoped
		// manager and must register the `async-result` yield-queue dispatcher —
		// a fake `{ yieldQueue: { enqueue } }` child would accept any kind and
		// mask an unregistered-kind drop in YieldQueue.enqueue.
		const subagent = await spawnTopLevelSession(undefined, registry, {
			agentId: "Child",
			parentAgentId: "Main",
			parentTaskPrefix: "0",
			taskDepth: 1,
		});
		try {
			const manager = AsyncJobManager.instance();
			expect(manager).toBeDefined();
			expect(registry.get("Child")?.session).toBe(subagent);
			const primaryEnqueue = vi.spyOn(primary.yieldQueue, "enqueue");
			// Retain instead of immediately dispatching so the routed entry is
			// observable in the child's queue.
			Object.defineProperty(subagent, "isStreaming", { configurable: true, get: () => true });

			manager!.register("wakeup", "wake child", async () => "child instruction", {
				ownerId: "Child",
				passive: true,
			});
			await manager!.waitForAll();
			await manager!.drainDeliveries();

			// The delivery must land in the child's REAL yield queue under a
			// registered kind and build into the agent-loop follow-up message.
			expect(subagent.yieldQueue.has("async-result")).toBe(true);
			const messages = subagent.yieldQueue.drainLazy().map(build => build());
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({
				role: "custom",
				customType: "async-result",
				content: expect.stringContaining("child instruction"),
			});
			expect(primaryEnqueue).not.toHaveBeenCalled();
		} finally {
			await subagent.dispose();
			await primary.dispose();
		}
	}, 60000);

	it("keeps a wakeup bound to its session when another top-level session replaces the Main registry entry", async () => {
		const registry = new AgentRegistry();
		const primary = await spawnTopLevelSession(undefined, registry);
		const secondary = await spawnTopLevelSession(undefined, registry);
		try {
			expect(registry.get("Main")?.session).toBe(secondary);
			const manager = AsyncJobManager.instance();
			expect(manager).toBeDefined();
			const primaryEnqueue = vi.spyOn(primary.yieldQueue, "enqueue");
			const secondaryEnqueue = vi.spyOn(secondary.yieldQueue, "enqueue");
			const wakeup = primary.getToolByName("wakeup");
			expect(wakeup).toBeDefined();

			vi.useFakeTimers();
			await wakeup!.execute("wakeup-call", {
				delaySeconds: 1,
				prompt: "Resume the primary session.",
			});
			vi.advanceTimersByTime(1_000);
			await manager!.waitForAll();
			await manager!.drainDeliveries();

			expect(primaryEnqueue).toHaveBeenCalledWith(
				"async-result",
				expect.objectContaining({ result: expect.stringContaining("Resume the primary session.") }),
			);
			expect(secondaryEnqueue).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
			await secondary.dispose();
			await primary.dispose();
		}
	}, 60000);

	it("retains a subagent wakeup in the subagent's shared-manager yield queue", async () => {
		const registry = new AgentRegistry();
		const primary = await spawnTopLevelSession(undefined, registry);
		const subagent = await spawnTopLevelSession(undefined, registry, {
			agentId: "Child",
			parentAgentId: "Main",
			parentTaskPrefix: "0",
			taskDepth: 1,
		});
		try {
			const manager = AsyncJobManager.instance();
			expect(manager).toBeDefined();
			const wakeup = subagent.getToolByName("wakeup");
			expect(wakeup).toBeDefined();
			Object.defineProperty(subagent, "isStreaming", { configurable: true, get: () => true });

			vi.useFakeTimers();
			await wakeup!.execute("wakeup-call", {
				delaySeconds: 1,
				prompt: "Resume the child session.",
			});
			vi.advanceTimersByTime(1_000);
			await manager!.waitForAll();
			await manager!.drainDeliveries();

			expect(subagent.yieldQueue.has("async-result")).toBe(true);
			const messages = subagent.yieldQueue.drainLazy().map(build => build());
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({
				role: "custom",
				customType: "async-result",
				content: expect.stringContaining("Resume the child session."),
			});
		} finally {
			vi.useRealTimers();
			await subagent.dispose();
			await primary.dispose();
		}
	}, 60000);

	it("cancels owned wakeups when disposal begins", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const manager = AsyncJobManager.instance();
			expect(manager).toBeDefined();
			const gate = Promise.withResolvers<string>();
			const jobId = manager!.register(
				"wakeup",
				"pending wakeup",
				async ({ signal }) => {
					signal.addEventListener("abort", () => gate.resolve("cancelled"), { once: true });
					return await gate.promise;
				},
				{ ownerId: "Main", passive: true },
			);

			primary.beginDispose();
			expect(manager!.getJob(jobId)?.status).toBe("cancelled");
			await manager!.getJob(jobId)?.promise;
			expect(manager!.getDeliveryState().queued).toBe(0);
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("suppresses an in-flight wakeup delivery when its session is replaced", async () => {
		const primary = await spawnTopLevelSession();
		const manager = AsyncJobManager.instance();
		expect(manager).toBeDefined();
		const deliveryStarted = Promise.withResolvers<void>();
		const releaseDelivery = Promise.withResolvers<void>();
		const enqueue = vi.spyOn(primary.yieldQueue, "enqueue");
		const jobId = manager!.register("wakeup", "expired wakeup", async () => "old-session wakeup", {
			ownerId: "Main",
			passive: true,
			onComplete: async completedJobId => {
				deliveryStarted.resolve();
				await releaseDelivery.promise;
				if (!manager!.isDeliverySuppressed(completedJobId)) {
					primary.yieldQueue.enqueue("async-result", {
						jobId: completedJobId,
						result: "old-session wakeup",
					});
				}
			},
		});

		try {
			await deliveryStarted.promise;
			await primary.newSession();
			expect(manager!.isDeliverySuppressed(jobId)).toBe(true);
			releaseDelivery.resolve();
			await manager!.drainDeliveries();
			expect(enqueue).not.toHaveBeenCalled();
		} finally {
			releaseDelivery.resolve();
			await primary.dispose();
		}
	}, 60000);

	it("clears a manager installed before a top-level session startup failure takes ownership", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-startup-failure-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				settings: Settings.isolated({ "bash.autoBackground.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry: sharedModelRegistry,
				systemPrompt: () => {
					throw new Error("forced startup failure");
				},
			}),
		).rejects.toThrow("forced startup failure");

		expect(AsyncJobManager.instance()).toBeUndefined();

		const replacement = await spawnTopLevelSession();
		try {
			expect(AsyncJobManager.instance()).toBeDefined();
			expect(replacement.getAsyncJobSnapshot()).not.toBeNull();
		} finally {
			await replacement.dispose();
		}
	}, 60000);
});
