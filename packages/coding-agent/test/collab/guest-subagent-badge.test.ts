import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import {
	type AgentSnapshot,
	COLLAB_PROTO,
	type CollabFrame,
	formatCollabLink,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import {
	countRunningSubagentBadgeAgents,
	getRunningSubagentBadgeRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/running-subagent-badge";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// In-memory transport: shared FakeWebSocket + InMemoryRelay harness (see
// ./helpers/in-memory-relay), mirroring the relay's forwarding contract.

function makeState(): Extract<CollabFrame, { t: "welcome" }>["state"] {
	return {
		isStreaming: false,
		queuedMessageCount: 0,
		sessionName: "host session",
		cwd: "/tmp",
		participants: [{ name: "Host", role: "host" }],
	};
}

function makeAgents(ids: string[]): AgentSnapshot[] {
	return ids.map((id, index) => ({
		id,
		displayName: `Remote ${index + 1}`,
		kind: "sub",
		parentId: "Main",
		status: "running",
		hasSessionFile: true,
		createdAt: 1000 + index,
		lastActivity: 2000 + index,
	}));
}

type TitleRefreshRecord = {
	options: { sessionName?: string | undefined; cwd?: string | undefined } | undefined;
	hadLoader: boolean;
	hasGuest: boolean;
};

function makeGuestContext(counts: number[], titleRefreshes: TitleRefreshRecord[]): InteractiveModeContext {
	let statusLineCount = 0;
	const ctx = {
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: { get: () => "" },
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local session",
			getCwd: () => "/local",
		},
		session: {
			messages: [],
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		},
		statusContainer: { clear: () => {}, removeChild: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		compactionLoader: undefined,
		retryLoader: undefined,
		statusLine: {
			setSubagentCount: (count: number) => {
				statusLineCount = count;
			},
			get subagentCount() {
				return statusLineCount;
			},
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: { handleEvent: () => Promise.resolve() },
		refreshTerminalTitle: (options?: { sessionName?: string | undefined; cwd?: string | undefined }) => {
			titleRefreshes.push({
				options,
				hadLoader: ctx.loadingAnimation !== undefined,
				hasGuest: ctx.collabGuest !== undefined,
			});
		},
		syncRunningSubagentBadge: () => {
			const registry = getRunningSubagentBadgeRegistry(ctx.collabGuest);
			const count = countRunningSubagentBadgeAgents(registry);
			ctx.statusLine.setSubagentCount(count);
			counts.push(count);
		},
	} as unknown as InteractiveModeContext;
	return ctx;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

describe("collab guest running-subagents badge", () => {
	it("uses the guest mirror registry and refreshes on join, resnapshot, and leave", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const roomId = "badge-room-1";
		const roomKey = generateRoomKey();
		const cryptoKey = await importRoomKey(roomKey);
		const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
		const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
		const hostOpen = Promise.withResolvers<void>();
		let nextWelcomeAgents = makeAgents(["remote-one"]);
		const sendWelcome = (agents: AgentSnapshot[]) => {
			hostSocket.send({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "remote-session", timestamp: "2026-06-26T00:00:00Z", cwd: "/tmp" },
				state: makeState(),
				agents,
				entryCount: 0,
			});
		};
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t === "hello") sendWelcome(nextWelcomeAgents);
		};
		hostSocket.connect();
		await hostOpen.promise;

		const counts: number[] = [];
		const titleRefreshes: TitleRefreshRecord[] = [];
		const ctx = makeGuestContext(counts, titleRefreshes);
		const guest = new CollabGuestLink(ctx);

		try {
			await guest.join(link);
			expect(ctx.collabGuest).toBe(guest);
			expect(counts).toEqual([0, 1]);
			expect(ctx.statusLine.subagentCount).toBe(1);
			expect(titleRefreshes).toEqual([
				{ options: { sessionName: "host session", cwd: "/tmp" }, hadLoader: false, hasGuest: false },
				{ options: { sessionName: "host session", cwd: "/tmp" }, hadLoader: false, hasGuest: true },
			]);

			let stoppedLoader = false;
			const stateRefresh = Promise.withResolvers<void>();
			const recordRefresh = ctx.refreshTerminalTitle.bind(ctx);
			ctx.refreshTerminalTitle = options => {
				recordRefresh(options);
				stateRefresh.resolve();
			};
			ctx.loadingAnimation = {
				stop: () => {
					stoppedLoader = true;
				},
			} as unknown as typeof ctx.loadingAnimation;
			hostSocket.send({ t: "state", state: { ...makeState(), sessionName: "renamed host", cwd: "/renamed" } });
			await stateRefresh.promise;
			expect(stoppedLoader).toBe(true);
			expect(guest.terminalTitleOptions).toEqual({ sessionName: "renamed host", cwd: "/renamed" });
			expect(titleRefreshes.at(-1)).toEqual({
				options: { sessionName: "renamed host", cwd: "/renamed" },
				hadLoader: false,
				hasGuest: true,
			});

			let autoCompactionStopped = false;
			let compactionStopped = false;
			let retryStopped = false;
			let hadMaintenanceLoaderAtRefresh = true;
			ctx.autoCompactionLoader = {
				stop: () => {
					autoCompactionStopped = true;
				},
			} as unknown as typeof ctx.autoCompactionLoader;
			ctx.compactionLoader = {
				stop: () => {
					compactionStopped = true;
				},
			} as unknown as typeof ctx.compactionLoader;
			ctx.retryLoader = {
				stop: () => {
					retryStopped = true;
				},
			} as unknown as typeof ctx.retryLoader;
			const recordSnapshotRefresh = ctx.refreshTerminalTitle.bind(ctx);
			ctx.refreshTerminalTitle = options => {
				hadMaintenanceLoaderAtRefresh = Boolean(
					ctx.autoCompactionLoader || ctx.compactionLoader || ctx.retryLoader,
				);
				recordSnapshotRefresh(options);
			};

			nextWelcomeAgents = makeAgents(["remote-one", "remote-two"]);
			const secondSnapshot = Promise.withResolvers<void>();
			const originalSync = ctx.syncRunningSubagentBadge.bind(ctx);
			ctx.syncRunningSubagentBadge = () => {
				originalSync();
				if (ctx.statusLine.subagentCount === 2) secondSnapshot.resolve();
			};
			sendWelcome(nextWelcomeAgents);
			await secondSnapshot.promise;
			expect(ctx.statusLine.subagentCount).toBe(2);
			expect(autoCompactionStopped).toBe(true);
			expect(compactionStopped).toBe(true);
			expect(retryStopped).toBe(true);
			expect(ctx.autoCompactionLoader).toBeUndefined();
			expect(ctx.compactionLoader).toBeUndefined();
			expect(ctx.retryLoader).toBeUndefined();
			expect(hadMaintenanceLoaderAtRefresh).toBe(false);
			expect(titleRefreshes).toEqual([
				{ options: { sessionName: "host session", cwd: "/tmp" }, hadLoader: false, hasGuest: false },
				{ options: { sessionName: "host session", cwd: "/tmp" }, hadLoader: false, hasGuest: true },
				{ options: { sessionName: "renamed host", cwd: "/renamed" }, hadLoader: false, hasGuest: true },
				{ options: { sessionName: "host session", cwd: "/tmp" }, hadLoader: false, hasGuest: true },
			]);

			await guest.leave("test cleanup");
			expect(ctx.collabGuest).toBeUndefined();
			expect(ctx.statusLine.subagentCount).toBe(0);
			expect(counts.at(-1)).toBe(0);
			expect(titleRefreshes).toEqual([
				{ options: { sessionName: "host session", cwd: "/tmp" }, hadLoader: false, hasGuest: false },
				{ options: { sessionName: "host session", cwd: "/tmp" }, hadLoader: false, hasGuest: true },
				{ options: { sessionName: "renamed host", cwd: "/renamed" }, hadLoader: false, hasGuest: true },
				{ options: { sessionName: "host session", cwd: "/tmp" }, hadLoader: false, hasGuest: true },
				{ options: undefined, hadLoader: false, hasGuest: false },
			]);
		} finally {
			hostSocket.close();
			writeSpy.mockRestore();
			await guest.leave("test cleanup").catch(() => {});
		}
	});
});
