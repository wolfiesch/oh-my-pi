import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decodeServerFrame,
	entryId,
	hostId,
	projectId,
	type ServerFrame,
	sessionId,
	type UsageReadResult,
} from "@oh-my-pi/app-wire";
import { appserverLockCheck } from "../../coding-agent/src/session/appserver-authority";
import { inspectSessionLock } from "../../coding-agent/src/session/session-lock";
import { stableProjectId } from "../src/discovery.ts";
import type { DesktopOperationsAuthority } from "../src/operations/dispatcher.ts";
import type { PendingPromptProjection } from "../src/projection.ts";
import { BunRpcChildFactory } from "../src/rpc-child.ts";
import { createAppserver, type LocalAppserver } from "../src/server.ts";
import type {
	AppserverUsageAuthority,
	ChildHandle,
	Clock,
	RpcChildFactory,
	SessionAuthority,
	SessionDiscovery,
	SessionRecord,
} from "../src/types.ts";
import { frameBytes, RawUdsWebSocket } from "./raw-uds-client.ts";

const host = hostId("live-test-host");
const epoch = "live-test-epoch";
const stamp = "2026-01-01T00:00:00.000Z";
const RPC_LOCK_CHILD = join(import.meta.dir, "fixtures", "rpc-lock-child.ts");
const sid = (value: string) => sessionId(value);
const rid = (value: string) => value as never;
const promptTransientId = (commandId: string) =>
	`user:${createHash("sha256").update(commandId).digest("hex").slice(0, 32)}`;
function decodePendingPrompts(value: unknown): PendingPromptProjection[] {
	if (!Array.isArray(value)) throw new Error("pending prompt projection is not an array");
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item))
			throw new Error(`pending prompt projection ${index} is not an object`);
		const candidate = item as Record<string, unknown>;
		if (
			typeof candidate.entryId !== "string" ||
			typeof candidate.text !== "string" ||
			typeof candidate.attachmentCount !== "number" ||
			typeof candidate.at !== "string"
		)
			throw new Error(`pending prompt projection ${index} is malformed`);
		return {
			entryId: candidate.entryId,
			text: candidate.text,
			attachmentCount: candidate.attachmentCount,
			at: candidate.at,
		};
	});
}
function pendingPromptTexts(value: unknown): string[] {
	return decodePendingPrompts(value).map(item => item.text);
}
function record(id: string): SessionRecord {
	return {
		sessionId: sid(id),
		path: `/tmp/${id}.jsonl`,
		cwd: "/tmp",
		projectId: projectId("project-test"),
		title: id,
		updatedAt: stamp,
		status: "idle",
		entries: [],
	};
}
function transcript(id: string, title = "Session"): string {
	return `${JSON.stringify({ type: "session", id, cwd: "/tmp", timestamp: stamp, title })}\n`;
}
async function replaceTranscript(path: string, value: string): Promise<void> {
	await writeFile(path, value, "utf8");
}
function transcriptWithEntry(id: string, title = "Session"): string {
	return `${transcript(id, title)}{"type":"message","id":"first","id":"last","parentId":null,"timestamp":"${stamp}","message":{"role":"user","content":"safe"}}\n`;
}
function hello(
	capabilities?: string[],
	authentication = false,
	requestedFeatures: string[] = ["resume"],
): Record<string, unknown> {
	return {
		v: "omp-app/1",
		type: "hello",
		protocol: { min: "omp-app/1", max: "omp-app/1" },
		client: { name: "raw-test", version: "1", build: "test", platform: "linux" },
		requestedFeatures,
		savedCursors: [],
		...(capabilities ? { capabilities: { client: capabilities } } : {}),
		...(authentication
			? { authentication: { deviceId: "device", deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }
			: {}),
	};
}
function command(
	requestId: string,
	commandId: string,
	name: string,
	session: string,
	args: Record<string, unknown>,
): Record<string, unknown> {
	return {
		v: "omp-app/1",
		type: "command",
		requestId: rid(requestId),
		commandId: rid(commandId),
		hostId: host,
		sessionId: sid(session),
		command: name,
		args,
	};
}
function hostCommand(
	requestId: string,
	commandId: string,
	name: string,
	args: Record<string, unknown>,
): Record<string, unknown> {
	return {
		v: "omp-app/1",
		type: "command",
		requestId: rid(requestId),
		commandId: rid(commandId),
		hostId: host,
		command: name,
		args,
	};
}
function confirmFrame(
	requestId: string,
	confirmationId: string,
	commandId: string,
	decision: "approve" | "deny",
	session?: string,
): Record<string, unknown> {
	return {
		v: "omp-app/1",
		type: "confirm",
		requestId: rid(requestId),
		confirmationId: rid(confirmationId),
		commandId: rid(commandId),
		hostId: host,
		...(session ? { sessionId: sid(session) } : {}),
		decision,
	};
}
class StaticDiscovery implements SessionDiscovery {
	constructor(private readonly values: SessionRecord[]) {}
	async list(): Promise<SessionRecord[]> {
		return this.values;
	}
}
class FakeAuthority implements SessionAuthority {
	readonly created = Promise.withResolvers<{ cwd: string; title?: string }>();
	readonly lifecycle: string[] = [];
	createCalls = 0;
	failLifecycle = false;
	constructor(private readonly values: SessionRecord[] = []) {}
	async list(): Promise<SessionRecord[]> {
		return this.values;
	}
	async create(cwd: string, title?: string) {
		this.createCalls += 1;
		this.created.resolve({ cwd, title });
		return { sessionId: sid("created"), path: "/tmp/created.jsonl", cwd, title, entries: [] };
	}
	async archive(session: SessionRecord, archivedAt: string): Promise<void> {
		if (this.failLifecycle) throw new Error("lifecycle failure");
		this.lifecycle.push(`archive:${session.sessionId}`);
		session.archivedAt = archivedAt;
	}
	async restore(session: SessionRecord): Promise<void> {
		if (this.failLifecycle) throw new Error("lifecycle failure");
		this.lifecycle.push(`restore:${session.sessionId}`);
		delete session.archivedAt;
	}
	async delete(session: SessionRecord): Promise<void> {
		if (this.failLifecycle) throw new Error("lifecycle failure");
		this.lifecycle.push(`delete:${session.sessionId}`);
		const index = this.values.findIndex(value => value.sessionId === session.sessionId);
		if (index >= 0) this.values.splice(index, 1);
	}
}
class Gate {
	readonly opened = Promise.withResolvers<void>();
	readonly started = Promise.withResolvers<void>();
	calls = 0;
	async lock(): Promise<void> {
		this.calls += 1;
		this.started.resolve();
		await this.opened.promise;
	}
}
type LiveChildExitMode = "graceful" | "forced" | "manual" | "throwing" | "ready-exits";
class LiveChild implements ChildHandle {
	readonly writes: string[] = [];
	readonly killed = Promise.withResolvers<void>();
	readonly killSignals: string[] = [];
	readonly #exit = Promise.withResolvers<number>();
	readonly exited = this.#exit.promise;
	readonly #lines: string[] = [];
	readonly #waiters: Array<{ resolve: (line: string | undefined) => void }> = [];
	readonly #writeWaiters: Array<{ count: number; resolve: () => void }> = [];
	readonly stdin = {
		write: (data: string) => {
			this.writes.push(data);
			for (const waiter of this.#writeWaiters.splice(0))
				if (this.writes.length >= waiter.count) waiter.resolve();
				else this.#writeWaiters.push(waiter);
		},
	};
	readonly stdout: AsyncIterable<string> = this.stream();
	readonly stderr: AsyncIterable<string> = (async function* () {})();
	constructor(
		readonly exitMode: LiveChildExitMode = "graceful",
		readonly readyGate?: Gate,
		readonly readyWatermark?: { entryCount: number; lastEntryId: string | null },
	) {}
	async *stream(): AsyncGenerator<string> {
		await this.readyGate?.lock();
		yield `${JSON.stringify({ type: "ready", ...(this.readyWatermark ? { transcriptWatermark: this.readyWatermark } : {}) })}\n`;
		if (this.exitMode === "ready-exits") {
			this.release();
			return;
		}
		while (true) {
			const line = this.#lines.shift() ?? (await this.nextLine());
			if (line === undefined) return;
			yield line;
		}
	}
	private nextLine(): Promise<string | undefined> {
		const waiter = Promise.withResolvers<string | undefined>();
		this.#waiters.push(waiter);
		return waiter.promise;
	}
	push(value: Record<string, unknown>): void {
		const line = `${JSON.stringify(value)}\n`;
		const waiter = this.#waiters.shift();
		if (waiter) waiter.resolve(line);
		else this.#lines.push(line);
	}
	kill(signal = "SIGTERM"): void {
		this.killSignals.push(signal);
		this.killed.resolve();
		if (this.exitMode === "throwing") throw new Error("synthetic kill failure");
		if (this.exitMode === "manual" || (this.exitMode === "forced" && signal !== "SIGKILL")) return;
		this.release();
	}
	release(): void {
		const waiter = this.#waiters.shift();
		waiter?.resolve(undefined);
		this.#exit.resolve(0);
	}
	async waitForWrites(count: number): Promise<void> {
		if (this.writes.length >= count) return;
		const waiter = Promise.withResolvers<void>();
		this.#writeWaiters.push({ count, resolve: waiter.resolve });
		await waiter.promise;
	}
}
class LiveFactory implements RpcChildFactory {
	readonly children: LiveChild[] = [];
	constructor(
		readonly exitMode: LiveChildExitMode = "graceful",
		readonly readyGate?: Gate,
		readonly readyWatermark?: { entryCount: number; lastEntryId: string | null },
	) {}
	spawn(): ChildHandle {
		const child = new LiveChild(this.exitMode, this.readyGate, this.readyWatermark);
		this.children.push(child);
		this.#spawned.resolve(child);
		return child;
	}
	readonly #spawned = Promise.withResolvers<LiveChild>();
	argv(path: string): string[] {
		return ["fake-omp", "--mode", "rpc", "--session", path];
	}
	async child(): Promise<LiveChild> {
		return this.children[0] ?? this.#spawned.promise;
	}
	async childAt(index: number): Promise<LiveChild> {
		while (!this.children[index]) await Bun.sleep(1);
		return this.children[index]!;
	}
}
function responseFor(child: LiveChild, command: string, success = true): void {
	const id = JSON.parse(child.writes.at(-1)!).id as string;
	child.push({
		id,
		type: "response",
		command,
		success,
		...(success ? { data: { agentInvoked: true } } : { error: "fake failure" }),
	});
}
async function waitForRpcWrite(
	child: LiveChild,
	type: string,
	startIndex = 0,
): Promise<{ frame: Record<string, unknown>; index: number }> {
	for (;;) {
		for (let index = startIndex; index < child.writes.length; index++) {
			const frame = JSON.parse(child.writes[index] ?? "{}") as Record<string, unknown>;
			if (frame.type === type) return { frame, index };
		}
		await child.waitForWrites(child.writes.length + 1);
	}
}
async function waitForRpcWriteId(
	child: LiveChild,
	type: string,
	idPrefix: string,
	startIndex = 0,
): Promise<{ frame: Record<string, unknown>; index: number }> {
	for (;;) {
		for (let index = startIndex; index < child.writes.length; index++) {
			const frame = JSON.parse(child.writes[index] ?? "{}") as Record<string, unknown>;
			if (frame.type === type && typeof frame.id === "string" && frame.id.startsWith(idPrefix))
				return { frame, index };
		}
		await child.waitForWrites(child.writes.length + 1);
	}
}
function respondState(
	child: LiveChild,
	call: Record<string, unknown>,
	overrides: Partial<{
		isStreaming: boolean;
		isCompacting: boolean;
		isPaused: boolean;
		messageCount: number;
		queuedMessageCount: number;
	}> = {},
): void {
	child.push({
		type: "response",
		id: call.id,
		command: "get_state",
		success: true,
		data: {
			isStreaming: false,
			isCompacting: false,
			isPaused: false,
			messageCount: 0,
			queuedMessageCount: 0,
			steeringMode: "one-at-a-time",
			followUpMode: "all",
			interruptMode: "wait",
			...overrides,
		},
	});
}
async function readyClient(
	path: string,
	capabilities?: string[],
	requestedFeatures?: string[],
): Promise<{
	client: RawUdsWebSocket;
	welcome: Extract<ServerFrame, { type: "welcome" }>;
	sessions: Extract<ServerFrame, { type: "sessions" }>;
}> {
	const client = await RawUdsWebSocket.connect(path);
	client.sendJson(hello(capabilities, false, requestedFeatures));
	const welcome = await client.nextServer();
	expect(welcome.type).toBe("welcome");
	const sessions = await client.nextServer();
	expect(sessions.type).toBe("sessions");
	expect(sessions).toMatchObject({ hostId: host });
	if (sessions.type !== "sessions") throw new Error("missing initial sessions inventory");
	return { client, welcome: welcome as Extract<ServerFrame, { type: "welcome" }>, sessions };
}
async function responseAndSnapshot(
	client: RawUdsWebSocket,
	requestId: string,
): Promise<[Extract<ServerFrame, { type: "response" }>, Extract<ServerFrame, { type: "snapshot" }>]> {
	const response = await client.nextServer();
	const snapshot = await client.nextServer();
	expect(response.type).toBe("response");
	expect(snapshot.type).toBe("snapshot");
	if (response.type !== "response" || snapshot.type !== "snapshot")
		throw new Error(`unexpected attach frames for ${requestId}`);
	expect(response.requestId).toBe(rid(requestId));
	return [response, snapshot];
}
async function untilResponse(
	client: RawUdsWebSocket,
	requestId: string,
): Promise<{ response: Extract<ServerFrame, { type: "response" }>; frames: ServerFrame[] }> {
	const frames: ServerFrame[] = [];
	while (true) {
		const frame = await client.nextServer();
		frames.push(frame);
		if (frame.type === "response" && frame.requestId === rid(requestId)) return { response: frame, frames };
	}
}
async function untilPong(client: RawUdsWebSocket, nonce: string): Promise<ServerFrame[]> {
	const frames: ServerFrame[] = [];
	for (;;) {
		const frame = await client.nextServer();
		frames.push(frame);
		if (frame.type === "pong" && frame.nonce === nonce) return frames;
	}
}
async function acceptedPromptPublication(
	client: RawUdsWebSocket,
	commandId: string,
	expectedText?: string,
	attachmentCount = 0,
): Promise<{ active: ServerFrame; pending: ServerFrame; transient: ServerFrame }> {
	const active = await client.nextServer();
	const pending = await client.nextServer();
	const transient = await client.nextServer();
	expect(active.type).toBe("session.delta");
	if (active.type !== "session.delta" || !active.upsert) throw new Error("missing active prompt projection");
	expect(active.upsert.status).toBe("active");
	expect(pending.type).toBe("session.delta");
	if (pending.type !== "session.delta" || !pending.upsert) throw new Error("missing pending prompt projection");
	const projected = decodePendingPrompts(pending.upsert.liveState?.pendingPrompts);
	expect(projected).toHaveLength(1);
	expect(projected[0]?.entryId).toBe(promptTransientId(commandId));
	expect(projected[0]?.attachmentCount).toBe(attachmentCount);
	if (expectedText !== undefined) expect(projected[0]?.text).toBe(expectedText);
	expect(transient.type).toBe("event");
	if (transient.type !== "event") throw new Error("missing transient prompt event");
	expect(transient.event.type).toBe("message.update");
	if (transient.event.type !== "message.update") throw new Error("missing transient prompt update");
	expect(transient.event.entryId).toBe(promptTransientId(commandId));
	expect(transient.event.attachmentCount).toBe(attachmentCount);
	if (expectedText !== undefined) expect(transient.event.text).toBe(expectedText);
	return { active, pending, transient };
}
async function untilSessionStatus(
	client: RawUdsWebSocket,
	status: "idle" | "active" | "closed",
): Promise<{ frame: Extract<ServerFrame, { type: "session.delta" }>; frames: ServerFrame[] }> {
	const frames: ServerFrame[] = [];
	for (;;) {
		const frame = await client.nextServer();
		frames.push(frame);
		if (frame.type === "session.delta" && frame.upsert?.status === status) return { frame, frames };
	}
}
async function startIdleSessionRuntime(
	client: RawUdsWebSocket,
	factory: LiveFactory,
	requestId: string,
): Promise<LiveChild> {
	client.sendJson(command(requestId, requestId, "session.state.get", "s1", {}));
	const child = await factory.child();
	await child.waitForWrites(1);
	const stateCall = JSON.parse(child.writes[0] ?? "{}") as { id?: string };
	if (!stateCall.id) throw new Error("state RPC id missing");
	child.push({
		type: "response",
		id: stateCall.id,
		command: "get_state",
		success: true,
		data: {
			isStreaming: false,
			isCompacting: false,
			isPaused: false,
			messageCount: 0,
			queuedMessageCount: 0,
			steeringMode: "one-at-a-time",
			followUpMode: "all",
			interruptMode: "wait",
		},
	});
	expect((await untilResponse(client, requestId)).response.ok).toBe(true);
	return child;
}
async function closeClients(clients: RawUdsWebSocket[]): Promise<void> {
	for (const client of clients) {
		client.destroy();
		await client.closed();
	}
}

async function liveServer(
	factory: LiveFactory,
	records = [record("s1"), record("s2")],
	ringSize = 256,
	transcriptImageRoot?: string,
	clock?: Clock,
	attentionOutcomePath?: string,
): Promise<{ appserver: LocalAppserver; root: string; path: string }> {
	const root = await mkdtemp(join(tmpdir(), "omp-appserver-live-"));
	const path = join(root, "run", "app.sock");
	const appserver = createAppserver({
		hostId: host,
		epoch,
		socketPath: path,
		discovery: new StaticDiscovery(records),
		childFactory: factory,
		ringSize,
		transcriptImageRoot,
		clock,
		attentionOutcomePath,
	});
	await appserver.start();
	return { appserver, root, path };
}

const usageSnapshot: UsageReadResult = {
	generatedAt: 1_800_000_000_000,
	reports: [
		{
			provider: "anthropic",
			fetchedAt: 1_799_999_999_000,
			limits: [
				{
					id: "five-hour",
					label: "5 Hour",
					scope: { provider: "anthropic", accountId: "account-1", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: 1_800_010_000_000 },
					amount: { usedFraction: 0.25, remainingFraction: 0.75, unit: "percent" },
					status: "ok",
				},
			],
			metadata: { email: "user@example.com", planType: "Max" },
		},
	],
	accountsWithoutUsage: [],
	capacity: {
		anthropic: [{ window: "5h", durationMs: 18_000_000, accounts: 1, usedAccounts: 0.25, remainingAccounts: 0.75 }],
	},
};

async function usageLiveServer(
	usageAuthority: AppserverUsageAuthority,
	usageReadTimeoutMs = 1_000,
): Promise<{ appserver: LocalAppserver; root: string; path: string }> {
	const root = await mkdtemp(join(tmpdir(), "omp-appserver-usage-live-"));
	const path = join(root, "run", "app.sock");
	const appserver = createAppserver({
		hostId: host,
		epoch,
		socketPath: path,
		discovery: new StaticDiscovery([]),
		childFactory: new LiveFactory(),
		usageAuthority,
		usageReadTimeoutMs,
	});
	await appserver.start();
	return { appserver, root, path };
}

describe("live Unix websocket protocol", () => {
	test("serves a typed usage snapshot only to clients granted the dedicated capability", async () => {
		let reads = 0;
		const { appserver, path, root } = await usageLiveServer({
			read: async signal => {
				expect(signal.aborted).toBe(false);
				reads += 1;
				return usageSnapshot;
			},
		});
		try {
			const denied = await readyClient(path, ["sessions.read"]);
			denied.client.sendJson(hostCommand("usage-denied", "usage-denied", "usage.read", {}));
			expect((await untilResponse(denied.client, "usage-denied")).response).toMatchObject({
				ok: false,
				error: { code: "capability_denied" },
			});

			const allowed = await readyClient(path, ["usage.read"]);
			expect(allowed.welcome.grantedCapabilities).toEqual(["usage.read"]);
			allowed.client.sendJson(hostCommand("usage-ok", "usage-ok", "usage.read", {}));
			expect((await untilResponse(allowed.client, "usage-ok")).response).toMatchObject({
				ok: true,
				result: usageSnapshot,
			});
			expect(reads).toBe(1);
			await closeClients([denied.client, allowed.client]);
		} finally {
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("fails closed when a usage authority returns secret or malformed provider data", async () => {
		const unsafe = {
			...usageSnapshot,
			reports: [
				{
					...usageSnapshot.reports[0],
					raw: { accessToken: "must-not-cross-wire" },
					metadata: { accessToken: "must-not-cross-wire" },
				},
			],
		} as unknown as UsageReadResult;
		const { appserver, path, root } = await usageLiveServer({ read: async () => unsafe });
		try {
			const connected = await readyClient(path, ["usage.read"]);
			connected.client.sendJson(hostCommand("usage-unsafe", "usage-unsafe", "usage.read", {}));
			const response = (await untilResponse(connected.client, "usage-unsafe")).response;
			expect(response).toMatchObject({ ok: false, error: { code: "usage_unavailable" } });
			expect(JSON.stringify(response)).not.toContain("must-not-cross-wire");
			await closeClients([connected.client]);
		} finally {
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("bounds a stuck usage authority by timeout and aborts an in-flight read on disconnect", async () => {
		const timedOut = Promise.withResolvers<UsageReadResult>();
		let timeoutSignal: AbortSignal | undefined;
		const timeoutServer = await usageLiveServer(
			{
				read: async signal => {
					timeoutSignal = signal;
					return timedOut.promise;
				},
			},
			10,
		);
		try {
			const connected = await readyClient(timeoutServer.path, ["usage.read"]);
			connected.client.sendJson(hostCommand("usage-timeout", "usage-timeout", "usage.read", {}));
			expect((await untilResponse(connected.client, "usage-timeout")).response).toMatchObject({
				ok: false,
				error: { code: "timeout" },
			});
			expect(timeoutSignal?.aborted).toBe(true);
			await closeClients([connected.client]);
		} finally {
			await timeoutServer.appserver.stop();
			await rm(timeoutServer.root, { recursive: true, force: true });
		}

		const started = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const disconnected = Promise.withResolvers<UsageReadResult>();
		const disconnectServer = await usageLiveServer({
			read: async signal => {
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				started.resolve();
				return disconnected.promise;
			},
		});
		try {
			const connected = await readyClient(disconnectServer.path, ["usage.read"]);
			connected.client.sendJson(hostCommand("usage-disconnect", "usage-disconnect", "usage.read", {}));
			await started.promise;
			connected.client.destroy();
			await Promise.all([connected.client.closed(), aborted.promise]);
		} finally {
			await disconnectServer.appserver.stop();
			await rm(disconnectServer.root, { recursive: true, force: true });
		}
	});

	test("ignores unknown additive client feature requests", async () => {
		const { appserver, path, root } = await liveServer(new LiveFactory());
		try {
			const connected = await readyClient(path, ["sessions.read"], ["resume", "future.client.feature"]);
			expect(connected.welcome.grantedFeatures).toEqual(["resume"]);
			await closeClients([connected.client]);
		} finally {
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("reads only attached transcript-entry images in bounded uncached chunks", async () => {
		const blobRoot = await mkdtemp(join(tmpdir(), "omp-appserver-blobs-"));
		await chmod(blobRoot, 0o700);
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.alloc(256 * 1024 + 31, 0x4a),
		]);
		const sha256 = createHash("sha256").update(png).digest("hex");
		await writeFile(join(blobRoot, sha256), png, { mode: 0o600 });
		const imageRecord = record("s1");
		imageRecord.archivedAt = stamp;
		imageRecord.entries = [
			{
				id: entryId("image-entry"),
				parentId: null,
				hostId: host,
				sessionId: sid("s1"),
				kind: "message",
				timestamp: stamp,
				data: {
					role: "user",
					text: "image",
					images: [{ sha256, mimeType: "image/png" }],
				},
			},
		];
		const { appserver, path, root } = await liveServer(new LiveFactory(), [imageRecord], 256, blobRoot);
		try {
			const connected = await readyClient(path, ["sessions.read"], ["resume", "transcript.images"]);
			expect(connected.welcome.grantedFeatures).toContain("transcript.images");
			const readArgs = { entryId: "image-entry", sha256, offset: 0 };
			connected.client.sendJson(command("before-attach", "before-attach", "session.image.read", "s1", readArgs));
			expect((await untilResponse(connected.client, "before-attach")).response).toMatchObject({
				ok: false,
				error: { code: "session_not_attached" },
			});

			connected.client.sendJson(command("attach-images", "attach-images", "session.attach", "s1", {}));
			const [, snapshot] = await responseAndSnapshot(connected.client, "attach-images");
			expect(snapshot.entries[0]?.data.images).toEqual([{ sha256, mimeType: "image/png" }]);

			connected.client.sendJson(
				command("wrong-entry", "wrong-entry", "session.image.read", "s1", {
					...readArgs,
					entryId: "another-entry",
				}),
			);
			const wrong = (await untilResponse(connected.client, "wrong-entry")).response;
			expect(wrong).toMatchObject({ ok: false, error: { code: "image_not_found" } });
			expect(JSON.stringify(wrong)).not.toContain(blobRoot);

			connected.client.sendJson(command("read-first", "reused-read", "session.image.read", "s1", readArgs));
			const first = (await untilResponse(connected.client, "read-first")).response;
			expect(first.ok).toBe(true);
			expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThan(1024 * 1024);
			const firstResult = first.result as {
				content: string;
				nextOffset: number;
				complete: boolean;
			};
			expect(firstResult.complete).toBe(false);
			expect(Buffer.from(firstResult.content, "base64")).toEqual(png.subarray(0, 256 * 1024));

			connected.client.sendJson(
				command("read-second", "reused-read", "session.image.read", "s1", {
					...readArgs,
					offset: firstResult.nextOffset,
				}),
			);
			const second = (await untilResponse(connected.client, "read-second")).response;
			expect(second.ok).toBe(true);
			const secondResult = second.result as { content: string; nextOffset: number; complete: boolean };
			expect(secondResult.complete).toBe(true);
			expect(secondResult.nextOffset).toBe(png.byteLength);
			expect(Buffer.from(secondResult.content, "base64")).toEqual(png.subarray(firstResult.nextOffset));
			await closeClients([connected.client]);
		} finally {
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
			await rm(blobRoot, { recursive: true, force: true });
		}
	});

	test("keeps managed image spools through disconnect until the child acknowledges reading them", async () => {
		const factory = new LiveFactory();
		const { appserver, path, root } = await liveServer(factory, [record("s1")]);
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
		const sha256 = createHash("sha256").update(png).digest("hex");
		const unnegotiated = await readyClient(path, ["sessions.read", "sessions.prompt"], ["resume"]);
		unnegotiated.client.sendJson(
			command("image-denied", "image-denied", "session.image.begin", "s1", {
				mimeType: "image/png",
				size: png.byteLength,
				sha256,
			}),
		);
		expect((await untilResponse(unnegotiated.client, "image-denied")).response).toMatchObject({
			ok: false,
			error: { code: "UNSUPPORTED_FEATURE", details: { feature: "prompt.images" } },
		});
		unnegotiated.client.sendJson(
			command("image-prompt-denied", "image-prompt-denied", "session.prompt", "s1", {
				message: "image",
				images: [{ imageId: "123e4567-e89b-42d3-a456-426614174000" }],
			}),
		);
		expect((await untilResponse(unnegotiated.client, "image-prompt-denied")).response).toMatchObject({
			ok: false,
			error: { code: "UNSUPPORTED_FEATURE", details: { feature: "prompt.images" } },
		});
		await closeClients([unnegotiated.client]);

		const connected = await readyClient(path, ["sessions.read", "sessions.prompt"], ["resume", "prompt.images"]);
		expect(connected.welcome.grantedFeatures).toContain("prompt.images");
		connected.client.sendJson(command("attach-image-prompt", "attach-image-prompt", "session.attach", "s1", {}));
		await responseAndSnapshot(connected.client, "attach-image-prompt");
		connected.client.sendJson(
			command("image-begin", "image-begin", "session.image.begin", "s1", {
				mimeType: "image/png",
				size: png.byteLength,
				sha256,
			}),
		);
		const begin = (await untilResponse(connected.client, "image-begin")).response;
		expect(begin.ok).toBe(true);
		const imageId = (begin.result as { imageId?: string } | undefined)?.imageId;
		if (!imageId) throw new Error("image begin response omitted imageId");
		const spool = join(`${path}.images`, imageId);
		expect((await stat(spool)).mode & 0o777).toBe(0o600);

		connected.client.sendJson(
			command("image-chunk", "image-chunk", "session.image.chunk", "s1", {
				imageId,
				offset: 0,
				content: png.toString("base64"),
			}),
		);
		expect((await untilResponse(connected.client, "image-chunk")).response).toMatchObject({
			ok: true,
			result: { imageId, received: png.byteLength, complete: true },
		});
		connected.client.sendJson(
			command("discard-begin", "discard-begin", "session.image.begin", "s1", {
				mimeType: "image/png",
				size: png.byteLength,
				sha256,
			}),
		);
		const discardBegin = (await untilResponse(connected.client, "discard-begin")).response;
		const discardId = (discardBegin.result as { imageId?: string } | undefined)?.imageId;
		if (!discardId) throw new Error("discard fixture omitted imageId");
		connected.client.sendJson(
			command("image-discard", "image-discard", "session.image.discard", "s1", { imageId: discardId }),
		);
		expect((await untilResponse(connected.client, "image-discard")).response).toMatchObject({
			ok: true,
			result: { discarded: true },
		});
		connected.client.sendJson(
			command("image-discard-again", "image-discard-again", "session.image.discard", "s1", {
				imageId: discardId,
			}),
		);
		expect((await untilResponse(connected.client, "image-discard-again")).response).toMatchObject({
			ok: true,
			result: { discarded: false },
		});

		connected.client.sendJson(
			command("image-prompt", "image-prompt", "session.prompt", "s1", {
				message: "",
				images: [{ imageId }],
			}),
		);
		const child = await factory.child();
		await child.waitForWrites(1);
		const publication = await acceptedPromptPublication(connected.client, "image-prompt", "", 1);
		expect(JSON.stringify(publication)).not.toContain(imageId);
		expect(JSON.stringify(publication)).not.toContain(sha256);
		expect(JSON.stringify(publication)).not.toContain(png.toString("base64"));
		const childPrompt = JSON.parse(child.writes[0] ?? "{}") as Record<string, unknown>;
		expect(childPrompt).toMatchObject({
			type: "prompt",
			message: "",
			appImageRefs: [{ imageId, mimeType: "image/png", size: png.byteLength, sha256 }],
		});
		expect(JSON.stringify(childPrompt)).not.toContain(png.toString("base64"));
		expect(await readFile(spool)).toEqual(png);

		connected.client.destroy();
		await connected.client.closed();
		await Bun.sleep(5);
		expect(await readFile(spool)).toEqual(png);
		responseFor(child, "prompt");
		let removed = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				await stat(spool);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					removed = true;
					break;
				}
				throw error;
			}
			await Bun.sleep(5);
		}
		expect(removed).toBe(true);
		await appserver.stop();
		await rm(root, { recursive: true, force: true });
	});
	test("scopes image command idempotency to each connection across reconnects", async () => {
		const { appserver, path, root } = await liveServer(new LiveFactory(), [record("s1")]);
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
		const sha256 = createHash("sha256").update(png).digest("hex");
		const args = { mimeType: "image/png", size: png.byteLength, sha256 };
		try {
			const first = await readyClient(path, ["sessions.read", "sessions.prompt"], ["resume", "prompt.images"]);
			first.client.sendJson(command("first-begin", "reused-begin", "session.image.begin", "s1", args));
			const firstBegin = (await untilResponse(first.client, "first-begin")).response;
			const firstImageId = (firstBegin.result as { imageId?: string } | undefined)?.imageId;
			if (!firstImageId) throw new Error("first image begin response omitted imageId");
			first.client.sendJson(
				command("first-chunk", "reused-chunk", "session.image.chunk", "s1", {
					imageId: firstImageId,
					offset: 0,
					content: png.toString("base64"),
				}),
			);
			expect((await untilResponse(first.client, "first-chunk")).response).toMatchObject({ ok: true });
			first.client.sendJson(
				command("first-discard", "reused-discard", "session.image.discard", "s1", {
					imageId: firstImageId,
				}),
			);
			expect((await untilResponse(first.client, "first-discard")).response).toMatchObject({
				ok: true,
				result: { discarded: true },
			});
			await closeClients([first.client]);

			const second = await readyClient(path, ["sessions.read", "sessions.prompt"], ["resume", "prompt.images"]);
			second.client.sendJson(command("second-begin", "reused-begin", "session.image.begin", "s1", args));
			const secondBegin = (await untilResponse(second.client, "second-begin")).response;
			const secondImageId = (secondBegin.result as { imageId?: string } | undefined)?.imageId;
			if (!secondImageId) throw new Error("second image begin response omitted imageId");
			expect(secondImageId).not.toBe(firstImageId);
			second.client.sendJson(
				command("second-chunk", "reused-chunk", "session.image.chunk", "s1", {
					imageId: secondImageId,
					offset: 0,
					content: png.toString("base64"),
				}),
			);
			expect((await untilResponse(second.client, "second-chunk")).response).toMatchObject({
				ok: true,
				result: { imageId: secondImageId, complete: true },
			});
			second.client.sendJson(
				command("second-discard", "reused-discard", "session.image.discard", "s1", {
					imageId: secondImageId,
				}),
			);
			expect((await untilResponse(second.client, "second-discard")).response).toMatchObject({
				ok: true,
				result: { discarded: true },
			});
			await closeClients([second.client]);
		} finally {
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});
	test("local transport rejects device authentication without echoing the token", async () => {
		const { appserver, path } = await liveServer(new LiveFactory(), []);
		const client = await RawUdsWebSocket.connect(path);
		client.sendJson(hello(undefined, true));
		const frame = await client.nextServer();
		expect(frame.type).toBe("error");
		expect(JSON.stringify(frame)).not.toContain("AAAAAAAA");
		await client.closed();
		await appserver.stop();
	});
	test("two clients negotiate capabilities, attach with one snapshot, and reject duplicate hello", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory);
		const readOnly = await readyClient(path, ["sessions.read"]);
		const promptClient = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		expect(readOnly.welcome.grantedCapabilities).toEqual(["sessions.read"]);
		expect(promptClient.welcome.grantedCapabilities).toEqual(["sessions.read", "sessions.prompt"]);
		readOnly.client.sendJson(command("attach-ro", "attach-ro", "session.attach", "s1", {}));
		const [attach] = await responseAndSnapshot(readOnly.client, "attach-ro");
		expect(attach.ok).toBe(true);
		expect(factory.children).toHaveLength(0);
		promptClient.client.sendJson(hello(["sessions.read"]));
		const duplicate = await promptClient.client.nextOrClose();
		expect(duplicate?.opcode).toBe(0x1);
		if (duplicate?.opcode === 0x1)
			expect(decodeServerFrame(new TextDecoder().decode(duplicate.payload)).type).toBe("error");
		await promptClient.client.closed();
		await closeClients([readOnly.client]);
		await appserver.stop();
	});
	test("a slow first client cannot delay ordered index or prompt publication to a fast second client", async () => {
		const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
		const port = reserved.port;
		reserved.stop(true);
		if (!port) throw new Error("failed to reserve a remote listener port");

		const factory = new LiveFactory();
		let releaseDelta = Promise.withResolvers<void>();
		let delayedDelta = Promise.withResolvers<void>();
		let holdDelta = false;
		const root = await mkdtemp(join(tmpdir(), "omp-index-order-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			discovery: new StaticDiscovery([record("s1")]),
			childFactory: factory,
			remoteEndpoint: {
				address: "127.0.0.1",
				port,
				serveProxy: true,
				trustedServeProxy: true,
			},
			remotePolicy: {
				authenticate: async () => ({ authenticated: true, grantedCapabilities: ["sessions.read"] }),
				authorize: async () => true,
				transformOutbound: async (_connection, frame) => {
					if (holdDelta && frame.type === "session.delta") {
						delayedDelta.resolve();
						await releaseDelta.promise;
					}
					return frame;
				},
			},
		});
		let observer: WebSocket | undefined;
		let owner: RawUdsWebSocket | undefined;
		try {
			await appserver.start();
			const observerReady = Promise.withResolvers<void>();
			let observerFrames = 0;
			observer = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, {
				headers: {
					"Tailscale-Node-ID": "observer-node",
					"Tailscale-Node-Name": "observer",
					"Tailscale-User-Login": "observer@example.com",
					"Tailscale-Client-IP": "100.64.0.2",
				},
				perMessageDeflate: false,
			});
			observer.addEventListener("open", () => observer?.send(JSON.stringify(hello(["sessions.read"]))));
			observer.addEventListener("error", () => observerReady.reject(new Error("remote observer failed")));
			observer.addEventListener("message", () => {
				observerFrames++;
				if (observerFrames === 2) observerReady.resolve();
			});
			await observerReady.promise;

			const readyOwner = await readyClient(appserver.socketPath, [
				"sessions.read",
				"sessions.manage",
				"sessions.prompt",
			]);
			owner = readyOwner.client;
			owner.sendJson(command("attach-model-owner", "attach-model-owner", "session.attach", "s1", {}));
			const [, snapshot] = await responseAndSnapshot(owner, "attach-model-owner");
			holdDelta = true;
			owner.sendJson({
				...command("set-model", "set-model", "session.model.set", "s1", {
					selector: "xai-oauth/grok-4.5",
					persistence: "session",
				}),
				expectedRevision: snapshot.revision,
			});

			const child = await factory.child();
			await child.waitForWrites(1);
			const setModel = JSON.parse(child.writes[0] ?? "{}") as { id?: string; type?: string };
			expect(setModel.type).toBe("set_model");
			if (!setModel.id) throw new Error("set_model RPC id missing");
			child.push({ type: "response", id: setModel.id, command: "set_model", success: true, data: {} });
			await child.waitForWrites(2);
			const getState = JSON.parse(child.writes[1] ?? "{}") as { id?: string; type?: string };
			expect(getState.type).toBe("get_state");
			if (!getState.id) throw new Error("get_state RPC id missing");
			child.push({
				type: "response",
				id: getState.id,
				command: "get_state",
				success: true,
				data: {
					isStreaming: false,
					isCompacting: false,
					isPaused: false,
					messageCount: 0,
					queuedMessageCount: 0,
					steeringMode: "one-at-a-time",
					followUpMode: "all",
					interruptMode: "wait",
					model: {
						id: "grok-4.5",
						provider: "xai-oauth",
						name: "Grok 4.5",
						selector: "xai-oauth/grok-4.5",
					},
				},
			});
			await delayedDelta.promise;
			releaseDelta.resolve();

			const changed = await untilResponse(owner, "set-model");
			expect(changed.frames.map(frame => frame.type)).toEqual(["session.delta", "response"]);
			expect(changed.frames[0]).toMatchObject({
				type: "session.delta",
				upsert: { model: "xai-oauth/grok-4.5" },
			});
			expect(changed.response).toMatchObject({ ok: true, result: { accepted: true } });

			releaseDelta = Promise.withResolvers<void>();
			delayedDelta = Promise.withResolvers<void>();
			holdDelta = true;
			owner.sendJson(command("ordered-prompt", "ordered-prompt", "session.prompt", "s1", { message: "ordered" }));
			const promptWrite = await waitForRpcWrite(child, "prompt", 2);
			await delayedDelta.promise;
			const active = await owner.nextServer();
			const pending = await owner.nextServer();
			const transient = await owner.nextServer();
			expect(active.type).toBe("session.delta");
			if (active.type !== "session.delta" || !active.upsert) throw new Error("ordered prompt active delta missing");
			expect(active.upsert.status).toBe("active");
			expect(pending.type).toBe("session.delta");
			if (pending.type !== "session.delta" || !pending.upsert)
				throw new Error("ordered prompt pending delta missing");
			expect(decodePendingPrompts(pending.upsert.liveState?.pendingPrompts)[0]?.text).toBe("ordered");
			expect(transient.type).toBe("event");
			if (transient.type !== "event") throw new Error("ordered prompt transient missing");
			expect(transient.event.type).toBe("message.update");
			releaseDelta.resolve();
			holdDelta = false;
			child.push({
				type: "response",
				id: promptWrite.frame.id,
				command: "prompt",
				success: true,
				data: { agentInvoked: false },
			});
			expect((await untilResponse(owner, "ordered-prompt")).response.ok).toBe(true);
			const terminalState = await waitForRpcWriteId(child, "get_state", "ordered-prompt:terminal:state");
			respondState(child, terminalState.frame);
			await untilSessionStatus(owner, "idle");
		} finally {
			releaseDelta.resolve();
			owner?.destroy();
			observer?.close();
			await appserver.stop();
		}
	});
	test("builds attach output before acknowledging success", async () => {
		const normal = record("normal");
		const fragile = record("fragile");
		const fragileData: Record<string, unknown> = { text: "fragile transcript entry" };
		fragile.entries = [
			{
				id: entryId("fragile-entry"),
				parentId: null,
				hostId: host,
				sessionId: sid("fragile"),
				kind: "message",
				timestamp: stamp,
				data: fragileData,
			},
		];
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [normal, fragile]);
		fragileData.unsupported = 1n;
		const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);

		client.client.sendJson(command("attach-normal", "attach-normal", "session.attach", "normal", {}));
		const normalFrames = [await client.client.nextServer(), await client.client.nextServer()];
		expect(normalFrames.map(frame => frame.type)).toEqual(["response", "snapshot"]);
		expect(normalFrames[0]).toMatchObject({ requestId: rid("attach-normal"), ok: true });
		client.client.sendJson(command("grow-normal", "grow-normal", "session.prompt", "normal", { message: "grow" }));
		const child = await factory.child();
		await child.waitForWrites(1);
		child.push({
			type: "session_entry",
			entry: {
				id: "grown-entry",
				parentId: null,
				type: "message",
				timestamp: stamp,
				message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "grown" }] },
			},
		});
		responseFor(child, "prompt");
		const grown = await untilResponse(client.client, "grow-normal");
		expect(grown.frames.some(frame => frame.type === "entry" && frame.entry.id === entryId("grown-entry"))).toBe(
			true,
		);
		client.client.sendJson(command("attach-normal-retry", "attach-normal", "session.attach", "normal", {}));
		const retriedFrames = [await client.client.nextServer(), await client.client.nextServer()];
		expect(retriedFrames.map(frame => frame.type)).toEqual(["response", "snapshot"]);
		expect(retriedFrames[0]).toMatchObject({ requestId: rid("attach-normal-retry"), ok: true });
		if (retriedFrames[0]?.type !== "response" || retriedFrames[1]?.type !== "snapshot")
			throw new Error("expected replayed attach response and snapshot");
		expect((retriedFrames[0].result as { cursor: unknown }).cursor).toEqual(retriedFrames[1].cursor);
		expect(retriedFrames[1].entries.at(-1)?.id).toBe(entryId("grown-entry"));

		client.client.sendJson(command("attach-fragile", "attach-fragile", "session.attach", "fragile", {}));
		const failed = await client.client.nextServer();
		expect(failed).toMatchObject({
			type: "response",
			requestId: rid("attach-fragile"),
			ok: false,
			error: { code: "outcome_unknown", message: "command failed" },
		});
		client.client.sendJson({ v: "omp-app/1", type: "ping", nonce: "after-failed-attach", timestamp: stamp });
		expect(await client.client.nextServer()).toMatchObject({ type: "pong", nonce: "after-failed-attach" });

		await closeClients([client.client]);
		await appserver.stop();
	});
	test("keeps the Unix websocket connected when attach bounds a multi-megabyte session", async () => {
		const oversized = record("s1");
		oversized.entries = Array.from({ length: 1200 }, (_, index) => ({
			id: entryId(`large-${index}`),
			parentId: index === 0 ? null : entryId(`large-${index - 1}`),
			hostId: host,
			sessionId: sid("s1"),
			kind: "message",
			timestamp: stamp,
			data: { role: "assistant", text: `${"x".repeat(4096)} ${index}` },
		}));
		const { appserver, path } = await liveServer(new LiveFactory(), [oversized]);
		const client = await readyClient(path, ["sessions.read"]);
		client.client.sendJson(command("large-attach", "large-attach", "session.attach", "s1", {}));
		const [response, snapshot] = await responseAndSnapshot(client.client, "large-attach");
		expect(response.ok).toBe(true);
		expect(snapshot.entries[0]?.kind).toBe("compaction");
		expect(snapshot.entries.at(-1)?.id).toBe(entryId("large-1199"));
		client.client.sendJson({ v: "omp-app/1", type: "ping", nonce: "after-large-attach", timestamp: stamp });
		expect((await client.client.nextServer()).type).toBe("pong");
		await closeClients([client.client]);
		await appserver.stop();
	});

	test("cursor attach replays contiguous frames, while an evicted cursor gets gap and snapshot", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")], 6);
		const first = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		first.client.sendJson(command("attach-1", "attach-1", "session.attach", "s1", {}));
		await responseAndSnapshot(first.client, "attach-1");
		first.client.sendJson(command("prompt-1", "prompt-1", "session.prompt", "s1", { message: "hello" }));
		const child = await factory.child();
		await child.waitForWrites(1);
		const prompt = JSON.parse(child.writes[0] ?? "{}") as { id?: string };
		child.push({
			type: "session_entry",
			entry: {
				id: "entry-1",
				parentId: null,
				type: "message",
				timestamp: stamp,
				message: { role: "user", content: "hello", clientCorrelationId: prompt.id },
			},
		});
		child.push({ type: "turn_start" });
		child.push({ type: "turn_end" });
		child.push({ type: "agent_end", messages: [] });
		child.push({ type: "prompt_result", id: prompt.id, agentInvoked: true });
		responseFor(child, "prompt");
		const firstOutput = await untilResponse(first.client, "prompt-1");
		expect(firstOutput.frames.map(frame => frame.type)).toEqual([
			"session.delta",
			"session.delta",
			"event",
			"entry",
			"event",
			"session.delta",
			"event",
			"event",
			"event",
			"session.delta",
			"response",
		]);
		const replayClient = await readyClient(path, ["sessions.read"]);
		replayClient.client.sendJson(
			command("attach-replay", "attach-replay", "session.attach", "s1", { cursor: { epoch, seq: 0 } }),
		);
		const replayResponse = await replayClient.client.nextServer();
		const replayFrames = await Promise.all(Array.from({ length: 6 }, () => replayClient.client.nextServer()));
		expect(replayResponse.type).toBe("response");
		expect(replayFrames.map(frame => frame.type)).toEqual(["event", "entry", "event", "event", "event", "event"]);
		expect(
			replayFrames.map(frame => (frame.type === "entry" || frame.type === "event" ? frame.cursor.seq : -1)),
		).toEqual([1, 2, 3, 4, 5, 6]);
		await closeClients([first.client, replayClient.client]);
		await appserver.stop();

		const evictFactory = new LiveFactory();
		const evicted = await liveServer(evictFactory, [record("s1")], 1);
		const source = await readyClient(evicted.path, ["sessions.read", "sessions.prompt"]);
		source.client.sendJson(command("attach-e", "attach-e", "session.attach", "s1", {}));
		await responseAndSnapshot(source.client, "attach-e");
		source.client.sendJson(command("prompt-e", "prompt-e", "session.prompt", "s1", { message: "hello" }));
		const evictChild = await evictFactory.child();
		await evictChild.waitForWrites(1);
		const evictPrompt = JSON.parse(evictChild.writes[0] ?? "{}") as { id?: string };
		evictChild.push({ type: "turn_start" });
		evictChild.push({ type: "turn_end" });
		evictChild.push({ type: "agent_end", messages: [] });
		evictChild.push({ type: "prompt_result", id: evictPrompt.id, agentInvoked: true });
		responseFor(evictChild, "prompt");
		await untilResponse(source.client, "prompt-e");
		const gapClient = await readyClient(evicted.path, ["sessions.read"]);
		gapClient.client.sendJson(
			command("attach-gap", "attach-gap", "session.attach", "s1", { cursor: { epoch, seq: 0 } }),
		);
		const gapResponse = await gapClient.client.nextServer();
		const gap = await gapClient.client.nextServer();
		const snapshot = await gapClient.client.nextServer();
		expect(gapResponse.type).toBe("response");
		expect(gap.type).toBe("gap");
		expect(snapshot.type).toBe("snapshot");
		await closeClients([source.client, gapClient.client]);
		await evicted.appserver.stop();
	});

	test("capability denial precedes child start and normal prompts serialize until agent completion", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const denied = await readyClient(path, ["sessions.read"]);
		denied.client.sendJson(command("denied-a", "same-denied", "session.prompt", "s1", { message: "no" }));
		denied.client.sendJson(command("denied-b", "same-denied", "session.prompt", "s1", { message: "different" }));
		const deniedA = await denied.client.nextServer();
		const deniedB = await denied.client.nextServer();
		expect(deniedA.type).toBe("response");
		expect(deniedB.type).toBe("response");
		if (deniedA.type === "response" && deniedB.type === "response") {
			expect(deniedA.error?.code).toBe("capability_denied");
			expect(deniedB.error?.code).toBe("capability_denied");
		}
		expect(factory.children).toHaveLength(0);
		const allowed = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		allowed.client.sendJson(command("attach-allowed", "attach-allowed", "session.attach", "s1", {}));
		await responseAndSnapshot(allowed.client, "attach-allowed");
		allowed.client.sendJson(command("prompt-a", "prompt-a", "session.prompt", "s1", { message: "a" }));
		const child = await factory.child();
		await child.waitForWrites(1);
		expect(factory.children).toHaveLength(1);
		await acceptedPromptPublication(allowed.client, "prompt-a", "a");

		const promptB = command("prompt-b", "prompt-b", "session.prompt", "s1", { message: "b" });
		allowed.client.sendJson(promptB);
		const refused = await untilResponse(allowed.client, "prompt-b");
		expect(refused.response).toMatchObject({ ok: false, error: { code: "session_busy" } });
		expect(child.writes.filter(value => JSON.parse(value).type === "prompt")).toHaveLength(1);
		allowed.client.sendJson(promptB);
		const replayed = await untilResponse(allowed.client, "prompt-b");
		expect(replayed.response).toEqual(refused.response);
		expect(child.writes.filter(value => JSON.parse(value).type === "prompt")).toHaveLength(1);

		const promptA = JSON.parse(child.writes[0]!) as { id: string };
		child.push({
			type: "response",
			id: promptA.id,
			command: "prompt",
			success: true,
			data: { agentInvoked: true },
		});
		expect((await untilResponse(allowed.client, "prompt-a")).response.ok).toBe(true);
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("active");
		child.push({ type: "agent_end", messages: [] });
		child.push({ type: "prompt_result", id: promptA.id, agentInvoked: true });
		expect(await allowed.client.nextServer()).toMatchObject({ type: "event", event: { type: "agent.end" } });
		expect(await allowed.client.nextServer()).toMatchObject({
			type: "session.delta",
			upsert: { attention: { latestOutcome: { kind: "completed" } } },
		});
		expect(await allowed.client.nextServer()).toMatchObject({
			type: "event",
			event: { type: "message.discarded", reason: "completed-without-entry" },
		});
		expect((await allowed.client.nextServer()).type).toBe("session.delta");
		const terminalState = await waitForRpcWrite(child, "get_state", 3);
		respondState(child, terminalState.frame);
		expect(await allowed.client.nextServer()).toMatchObject({
			type: "session.delta",
			upsert: expect.objectContaining({ status: "idle" }),
		});

		allowed.client.sendJson(command("prompt-c", "prompt-c", "session.prompt", "s1", { message: "c" }));
		while (child.writes.filter(value => JSON.parse(value).type === "prompt").length < 2)
			await child.waitForWrites(child.writes.length + 1);
		const prompts = child.writes.map(value => JSON.parse(value)).filter(frame => frame.type === "prompt");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]?.message).toBe("c");
		await acceptedPromptPublication(allowed.client, "prompt-c", "c");
		child.push({
			type: "response",
			id: prompts[1]?.id,
			command: "prompt",
			success: true,
			data: { agentInvoked: false },
		});
		expect((await untilResponse(allowed.client, "prompt-c")).response.ok).toBe(true);
		const promptCState = await waitForRpcWriteId(child, "get_state", "prompt-c:terminal:state");
		respondState(child, promptCState.frame);
		await untilSessionStatus(allowed.client, "idle");
		await closeClients([denied.client, allowed.client]);
		await appserver.stop();
	});

	test("broadcasts index deltas host-wide while entry and subagent frames remain attached", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory);
		const s1 = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		const s2 = await readyClient(path, ["sessions.read"]);
		const unattached = await readyClient(path, ["sessions.read"]);
		s1.client.sendJson(command("attach-s1", "attach-s1", "session.attach", "s1", {}));
		await responseAndSnapshot(s1.client, "attach-s1");
		s2.client.sendJson(command("attach-s2", "attach-s2", "session.attach", "s2", {}));
		await responseAndSnapshot(s2.client, "attach-s2");
		s1.client.sendJson(command("prompt-s1", "prompt-s1", "session.prompt", "s1", { message: "event" }));
		const child = await factory.child();
		await child.waitForWrites(1);
		await acceptedPromptPublication(s1.client, "prompt-s1", "event");
		child.push({
			type: "session_entry",
			entry: {
				id: "broadcast-entry",
				parentId: null,
				type: "message",
				timestamp: stamp,
				message: { role: "user", content: "entry" },
			},
		});
		child.push({
			type: "subagent_lifecycle",
			payload: {
				id: "BroadcastWorker",
				index: 0,
				agent: "task",
				agentSource: "bundled",
				description: "Broadcast worker",
				status: "started",
				lastUpdate: 100,
			},
		});
		responseFor(child, "prompt");
		const received = await untilResponse(s1.client, "prompt-s1");
		expect(
			received.frames.some(frame => frame.type === "entry" && frame.entry.id === entryId("broadcast-entry")),
		).toBe(true);
		expect(received.frames).toContainEqual(
			expect.objectContaining({ type: "agent", agentId: "BroadcastWorker", state: "started" }),
		);
		s2.client.sendJson({ v: "omp-app/1", type: "ping", nonce: "s2", timestamp: stamp });
		unattached.client.sendJson({ v: "omp-app/1", type: "ping", nonce: "none", timestamp: stamp });
		const s2Frames = await untilPong(s2.client, "s2");
		const unattachedFrames = await untilPong(unattached.client, "none");
		expect(s2Frames).toContainEqual(
			expect.objectContaining({
				type: "session.delta",
				sessionId: "s1",
				upsert: expect.objectContaining({ status: "active" }),
			}),
		);
		expect(unattachedFrames).toContainEqual(
			expect.objectContaining({
				type: "session.delta",
				sessionId: "s1",
				upsert: expect.objectContaining({ status: "active" }),
			}),
		);
		await s1.client.close();
		await s1.client.closed();
		child.push({ type: "subagent_progress", payload: { message: "after-disconnect" } });
		s2.client.sendJson({ v: "omp-app/1", type: "ping", nonce: "s2-after", timestamp: stamp });
		expect((await s2.client.nextServer()).type).toBe("pong");
		await closeClients([s2.client, unattached.client]);
		await appserver.stop();
	});

	test("projects nested OMP records into safe flat durable entries", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		client.client.sendJson(command("attach-project", "attach-project", "session.attach", "s1", {}));
		await responseAndSnapshot(client.client, "attach-project");
		client.client.sendJson(command("prompt-project", "prompt-project", "session.prompt", "s1", { message: "go" }));
		const child = await factory.child();
		await child.waitForWrites(1);
		await acceptedPromptPublication(client.client, "prompt-project", "go");
		child.push({
			type: "session_entry",
			entry: {
				id: "init",
				parentId: null,
				type: "session_init",
				timestamp: stamp,
				systemPrompt: "hidden /home/tester/system",
				token: "secret",
			},
		});
		child.push({
			type: "session_entry",
			entry: {
				id: "hidden",
				parentId: "init",
				type: "custom_message",
				timestamp: stamp,
				display: false,
				content: "hidden custom /home/tester/private",
				authorization: "secret",
			},
		});
		child.push({
			type: "session_entry",
			entry: {
				id: "user",
				parentId: "hidden",
				type: "message",
				timestamp: stamp,
				message: { role: "user", content: "Inspect /home/tester/project" },
			},
		});
		child.push({
			type: "session_entry",
			entry: {
				id: "assistant",
				parentId: "user",
				type: "message",
				timestamp: stamp,
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "I will inspect safely." },
						{
							type: "toolCall",
							id: "call-1",
							name: "read",
							title: "Read file",
							arguments: { path: "/home/tester/project/src/app.ts", authorization: "secret" },
						},
					],
				},
			},
		});
		const beforeResult = [await client.client.nextServer(), await client.client.nextServer()];
		expect(beforeResult.every(frame => frame.type === "entry" && frame.entry.kind !== "tool-use")).toBe(true);
		child.push({
			type: "session_entry",
			entry: {
				id: "result",
				parentId: "assistant",
				type: "message",
				timestamp: stamp,
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					content: [{ type: "text", text: "contents from /home/tester/project/src/app.ts" }],
					isError: false,
				},
			},
		});
		child.push({
			type: "session_entry",
			entry: {
				id: "shown",
				parentId: "result",
				type: "custom_message",
				timestamp: stamp,
				display: true,
				attribution: "agent",
				content: "Visible note",
			},
		});
		responseFor(child, "prompt");
		const output = await untilResponse(client.client, "prompt-project");
		const entries = [...beforeResult, ...output.frames].filter(frame => frame.type === "entry");
		expect(entries.map(frame => (frame.type === "entry" ? frame.entry.kind : ""))).toEqual([
			"message",
			"message",
			"tool-use",
			"message",
		]);
		if (entries[0]?.type === "entry") expect(entries[0].entry.data).toEqual({ role: "user", text: "Inspect [path]" });
		if (entries[1]?.type === "entry")
			expect(entries[1].entry.data).toEqual({ role: "assistant", text: "", reasoning: "I will inspect safely." });
		if (entries[2]?.type === "entry")
			expect(entries[2].entry.data).toMatchObject({
				toolCallId: "call-1",
				tool: "read",
				title: "Read file",
				ok: true,
				result: { output: "contents from [path]" },
			});
		if (entries[3]?.type === "entry")
			expect(entries[3].entry.data).toEqual({ role: "assistant", text: "Visible note" });
		expect(JSON.stringify(output.frames)).not.toContain("systemPrompt");
		expect(JSON.stringify(output.frames)).not.toContain("authorization");
		expect(JSON.stringify(output.frames)).not.toContain("/home/tester");
		await closeClients([client.client]);
		await appserver.stop();
	});
	test("keeps an accepted prompt authoritative across attach and settles only its exactly correlated user entry", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const owner = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		owner.client.sendJson(command("attach-authority", "attach-authority", "session.attach", "s1", {}));
		await responseAndSnapshot(owner.client, "attach-authority");

		const message = `Inspect /home/tester/project token=plaintext ${"🙂".repeat(4_000)}`;
		owner.client.sendJson(
			command("prompt-authority", "prompt-authority-command", "session.prompt", "s1", { message }),
		);
		const child = await factory.child();
		await child.waitForWrites(1);
		const active = await owner.client.nextServer();
		const pendingDelta = await owner.client.nextServer();
		const transient = await owner.client.nextServer();
		const transientEntryId = promptTransientId("prompt-authority-command");
		expect(active).toMatchObject({
			type: "session.delta",
			upsert: expect.objectContaining({ status: "active" }),
		});
		if (pendingDelta.type !== "session.delta" || !pendingDelta.upsert)
			throw new Error("missing authoritative pending prompt");
		const pendingPrompts = pendingDelta.upsert.liveState?.pendingPrompts;
		if (!Array.isArray(pendingPrompts) || pendingPrompts.length !== 1)
			throw new Error(`pending prompt list is malformed: ${JSON.stringify(pendingDelta)}`);
		const pendingPrompt = pendingPrompts[0];
		if (!pendingPrompt || typeof pendingPrompt !== "object" || Array.isArray(pendingPrompt))
			throw new Error(`pending prompt metadata is malformed: ${JSON.stringify(pendingDelta)}`);
		expect("entryId" in pendingPrompt ? pendingPrompt.entryId : undefined).toBe(transientEntryId);
		expect("attachmentCount" in pendingPrompt ? pendingPrompt.attachmentCount : undefined).toBe(0);
		const pendingText = "text" in pendingPrompt ? pendingPrompt.text : undefined;
		const pendingAt = "at" in pendingPrompt ? pendingPrompt.at : undefined;
		expect(typeof pendingText).toBe("string");
		expect(new TextEncoder().encode(String(pendingText)).byteLength).toBeLessThanOrEqual(8 * 1024);
		expect(String(pendingText)).not.toContain("/home/tester");
		expect(String(pendingText)).not.toContain("plaintext");
		expect(typeof pendingAt).toBe("string");
		expect(new Date(String(pendingAt)).toISOString()).toBe(pendingAt);
		expect(transient).toMatchObject({
			type: "event",
			event: {
				type: "message.update",
				entryId: transientEntryId,
				role: "user",
				at: pendingAt,
			},
		});
		if (transient.type !== "event") throw new Error("missing transient prompt event");
		expect(new TextEncoder().encode(String(transient.event.text)).byteLength).toBeGreaterThan(8 * 1024);
		expect(String(transient.event.text)).not.toContain("/home/tester");
		expect(String(transient.event.text)).not.toContain("plaintext");

		const reconnected = await readyClient(path, ["sessions.read"]);
		const reconnectRef = reconnected.sessions.sessions.find(session => session.sessionId === sid("s1"));
		expect(reconnectRef?.liveState?.pendingPrompts).toEqual([pendingPrompt]);
		reconnected.client.sendJson(command("attach-reconnected", "attach-reconnected", "session.attach", "s1", {}));
		const [, reconnectSnapshot] = await responseAndSnapshot(reconnected.client, "attach-reconnected");
		expect(reconnectSnapshot.cursor).toEqual({ epoch, seq: 1 });
		expect(appserver.snapshot(sid("s1"))?.ref.liveState?.pendingPrompts).toEqual([pendingPrompt]);

		const prompt = JSON.parse(child.writes[0]!) as { id: string; message: string; type: string };
		expect(prompt).toMatchObject({ type: "prompt", message });
		child.push({ type: "response", id: prompt.id, command: "prompt", success: true, data: { agentInvoked: true } });
		expect((await untilResponse(owner.client, "prompt-authority")).response.ok).toBe(true);

		child.push({
			type: "session_entry",
			entry: {
				id: "unrelated-user",
				parentId: null,
				type: "message",
				timestamp: stamp,
				message: {
					role: "user",
					content: message,
					timestamp: 1,
					clientCorrelationId: "another-rpc-command",
				},
			},
		});
		expect(await owner.client.nextServer()).toMatchObject({ type: "entry", entry: { id: "unrelated-user" } });
		expect(appserver.snapshot(sid("s1"))?.ref.liveState?.pendingPrompts).toEqual([pendingPrompt]);

		child.push({
			type: "session_entry",
			entry: {
				id: "correlated-user",
				parentId: "unrelated-user",
				type: "message",
				timestamp: stamp,
				message: {
					role: "user",
					content: message,
					timestamp: 2,
					clientCorrelationId: prompt.id,
				},
			},
		});
		const durable = await owner.client.nextServer();
		const settled = await owner.client.nextServer();
		const cleared = await owner.client.nextServer();
		expect(durable).toMatchObject({ type: "entry", entry: { id: "correlated-user" } });
		expect(settled).toMatchObject({
			type: "event",
			event: { type: "message.settled", transientEntryId, entryId: "correlated-user" },
		});
		expect(cleared.type).toBe("session.delta");
		if (cleared.type !== "session.delta" || !cleared.upsert) throw new Error("missing pending prompt clear");
		expect(cleared.upsert.liveState?.pendingPrompts).toBeUndefined();
		expect(appserver.snapshot(sid("s1"))?.ref.liveState?.pendingPrompts).toBeUndefined();

		const replay = await readyClient(path, ["sessions.read"]);
		expect(
			replay.sessions.sessions.find(session => session.sessionId === sid("s1"))?.liveState?.pendingPrompts,
		).toBeUndefined();
		replay.client.sendJson(
			command("attach-authority-replay", "attach-authority-replay", "session.attach", "s1", {
				cursor: { epoch, seq: 0 },
			}),
		);
		const replayResponse = await replay.client.nextServer();
		const replayFrames = [
			await replay.client.nextServer(),
			await replay.client.nextServer(),
			await replay.client.nextServer(),
			await replay.client.nextServer(),
		];
		expect(replayResponse.type).toBe("response");
		expect(replayFrames.map(frame => frame.type)).toEqual(["event", "entry", "entry", "event"]);
		expect(replayFrames[0]).toMatchObject({ event: { type: "message.update", entryId: transientEntryId } });
		expect(replayFrames[3]).toMatchObject({
			event: { type: "message.settled", transientEntryId, entryId: "correlated-user" },
		});

		child.push({ type: "prompt_result", id: prompt.id, agentInvoked: true });
		await child.waitForWrites(3);
		const terminalState = JSON.parse(child.writes[2] ?? "{}") as { id?: string; type?: string };
		expect(terminalState.type).toBe("get_state");
		child.push({
			type: "response",
			id: terminalState.id,
			command: "get_state",
			success: true,
			data: {
				isStreaming: false,
				isCompacting: false,
				isPaused: false,
				messageCount: 1,
				queuedMessageCount: 0,
				steeringMode: "one-at-a-time",
				followUpMode: "all",
				interruptMode: "wait",
			},
		});
		expect(await owner.client.nextServer()).toMatchObject({
			type: "session.delta",
			upsert: expect.objectContaining({ status: "idle" }),
		});
		await closeClients([owner.client, reconnected.client, replay.client]);
		await appserver.stop();
	});

	test("keeps an accepted prompt alive across sender disconnect and settles it for a reconnecting client", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const sender = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		sender.client.sendJson(command("attach-disconnect", "attach-disconnect", "session.attach", "s1", {}));
		await responseAndSnapshot(sender.client, "attach-disconnect");
		sender.client.sendJson(
			command("prompt-disconnect", "prompt-disconnect", "session.prompt", "s1", { message: "survive" }),
		);
		const child = await factory.child();
		await child.waitForWrites(1);
		await acceptedPromptPublication(sender.client, "prompt-disconnect", "survive");
		const prompt = JSON.parse(child.writes[0] ?? "{}") as { id?: string; type?: string };
		expect(prompt.type).toBe("prompt");
		if (!prompt.id) throw new Error("disconnect prompt RPC id missing");
		sender.client.destroy();
		await sender.client.closed();

		const reconnected = await readyClient(path, ["sessions.read"]);
		const pending = reconnected.sessions.sessions.find(session => session.sessionId === sid("s1"));
		expect(decodePendingPrompts(pending?.liveState?.pendingPrompts)[0]?.text).toBe("survive");
		expect(child.writes.map(value => JSON.parse(value).type)).toEqual(["prompt"]);
		reconnected.client.sendJson(
			command("attach-reconnected", "attach-reconnected", "session.attach", "s1", {
				cursor: { epoch, seq: 0 },
			}),
		);
		expect((await reconnected.client.nextServer()).type).toBe("response");
		expect(await reconnected.client.nextServer()).toMatchObject({
			type: "event",
			event: { type: "message.update", entryId: promptTransientId("prompt-disconnect") },
		});

		child.push({
			type: "session_entry",
			entry: {
				id: "disconnect-user",
				parentId: null,
				type: "custom_message",
				timestamp: stamp,
				customType: "skill-prompt",
				content: "survive",
				display: true,
				attribution: "user",
				clientCorrelationId: prompt.id,
			},
		});
		const durable = await reconnected.client.nextServer();
		const settled = await reconnected.client.nextServer();
		const cleared = await reconnected.client.nextServer();
		expect(durable).toMatchObject({ type: "entry", entry: { id: "disconnect-user" } });
		expect(settled).toMatchObject({
			type: "event",
			event: {
				type: "message.settled",
				transientEntryId: promptTransientId("prompt-disconnect"),
				entryId: "disconnect-user",
			},
		});
		expect(cleared.type).toBe("session.delta");
		if (cleared.type !== "session.delta" || !cleared.upsert) throw new Error("disconnect pending clear missing");
		expect(cleared.upsert.liveState?.pendingPrompts).toBeUndefined();
		child.push({
			type: "response",
			id: prompt.id,
			command: "prompt",
			success: true,
			data: { agentInvoked: true },
		});
		child.push({ type: "prompt_result", id: prompt.id, agentInvoked: true });
		const terminalState = await waitForRpcWriteId(child, "get_state", `${prompt.id}:terminal:state`);
		respondState(child, terminalState.frame);
		await untilSessionStatus(reconnected.client, "idle");
		expect(child.writes.some(value => JSON.parse(value).type === "abort")).toBe(false);
		await closeClients([reconnected.client]);
		await appserver.stop();
	});

	test("discards rejected and local-only prompt transients with replay-safe terminal events", async () => {
		for (const scenario of [
			{ name: "rejected", success: false, reason: "rejected", ok: false },
			{ name: "local", success: true, reason: "local-only", ok: true },
		] as const) {
			const factory = new LiveFactory();
			const { appserver, path } = await liveServer(factory, [record("s1")]);
			const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
			client.client.sendJson(
				command(`attach-${scenario.name}`, `attach-${scenario.name}`, "session.attach", "s1", {}),
			);
			await responseAndSnapshot(client.client, `attach-${scenario.name}`);
			const commandId = `prompt-${scenario.name}-command`;
			client.client.sendJson(
				command(`prompt-${scenario.name}`, commandId, "session.prompt", "s1", { message: scenario.name }),
			);
			const child = await factory.child();
			await child.waitForWrites(1);
			expect((await client.client.nextServer()).type).toBe("session.delta");
			expect((await client.client.nextServer()).type).toBe("session.delta");
			expect(await client.client.nextServer()).toMatchObject({
				type: "event",
				event: { type: "message.update", entryId: promptTransientId(commandId) },
			});
			const prompt = JSON.parse(child.writes[0]!) as { id: string };
			child.push({
				type: "response",
				id: prompt.id,
				command: "prompt",
				success: scenario.success,
				...(scenario.success ? { data: { agentInvoked: false } } : { error: "busy" }),
			});
			const terminal = await untilResponse(client.client, `prompt-${scenario.name}`);
			expect(terminal.response.ok).toBe(scenario.ok);
			expect(terminal.frames).toContainEqual(
				expect.objectContaining({
					type: "event",
					event: expect.objectContaining({
						type: "message.discarded",
						transientEntryId: promptTransientId(commandId),
						reason: scenario.reason,
					}),
				}),
			);
			const stateCall = await waitForRpcWrite(child, "get_state", 1);
			respondState(child, stateCall.frame);
			expect(await client.client.nextServer()).toMatchObject({
				type: "session.delta",
				upsert: expect.objectContaining({ status: "idle" }),
			});
			expect(appserver.snapshot(sid("s1"))?.ref).toMatchObject({ status: "idle" });
			expect(appserver.snapshot(sid("s1"))?.ref.liveState?.pendingPrompts).toBeUndefined();

			const replay = await readyClient(path, ["sessions.read"]);
			replay.client.sendJson(
				command(`replay-${scenario.name}`, `replay-${scenario.name}`, "session.attach", "s1", {
					cursor: { epoch, seq: 0 },
				}),
			);
			expect((await replay.client.nextServer()).type).toBe("response");
			expect(await replay.client.nextServer()).toMatchObject({
				type: "event",
				event: { type: "message.update", entryId: promptTransientId(commandId) },
			});
			expect(await replay.client.nextServer()).toMatchObject({
				type: "event",
				event: {
					type: "message.discarded",
					transientEntryId: promptTransientId(commandId),
					reason: scenario.reason,
				},
			});
			await closeClients([client.client, replay.client]);
			await appserver.stop();
		}
	});

	test("translates a live RPC turn once and survives meta/future frames", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		client.client.sendJson(command("attach-pipeline", "attach-pipeline", "session.attach", "s1", {}));
		await responseAndSnapshot(client.client, "attach-pipeline");
		client.client.sendJson(command("prompt-pipeline", "prompt-pipeline", "session.prompt", "s1", { message: "go" }));
		const child = await factory.child();
		await child.waitForWrites(1);
		await acceptedPromptPublication(client.client, "prompt-pipeline", "go");
		const prompt = JSON.parse(child.writes[0] ?? "{}") as { id?: string };
		if (!prompt.id) throw new Error("pipeline prompt RPC id missing");
		child.push({ type: "turn_start" });
		child.push({
			type: "message_start",
			streamId: "assistant-stream-1",
			message: { role: "assistant", content: [] },
		});
		child.push({
			type: "message_update",
			streamId: "assistant-stream-1",
			message: {
				role: "assistant",
				timestamp: 10,
				content: [
					{ type: "thinking", thinking: "plan" },
					{ type: "text", text: "hello" },
				],
			},
		});
		child.push({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "x" } });
		child.push({ type: "tool_execution_update", toolCallId: "call-1", partialResult: "working" });
		child.push({
			type: "tool_execution_end",
			toolCallId: "call-1",
			isError: false,
			result: { content: [{ type: "text", text: "done" }] },
		});
		child.push({
			type: "message_end",
			streamId: "assistant-stream-1",
			message: {
				role: "assistant",
				timestamp: 10,
				content: [
					{ type: "thinking", thinking: "plan" },
					{ type: "text", text: "hello" },
				],
			},
		});
		child.push({
			type: "session_entry",
			entry: {
				id: "assistant-1",
				parentId: null,
				type: "message",
				timestamp: stamp,
				message: {
					role: "assistant",
					timestamp: 10,
					content: [
						{ type: "thinking", thinking: "plan" },
						{ type: "text", text: "hello" },
					],
				},
			},
		});
		child.push({ type: "message_persisted", streamId: "assistant-stream-1", entryId: "assistant-1" });
		child.push({ type: "future_frame", payload: "ignored" });
		child.push({ type: "turn_end" });
		child.push({ type: "agent_end", messages: [] });
		child.push({ type: "prompt_result", id: prompt.id, agentInvoked: true });
		child.push({ type: "response", id: prompt.id, command: "prompt", success: true, data: { agentInvoked: true } });
		const output = await untilResponse(client.client, "prompt-pipeline");
		const eventFrames = output.frames.filter(frame => frame.type === "event");
		expect(eventFrames.map(frame => (frame.type === "event" ? frame.event.type : ""))).toEqual([
			"turn.start",
			"message.update",
			"tool.start",
			"tool.progress",
			"tool.result",
			"message.settled",
			"turn.end",
			"agent.end",
			"message.discarded",
		]);
		const messageUpdateIndex = output.frames.findIndex(
			frame => frame.type === "event" && frame.event.type === "message.update",
		);
		const settledIndex = output.frames.findIndex(
			frame => frame.type === "event" && frame.event.type === "message.settled",
		);
		const durableIndex = output.frames.findIndex(frame => frame.type === "entry" && frame.entry.id === "assistant-1");
		expect(messageUpdateIndex).toBeGreaterThanOrEqual(0);
		expect(settledIndex).toBeGreaterThan(messageUpdateIndex);
		expect(durableIndex).toBeGreaterThan(messageUpdateIndex);
		expect(settledIndex).toBeGreaterThan(durableIndex);
		const messageUpdate = output.frames[messageUpdateIndex];
		const settled = output.frames[settledIndex];
		const durable = output.frames[durableIndex];
		if (messageUpdate?.type !== "event" || settled?.type !== "event" || durable?.type !== "entry")
			throw new Error("expected correlated streaming, settlement, and durable frames");
		expect(settled.event).toMatchObject({
			type: "message.settled",
			transientEntryId: messageUpdate.event.entryId,
			entryId: durable.entry.id,
		});
		const terminalState = await waitForRpcWriteId(child, "get_state", `${prompt.id}:terminal:state`);
		respondState(child, terminalState.frame);
		await untilSessionStatus(client.client, "idle");
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("idle");
		expect(eventFrames.filter(frame => frame.type === "event" && frame.event.type === "message.update")).toHaveLength(
			1,
		);
		expect(eventFrames.filter(frame => frame.type === "event" && frame.event.type === "tool.start")).toHaveLength(1);
		expect(eventFrames.filter(frame => frame.type === "event" && frame.event.type === "tool.result")).toHaveLength(1);
		expect(JSON.stringify(eventFrames)).not.toContain("future_frame");
		expect(JSON.stringify(eventFrames)).not.toContain("message_update");
		await closeClients([client.client]);
		await appserver.stop();
	});
	test("local-only prompt results return an accepted session to idle without a visible error", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		client.client.sendJson(command("attach-local", "attach-local", "session.attach", "s1", {}));
		await responseAndSnapshot(client.client, "attach-local");

		client.client.sendJson(command("prompt-local", "prompt-local", "session.prompt", "s1", { message: "/local" }));
		const child = await factory.child();
		await child.waitForWrites(1);
		await acceptedPromptPublication(client.client, "prompt-local", "/local");
		const prompt = JSON.parse(child.writes[0]!) as { id: string };
		child.push({ type: "response", id: prompt.id, command: "prompt", success: true, data: { agentInvoked: true } });
		expect((await untilResponse(client.client, "prompt-local")).response.ok).toBe(true);
		child.push({ type: "prompt_result", id: prompt.id, agentInvoked: false });
		const terminalState = await waitForRpcWriteId(child, "get_state", `${prompt.id}:terminal:state`);
		respondState(child, terminalState.frame);
		const idle = await untilSessionStatus(client.client, "idle");
		expect(idle.frames).toContainEqual(
			expect.objectContaining({ type: "event", event: expect.objectContaining({ type: "message.discarded" }) }),
		);
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("idle");

		await closeClients([client.client]);
		await appserver.stop();
	});
	test("prompt rejections and immediate local handling release the session without closing the child", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		client.client.sendJson(command("attach-rejected", "attach-rejected", "session.attach", "s1", {}));
		await responseAndSnapshot(client.client, "attach-rejected");

		client.client.sendJson(command("prompt-rejected", "prompt-rejected", "session.prompt", "s1", { message: "A" }));
		const child = await factory.child();
		await child.waitForWrites(1);
		await acceptedPromptPublication(client.client, "prompt-rejected", "A");
		const rejectedPrompt = JSON.parse(child.writes[0]!) as { id: string };
		child.push({
			type: "response",
			id: rejectedPrompt.id,
			command: "prompt",
			success: false,
			error: "busy",
		});
		const rejected = await untilResponse(client.client, "prompt-rejected");
		expect(rejected.response).toMatchObject({ ok: false, error: { code: "child_error" } });
		expect(rejected.frames).toContainEqual(
			expect.objectContaining({ type: "event", event: expect.objectContaining({ type: "message.discarded" }) }),
		);
		const rejectedState = await waitForRpcWriteId(child, "get_state", "prompt-rejected:terminal:state");
		respondState(child, rejectedState.frame);
		await untilSessionStatus(client.client, "idle");
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("idle");

		client.client.sendJson(
			command("prompt-local-response", "prompt-local-response", "session.prompt", "s1", {
				message: "B",
			}),
		);
		while (child.writes.map(value => JSON.parse(value)).filter(frame => frame.type === "prompt").length < 2)
			await child.waitForWrites(child.writes.length + 1);
		await acceptedPromptPublication(client.client, "prompt-local-response", "B");
		const secondPrompt = child.writes.map(value => JSON.parse(value)).filter(frame => frame.type === "prompt")[1];
		child.push({
			type: "response",
			id: secondPrompt.id,
			command: "prompt",
			success: true,
			data: { agentInvoked: false },
		});
		const local = await untilResponse(client.client, "prompt-local-response");
		expect(local.response).toMatchObject({ ok: true, result: { accepted: true } });
		expect(local.frames).toContainEqual(
			expect.objectContaining({ type: "event", event: expect.objectContaining({ type: "message.discarded" }) }),
		);
		const localState = await waitForRpcWriteId(child, "get_state", "prompt-local-response:terminal:state");
		respondState(child, localState.frame);
		await untilSessionStatus(client.client, "idle");
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("idle");

		client.client.sendJson(
			command("prompt-after-rejection", "prompt-after-rejection", "session.prompt", "s1", {
				message: "C",
			}),
		);
		while (child.writes.map(value => JSON.parse(value)).filter(frame => frame.type === "prompt").length < 3)
			await child.waitForWrites(child.writes.length + 1);
		expect(factory.children).toHaveLength(1);
		await closeClients([client.client]);
		await appserver.stop();
	});
	for (const staleResult of [
		{ name: "local-only result", frame: { agentInvoked: false } },
		{ name: "error result", frame: { error: "Bearer stale-secret failed at /home/tester/stale" } },
	] as const) {
		test(`a delayed A ${staleResult.name} cannot settle B`, async () => {
			const factory = new LiveFactory();
			const { appserver, path } = await liveServer(factory, [record("s1")]);
			const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
			client.client.sendJson(command("attach-correlated", "attach-correlated", "session.attach", "s1", {}));
			await responseAndSnapshot(client.client, "attach-correlated");

			client.client.sendJson(command("prompt-a", "prompt-a-correlated", "session.prompt", "s1", { message: "A" }));
			const child = await factory.child();
			await child.waitForWrites(1);
			await acceptedPromptPublication(client.client, "prompt-a-correlated", "A");
			const promptA = child.writes
				.map(value => JSON.parse(value) as Record<string, unknown>)
				.find(frame => frame.type === "prompt");
			if (typeof promptA?.id !== "string") throw new Error("prompt A RPC id missing");
			child.push({ type: "response", id: promptA.id, command: "prompt", success: true });
			expect((await untilResponse(client.client, "prompt-a")).response.ok).toBe(true);
			expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("active");
			child.push({ type: "prompt_result", id: promptA.id, agentInvoked: true });
			const terminalAState = await waitForRpcWriteId(child, "get_state", `${promptA.id}:terminal:state`);
			respondState(child, terminalAState.frame);
			await untilSessionStatus(client.client, "idle");

			client.client.sendJson(command("prompt-b", "prompt-b-correlated", "session.prompt", "s1", { message: "B" }));
			let promptB: Record<string, unknown> | undefined;
			while (!promptB) {
				promptB = child.writes
					.map(value => JSON.parse(value) as Record<string, unknown>)
					.filter(frame => frame.type === "prompt")[1];
				if (!promptB) await child.waitForWrites(child.writes.length + 1);
			}
			if (typeof promptB.id !== "string") throw new Error("prompt B RPC id missing");
			await acceptedPromptPublication(client.client, "prompt-b-correlated", "B");
			child.push({ type: "response", id: promptB.id, command: "prompt", success: true });
			expect((await untilResponse(client.client, "prompt-b")).response.ok).toBe(true);
			child.push({ type: "turn_start" });
			expect(await client.client.nextServer()).toMatchObject({ type: "event", event: { type: "turn.start" } });

			child.push({ type: "prompt_result", id: promptA.id, ...staleResult.frame });
			child.push({ type: "notice", level: "info", message: "stale-result-barrier" });
			const staleFrames: ServerFrame[] = [];
			for (;;) {
				const frame = await client.client.nextServer();
				staleFrames.push(frame);
				if (frame.type === "event" && frame.event.type === "notice") break;
			}
			expect(staleFrames.some(frame => frame.type === "event" && frame.event.type === "turn.error")).toBe(false);
			expect(staleFrames.some(frame => frame.type === "event" && frame.event.type === "message.discarded")).toBe(
				false,
			);
			expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("active");
			expect(decodePendingPrompts(appserver.snapshot(sid("s1"))?.ref.liveState?.pendingPrompts)[0]?.text).toBe("B");

			child.push({ type: "prompt_result", id: promptB.id, error: "current B failed" });
			const terminalBState = await waitForRpcWriteId(child, "get_state", `${promptB.id}:terminal:state`);
			respondState(child, terminalBState.frame);
			const current = await untilSessionStatus(client.client, "idle");
			expect(current.frames.some(frame => frame.type === "event" && frame.event.type === "turn.error")).toBe(true);
			expect(current.frames.some(frame => frame.type === "event" && frame.event.type === "turn.end")).toBe(true);
			expect(current.frames.some(frame => frame.type === "event" && frame.event.type === "message.discarded")).toBe(
				true,
			);

			client.client.sendJson({ v: "omp-app/1", type: "ping", nonce: "after-correlated-error", timestamp: stamp });
			expect(await client.client.nextServer()).toMatchObject({ type: "pong", nonce: "after-correlated-error" });

			await closeClients([client.client]);
			await appserver.stop();
		});
	}
	test("reconnects plural steer and follow-up transients and settles them out of order by exact correlation", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const owner = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		owner.client.sendJson(command("attach-queued-pair", "attach-queued-pair", "session.attach", "s1", {}));
		await responseAndSnapshot(owner.client, "attach-queued-pair");

		owner.client.sendJson(command("steer-a", "steer-a", "session.steer", "s1", { message: "steer A" }));
		const child = await factory.child();
		const steer = await waitForRpcWrite(child, "steer");
		await acceptedPromptPublication(owner.client, "steer-a", "steer A");
		child.push({ type: "response", id: steer.frame.id, command: "steer", success: true, data: {} });
		expect((await untilResponse(owner.client, "steer-a")).response.ok).toBe(true);

		owner.client.sendJson(command("follow-b", "follow-b", "session.followUp", "s1", { message: "follow B" }));
		const follow = await waitForRpcWrite(child, "follow_up", steer.index + 1);
		child.push({ type: "response", id: follow.frame.id, command: "follow_up", success: true, data: {} });
		expect((await untilResponse(owner.client, "follow-b")).response.ok).toBe(true);
		expect(pendingPromptTexts(appserver.snapshot(sid("s1"))?.ref.liveState?.pendingPrompts)).toEqual([
			"steer A",
			"follow B",
		]);
		const reconnected = await readyClient(path, ["sessions.read"]);
		expect(
			pendingPromptTexts(
				reconnected.sessions.sessions.find(session => session.sessionId === sid("s1"))?.liveState?.pendingPrompts,
			),
		).toEqual(["steer A", "follow B"]);

		if (typeof follow.frame.id !== "string" || typeof steer.frame.id !== "string")
			throw new Error("queued pair RPC ids missing");
		child.push({
			type: "session_entry",
			entry: {
				id: "follow-b-user",
				parentId: null,
				type: "message",
				timestamp: stamp,
				message: { role: "user", content: "follow B", clientCorrelationId: follow.frame.id },
			},
		});
		const followFrames = [
			await owner.client.nextServer(),
			await owner.client.nextServer(),
			await owner.client.nextServer(),
		];
		expect(followFrames.map(frame => frame.type)).toEqual(["entry", "event", "session.delta"]);
		expect(pendingPromptTexts(appserver.snapshot(sid("s1"))?.ref.liveState?.pendingPrompts)).toEqual(["steer A"]);
		child.push({
			type: "session_entry",
			entry: {
				id: "steer-a-user",
				parentId: "follow-b-user",
				type: "message",
				timestamp: stamp,
				message: { role: "user", content: "steer A", clientCorrelationId: steer.frame.id },
			},
		});
		const steerFrames = [
			await owner.client.nextServer(),
			await owner.client.nextServer(),
			await owner.client.nextServer(),
		];
		expect(steerFrames.map(frame => frame.type)).toEqual(["entry", "event", "session.delta"]);
		expect(appserver.snapshot(sid("s1"))?.ref.liveState?.pendingPrompts).toBeUndefined();
		child.push({ type: "agent_end", messages: [] });
		expect(await owner.client.nextServer()).toMatchObject({ type: "event", event: { type: "agent.end" } });
		const terminalState = await waitForRpcWriteId(child, "get_state", "agent-end:state");
		respondState(child, terminalState.frame);
		await untilSessionStatus(owner.client, "idle");
		await closeClients([owner.client, reconnected.client]);
		await appserver.stop();
	});
	test("a cancel awaiting supervisor startup never aborts a newer root", async () => {
		const readyGate = new Gate();
		const factory = new LiveFactory("graceful", readyGate);
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read", "sessions.prompt", "sessions.control"]);

		// The prompt starts the supervisor first but cannot register its lifecycle
		// until the child becomes ready.
		client.client.sendJson(command("new-root", "new-root", "session.prompt", "s1", { message: "B" }));
		const child = await factory.child();
		await readyGate.started.promise;

		client.client.sendJson(command("cancel-before-ready", "cancel-before-ready", "session.cancel", "s1", {}));
		const challenge = await client.client.nextServer();
		expect(challenge.type).toBe("confirmation");
		if (challenge.type !== "confirmation") throw new Error("cancel confirmation missing");
		client.client.sendJson(
			confirmFrame(
				"cancel-before-ready-confirm",
				String(challenge.confirmationId),
				"cancel-before-ready",
				"approve",
				"s1",
			),
		);
		// A subsequent ping is handled only after the confirm callback has entered
		// its first await, proving cancel captured the pre-prompt (undefined) root
		// and joined the delayed supervisor start before readiness is released.
		client.client.sendJson({ v: "omp-app/1", type: "ping", nonce: "cancel-awaiting-ready", timestamp: stamp });
		await untilPong(client.client, "cancel-awaiting-ready");
		readyGate.opened.resolve();

		const prompt = await waitForRpcWrite(child, "prompt");
		const cancelled = await untilResponse(client.client, "cancel-before-ready");
		expect(cancelled.response).toMatchObject({ ok: true, result: { cancelled: false } });
		expect(child.writes.map(value => JSON.parse(value)).some(frame => frame.type === "abort")).toBe(false);

		child.push({
			type: "response",
			id: prompt.frame.id,
			command: "prompt",
			success: true,
			data: { agentInvoked: true },
		});
		expect((await untilResponse(client.client, "new-root")).response.ok).toBe(true);
		await closeClients([client.client]);
		await appserver.stop();
	});
	test("routes agent cancellation only to the target session RPC child and reflects its result", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory);
		const client = await readyClient(path, ["sessions.read", "agents.control"]);
		try {
			const first = await startIdleSessionRuntime(client.client, factory, "state-s1");
			client.client.sendJson(command("state-s2", "state-s2", "session.state.get", "s2", {}));
			const second = await factory.childAt(1);
			const secondState = await waitForRpcWrite(second, "get_state");
			respondState(second, secondState.frame);
			expect((await untilResponse(client.client, "state-s2")).response.ok).toBe(true);
			client.client.sendJson(command("attach-s2", "attach-s2", "session.attach", "s2", {}));
			await responseAndSnapshot(client.client, "attach-s2");

			client.client.sendJson(command("cancel-true", "cancel-true", "agent.cancel", "s2", { agentId: "Worker" }));
			const trueChallenge = await client.client.nextServer();
			expect(trueChallenge.type).toBe("confirmation");
			if (trueChallenge.type !== "confirmation") throw new Error("agent cancel confirmation missing");
			client.client.sendJson(
				confirmFrame("cancel-true-confirm", String(trueChallenge.confirmationId), "cancel-true", "approve", "s2"),
			);
			const cancelled = await waitForRpcWrite(second, "cancel_subagent");
			expect(cancelled.frame).toMatchObject({ agentId: "Worker" });
			expect(first.writes.map(value => JSON.parse(value)).some(frame => frame.type === "cancel_subagent")).toBe(
				false,
			);
			second.push({
				type: "subagent_lifecycle",
				payload: {
					id: "Worker",
					index: 0,
					agent: "task",
					status: "aborted",
					lastUpdate: 100,
				},
			});
			second.push({
				type: "response",
				id: cancelled.frame.id,
				command: "cancel_subagent",
				success: true,
				data: { cancelled: true },
			});
			const cancelResult = await untilResponse(client.client, "cancel-true");
			expect(cancelResult.response).toMatchObject({ ok: true, result: { cancelled: true } });
			expect(cancelResult.frames).toContainEqual(
				expect.objectContaining({ type: "agent", agentId: "Worker", state: "cancelled" }),
			);

			client.client.sendJson(command("cancel-false", "cancel-false", "agent.cancel", "s2", { agentId: "Gone" }));
			const falseChallenge = await client.client.nextServer();
			expect(falseChallenge.type).toBe("confirmation");
			if (falseChallenge.type !== "confirmation") throw new Error("agent cancel confirmation missing");
			client.client.sendJson(
				confirmFrame(
					"cancel-false-confirm",
					String(falseChallenge.confirmationId),
					"cancel-false",
					"approve",
					"s2",
				),
			);
			const missing = await waitForRpcWrite(second, "cancel_subagent", cancelled.index + 1);
			second.push({
				type: "response",
				id: missing.frame.id,
				command: "cancel_subagent",
				success: true,
				data: { cancelled: false },
			});
			expect((await untilResponse(client.client, "cancel-false")).response).toMatchObject({
				ok: true,
				result: { cancelled: false },
			});

			client.client.sendJson(command("cancel-error", "cancel-error", "agent.cancel", "s2", { agentId: "Main" }));
			const errorChallenge = await client.client.nextServer();
			expect(errorChallenge.type).toBe("confirmation");
			if (errorChallenge.type !== "confirmation") throw new Error("agent cancel confirmation missing");
			client.client.sendJson(
				confirmFrame(
					"cancel-error-confirm",
					String(errorChallenge.confirmationId),
					"cancel-error",
					"approve",
					"s2",
				),
			);
			const rejected = await waitForRpcWrite(second, "cancel_subagent", missing.index + 1);
			second.push({
				type: "response",
				id: rejected.frame.id,
				command: "cancel_subagent",
				success: false,
				error: "only subagents can be cancelled",
			});
			expect((await untilResponse(client.client, "cancel-error")).response).toMatchObject({
				ok: false,
				error: { code: "child_error" },
			});
		} finally {
			await closeClients([client.client]);
			await appserver.stop();
		}
	});
	test("keeps agent cancellation durable across requester disconnect", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory);
		const sender = await readyClient(path, ["sessions.read", "agents.control"]);
		let reconnectedClient: RawUdsWebSocket | undefined;
		try {
			const child = await startIdleSessionRuntime(sender.client, factory, "state-s1");
			sender.client.sendJson(
				command("cancel-disconnect", "cancel-disconnect", "agent.cancel", "s1", { agentId: "Worker" }),
			);
			const challenge = await sender.client.nextServer();
			expect(challenge.type).toBe("confirmation");
			if (challenge.type !== "confirmation") throw new Error("agent cancel confirmation missing");
			sender.client.sendJson(
				confirmFrame(
					"cancel-disconnect-confirm",
					String(challenge.confirmationId),
					"cancel-disconnect",
					"approve",
					"s1",
				),
			);
			const cancelled = await waitForRpcWrite(child, "cancel_subagent");
			sender.client.destroy();
			await sender.client.closed();

			child.push({
				type: "subagent_lifecycle",
				payload: {
					id: "Worker",
					index: 0,
					agent: "task",
					status: "aborted",
					lastUpdate: 100,
				},
			});
			child.push({
				type: "response",
				id: cancelled.frame.id,
				command: "cancel_subagent",
				success: true,
				data: { cancelled: true },
			});

			reconnectedClient = (await readyClient(path, ["sessions.read", "agents.control"])).client;
			reconnectedClient.sendJson(
				command("cancel-disconnect", "cancel-disconnect", "agent.cancel", "s1", {
					agentId: "Worker",
				}),
			);
			const replayChallenge = await reconnectedClient.nextServer();
			expect(replayChallenge.type).toBe("confirmation");
			if (replayChallenge.type !== "confirmation") throw new Error("agent cancel replay confirmation missing");
			reconnectedClient.sendJson(
				confirmFrame(
					"cancel-disconnect-replay-confirm",
					String(replayChallenge.confirmationId),
					"cancel-disconnect",
					"approve",
					"s1",
				),
			);
			expect(await reconnectedClient.nextServer()).toMatchObject({
				type: "response",
				requestId: rid("cancel-disconnect"),
				ok: true,
				result: { cancelled: true },
			});
			expect(child.writes.filter(value => JSON.parse(value).type === "cancel_subagent")).toHaveLength(1);
		} finally {
			sender.client.destroy();
			if (reconnectedClient) await closeClients([reconnectedClient]);
			await appserver.stop();
		}
	});
	test("cancelling root A preserves a queued cross-client follow-up B until its exact durable entry", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const owner = await readyClient(path, ["sessions.read", "sessions.prompt", "sessions.control"]);
		const queueClient = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		owner.client.sendJson(command("attach-cancel-owner", "attach-cancel-owner", "session.attach", "s1", {}));
		await responseAndSnapshot(owner.client, "attach-cancel-owner");
		queueClient.client.sendJson(command("attach-cancel-queue", "attach-cancel-queue", "session.attach", "s1", {}));
		await responseAndSnapshot(queueClient.client, "attach-cancel-queue");

		owner.client.sendJson(command("prompt-cancel-a", "prompt-cancel-a", "session.prompt", "s1", { message: "A" }));
		const child = await factory.child();
		await child.waitForWrites(1);
		await acceptedPromptPublication(owner.client, "prompt-cancel-a", "A");
		await acceptedPromptPublication(queueClient.client, "prompt-cancel-a", "A");
		const promptA = JSON.parse(child.writes[0] ?? "{}") as { id?: string; type?: string };
		expect(promptA.type).toBe("prompt");
		if (!promptA.id) throw new Error("cancel A prompt RPC id missing");

		queueClient.client.sendJson(command("queue-b", "queue-b", "session.followUp", "s1", { message: "B" }));
		const followUp = await waitForRpcWrite(child, "follow_up", 1);
		if (typeof followUp.frame.id !== "string") throw new Error("queued B follow-up RPC id missing");
		child.push({
			type: "response",
			id: followUp.frame.id,
			command: "follow_up",
			success: true,
			data: {},
		});
		const queued = await untilResponse(queueClient.client, "queue-b");
		expect(queued.response).toMatchObject({ ok: true, result: { accepted: true } });
		const ownerPending = await owner.client.nextServer();
		const ownerTransient = await owner.client.nextServer();
		expect(ownerPending.type).toBe("session.delta");
		if (ownerPending.type !== "session.delta" || !ownerPending.upsert)
			throw new Error("queued B pending projection missing");
		expect(pendingPromptTexts(ownerPending.upsert.liveState?.pendingPrompts)).toEqual(["A", "B"]);
		expect(ownerTransient).toMatchObject({
			type: "event",
			event: { type: "message.update", entryId: promptTransientId("queue-b"), text: "B" },
		});

		owner.client.sendJson(command("cancel-a", "cancel-a", "session.cancel", "s1", {}));
		const challenge = await owner.client.nextServer();
		expect(challenge.type).toBe("confirmation");
		if (challenge.type !== "confirmation") throw new Error("cancel A confirmation missing");
		owner.client.sendJson(
			confirmFrame("cancel-a-confirm", String(challenge.confirmationId), "cancel-a", "approve", "s1"),
		);
		const abort = await waitForRpcWrite(child, "abort", followUp.index + 1);
		expect(abort.frame.resumeQueuedMessages).toBe(true);
		child.push({ type: "response", id: abort.frame.id, command: "abort", success: true, data: {} });
		const cancelled = await untilResponse(owner.client, "cancel-a");
		expect(cancelled.response).toMatchObject({ ok: true, result: { cancelled: true } });
		expect(cancelled.frames.some(frame => frame.type === "event" && frame.event.type === "message.discarded")).toBe(
			true,
		);
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("active");
		expect(pendingPromptTexts(appserver.snapshot(sid("s1"))?.ref.liveState?.pendingPrompts)).toEqual(["B"]);

		child.push({
			type: "response",
			id: promptA.id,
			command: "prompt",
			success: true,
			data: { agentInvoked: true },
		});
		expect((await untilResponse(owner.client, "prompt-cancel-a")).response.ok).toBe(true);
		child.push({ type: "prompt_result", id: promptA.id, agentInvoked: true });
		child.push({ type: "notice", level: "info", message: "cancelled-a-stale-terminal" });
		const stale = await owner.client.nextServer();
		expect(stale).toMatchObject({ type: "event", event: { type: "notice", message: "cancelled-a-stale-terminal" } });
		expect(pendingPromptTexts(appserver.snapshot(sid("s1"))?.ref.liveState?.pendingPrompts)).toEqual(["B"]);

		child.push({
			type: "session_entry",
			entry: {
				id: "queued-b-user",
				parentId: null,
				type: "message",
				timestamp: stamp,
				message: { role: "user", content: "B", clientCorrelationId: followUp.frame.id },
			},
		});
		const durable = await owner.client.nextServer();
		const settled = await owner.client.nextServer();
		const cleared = await owner.client.nextServer();
		expect(durable).toMatchObject({ type: "entry", entry: { id: "queued-b-user" } });
		expect(settled).toMatchObject({
			type: "event",
			event: { type: "message.settled", transientEntryId: promptTransientId("queue-b"), entryId: "queued-b-user" },
		});
		expect(cleared.type).toBe("session.delta");
		if (cleared.type !== "session.delta" || !cleared.upsert) throw new Error("queued B clear missing");
		expect(cleared.upsert.liveState?.pendingPrompts).toBeUndefined();
		child.push({ type: "agent_end", messages: [] });
		expect(await owner.client.nextServer()).toMatchObject({ type: "event", event: { type: "agent.end" } });
		const terminalState = await waitForRpcWriteId(child, "get_state", "agent-end:state");
		respondState(child, terminalState.frame);
		await untilSessionStatus(owner.client, "idle");
		await closeClients([owner.client, queueClient.client]);
		await appserver.stop();
	});
	test("a successful root A terminal cannot idle or clear follow-up B that already started", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		client.client.sendJson(command("attach-a-success", "attach-a-success", "session.attach", "s1", {}));
		await responseAndSnapshot(client.client, "attach-a-success");
		client.client.sendJson(command("success-a", "success-a", "session.prompt", "s1", { message: "A" }));
		const child = await factory.child();
		const promptA = await waitForRpcWrite(child, "prompt");
		await acceptedPromptPublication(client.client, "success-a", "A");
		if (typeof promptA.frame.id !== "string") throw new Error("success A prompt RPC id missing");
		child.push({
			type: "response",
			id: promptA.frame.id,
			command: "prompt",
			success: true,
			data: { agentInvoked: true },
		});
		expect((await untilResponse(client.client, "success-a")).response.ok).toBe(true);

		client.client.sendJson(command("success-b", "success-b", "session.followUp", "s1", { message: "B" }));
		const followB = await waitForRpcWrite(child, "follow_up", promptA.index + 1);
		if (typeof followB.frame.id !== "string") throw new Error("success B follow-up RPC id missing");
		child.push({ type: "response", id: followB.frame.id, command: "follow_up", success: true, data: {} });
		expect((await untilResponse(client.client, "success-b")).response.ok).toBe(true);
		expect(pendingPromptTexts(appserver.snapshot(sid("s1"))?.ref.liveState?.pendingPrompts)).toEqual(["A", "B"]);

		child.push({ type: "prompt_result", id: promptA.frame.id, agentInvoked: true });
		const terminalAState = await waitForRpcWriteId(child, "get_state", `${promptA.frame.id}:terminal:state`);
		respondState(child, terminalAState.frame);
		child.push({ type: "notice", level: "info", message: "success-a-terminal-applied" });
		for (;;) {
			const frame = await client.client.nextServer();
			if (frame.type === "event" && frame.event.type === "notice") break;
		}
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("active");
		expect(pendingPromptTexts(appserver.snapshot(sid("s1"))?.ref.liveState?.pendingPrompts)).toEqual(["B"]);

		child.push({
			type: "session_entry",
			entry: {
				id: "success-b-user",
				parentId: null,
				type: "message",
				timestamp: stamp,
				message: { role: "user", content: "B", clientCorrelationId: followB.frame.id },
			},
		});
		expect((await client.client.nextServer()).type).toBe("entry");
		expect((await client.client.nextServer()).type).toBe("event");
		expect((await client.client.nextServer()).type).toBe("session.delta");
		child.push({ type: "agent_end", messages: [] });
		expect(await client.client.nextServer()).toMatchObject({ type: "event", event: { type: "agent.end" } });
		const terminalBState = await waitForRpcWriteId(child, "get_state", "agent-end:state");
		respondState(child, terminalBState.frame);
		await untilSessionStatus(client.client, "idle");
		await closeClients([client.client]);
		await appserver.stop();
	});
	test("caps plural pending prompt state at sixteen and bounds reconnect text", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		client.client.sendJson(command("cap-attach", "cap-attach", "session.attach", "s1", {}));
		await responseAndSnapshot(client.client, "cap-attach");
		client.client.sendJson(command("cap-root", "cap-root", "session.prompt", "s1", { message: "root" }));
		const child = await factory.child();
		const rootPrompt = await waitForRpcWrite(child, "prompt");
		child.push({
			type: "response",
			id: rootPrompt.frame.id,
			command: "prompt",
			success: true,
			data: { agentInvoked: true },
		});
		expect((await untilResponse(client.client, "cap-root")).response.ok).toBe(true);

		let writeIndex = rootPrompt.index + 1;
		for (let index = 1; index < 16; index++) {
			const message = index === 15 ? "\n".repeat(63 * 1024) : `queued-${index}`;
			client.client.sendJson(command(`cap-${index}`, `cap-${index}`, "session.followUp", "s1", { message }));
			const queued = await waitForRpcWrite(child, "follow_up", writeIndex);
			writeIndex = queued.index + 1;
			child.push({
				type: "response",
				id: queued.frame.id,
				command: "follow_up",
				success: true,
				data: {},
			});
			const accepted = await untilResponse(client.client, `cap-${index}`);
			expect(accepted.response.ok).toBe(true);
			if (index === 15) {
				const transient = accepted.frames.find(
					frame => frame.type === "event" && frame.event.type === "message.update",
				);
				if (!transient) throw new Error("large prompt transient event missing");
				expect(new TextEncoder().encode(JSON.stringify(transient)).byteLength).toBeLessThanOrEqual(64 * 1024);
			}
		}
		expect(appserver.snapshot(sid("s1"))?.ref.liveState?.pendingPrompts).toHaveLength(16);
		const bounded =
			decodePendingPrompts(appserver.snapshot(sid("s1"))?.ref.liveState?.pendingPrompts)[15]?.text ?? "";
		expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(8 * 1024);

		client.client.sendJson(
			command("cap-overflow", "cap-overflow", "session.followUp", "s1", { message: "overflow" }),
		);
		expect((await untilResponse(client.client, "cap-overflow")).response).toMatchObject({
			ok: false,
			error: { code: "message_queue_full" },
		});
		expect(child.writes.map(value => JSON.parse(value)).filter(frame => frame.type === "follow_up")).toHaveLength(15);
		const reconnected = await readyClient(path, ["sessions.read"]);
		const pending = reconnected.sessions.sessions.find(session => session.sessionId === sid("s1"));
		expect(pending?.liveState?.pendingPrompts).toHaveLength(16);
		expect(
			new TextEncoder().encode(decodePendingPrompts(pending?.liveState?.pendingPrompts)[15]?.text ?? "").byteLength,
		).toBeLessThanOrEqual(8 * 1024);
		await closeClients([client.client, reconnected.client]);
		await appserver.stop();
	});
	test("retains accepted prompt command ownership beyond idempotency expiry", async () => {
		let now = Date.parse(stamp);
		const clock: Clock = { now: () => new Date(now) };
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")], 256, undefined, clock);
		const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		client.client.sendJson(command("owned-first", "owned-command", "session.prompt", "s1", { message: "once" }));
		const child = await factory.child();
		const prompt = await waitForRpcWrite(child, "prompt");
		child.push({
			type: "response",
			id: prompt.frame.id,
			command: "prompt",
			success: true,
			data: { agentInvoked: true },
		});
		expect((await untilResponse(client.client, "owned-first")).response.ok).toBe(true);

		now += 5 * 60_000 + 1;
		client.client.sendJson(
			command("owned-conflict", "owned-command", "session.prompt", "s1", { message: "different" }),
		);
		expect((await untilResponse(client.client, "owned-conflict")).response).toMatchObject({
			ok: false,
			error: { code: "idempotency_conflict" },
		});
		client.client.sendJson(command("owned-replay", "owned-command", "session.prompt", "s1", { message: "once" }));
		expect((await untilResponse(client.client, "owned-replay")).response).toMatchObject({
			ok: true,
			result: { accepted: true },
		});
		client.client.sendJson(
			command("owned-conflict-again", "owned-command", "session.prompt", "s1", { message: "different" }),
		);
		expect((await untilResponse(client.client, "owned-conflict-again")).response).toMatchObject({
			ok: false,
			error: { code: "idempotency_conflict" },
		});
		expect(child.writes.map(value => JSON.parse(value)).filter(frame => frame.type === "prompt")).toHaveLength(1);

		await closeClients([client.client]);
		await appserver.stop();
	});
	test("late prompt failures surface a sanitized error and return the session to idle", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		client.client.sendJson(command("attach-error", "attach-error", "session.attach", "s1", {}));
		await responseAndSnapshot(client.client, "attach-error");

		client.client.sendJson(command("prompt-error", "prompt-error", "session.prompt", "s1", { message: "go" }));
		const child = await factory.child();
		await child.waitForWrites(1);
		await acceptedPromptPublication(client.client, "prompt-error", "go");
		const prompt = JSON.parse(child.writes[0]!) as { id: string };
		child.push({ type: "response", id: prompt.id, command: "prompt", success: true, data: { agentInvoked: true } });
		expect((await untilResponse(client.client, "prompt-error")).response.ok).toBe(true);

		child.push({
			type: "prompt_result",
			id: prompt.id,
			error: "Bearer abcdefghijklmnop failed at /home/tester/private token=plaintext https://signed.example/download?signature=url-secret",
		});
		const terminalState = await waitForRpcWriteId(child, "get_state", `${prompt.id}:terminal:state`);
		respondState(child, terminalState.frame);
		const terminal = await untilSessionStatus(client.client, "idle");
		const failure = terminal.frames.find(frame => frame.type === "event" && frame.event.type === "turn.error");
		expect(failure).toMatchObject({
			type: "event",
			event: { type: "turn.error", message: "Bearer [redacted] failed at [path] token=[redacted] [url]" },
		});
		expect(JSON.stringify(terminal.frames)).not.toContain("abcdefghijklmnop");
		expect(JSON.stringify(terminal.frames)).not.toContain("/home/tester");
		expect(JSON.stringify(terminal.frames)).not.toContain("plaintext");
		expect(JSON.stringify(terminal.frames)).not.toContain("signed.example");
		expect(JSON.stringify(terminal.frames)).not.toContain("url-secret");
		expect(appserver.snapshot(sid("s1"))?.ref.attention?.latestOutcome?.summary).toBe(
			"Bearer [redacted] failed at [path] token=[redacted] [url]",
		);
		expect(appserver.snapshot(sid("s1"))?.ref.attention?.latestOutcome?.summary).not.toContain("signed.example");
		expect(appserver.snapshot(sid("s1"))?.ref.attention?.latestOutcome?.summary).not.toContain("url-secret");
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("idle");

		client.client.sendJson({ v: "omp-app/1", type: "ping", nonce: "after-prompt-error", timestamp: stamp });
		expect(await client.client.nextServer()).toMatchObject({ type: "pong", nonce: "after-prompt-error" });
		await closeClients([client.client]);
		await appserver.stop();
	});
	test("keeps multi-turn prompts active until the final agent end", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		client.client.sendJson(command("attach-status", "attach-status", "session.attach", "s1", {}));
		const [, initial] = await responseAndSnapshot(client.client, "attach-status");
		client.client.sendJson(command("prompt-status", "prompt-status", "session.prompt", "s1", { message: "go" }));
		const child = await factory.child();
		await child.waitForWrites(1);
		const publication = await acceptedPromptPublication(client.client, "prompt-status", "go");
		if (publication.active.type === "session.delta") {
			expect(publication.active.revision).not.toBe(initial.revision);
			expect(publication.active.upsert?.revision).toBe(publication.active.revision);
		}
		const prompt = JSON.parse(child.writes[0] ?? "{}") as { id?: string };
		if (!prompt.id) throw new Error("status prompt RPC id missing");
		child.push({ type: "response", id: prompt.id, command: "prompt", success: true, data: { agentInvoked: true } });
		const acknowledged = await untilResponse(client.client, "prompt-status");
		expect(acknowledged.response.ok).toBe(true);
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("active");
		child.push({ type: "turn_start" });
		const firstTurnStart = await client.client.nextServer();
		expect(firstTurnStart.type === "event" ? firstTurnStart.event.type : firstTurnStart.type).toBe("turn.start");
		child.push({ type: "turn_end" });
		const turnEnd = await client.client.nextServer();
		expect(turnEnd.type === "event" ? turnEnd.event.type : turnEnd.type).toBe("turn.end");
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("active");
		child.push({ type: "turn_start" });
		const turnStart = await client.client.nextServer();
		expect(turnStart.type === "event" ? turnStart.event.type : turnStart.type).toBe("turn.start");
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("active");
		child.push({ type: "agent_end", messages: [] });
		const agentEnd = await client.client.nextServer();
		expect(agentEnd.type === "event" ? agentEnd.event.type : agentEnd.type).toBe("agent.end");
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("active");
		child.push({ type: "prompt_result", id: prompt.id, agentInvoked: true });
		const terminalState = await waitForRpcWriteId(child, "get_state", `${prompt.id}:terminal:state`);
		respondState(child, terminalState.frame);
		await untilSessionStatus(client.client, "idle");
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("idle");
		await closeClients([client.client]);
		await appserver.stop();
	});
	test("returns authoritative state and settles each pending UI request exactly once", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		client.client.sendJson(command("attach-controls", "attach-controls", "session.attach", "s1", {}));
		await responseAndSnapshot(client.client, "attach-controls");

		client.client.sendJson(command("state", "state", "session.state.get", "s1", {}));
		const child = await factory.child();
		await child.waitForWrites(1);
		const stateCommand = JSON.parse(child.writes[0] ?? "{}") as Record<string, unknown>;
		child.push({
			type: "response",
			id: stateCommand.id,
			command: "get_state",
			success: true,
			data: {
				model: { id: "gpt-5.6", provider: "openai", name: "GPT 5.6" },
				thinkingLevel: "high",
				thinkingEffective: "medium",
				thinkingResolved: "high",
				thinkingLevels: ["minimal", "low", "medium", "high"],
				thinkingSupported: true,
				thinkingOffFloored: false,
				fast: true,
				fastAvailable: true,
				fastActive: true,
				isStreaming: false,
				isCompacting: false,
				isPaused: true,
				steeringMode: "one-at-a-time",
				followUpMode: "all",
				interruptMode: "wait",
				sessionName: "Renamed",
				messageCount: 7,
				queuedMessageCount: 2,
				queuedMessages: { steering: ["steer"], followUp: ["follow"] },
				contextUsage: { tokens: 123, contextWindow: 1_000 },
				providerTransport: {
					provider: "openai-codex",
					configuredPolicy: "on",
					websocketPreferred: true,
					lastTransport: "websocket",
					websocketDisabled: false,
					websocketConnected: true,
					fallbackCount: 0,
					canAppend: true,
					prewarmed: true,
					hasSessionState: true,
					hasTurnState: true,
					fullContextRequests: 2,
					deltaRequests: 19,
					inputJsonBytes: 78_297,
					lastInputJsonBytes: 126,
				},
			},
		});
		const state = await untilResponse(client.client, "state");
		expect(state.response).toMatchObject({
			ok: true,
			result: {
				isPaused: true,
				model: { id: "gpt-5.6", provider: "openai", displayName: "GPT 5.6" },
				thinking: "high",
				thinkingEffective: "medium",
				thinkingResolved: "high",
				thinkingLevels: ["minimal", "low", "medium", "high"],
				thinkingSupported: true,
				thinkingOffFloored: false,
				fast: true,
				fastAvailable: true,
				fastActive: true,
				sessionName: "Renamed",
				queuedMessages: { steering: ["steer"], followUp: ["follow"] },
				contextUsage: { used: 123, limit: 1_000 },
			},
		});
		expect(appserver.snapshot(sid("s1"))?.ref.liveState).toMatchObject({
			providerTransport: {
				provider: "openai-codex",
				configuredPolicy: "on",
				lastTransport: "websocket",
				deltaRequests: 19,
				inputJsonBytes: 78_297,
			},
		});

		child.push({
			type: "extension_ui_request",
			id: "ask-1",
			method: "input",
			title: "Your answer",
		});
		const request = await client.client.nextServer();
		expect(request).toMatchObject({
			type: "event",
			event: { type: "ask.request", askId: "ask-1", responseKind: "value" },
		});
		expect(await client.client.nextServer()).toMatchObject({
			type: "session.delta",
			upsert: {
				pendingUserInput: true,
				attention: {
					pending: [{ kind: "question", id: "ask-1", question: "Your answer" }],
					pendingCount: 1,
					truncated: false,
				},
			},
		});
		client.client.sendJson(
			command("ui-answer", "ui-answer", "session.ui.respond", "s1", {
				requestId: "ask-1",
				value: "answer",
			}),
		);
		await child.waitForWrites(2);
		expect(JSON.parse(child.writes[1] ?? "{}")).toEqual({
			type: "extension_ui_response",
			id: "ask-1",
			value: "answer",
		});
		const answered = await untilResponse(client.client, "ui-answer");
		expect(answered.frames[0]).toMatchObject({
			type: "event",
			event: { type: "ask.resolved", askId: "ask-1" },
		});
		const answeredDelta = answered.frames.filter(frame => frame.type === "session.delta").at(-1);
		expect(answeredDelta?.type).toBe("session.delta");
		if (answeredDelta?.type !== "session.delta" || !answeredDelta.upsert) throw new Error("missing answer delta");
		expect(answeredDelta.upsert.attention).toBeUndefined();
		expect(answeredDelta.upsert.pendingUserInput).toBeUndefined();
		expect(answered.response).toMatchObject({ ok: true, result: { accepted: true } });

		client.client.sendJson(
			command("ui-duplicate", "ui-duplicate", "session.ui.respond", "s1", {
				requestId: "ask-1",
				value: "again",
			}),
		);
		const duplicate = await client.client.nextServer();
		expect(duplicate).toMatchObject({
			type: "response",
			ok: false,
			error: { code: "ui_request_invalid" },
		});
		expect(child.writes).toHaveLength(2);

		child.push({
			type: "extension_ui_request",
			id: "approval-1",
			method: "confirm",
			title: "Run?",
			message: "Approve command",
		});
		expect(await client.client.nextServer()).toMatchObject({
			type: "event",
			event: { type: "approval.request", approvalId: "approval-1" },
		});
		expect(await client.client.nextServer()).toMatchObject({
			type: "session.delta",
			upsert: {
				pendingApproval: true,
				attention: { pending: [{ kind: "approval", id: "approval-1" }], pendingCount: 1 },
			},
		});
		client.client.sendJson(
			command("ui-wrong-kind", "ui-wrong-kind", "session.ui.respond", "s1", {
				requestId: "approval-1",
				value: "wrong",
			}),
		);
		expect(await client.client.nextServer()).toMatchObject({
			type: "response",
			ok: false,
			error: { code: "ui_request_invalid" },
		});
		expect(child.writes).toHaveLength(2);
		client.client.sendJson(
			command("ui-confirm", "ui-confirm", "session.ui.respond", "s1", {
				requestId: "approval-1",
				confirmed: false,
			}),
		);
		await child.waitForWrites(3);
		const confirmed = await untilResponse(client.client, "ui-confirm");
		expect(confirmed.frames[0]).toMatchObject({
			type: "event",
			event: { type: "approval.resolved", approvalId: "approval-1" },
		});
		const confirmedDelta = confirmed.frames.filter(frame => frame.type === "session.delta").at(-1);
		expect(confirmedDelta?.type).toBe("session.delta");
		if (confirmedDelta?.type !== "session.delta" || !confirmedDelta.upsert) throw new Error("missing approval delta");
		expect(confirmedDelta.upsert.attention).toBeUndefined();
		expect(confirmed.response.ok).toBe(true);
		child.push({
			type: "thinking_level_changed",
			thinkingLevel: "medium",
			configured: "auto",
			resolved: "medium",
		});
		expect(await client.client.nextServer()).toMatchObject({
			type: "event",
			event: { type: "thinking.level.changed", configured: "auto", resolved: "medium" },
		});
		const eventRefresh = await waitForRpcWriteId(child, "get_state", "thinking-level-changed:state", 3);
		respondState(child, eventRefresh.frame);
		expect(await client.client.nextServer()).toMatchObject({
			type: "session.delta",
			upsert: { liveState: { isStreaming: false } },
		});
		await closeClients([client.client]);
		await appserver.stop();
	});
	test("publishes attention to an unattached index client and ignores stale diagnostic failures", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		client.client.sendJson(command("state-unattached", "state-unattached", "session.state.get", "s1", {}));
		const child = await factory.child();
		await child.waitForWrites(1);
		respondState(child, JSON.parse(child.writes[0] ?? "{}") as Record<string, unknown>);
		await untilResponse(client.client, "state-unattached");

		child.push({
			type: "extension_ui_request",
			id: "ask-cold",
			method: "input",
			title: "Use token=secret at https://example.test/private from /Users/name/project?",
		});
		expect(await client.client.nextServer()).toMatchObject({
			type: "session.delta",
			upsert: {
				attention: {
					pending: [
						{
							kind: "question",
							id: "ask-cold",
							question: "Use token=[redacted] at [url] from [path]",
						},
					],
					pendingCount: 1,
					truncated: false,
				},
			},
		});

		child.push({ type: "agent_end", status: "completed", messageCount: 1 });
		expect(await client.client.nextServer()).toMatchObject({
			type: "session.delta",
			upsert: {
				attention: {
					pending: [],
					pendingCount: 0,
					latestOutcome: { kind: "completed", summary: "Agent completed work." },
				},
			},
		});
		const completed = appserver.snapshot(sid("s1"))?.ref.attention?.latestOutcome;

		child.push({ type: "prompt_result", id: "stale-prompt", error: "stale failure" });
		client.client.sendJson({ v: "omp-app/1", type: "ping", nonce: "after-stale", timestamp: stamp });
		const frames = await untilPong(client.client, "after-stale");
		expect(frames).toEqual([expect.objectContaining({ type: "pong", nonce: "after-stale" })]);
		expect(appserver.snapshot(sid("s1"))?.ref.attention?.latestOutcome).toEqual(completed);

		await closeClients([client.client]);
		await appserver.stop();
	});
	test("restores latest outcomes after restart without restoring live requests", async () => {
		const ledgerRoot = await mkdtemp(join(tmpdir(), "omp-attention-restart-"));
		const ledgerPath = join(ledgerRoot, "profile", "agent", "appserver", "attention-outcomes.json");
		const firstFactory = new LiveFactory();
		const first = await liveServer(firstFactory, [record("s1")], 256, undefined, undefined, ledgerPath);
		const firstClient = await readyClient(first.path, ["sessions.read", "sessions.prompt"]);
		firstClient.client.sendJson(command("state-persist", "state-persist", "session.state.get", "s1", {}));
		const child = await firstFactory.child();
		await child.waitForWrites(1);
		respondState(child, JSON.parse(child.writes[0] ?? "{}") as Record<string, unknown>);
		await untilResponse(firstClient.client, "state-persist");
		child.push({
			type: "extension_ui_request",
			id: "not-durable",
			method: "confirm",
			title: "Temporary approval",
			message: "Do not restore this request",
		});
		expect(await firstClient.client.nextServer()).toMatchObject({
			type: "session.delta",
			upsert: { attention: { pendingCount: 1 } },
		});
		child.push({ type: "agent_end", status: "completed", messageCount: 1 });
		expect(await firstClient.client.nextServer()).toMatchObject({
			type: "session.delta",
			upsert: { attention: { pendingCount: 0, latestOutcome: { kind: "completed" } } },
		});
		const persisted = first.appserver.snapshot(sid("s1"))?.ref.attention?.latestOutcome;
		await closeClients([firstClient.client]);
		await first.appserver.stop();

		const second = await liveServer(new LiveFactory(), [record("s1")], 256, undefined, undefined, ledgerPath);
		const secondClient = await readyClient(second.path, ["sessions.read"]);
		expect(secondClient.sessions.sessions[0]?.attention).toEqual({
			pending: [],
			pendingCount: 0,
			truncated: false,
			latestOutcome: persisted,
		});
		expect(secondClient.sessions.sessions[0]?.pendingApproval).toBeUndefined();
		await closeClients([secondClient.client]);
		await second.appserver.stop();
		await rm(ledgerRoot, { recursive: true, force: true });
	});

	test("drops malformed provider diagnostics without blocking the state refresh", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read"]);
		client.client.sendJson(command("malformed-diagnostics", "malformed-diagnostics", "session.state.get", "s1", {}));
		const child = await factory.child();
		await child.waitForWrites(1);
		const stateCommand = JSON.parse(child.writes[0] ?? "{}") as Record<string, unknown>;
		child.push({
			type: "response",
			id: stateCommand.id,
			command: "get_state",
			success: true,
			data: {
				isStreaming: false,
				isCompacting: false,
				isPaused: false,
				messageCount: 3,
				queuedMessageCount: 0,
				steeringMode: "one-at-a-time",
				followUpMode: "all",
				interruptMode: "wait",
				sessionName: "State still refreshed",
				providerTransport: {
					provider: "openai-codex",
					configuredPolicy: "future-policy",
				},
			},
		});
		const result = await untilResponse(client.client, "malformed-diagnostics");
		expect(result.response).toMatchObject({
			ok: true,
			result: { messageCount: 3, sessionName: "State still refreshed" },
		});
		expect(appserver.snapshot(sid("s1"))?.ref.liveState?.providerTransport).toBeUndefined();
		await closeClients([client.client]);
		await appserver.stop();
	});
	test("projects live subagent progress and replays current agent state on attach", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const first = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		first.client.sendJson(command("attach-agent", "attach-agent", "session.attach", "s1", {}));
		await responseAndSnapshot(first.client, "attach-agent");
		first.client.sendJson(command("prompt-agent", "prompt-agent", "session.prompt", "s1", { message: "go" }));
		const child = await factory.child();
		await child.waitForWrites(1);
		child.push({
			type: "subagent_lifecycle",
			payload: {
				id: "WorkerA",
				index: 0,
				agent: "task",
				agentSource: "bundled",
				description: "Worker",
				status: "started",
				lastUpdate: 100,
			},
		});
		child.push({
			type: "subagent_progress",
			payload: {
				index: 0,
				agent: "task",
				agentSource: "bundled",
				task: "Implement",
				progress: {
					id: "WorkerA",
					agent: "task",
					status: "running",
					lastIntent: "Editing /home/tester/private.ts",
					contextTokens: 250,
					contextWindow: 1_000,
					tokens: 500,
					toolCount: 2,
					durationMs: 100,
				},
			},
		});
		child.push({
			type: "subagent_lifecycle",
			payload: {
				id: "WorkerA",
				index: 0,
				agent: "task",
				agentSource: "bundled",
				status: "parked",
				resumable: true,
			},
		});
		responseFor(child, "prompt");
		const output = await untilResponse(first.client, "prompt-agent");
		const agentFrames = output.frames.filter(frame => frame.type === "agent");
		expect(agentFrames.map(frame => (frame.type === "agent" ? frame.state : ""))).toEqual([
			"started",
			"running",
			"parked",
		]);
		expect(agentFrames[1]).toMatchObject({
			type: "agent",
			agentId: "WorkerA",
			detail: {
				title: "Implement",
				progress: "Editing [path]",
				contextUsage: { used: 250, limit: 1_000 },
			},
		});
		expect(agentFrames[2]).toMatchObject({
			type: "agent",
			state: "parked",
			detail: { resumable: true },
		});

		const second = await readyClient(path, ["sessions.read"]);
		second.client.sendJson(command("attach-agent-2", "attach-agent-2", "session.attach", "s1", {}));
		await responseAndSnapshot(second.client, "attach-agent-2");
		expect(await second.client.nextServer()).toMatchObject({
			type: "agent",
			agentId: "WorkerA",
			state: "parked",
			detail: { resumable: true },
		});
		await closeClients([first.client, second.client]);
		await appserver.stop();
	});

	test("gates live and attached agent transcripts by negotiated feature", async () => {
		const factory = new LiveFactory();
		const { appserver, path, root } = await liveServer(factory, [record("s1")]);
		const clients: RawUdsWebSocket[] = [];
		try {
			const negotiated = await readyClient(path, ["sessions.read"], ["resume", "agent.transcript"]);
			const unnegotiated = await readyClient(path, ["sessions.read"], ["resume"]);
			clients.push(negotiated.client, unnegotiated.client);
			expect(negotiated.welcome.grantedFeatures).toEqual(["resume", "agent.transcript"]);
			expect(unnegotiated.welcome.grantedFeatures).toEqual(["resume"]);

			negotiated.client.sendJson(command("attach-transcript", "attach-transcript", "session.attach", "s1", {}));
			await responseAndSnapshot(negotiated.client, "attach-transcript");
			unnegotiated.client.sendJson(
				command("attach-no-transcript", "attach-no-transcript", "session.attach", "s1", {}),
			);
			await responseAndSnapshot(unnegotiated.client, "attach-no-transcript");

			const child = await startIdleSessionRuntime(negotiated.client, factory, "start-agent-transcript");
			expect(await unnegotiated.client.nextServer()).toMatchObject({
				type: "session.delta",
				sessionId: "s1",
				upsert: { liveState: { isStreaming: false } },
			});
			child.push({
				type: "subagent_lifecycle",
				payload: {
					id: "WorkerA",
					index: 0,
					agent: "task",
					agentSource: "bundled",
					description: "Worker",
					status: "started",
					lastUpdate: 100,
				},
			});
			await child.waitForWrites(2);
			const firstRead = JSON.parse(child.writes[1] ?? "{}") as Record<string, unknown>;
			expect(firstRead).toMatchObject({
				type: "get_subagent_messages",
				subagentId: "WorkerA",
				fromByte: 0,
				maxBytes: 384 * 1_024,
				includeMessages: false,
			});
			if (typeof firstRead.id !== "string") throw new Error("first transcript read id missing");
			child.push({
				type: "response",
				id: firstRead.id,
				command: "get_subagent_messages",
				success: true,
				data: {
					sessionFile: "/home/tester/private/worker.jsonl",
					fromByte: 0,
					nextByte: 100,
					reset: false,
					entries: [
						{
							type: "message",
							id: "worker-message",
							parentId: null,
							timestamp: stamp,
							message: {
								role: "assistant",
								content: [{ type: "text", text: "child says /home/tester/private/source.ts" }],
							},
						},
					],
					messages: [],
				},
			});
			await child.waitForWrites(3);
			const secondRead = JSON.parse(child.writes[2] ?? "{}") as Record<string, unknown>;
			expect(secondRead).toMatchObject({
				type: "get_subagent_messages",
				subagentId: "WorkerA",
				fromByte: 100,
				maxBytes: 384 * 1_024,
				includeMessages: false,
			});
			if (typeof secondRead.id !== "string") throw new Error("second transcript read id missing");
			child.push({
				type: "response",
				id: secondRead.id,
				command: "get_subagent_messages",
				success: true,
				data: {
					sessionFile: "/home/tester/private/worker.jsonl",
					fromByte: 100,
					nextByte: 100,
					reset: false,
					entries: [],
					messages: [],
				},
			});

			expect(await negotiated.client.nextServer()).toMatchObject({
				type: "agent",
				agentId: "WorkerA",
				state: "started",
			});
			const transcript = await negotiated.client.nextServer();
			expect(transcript).toMatchObject({
				type: "agent.transcript",
				agentId: "WorkerA",
				entries: [{ kind: "message", data: { role: "assistant", text: "child says [path]" } }],
			});
			expect(JSON.stringify(transcript)).not.toContain("/home/tester");
			expect(await unnegotiated.client.nextServer()).toMatchObject({
				type: "agent",
				agentId: "WorkerA",
				state: "started",
			});
			unnegotiated.client.sendJson({ v: "omp-app/1", type: "ping", nonce: "no-live-transcript", timestamp: stamp });
			expect(await unnegotiated.client.nextServer()).toMatchObject({ type: "pong", nonce: "no-live-transcript" });

			const attachedNegotiated = await readyClient(path, ["sessions.read"], ["resume", "agent.transcript"]);
			clients.push(attachedNegotiated.client);
			attachedNegotiated.client.sendJson(
				command("attach-transcript-baseline", "attach-transcript-baseline", "session.attach", "s1", {}),
			);
			await responseAndSnapshot(attachedNegotiated.client, "attach-transcript-baseline");
			expect(await attachedNegotiated.client.nextServer()).toMatchObject({ type: "agent", agentId: "WorkerA" });
			expect(await attachedNegotiated.client.nextServer()).toMatchObject({
				type: "agent.transcript",
				agentId: "WorkerA",
				entries: [{ kind: "message", data: { text: "child says [path]" } }],
			});

			const attachedUnnegotiated = await readyClient(path, ["sessions.read"], ["resume"]);
			clients.push(attachedUnnegotiated.client);
			attachedUnnegotiated.client.sendJson(
				command("attach-no-transcript-baseline", "attach-no-transcript-baseline", "session.attach", "s1", {}),
			);
			await responseAndSnapshot(attachedUnnegotiated.client, "attach-no-transcript-baseline");
			expect(await attachedUnnegotiated.client.nextServer()).toMatchObject({ type: "agent", agentId: "WorkerA" });
			attachedUnnegotiated.client.sendJson({
				v: "omp-app/1",
				type: "ping",
				nonce: "no-attached-transcript",
				timestamp: stamp,
			});
			expect(await attachedUnnegotiated.client.nextServer()).toMatchObject({
				type: "pong",
				nonce: "no-attached-transcript",
			});
		} finally {
			await closeClients(clients);
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("reads only negotiated image metadata retained by a child transcript", async () => {
		const blobRoot = await mkdtemp(join(tmpdir(), "omp-appserver-child-blobs-"));
		await chmod(blobRoot, 0o700);
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.from("child-transcript-image"),
		]);
		const sha256 = createHash("sha256").update(png).digest("hex");
		await writeFile(join(blobRoot, sha256), png, { mode: 0o600 });
		const factory = new LiveFactory();
		const { appserver, path, root } = await liveServer(factory, [record("s1")], 256, blobRoot);
		const clients: RawUdsWebSocket[] = [];
		try {
			const connected = await readyClient(
				path,
				["sessions.read"],
				["resume", "agent.transcript", "transcript.images"],
			);
			clients.push(connected.client);
			expect(connected.welcome.grantedFeatures).toEqual(["resume", "agent.transcript", "transcript.images"]);
			connected.client.sendJson(command("attach-child-image", "attach-child-image", "session.attach", "s1", {}));
			await responseAndSnapshot(connected.client, "attach-child-image");

			const child = await startIdleSessionRuntime(connected.client, factory, "start-child-image");
			child.push({
				type: "subagent_lifecycle",
				payload: {
					id: "WorkerImage",
					index: 0,
					agent: "task",
					agentSource: "bundled",
					description: "Image worker",
					status: "started",
					lastUpdate: 100,
				},
			});
			await child.waitForWrites(2);
			const firstRead = JSON.parse(child.writes[1] ?? "{}") as Record<string, unknown>;
			expect(firstRead).toMatchObject({
				type: "get_subagent_messages",
				subagentId: "WorkerImage",
				fromByte: 0,
			});
			if (typeof firstRead.id !== "string") throw new Error("child image transcript read id missing");
			child.push({
				type: "response",
				id: firstRead.id,
				command: "get_subagent_messages",
				success: true,
				data: {
					sessionFile: "/home/tester/private/image-worker.jsonl",
					fromByte: 0,
					nextByte: 100,
					reset: false,
					entries: [
						{
							type: "message",
							id: "child-image-entry",
							parentId: null,
							timestamp: stamp,
							message: {
								role: "assistant",
								content: [
									{ type: "text", text: "child image" },
									{
										type: "image",
										mimeType: "image/png",
										data: `blob:sha256:${sha256}`,
										appImageSha256: sha256,
									},
								],
							},
						},
					],
					messages: [],
				},
			});
			await child.waitForWrites(3);
			const secondRead = JSON.parse(child.writes[2] ?? "{}") as Record<string, unknown>;
			expect(secondRead).toMatchObject({
				type: "get_subagent_messages",
				subagentId: "WorkerImage",
				fromByte: 100,
			});
			if (typeof secondRead.id !== "string") throw new Error("child image transcript completion id missing");
			child.push({
				type: "response",
				id: secondRead.id,
				command: "get_subagent_messages",
				success: true,
				data: {
					sessionFile: "/home/tester/private/image-worker.jsonl",
					fromByte: 100,
					nextByte: 100,
					reset: false,
					entries: [],
					messages: [],
				},
			});

			expect(await connected.client.nextServer()).toMatchObject({
				type: "agent",
				agentId: "WorkerImage",
				state: "started",
			});
			expect(await connected.client.nextServer()).toMatchObject({
				type: "agent.transcript",
				agentId: "WorkerImage",
				entries: [
					{
						id: "child-image-entry",
						data: { images: [{ sha256, mimeType: "image/png" }] },
					},
				],
			});

			const readArgs = { entryId: "child-image-entry", sha256, offset: 0 };
			const imageOnly = await readyClient(path, ["sessions.read"], ["resume", "transcript.images"]);
			clients.push(imageOnly.client);
			imageOnly.client.sendJson(
				command("attach-child-image-only", "attach-child-image-only", "session.attach", "s1", {}),
			);
			await responseAndSnapshot(imageOnly.client, "attach-child-image-only");
			expect(await imageOnly.client.nextServer()).toMatchObject({ type: "agent", agentId: "WorkerImage" });
			imageOnly.client.sendJson(
				command("read-child-image-only", "read-child-image-only", "session.image.read", "s1", readArgs),
			);
			expect((await untilResponse(imageOnly.client, "read-child-image-only")).response).toMatchObject({
				ok: false,
				error: { code: "image_not_found" },
			});

			connected.client.sendJson(
				command("read-child-image", "read-child-image", "session.image.read", "s1", readArgs),
			);
			const read = (await untilResponse(connected.client, "read-child-image")).response;
			expect(read).toMatchObject({
				ok: true,
				result: { sha256, mimeType: "image/png", offset: 0, complete: true },
			});
			expect(Buffer.from((read.result as { content: string }).content, "base64")).toEqual(png);

			connected.client.sendJson(
				command("read-child-mismatch", "read-child-mismatch", "session.image.read", "s1", {
					...readArgs,
					sha256: "f".repeat(64),
				}),
			);
			expect((await untilResponse(connected.client, "read-child-mismatch")).response).toMatchObject({
				ok: false,
				error: { code: "image_not_found" },
			});

			child.push({
				type: "subagent_lifecycle",
				payload: {
					id: "WorkerImage",
					index: 0,
					agent: "task",
					agentSource: "bundled",
					status: "parked",
					resumable: true,
				},
			});
			await child.waitForWrites(4);
			const resetRead = JSON.parse(child.writes[3] ?? "{}") as Record<string, unknown>;
			expect(resetRead).toMatchObject({
				type: "get_subagent_messages",
				subagentId: "WorkerImage",
				fromByte: 100,
			});
			if (typeof resetRead.id !== "string") throw new Error("child image transcript reset id missing");
			child.push({
				type: "response",
				id: resetRead.id,
				command: "get_subagent_messages",
				success: true,
				data: {
					sessionFile: "/home/tester/private/image-worker.jsonl",
					fromByte: 0,
					nextByte: 0,
					reset: true,
					entries: [],
					messages: [],
				},
			});
			expect(await connected.client.nextServer()).toMatchObject({
				type: "agent",
				agentId: "WorkerImage",
				state: "parked",
			});
			expect(await connected.client.nextServer()).toMatchObject({
				type: "agent.transcript",
				agentId: "WorkerImage",
				entries: [],
			});

			connected.client.sendJson(
				command("read-child-unretained", "read-child-unretained", "session.image.read", "s1", readArgs),
			);
			expect((await untilResponse(connected.client, "read-child-unretained")).response).toMatchObject({
				ok: false,
				error: { code: "image_not_found" },
			});

			const unnegotiated = await readyClient(path, ["sessions.read"], ["resume"]);
			clients.push(unnegotiated.client);
			unnegotiated.client.sendJson(
				command("attach-child-image-unnegotiated", "attach-child-image-unnegotiated", "session.attach", "s1", {}),
			);
			await responseAndSnapshot(unnegotiated.client, "attach-child-image-unnegotiated");
			expect(await unnegotiated.client.nextServer()).toMatchObject({ type: "agent", agentId: "WorkerImage" });
			unnegotiated.client.sendJson(
				command("read-child-unnegotiated", "read-child-unnegotiated", "session.image.read", "s1", readArgs),
			);
			expect((await untilResponse(unnegotiated.client, "read-child-unnegotiated")).response).toMatchObject({
				ok: false,
				error: { code: "UNSUPPORTED_FEATURE", details: { feature: "transcript.images" } },
			});
		} finally {
			await closeClients(clients);
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
			await rm(blobRoot, { recursive: true, force: true });
		}
	});
});

describe("raw RFC6455 boundary and lifecycle", () => {
	async function malformedCase(payload: Uint8Array, opcode = 0x1): Promise<RawUdsWebSocket> {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, []);
		const client = await readyClient(path);
		client.client.sendRaw(frameBytes(opcode, payload));
		if (payload.byteLength > 1024 * 1024) {
			client.client.destroy();
			await client.client.closed();
			await appserver.stop();
			return client.client;
		}
		const frame = await client.client.nextOrClose();
		expect(frame?.opcode === 0x1 || frame?.opcode === 0x8 || frame === undefined).toBe(true);
		if (frame?.opcode === 0x1) expect(decodeServerFrame(new TextDecoder().decode(frame.payload)).type).toBe("error");
		await client.client.closed();
		await appserver.stop();
		return client.client;
	}
	test("binary, duplicate-key, invalid UTF-8, oversize, and unknown frames are rejected and closed", async () => {
		await malformedCase(new TextEncoder().encode("{}"), 0x2);
		await malformedCase(new TextEncoder().encode('{"v":"omp-app/1","type":"ping","nonce":"a","nonce":"b"}'));
		await malformedCase(new Uint8Array([0xff, 0xfe]));
		await malformedCase(new Uint8Array(1024 * 1024 + 1));
		await malformedCase(new TextEncoder().encode('{"v":"omp-app/1","type":"unknown"}'));
	});
	test("stop after a spawned child closes clients and removes socket, owner, and transient files", async () => {
		const factory = new LiveFactory();
		const { appserver, root, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		client.client.sendJson(command("attach", "attach", "session.attach", "s1", {}));
		await responseAndSnapshot(client.client, "attach");
		client.client.sendJson(command("prompt", "prompt", "session.prompt", "s1", { message: "start" }));
		const child = await factory.child();
		await child.waitForWrites(1);
		responseFor(child, "prompt");
		await untilResponse(client.client, "prompt");
		expect(factory.children).toHaveLength(1);
		await appserver.stop();
		await client.client.closed();
		expect(await stat(path).catch(() => undefined)).toBeUndefined();
		await factory.children[0]!.killed.promise;
		const files = await readdir(join(root, "run"));
		expect(
			files.filter(name => name.includes("owner") || name.includes("stale") || name.includes("tmp")).length,
		).toBe(0);
	});
	test("owner crash residue and concurrent stale recovery are deterministic", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-owner-live-"));
		const path = join(root, "run", "app.sock");
		await mkdir(join(root, "run"), { recursive: true });
		await writeFile(`${path}.owner.tmp-orphan`, "orphan");
		const first = createAppserver({
			hostId: host,
			epoch: "owner-a",
			socketPath: path,
			discovery: new StaticDiscovery([]),
		});
		await first.start();
		await first.stop();
		const staleOwner = "22222222-2222-4222-8222-222222222222";
		await writeFile(
			`${path}.owner`,
			JSON.stringify({
				version: 2,
				ownerId: staleOwner,
				pid: 999999,
				backingName: `.appserver-${staleOwner}.sock`,
				device: 0,
				inode: 0,
			}),
			{ mode: 0o600 },
		);
		const a = createAppserver({
			hostId: host,
			epoch: "owner-b",
			socketPath: path,
			discovery: new StaticDiscovery([]),
		});
		const b = createAppserver({
			hostId: host,
			epoch: "owner-c",
			socketPath: path,
			discovery: new StaticDiscovery([]),
		});
		const results = await Promise.allSettled([a.start(), b.start()]);
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		await a.stop();
		await b.stop();
		await writeFile(`${path}.owner`, "not-json", { mode: 0o600 });
		const malformed = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) });
		await expect(malformed.start()).rejects.toThrow("malformed appserver");
		const foreignOwner = "33333333-3333-4333-8333-333333333333";
		await writeFile(
			`${path}.owner`,
			JSON.stringify({
				version: 2,
				ownerId: foreignOwner,
				pid: 999999,
				backingName: `.appserver-${foreignOwner}.sock`,
				device: 0,
				inode: 0,
			}),
			{ mode: 0o600 },
		);
		const cleanup = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) });
		await cleanup.start();
		await writeFile(
			`${path}.owner`,
			JSON.stringify({
				version: 2,
				ownerId: foreignOwner,
				pid: 999999,
				backingName: `.appserver-${foreignOwner}.sock`,
				device: 0,
				inode: 0,
			}),
			{ mode: 0o600 },
		);
		await cleanup.stop();
		expect(await stat(`${path}.owner`)).toBeDefined();
	});
});
describe("WS command boundary, authority, confirmation, and lock lifecycle", () => {
	test("real WS dispatch enforces arguments, idempotency, and raw path validation", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
		client.client.sendJson(hostCommand("list-a", "list", "session.list", {}));
		client.client.sendJson(hostCommand("list-b", "list", "session.list", {}));
		const first = await client.client.nextServer();
		const replay = await client.client.nextServer();
		expect(first.type).toBe("response");
		expect(replay.type).toBe("response");
		client.client.sendJson(hostCommand("conflict", "list", "session.list", { bad: true }));
		const conflict = await client.client.nextServer();
		expect(conflict.type).toBe("response");
		if (conflict.type === "response") expect(conflict.error?.code).toBe("idempotency_conflict");
		client.client.sendJson(command("bad-args", "bad-args", "session.prompt", "s1", { message: "ok", extra: true }));
		const badArgs = await client.client.nextServer();
		expect(badArgs.type).toBe("error");
		if (badArgs.type === "error") expect(badArgs.code).toBe("invalid_frame");
		client.client.sendJson(command("big", "big", "session.prompt", "s1", { message: "x".repeat(65_537) }));
		const big = await client.client.nextOrClose();
		expect(big?.opcode).toBe(0x8);
		await closeClients([client.client]);
		await appserver.stop();

		const pathServer = await liveServer(new LiveFactory(), [record("s1")]);
		const pathClient = await readyClient(pathServer.path, ["files.read"]);
		pathClient.client.sendRaw(
			frameBytes(
				1,
				new TextEncoder().encode(
					JSON.stringify({
						v: "omp-app/1",
						type: "command",
						requestId: "bad-path-r",
						commandId: "bad-path-c",
						hostId: host,
						command: "files.read",
						sessionId: "s1",
						args: { path: "/etc/passwd" },
					}),
				),
			),
		);
		const pathResult = await pathClient.client.nextOrClose();
		expect(pathResult?.opcode === 1 || pathResult?.opcode === 8 || pathResult === undefined).toBe(true);
		pathClient.client.destroy();
		await pathClient.client.closed();
		await pathServer.appserver.stop();
	});

	test("caps session list wire refs while preserving total metadata and projections", async () => {
		const records = Array.from({ length: 5_000 }, (_, index) => record(`session-${index}`));
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, records);
		const client = await readyClient(path, ["sessions.read"]);
		const projection = appserver.snapshot(sid("session-0"));
		client.client.sendJson(hostCommand("list-capped", "list-capped", "session.list", {}));
		const frame = await client.client.nextServer();
		expect(frame.type).toBe("response");
		if (frame.type === "response") {
			const result = frame.result as { sessions: unknown[]; totalCount: number; truncated: boolean };
			expect(result.sessions).toHaveLength(1_000);
			expect(result.totalCount).toBe(5_000);
			expect(result.truncated).toBe(true);
		}
		expect(appserver.snapshot(sid("session-0"))).toBe(projection);
		await closeClients([client.client]);
		await appserver.stop();
	});

	test("bounds aggregate pending prompt detail in session inventory frames", async () => {
		const records = Array.from({ length: 96 }, (_, index) => record(`pending-session-${index}`));
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, records);
		const escapedText = '\n"\\'.repeat(2_048);
		const promptsPerSession = 16;
		for (const session of records) {
			const projection = appserver.snapshot(session.sessionId);
			if (!projection) throw new Error(`missing projection for ${session.sessionId}`);
			projection.ref.liveState = {
				isStreaming: true,
				pendingPrompts: Array.from({ length: promptsPerSession }, (_, index) => ({
					entryId: `${session.sessionId}:pending:${index}`,
					text: escapedText,
					attachmentCount: 0,
					at: stamp,
				})),
			};
		}

		const client = await readyClient(path, ["sessions.read"]);
		const initialBytes = new TextEncoder().encode(JSON.stringify(client.sessions)).byteLength;
		expect(initialBytes).toBeLessThanOrEqual(1_048_576);
		expect(() => decodeServerFrame(JSON.stringify(client.sessions))).not.toThrow();
		expect(client.sessions.sessions).toHaveLength(records.length);
		expect(client.sessions.totalCount).toBe(records.length);
		expect(client.sessions.truncated).toBe(false);

		const listedPrompts = client.sessions.sessions.flatMap(session => {
			const pending = session.liveState?.pendingPrompts;
			return Array.isArray(pending) ? pending : [];
		});
		expect(listedPrompts.length).toBeGreaterThan(0);
		expect(listedPrompts.length).toBeLessThan(records.length * promptsPerSession);
		expect(
			client.sessions.sessions.some(
				session =>
					session.liveState?.pendingPromptsTruncated === true &&
					session.liveState?.pendingPromptCount === promptsPerSession,
			),
		).toBe(true);
		expect(appserver.snapshot(sid("pending-session-0"))?.ref.liveState?.pendingPrompts).toHaveLength(
			promptsPerSession,
		);

		client.client.sendJson(hostCommand("pending-list", "pending-list", "session.list", {}));
		const response = await client.client.nextServer();
		expect(response.type).toBe("response");
		expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThanOrEqual(1_048_576);
		expect(() => decodeServerFrame(JSON.stringify(response))).not.toThrow();
		await closeClients([client.client]);
		await appserver.stop();
	});

	test("confirmation challenge is one-shot, connection-bound, expiry-aware, and gated by revision", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const owner = await readyClient(path, ["sessions.read", "sessions.manage"]);
		const other = await readyClient(path, ["sessions.read", "sessions.manage"]);
		owner.client.sendJson(command("attach-close", "attach-close", "session.attach", "s1", {}));
		const [, snapshot] = await responseAndSnapshot(owner.client, "attach-close");
		const close = command("close", "close", "session.close", "s1", {});
		(close as Record<string, unknown>).expectedRevision = snapshot.revision;
		owner.client.sendJson(close);
		const challenge = await owner.client.nextServer();
		expect(challenge.type).toBe("confirmation");
		if (challenge.type !== "confirmation") throw new Error("missing challenge");
		expect(challenge.commandHash).toMatch(/^[0-9a-f]{64}$/);
		expect(factory.children).toHaveLength(0);
		other.client.sendJson(confirmFrame("wrong", String(challenge.confirmationId), "close", "approve", "s1"));
		const wrong = await other.client.nextServer();
		expect(wrong.type).toBe("response");
		if (wrong.type === "response") expect(wrong.error?.code).toBe("confirmation_invalid");
		owner.client.sendJson(confirmFrame("deny", String(challenge.confirmationId), "close", "deny", "s1"));
		const denied = await owner.client.nextServer();
		expect(denied.type).toBe("response");
		if (denied.type === "response") expect(denied.error?.code).toBe("confirmation_denied");
		const bypass = command("bypass", "bypass", "session.close", "s1", {});
		(bypass as Record<string, unknown>).expectedRevision = snapshot.revision;
		(bypass as Record<string, unknown>).confirmationId = "random-confirmation";
		owner.client.sendJson(bypass);
		const bypassResult = await owner.client.nextServer();
		expect(bypassResult.type).toBe("response");
		if (bypassResult.type === "response") expect(bypassResult.error?.code).toBe("confirmation_invalid");
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("idle");
		owner.client.sendJson(confirmFrame("reuse", String(challenge.confirmationId), "close", "approve", "s1"));
		const reused = await owner.client.nextServer();
		expect(reused.type).toBe("response");
		if (reused.type === "response") expect(reused.error?.code).toBe("confirmation_invalid");
		const stale = command("stale-close", "stale-close", "session.close", "s1", {});
		(stale as Record<string, unknown>).expectedRevision = "wrong-revision";
		owner.client.sendJson(stale);
		const staleChallenge = await owner.client.nextServer();
		expect(staleChallenge.type).toBe("confirmation");
		if (staleChallenge.type === "confirmation") {
			owner.client.sendJson(
				confirmFrame("stale-approve", String(staleChallenge.confirmationId), "stale-close", "approve", "s1"),
			);
			const staleResult = await owner.client.nextServer();
			expect(staleResult.type).toBe("response");
			if (staleResult.type === "response") expect(staleResult.error?.code).toBe("stale_revision");
		}
		const valid = command("valid-close", "valid-close", "session.close", "s1", {});
		(valid as Record<string, unknown>).expectedRevision = snapshot.revision;
		owner.client.sendJson(valid);
		const validChallenge = await owner.client.nextServer();
		expect(validChallenge.type).toBe("confirmation");
		if (validChallenge.type === "confirmation") {
			owner.client.sendJson(
				confirmFrame("valid-approve", String(validChallenge.confirmationId), "valid-close", "approve", "s1"),
			);
			const approved = await untilResponse(owner.client, "valid-close");
			expect(approved.response.ok).toBe(true);
		}
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("closed");
		const expiring = command("expire", "expire", "session.close", "s1", {});
		(expiring as Record<string, unknown>).expectedRevision = snapshot.revision;
		owner.client.sendJson(expiring);
		const expiringChallenge = await owner.client.nextServer();
		const originalNow = Date.now;
		Date.now = () => Number.MAX_SAFE_INTEGER;
		try {
			if (expiringChallenge.type === "confirmation") {
				owner.client.sendJson(
					confirmFrame("expired", String(expiringChallenge.confirmationId), "expire", "approve", "s1"),
				);
				const expired = await owner.client.nextServer();
				expect(expired.type).toBe("response");
				if (expired.type === "response") expect(expired.error?.code).toBe("confirmation_invalid");
			}
		} finally {
			Date.now = originalNow;
		}
		await closeClients([owner.client, other.client]);
		await appserver.stop();
	});

	test("streaming revision drift stales a revisioned cancel, while revisionless cancel reaches RPC and returns idle", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read", "sessions.prompt", "sessions.control"]);
		client.client.sendJson(command("attach-cancel", "attach-cancel", "session.attach", "s1", {}));
		await responseAndSnapshot(client.client, "attach-cancel");

		client.client.sendJson(command("state-before-cancel", "state-before-cancel", "session.state.get", "s1", {}));
		const child = await factory.child();
		await child.waitForWrites(1);
		const state = JSON.parse(child.writes[0]!) as { id: string; type: string };
		expect(state.type).toBe("get_state");
		child.push({
			id: state.id,
			type: "response",
			command: "get_state",
			success: true,
			data: {
				isStreaming: false,
				isCompacting: false,
				isPaused: false,
				steeringMode: "one-at-a-time",
				followUpMode: "all",
				interruptMode: "wait",
				messageCount: 0,
				queuedMessageCount: 0,
			},
		});
		expect((await untilResponse(client.client, "state-before-cancel")).response.ok).toBe(true);

		child.push({ type: "agent_start" });
		const agentStart = await client.client.nextServer();
		const active = await client.client.nextServer();
		expect(agentStart.type === "event" ? agentStart.event.type : agentStart.type).toBe("agent.start");
		expect(active).toMatchObject({ type: "session.delta", upsert: expect.objectContaining({ status: "active" }) });
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("active");

		const revisionedCancel = command("cancel-stale", "cancel-stale", "session.cancel", "s1", {});
		(revisionedCancel as Record<string, unknown>).expectedRevision = appserver.snapshot(sid("s1"))?.revision;
		client.client.sendJson(revisionedCancel);
		const staleChallenge = await client.client.nextServer();
		expect(staleChallenge.type).toBe("confirmation");
		if (staleChallenge.type !== "confirmation") throw new Error("missing revisioned cancel challenge");
		child.push({
			type: "session_entry",
			entry: {
				id: "entry-before-stale-approval",
				parentId: null,
				type: "message",
				timestamp: stamp,
				message: { role: "user", content: "first" },
			},
		});
		expect((await client.client.nextServer()).type).toBe("entry");
		client.client.sendJson(
			confirmFrame("approve-stale-cancel", String(staleChallenge.confirmationId), "cancel-stale", "approve", "s1"),
		);
		const staleCancel = await untilResponse(client.client, "cancel-stale");
		expect(staleCancel.response).toMatchObject({ ok: false, error: { code: "stale_revision" } });
		expect(child.writes).toHaveLength(1);

		// Cancel intentionally carries no expectedRevision. A streaming session's
		// projection can advance between challenge and approval, but the approved
		// stop intent must still reach the RPC child.
		client.client.sendJson(command("cancel", "cancel", "session.cancel", "s1", {}));
		const challenge = await client.client.nextServer();
		expect(challenge.type).toBe("confirmation");
		if (challenge.type !== "confirmation") throw new Error("missing cancel challenge");
		const revisionAtChallenge = appserver.snapshot(sid("s1"))?.revision;

		child.push({
			type: "session_entry",
			entry: {
				id: "entry-during-cancel",
				parentId: null,
				type: "message",
				timestamp: stamp,
				message: { role: "user", content: "second" },
			},
		});
		const streamedEntry = await client.client.nextServer();
		expect(streamedEntry.type).toBe("entry");
		expect(appserver.snapshot(sid("s1"))?.revision).not.toBe(revisionAtChallenge);

		client.client.sendJson(
			confirmFrame("approve-cancel", String(challenge.confirmationId), "cancel", "approve", "s1"),
		);
		await child.waitForWrites(2);
		const abort = JSON.parse(child.writes[1]!) as { id: string; type: string };
		expect(abort.type).toBe("abort");

		// AgentSession emits these before its abort response settles. Appserver must
		// translate both and project the terminal status for every attached client.
		child.push({ type: "turn_end" });
		child.push({ type: "agent_end", messages: [] });
		child.push({ id: abort.id, type: "response", command: "abort", success: true });
		const cancelled = await untilResponse(client.client, "cancel");
		expect(cancelled.response).toMatchObject({ ok: true, result: { cancelled: true } });
		expect(cancelled.frames.flatMap(frame => (frame.type === "event" ? [frame.event.type] : []))).toEqual([
			"turn.end",
			"agent.end",
		]);
		const terminalState = await waitForRpcWriteId(child, "get_state", "cancel:terminal:state");
		respondState(child, terminalState.frame);
		await untilSessionStatus(client.client, "idle");
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("idle");

		await closeClients([client.client]);
		await appserver.stop();
	});

	test("lifecycle mutations converge host-wide while events remain attached and archived sessions stay read-only", async () => {
		const values = [record("s1")];
		const authority = new FakeAuthority(values);
		const factory = new LiveFactory();
		const root = await mkdtemp(join(tmpdir(), "omp-lifecycle-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			childFactory: factory,
		});
		await appserver.start();
		const attached = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "sessions.prompt"]);
		const observer = await readyClient(appserver.socketPath, ["sessions.read"]);
		attached.client.sendJson(command("attach-lifecycle", "attach-lifecycle", "session.attach", "s1", {}));
		await responseAndSnapshot(attached.client, "attach-lifecycle");

		const initialRevision = appserver.snapshot(sid("s1"))!.revision;
		attached.client.sendJson({
			...command("archive", "archive", "session.archive", "s1", {}),
			expectedRevision: initialRevision,
		});
		const archived = await untilResponse(attached.client, "archive");
		expect(archived.frames.map(frame => frame.type)).toEqual(["event", "session.delta", "response"]);
		expect(archived.frames[0]).toMatchObject({ type: "event", event: { type: "session_archived" } });
		expect(archived.frames[1]).toMatchObject({
			type: "session.delta",
			upsert: { archivedAt: expect.stringMatching(/Z$/) },
		});
		expect(archived.response).toMatchObject({ ok: true, result: { archived: true } });
		const observerArchive = await observer.client.nextServer();
		expect(observerArchive).toMatchObject({ type: "session.delta", upsert: { archivedAt: expect.any(String) } });
		expect(authority.lifecycle).toEqual(["archive:s1"]);

		attached.client.sendJson(
			command("archived-prompt", "archived-prompt", "session.prompt", "s1", { message: "no" }),
		);
		const rejectedPrompt = await untilResponse(attached.client, "archived-prompt");
		expect(rejectedPrompt.frames).toHaveLength(1);
		expect(rejectedPrompt.response).toMatchObject({ ok: false, error: { code: "session_archived" } });
		expect(factory.children).toHaveLength(0);

		const archivedRevision = appserver.snapshot(sid("s1"))!.revision;
		attached.client.sendJson({
			...command("restore", "restore", "session.restore", "s1", {}),
			expectedRevision: archivedRevision,
		});
		const restored = await untilResponse(attached.client, "restore");
		expect(restored.frames.map(frame => frame.type)).toEqual(["event", "session.delta", "response"]);
		expect(restored.frames[0]).toMatchObject({ type: "event", event: { type: "session_restored" } });
		expect(restored.frames[1]).toMatchObject({ type: "session.delta", upsert: { sessionId: "s1" } });
		const restoredDelta = restored.frames[1];
		if (restoredDelta?.type !== "session.delta" || !restoredDelta.upsert)
			throw new Error("missing restore index delta");
		expect("archivedAt" in restoredDelta.upsert).toBe(false);
		expect((await observer.client.nextServer()).type).toBe("session.delta");

		attached.client.sendJson(command("state-before-delete", "state-before-delete", "session.state.get", "s1", {}));
		const child = await factory.child();
		await child.waitForWrites(1);
		const stateCommand = JSON.parse(child.writes[0]!) as { id: string };
		child.push({
			type: "response",
			id: stateCommand.id,
			command: "get_state",
			success: true,
			data: {
				isStreaming: false,
				isCompacting: false,
				isPaused: false,
				messageCount: 0,
				queuedMessageCount: 0,
				steeringMode: "one-at-a-time",
				followUpMode: "all",
				interruptMode: "wait",
			},
		});
		const state = await untilResponse(attached.client, "state-before-delete");
		expect(state.response.ok).toBe(true);
		if (state.frames.some(frame => frame.type === "session.delta"))
			expect((await observer.client.nextServer()).type).toBe("session.delta");

		const deleteRevision = appserver.snapshot(sid("s1"))!.revision;
		attached.client.sendJson({
			...command("delete", "delete", "session.delete", "s1", {}),
			expectedRevision: deleteRevision,
		});
		const challenge = await attached.client.nextServer();
		expect(challenge.type).toBe("confirmation");
		if (challenge.type !== "confirmation") throw new Error("missing delete confirmation");
		attached.client.sendJson(
			confirmFrame("delete-confirm", String(challenge.confirmationId), "delete", "approve", "s1"),
		);
		const deleted = await untilResponse(attached.client, "delete");
		expect(deleted.frames.map(frame => frame.type)).toEqual(["event", "session.delta", "response"]);
		expect(deleted.frames[0]).toMatchObject({ type: "event", event: { type: "session_deleted" } });
		expect(deleted.frames[1]).toMatchObject({ type: "session.delta", remove: "s1" });
		expect(deleted.response).toMatchObject({ ok: true, result: { deleted: true } });
		expect(await child.killed.promise).toBeUndefined();
		const observerDelete = await observer.client.nextServer();
		expect(observerDelete).toMatchObject({ type: "session.delta", remove: "s1" });
		expect(authority.lifecycle).toEqual(["archive:s1", "restore:s1", "delete:s1"]);

		attached.client.sendJson(command("attach-after-delete", "attach-lifecycle", "session.attach", "s1", {}));
		const attachAfterDelete = await untilResponse(attached.client, "attach-after-delete");
		expect(attachAfterDelete.frames).toHaveLength(1);
		expect(attachAfterDelete.response).toMatchObject({ ok: false, error: { code: "unknown_session" } });
		attached.client.sendJson({
			v: "omp-app/1",
			type: "ping",
			nonce: "after-deleted-attach-replay",
			timestamp: stamp,
		});
		expect(await attached.client.nextServer()).toMatchObject({
			type: "pong",
			nonce: "after-deleted-attach-replay",
		});

		const reconnected = await readyClient(appserver.socketPath, ["sessions.read"]);
		expect(reconnected.sessions).toMatchObject({
			hostId: host,
			sessions: [],
			totalCount: 0,
			truncated: false,
		});
		await closeClients([attached.client, observer.client, reconnected.client]);
		await appserver.stop();
	});

	test("active deletion is refused before challenge and failed metadata mutation emits no lifecycle frames", async () => {
		const values = [record("s1")];
		const authority = new FakeAuthority(values);
		const factory = new LiveFactory();
		const root = await mkdtemp(join(tmpdir(), "omp-lifecycle-guard-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			childFactory: factory,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "sessions.prompt"]);
		client.client.sendJson(command("attach-guard", "attach-guard", "session.attach", "s1", {}));
		await responseAndSnapshot(client.client, "attach-guard");
		client.client.sendJson(command("prompt-guard", "prompt-guard", "session.prompt", "s1", { message: "work" }));
		const child = await factory.child();
		await child.waitForWrites(1);
		await acceptedPromptPublication(client.client, "prompt-guard", "work");
		client.client.sendJson({
			...command("delete-active", "delete-active", "session.delete", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const refused = await client.client.nextServer();
		expect(refused).toMatchObject({ type: "response", ok: false, error: { code: "session_busy" } });
		expect(authority.lifecycle).toEqual([]);

		const prompt = JSON.parse(child.writes[0] ?? "{}") as { id?: string };
		if (!prompt.id) throw new Error("guard prompt RPC id missing");
		child.push({ type: "response", id: prompt.id, command: "prompt", success: true, data: { agentInvoked: true } });
		await untilResponse(client.client, "prompt-guard");
		await child.waitForWrites(2);
		const refreshCall = JSON.parse(child.writes[1] ?? "{}") as { id?: string };
		if (!refreshCall.id) throw new Error("scheduled state refresh RPC id missing");
		child.push({
			type: "response",
			id: refreshCall.id,
			command: "get_state",
			success: true,
			data: {
				isStreaming: false,
				isCompacting: false,
				isPaused: false,
				messageCount: 1,
				queuedMessageCount: 0,
				steeringMode: "one-at-a-time",
				followUpMode: "all",
				interruptMode: "wait",
			},
		});
		expect((await client.client.nextServer()).type).toBe("session.delta");
		child.push({ type: "agent_end", messages: [] });
		expect(await client.client.nextServer()).toMatchObject({ type: "event", event: { type: "agent.end" } });
		child.push({ type: "prompt_result", id: prompt.id, agentInvoked: true });
		const terminalState = await waitForRpcWriteId(child, "get_state", `${prompt.id}:terminal:state`);
		respondState(child, terminalState.frame);
		await untilSessionStatus(client.client, "idle");
		const agentEndState = await waitForRpcWriteId(child, "get_state", "agent-end:state");
		respondState(child, agentEndState.frame);
		authority.failLifecycle = true;
		client.client.sendJson({
			...command("archive-fail", "archive-fail", "session.archive", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const failed = await untilResponse(client.client, "archive-fail");
		expect(failed.frames).toHaveLength(1);
		expect(failed.response).toMatchObject({ ok: false, error: { code: "session_lifecycle_failed" } });
		expect(appserver.snapshot(sid("s1"))!.ref.archivedAt).toBeUndefined();
		await closeClients([client.client]);
		await appserver.stop();
	});

	test("a stale scheduled state refresh cannot resurrect streaming after agent end", async () => {
		const values = [record("s1")];
		const authority = new FakeAuthority(values);
		const factory = new LiveFactory();
		const root = await mkdtemp(join(tmpdir(), "omp-lifecycle-stale-state-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			childFactory: factory,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "sessions.prompt"]);
		client.client.sendJson(command("attach-stale-state", "attach-stale-state", "session.attach", "s1", {}));
		await responseAndSnapshot(client.client, "attach-stale-state");

		client.client.sendJson(
			command("prompt-stale-state", "prompt-stale-state", "session.prompt", "s1", { message: "work" }),
		);
		const child = await factory.child();
		await child.waitForWrites(1);
		await acceptedPromptPublication(client.client, "prompt-stale-state", "work");
		const promptCall = JSON.parse(child.writes[0]!) as { id: string; type: string };
		expect(promptCall.type).toBe("prompt");
		child.push({
			type: "response",
			id: promptCall.id,
			command: "prompt",
			success: true,
			data: { agentInvoked: true },
		});
		expect((await untilResponse(client.client, "prompt-stale-state")).response.ok).toBe(true);
		await child.waitForWrites(2);
		const refreshCall = child.writes
			.map(value => JSON.parse(value) as { id?: string; type?: string })
			.find(value => value.type === "get_state");
		if (!refreshCall?.id) throw new Error("scheduled state refresh RPC id missing");

		child.push({ type: "agent_end", messages: [] });
		expect(await client.client.nextServer()).toMatchObject({ type: "event", event: { type: "agent.end" } });
		child.push({ type: "prompt_result", id: promptCall.id, agentInvoked: true });
		const terminalState = await waitForRpcWriteId(child, "get_state", `${promptCall.id}:terminal:state`);
		respondState(child, terminalState.frame);
		await untilSessionStatus(client.client, "idle");
		child.push({
			type: "response",
			id: refreshCall.id,
			command: "get_state",
			success: true,
			data: {
				isStreaming: true,
				isCompacting: false,
				isPaused: false,
				messageCount: 1,
				queuedMessageCount: 0,
				steeringMode: "one-at-a-time",
				followUpMode: "all",
				interruptMode: "wait",
			},
		});
		const agentEndState = await waitForRpcWriteId(child, "get_state", "agent-end:state");
		respondState(child, agentEndState.frame);
		child.push({ type: "notice", level: "info", message: "stale-state-barrier" });
		const postTerminalFrames: ServerFrame[] = [];
		while (true) {
			const frame = await client.client.nextServer();
			postTerminalFrames.push(frame);
			if (frame.type === "event" && frame.event.type === "notice") break;
		}
		expect(postTerminalFrames).not.toContainEqual(
			expect.objectContaining({
				type: "session.delta",
				upsert: expect.objectContaining({ liveState: expect.objectContaining({ isStreaming: true }) }),
			}),
		);
		expect(appserver.snapshot(sid("s1"))?.ref.liveState?.isStreaming).not.toBe(true);

		client.client.sendJson({
			...command("archive-after-stale-state", "archive-after-stale-state", "session.archive", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const archived = await untilResponse(client.client, "archive-after-stale-state");
		expect(archived.response).toMatchObject({ ok: true, result: { archived: true } });
		expect(authority.lifecycle).toEqual(["archive:s1"]);

		await closeClients([client.client]);
		await appserver.stop();
	});

	test("agent end clears streaming state that a scheduled refresh already projected", async () => {
		const values = [record("s1")];
		const authority = new FakeAuthority(values);
		const factory = new LiveFactory();
		const root = await mkdtemp(join(tmpdir(), "omp-lifecycle-terminal-state-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			childFactory: factory,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "sessions.prompt"]);
		client.client.sendJson(command("attach-terminal-state", "attach-terminal-state", "session.attach", "s1", {}));
		await responseAndSnapshot(client.client, "attach-terminal-state");

		client.client.sendJson(
			command("prompt-terminal-state", "prompt-terminal-state", "session.prompt", "s1", { message: "work" }),
		);
		const child = await factory.child();
		await child.waitForWrites(1);
		await acceptedPromptPublication(client.client, "prompt-terminal-state", "work");
		const promptCall = JSON.parse(child.writes[0]!) as { id: string; type: string };
		expect(promptCall.type).toBe("prompt");
		child.push({
			type: "response",
			id: promptCall.id,
			command: "prompt",
			success: true,
			data: { agentInvoked: true },
		});
		expect((await untilResponse(client.client, "prompt-terminal-state")).response.ok).toBe(true);
		await child.waitForWrites(2);
		const refreshCall = child.writes
			.map(value => JSON.parse(value) as { id?: string; type?: string })
			.find(value => value.type === "get_state");
		if (!refreshCall?.id) throw new Error("scheduled state refresh RPC id missing");

		child.push({
			type: "response",
			id: refreshCall.id,
			command: "get_state",
			success: true,
			data: {
				isStreaming: true,
				isCompacting: false,
				isPaused: false,
				messageCount: 1,
				queuedMessageCount: 0,
				steeringMode: "one-at-a-time",
				followUpMode: "all",
				interruptMode: "wait",
			},
		});
		expect(await client.client.nextServer()).toMatchObject({
			type: "session.delta",
			upsert: expect.objectContaining({
				status: "active",
				liveState: expect.objectContaining({ isStreaming: true }),
			}),
		});

		child.push({ type: "agent_end", messages: [] });
		expect(await client.client.nextServer()).toMatchObject({ type: "event", event: { type: "agent.end" } });
		expect(await client.client.nextServer()).toMatchObject({
			type: "session.delta",
			upsert: { attention: { latestOutcome: { kind: "completed" } } },
		});
		const agentEndState = await waitForRpcWriteId(child, "get_state", "agent-end:state");
		respondState(child, agentEndState.frame);
		expect(await client.client.nextServer()).toMatchObject({
			type: "session.delta",
			upsert: expect.objectContaining({
				status: "active",
				liveState: expect.objectContaining({ isStreaming: false }),
			}),
		});
		expect(appserver.snapshot(sid("s1"))?.ref).toMatchObject({
			status: "active",
			liveState: expect.objectContaining({ isStreaming: false }),
		});
		child.push({ type: "prompt_result", id: promptCall.id, agentInvoked: true });
		const terminalState = await waitForRpcWriteId(child, "get_state", `${promptCall.id}:terminal:state`);
		respondState(child, terminalState.frame);
		await untilSessionStatus(client.client, "idle");

		client.client.sendJson({
			...command("archive-terminal-state", "archive-terminal-state", "session.archive", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const archived = await untilResponse(client.client, "archive-terminal-state");
		expect(archived.response).toMatchObject({ ok: true, result: { archived: true } });
		expect(authority.lifecycle).toEqual(["archive:s1"]);

		await closeClients([client.client]);
		await appserver.stop();
	});

	test("queued state and a pending non-streaming RPC both fail lifecycle operations closed", async () => {
		const values = [record("s1")];
		const authority = new FakeAuthority(values);
		const factory = new LiveFactory();
		const root = await mkdtemp(join(tmpdir(), "omp-lifecycle-pending-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			childFactory: factory,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage"]);
		client.client.sendJson({
			...command("rename-pending", "rename-pending", "session.rename", "s1", { name: "Renamed" }),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const child = await factory.child();
		await child.waitForWrites(1);
		client.client.sendJson({
			...command("archive-during-rpc", "archive-during-rpc", "session.archive", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const rpcBusy = await untilResponse(client.client, "archive-during-rpc");
		expect(rpcBusy.response).toMatchObject({ ok: false, error: { code: "session_busy" } });
		expect(authority.lifecycle).toEqual([]);

		const renameCall = JSON.parse(child.writes[0] ?? "{}") as { id?: string };
		if (!renameCall.id) throw new Error("rename RPC id missing");
		child.push({ type: "response", id: renameCall.id, command: "set_session_name", success: true, data: {} });
		expect((await untilResponse(client.client, "rename-pending")).response.ok).toBe(true);
		await child.waitForWrites(2);
		const stateCall = JSON.parse(child.writes[1] ?? "{}") as { id?: string };
		if (!stateCall.id) throw new Error("state RPC id missing");
		child.push({
			type: "response",
			id: stateCall.id,
			command: "get_state",
			success: true,
			data: {
				isStreaming: false,
				isCompacting: false,
				isPaused: false,
				messageCount: 1,
				queuedMessageCount: 1,
				queuedMessages: { steering: ["later"], followUp: [] },
				steeringMode: "one-at-a-time",
				followUpMode: "all",
				interruptMode: "wait",
			},
		});
		const queuedDelta = await client.client.nextServer();
		expect(queuedDelta).toMatchObject({
			type: "session.delta",
			upsert: { liveState: { queuedMessageCount: 1, queuedMessages: { steering: ["later"] } } },
		});
		client.client.sendJson({
			...command("archive-queued", "archive-queued", "session.archive", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const queuedBusy = await untilResponse(client.client, "archive-queued");
		expect(queuedBusy.response).toMatchObject({ ok: false, error: { code: "session_busy" } });
		expect(authority.lifecycle).toEqual([]);
		await closeClients([client.client]);
		await appserver.stop();
	});

	test("a deferred desktop write blocks archive until the write has fully settled", async () => {
		const values = [record("s1")];
		const authority = new FakeAuthority(values);
		const writeStarted = Promise.withResolvers<void>();
		const releaseWrite = Promise.withResolvers<void>();
		let writeFinished = false;
		const operationsAuthority: DesktopOperationsAuthority = {
			filesWrite: async () => {
				writeStarted.resolve();
				await releaseWrite.promise;
				writeFinished = true;
				return {};
			},
		};
		const root = await mkdtemp(join(tmpdir(), "omp-lifecycle-write-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			operationsAuthority,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "files.write"]);
		client.client.sendJson({
			...command("write", "write", "files.write", "s1", { path: "file.txt", content: "new" }),
			expectedRevision: "file-revision",
		});
		const writeChallenge = await client.client.nextServer();
		if (writeChallenge.type !== "confirmation") throw new Error("missing write confirmation");
		client.client.sendJson(
			confirmFrame("write-confirm", String(writeChallenge.confirmationId), "write", "approve", "s1"),
		);
		await writeStarted.promise;
		client.client.sendJson({
			...command("archive-during-write", "archive-during-write", "session.archive", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const busy = await untilResponse(client.client, "archive-during-write");
		expect(busy.response).toMatchObject({ ok: false, error: { code: "session_busy" } });
		expect(writeFinished).toBe(false);
		expect(authority.lifecycle).toEqual([]);

		releaseWrite.resolve();
		expect((await untilResponse(client.client, "write")).response.ok).toBe(true);
		expect(writeFinished).toBe(true);
		client.client.sendJson({
			...command("archive-after-write", "archive-after-write", "session.archive", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const archived = await untilResponse(client.client, "archive-after-write");
		expect(archived.response).toMatchObject({ ok: true, result: { archived: true } });
		expect(authority.lifecycle).toEqual(["archive:s1"]);
		await closeClients([client.client]);
		await appserver.stop();
	});

	test("deleting the last session closes its open terminal before removing the projection", async () => {
		const values = [record("s1")];
		const authority = new FakeAuthority(values);
		let closes = 0;
		const operationsAuthority: DesktopOperationsAuthority = {
			termOpen: async () => ({ terminalId: "term-last" }),
			terminalInput: async () => {},
			terminalResize: async () => {},
			terminalClose: async () => {
				closes++;
			},
		};
		const root = await mkdtemp(join(tmpdir(), "omp-lifecycle-terminal-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			operationsAuthority,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "term.open"]);
		client.client.sendJson(command("term-open", "term-open", "term.open", "s1", {}));
		const openChallenge = await client.client.nextServer();
		if (openChallenge.type !== "confirmation") throw new Error("missing terminal confirmation");
		client.client.sendJson(
			confirmFrame("term-open-confirm", String(openChallenge.confirmationId), "term-open", "approve", "s1"),
		);
		expect((await untilResponse(client.client, "term-open")).response).toMatchObject({
			ok: true,
			result: { terminalId: "term-last" },
		});

		client.client.sendJson({
			...command("delete-last", "delete-last", "session.delete", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const deleteChallenge = await client.client.nextServer();
		if (deleteChallenge.type !== "confirmation") throw new Error("missing delete confirmation");
		client.client.sendJson(
			confirmFrame("delete-last-confirm", String(deleteChallenge.confirmationId), "delete-last", "approve", "s1"),
		);
		const deleted = await untilResponse(client.client, "delete-last");
		expect(deleted.response).toMatchObject({ ok: true, result: { deleted: true } });
		expect(appserver.snapshot(sid("s1"))).toBeUndefined();
		expect(closes).toBe(1);
		await closeClients([client.client]);
		await appserver.stop();
		expect(closes).toBe(1);
	});

	test("a hung terminal close times out and releases the lifecycle fence", async () => {
		const values = [record("s1")];
		const authority = new FakeAuthority(values);
		const releaseClose = Promise.withResolvers<void>();
		let closeCalls = 0;
		const operationsAuthority: DesktopOperationsAuthority = {
			termOpen: async () => ({ terminalId: "term-hung" }),
			terminalInput: async () => {},
			terminalResize: async () => {},
			terminalClose: async () => {
				closeCalls++;
				await releaseClose.promise;
			},
		};
		const root = await mkdtemp(join(tmpdir(), "omp-lifecycle-terminal-timeout-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			operationsAuthority,
			lifecycleQuiesceTimeoutMs: 20,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "term.open"]);
		client.client.sendJson(command("term-hung", "term-hung", "term.open", "s1", {}));
		const challenge = await client.client.nextServer();
		if (challenge.type !== "confirmation") throw new Error("missing terminal confirmation");
		client.client.sendJson(
			confirmFrame("term-hung-confirm", String(challenge.confirmationId), "term-hung", "approve", "s1"),
		);
		expect((await untilResponse(client.client, "term-hung")).response.ok).toBe(true);

		client.client.sendJson({
			...command("archive-hung-term", "archive-hung-term", "session.archive", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const refused = await untilResponse(client.client, "archive-hung-term");
		expect(refused.response).toMatchObject({ ok: false, error: { code: "session_busy" } });
		expect(closeCalls).toBe(1);
		expect(authority.lifecycle).toEqual([]);

		client.client.sendJson(command("attach-after-timeout", "attach-after-timeout", "session.attach", "s1", {}));
		expect((await responseAndSnapshot(client.client, "attach-after-timeout"))[0].ok).toBe(true);
		releaseClose.resolve();
		await Bun.sleep(0);
		await closeClients([client.client]);
		await appserver.stop();
	});

	test("lifecycle quiesce escalates a graceful-stop timeout before mutating metadata", async () => {
		const values = [record("s1")];
		const authority = new FakeAuthority(values);
		const factory = new LiveFactory("forced");
		const root = await mkdtemp(join(tmpdir(), "omp-lifecycle-supervisor-force-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			childFactory: factory,
			lifecycleQuiesceTimeoutMs: 20,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "sessions.prompt"]);
		const child = await startIdleSessionRuntime(client.client, factory, "state-before-force");

		client.client.sendJson({
			...command("archive-force", "archive-force", "session.archive", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const archived = await untilResponse(client.client, "archive-force");
		expect(archived.response).toMatchObject({ ok: true, result: { archived: true } });
		expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(appserver.childFor(sid("s1"))).toBeUndefined();
		expect(authority.lifecycle).toEqual(["archive:s1"]);

		await closeClients([client.client]);
		await appserver.stop();
	});

	test("a crashed runtime becomes restartable before prompt while explicit close stays closed", async () => {
		const factory = new LiveFactory();
		const { appserver, path } = await liveServer(factory, [record("s1")]);
		const client = await readyClient(path, ["sessions.read", "sessions.manage", "sessions.prompt"]);
		const crashed = await startIdleSessionRuntime(client.client, factory, "state-before-crash-recovery");

		crashed.push({ invalid: true });
		const crashDelta = await client.client.nextServer();
		expect(crashDelta).toMatchObject({
			type: "session.delta",
			upsert: expect.objectContaining({
				status: "closed",
				liveState: expect.objectContaining({ runtimeCrashed: true }),
			}),
		});
		expect(await crashed.exited).toBe(0);
		const restartableDelta = await client.client.nextServer();
		expect(restartableDelta).toMatchObject({
			type: "session.delta",
			upsert: expect.objectContaining({
				status: "idle",
				liveState: expect.objectContaining({ runtimeCrashed: true }),
			}),
		});
		while (appserver.childFor(sid("s1"))) await Bun.sleep(1);
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("idle");

		client.client.sendJson(
			command("prompt-after-crash", "prompt-after-crash", "session.prompt", "s1", { message: "retry" }),
		);
		const respawned = await factory.childAt(1);
		await respawned.waitForWrites(1);
		const promptCall = JSON.parse(respawned.writes[0] ?? "{}") as { id?: string; type?: string };
		expect(promptCall.type).toBe("prompt");
		if (!promptCall.id) throw new Error("respawned prompt RPC id missing");
		respawned.push({
			type: "response",
			id: promptCall.id,
			command: "prompt",
			success: true,
			data: { agentInvoked: false },
		});
		const recovered = await untilResponse(client.client, "prompt-after-crash");
		expect(recovered.response.ok).toBe(true);
		expect(recovered.frames).toContainEqual(
			expect.objectContaining({
				type: "session.delta",
				upsert: expect.objectContaining({ status: "active" }),
			}),
		);
		const terminalState = await waitForRpcWriteId(respawned, "get_state", "prompt-after-crash:terminal:state");
		respondState(respawned, terminalState.frame);
		await untilSessionStatus(client.client, "idle");
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("idle");
		expect(appserver.snapshot(sid("s1"))?.ref.liveState).not.toHaveProperty("runtimeCrashed");

		client.client.sendJson({
			...command("explicit-close", "explicit-close", "session.close", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const challenge = await client.client.nextServer();
		expect(challenge.type).toBe("confirmation");
		if (challenge.type !== "confirmation") throw new Error("missing explicit close confirmation");
		client.client.sendJson(
			confirmFrame("explicit-close-confirm", String(challenge.confirmationId), "explicit-close", "approve", "s1"),
		);
		expect((await untilResponse(client.client, "explicit-close")).response.ok).toBe(true);
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("closed");

		client.client.sendJson(
			command("state-after-explicit-close", "state-after-explicit-close", "session.state.get", "s1", {}),
		);
		expect((await untilResponse(client.client, "state-after-explicit-close")).response.ok).toBe(false);
		expect(factory.children).toHaveLength(2);
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("closed");

		await closeClients([client.client]);
		await appserver.stop();
	});

	test("confirmed close reaps a forced busy child, settles working state, and permits archive", async () => {
		const values = [record("s1")];
		const authority = new FakeAuthority(values);
		const factory = new LiveFactory("forced");
		const root = await mkdtemp(join(tmpdir(), "omp-close-supervisor-force-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			childFactory: factory,
			lifecycleQuiesceTimeoutMs: 20,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "sessions.prompt"]);
		client.client.sendJson(
			command("state-before-close-force", "state-before-close-force", "session.state.get", "s1", {}),
		);
		const child = await factory.child();
		await child.waitForWrites(1);
		const stateCall = JSON.parse(child.writes[0] ?? "{}") as { id?: string };
		if (!stateCall.id) throw new Error("state RPC id missing");
		child.push({
			type: "response",
			id: stateCall.id,
			command: "get_state",
			success: true,
			data: {
				isStreaming: true,
				isCompacting: true,
				isPaused: false,
				messageCount: 3,
				queuedMessageCount: 2,
				queuedMessages: { steering: ["steer"], followUp: ["follow"] },
				steeringMode: "one-at-a-time",
				followUpMode: "all",
				interruptMode: "wait",
			},
		});
		expect((await untilResponse(client.client, "state-before-close-force")).response.ok).toBe(true);
		const working = appserver.snapshot(sid("s1"));
		if (!working) throw new Error("working projection missing");
		working.ref = {
			...working.ref,
			pendingApproval: true,
			pendingUserInput: true,
			liveState: {
				...working.ref.liveState,
				pendingApproval: true,
				pendingUserInput: true,
			},
		};

		client.client.sendJson({
			...command("close-force", "close-force", "session.close", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const challenge = await client.client.nextServer();
		expect(challenge.type).toBe("confirmation");
		if (challenge.type !== "confirmation") throw new Error("missing close confirmation");
		client.client.sendJson(
			confirmFrame("close-force-confirm", String(challenge.confirmationId), "close-force", "approve", "s1"),
		);
		const closed = await untilResponse(client.client, "close-force");
		expect(closed.response).toMatchObject({ ok: true, result: { closed: true } });
		expect(await child.exited).toBe(0);
		expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(appserver.childFor(sid("s1"))).toBeUndefined();
		expect(appserver.snapshot(sid("s1"))?.ref).toMatchObject({
			status: "closed",
			liveState: { isStreaming: false, isCompacting: false, queuedMessageCount: 0 },
		});
		expect(appserver.snapshot(sid("s1"))?.ref).not.toHaveProperty("pendingApproval");
		expect(appserver.snapshot(sid("s1"))?.ref).not.toHaveProperty("pendingUserInput");
		expect(appserver.snapshot(sid("s1"))?.ref.liveState).not.toHaveProperty("queuedMessages");
		expect(appserver.snapshot(sid("s1"))?.ref.liveState).not.toHaveProperty("pendingApproval");
		expect(appserver.snapshot(sid("s1"))?.ref.liveState).not.toHaveProperty("pendingUserInput");
		const closedOnce = appserver.snapshot(sid("s1"))!;
		const closedRevision = closedOnce.revision;
		const closedCursor = closedOnce.cursor.seq;
		const closedEventCount = closedOnce.ring.filter(
			frame => frame.type === "event" && frame.event.type === "session_closed",
		).length;

		client.client.sendJson({
			...command("close-force-again", "close-force-again", "session.close", "s1", {}),
			expectedRevision: closedRevision,
		});
		const secondChallenge = await client.client.nextServer();
		expect(secondChallenge.type).toBe("confirmation");
		if (secondChallenge.type !== "confirmation") throw new Error("missing second close confirmation");
		client.client.sendJson(
			confirmFrame(
				"close-force-again-confirm",
				String(secondChallenge.confirmationId),
				"close-force-again",
				"approve",
				"s1",
			),
		);
		expect((await untilResponse(client.client, "close-force-again")).response).toMatchObject({
			ok: true,
			result: { closed: true },
		});
		const closedTwice = appserver.snapshot(sid("s1"))!;
		expect(closedTwice.revision).toBe(closedRevision);
		expect(closedTwice.cursor.seq).toBe(closedCursor);
		expect(
			closedTwice.ring.filter(frame => frame.type === "event" && frame.event.type === "session_closed"),
		).toHaveLength(closedEventCount);

		client.client.sendJson({
			...command("archive-after-close", "archive-after-close", "session.archive", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const archived = await untilResponse(client.client, "archive-after-close");
		expect(archived.response).toMatchObject({ ok: true, result: { archived: true } });
		expect(authority.lifecycle).toEqual(["archive:s1"]);

		await closeClients([client.client]);
		await appserver.stop();
	});

	test("a throwing child kill rolls back explicit close and becomes restartable after exit", async () => {
		const factory = new LiveFactory("throwing");
		const root = await mkdtemp(join(tmpdir(), "omp-close-kill-throw-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: new FakeAuthority([record("s1")]),
			childFactory: factory,
			lifecycleQuiesceTimeoutMs: 5,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "sessions.prompt"]);
		const child = await startIdleSessionRuntime(client.client, factory, "state-before-kill-throw");

		client.client.sendJson({
			...command("close-kill-throw", "close-kill-throw", "session.close", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const challenge = await client.client.nextServer();
		expect(challenge.type).toBe("confirmation");
		if (challenge.type !== "confirmation") throw new Error("missing close confirmation");
		client.client.sendJson(
			confirmFrame(
				"close-kill-throw-confirm",
				String(challenge.confirmationId),
				"close-kill-throw",
				"approve",
				"s1",
			),
		);
		const refused = await untilResponse(client.client, "close-kill-throw");
		expect(refused.response).toMatchObject({ ok: false, error: { code: "session_busy" } });
		expect(refused.frames).toContainEqual(
			expect.objectContaining({
				type: "session.delta",
				upsert: expect.objectContaining({
					status: "closed",
					liveState: expect.objectContaining({ runtimeCrashed: true }),
				}),
			}),
		);
		expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(appserver.childFor(sid("s1"))).toBe(child);

		child.release();
		expect(await child.exited).toBe(0);
		const restartable = await client.client.nextServer();
		expect(restartable).toMatchObject({
			type: "session.delta",
			upsert: expect.objectContaining({
				status: "idle",
				liveState: expect.objectContaining({ runtimeCrashed: true }),
			}),
		});
		expect(appserver.childFor(sid("s1"))).toBeUndefined();

		client.client.sendJson(
			command("state-after-kill-throw", "state-after-kill-throw", "session.state.get", "s1", {}),
		);
		const respawned = await factory.childAt(1);
		await respawned.waitForWrites(1);
		const stateCall = JSON.parse(respawned.writes[0] ?? "{}") as { id?: string };
		if (!stateCall.id) throw new Error("respawned state RPC id missing");
		respawned.push({
			type: "response",
			id: stateCall.id,
			command: "get_state",
			success: true,
			data: {
				isStreaming: false,
				isCompacting: false,
				isPaused: false,
				messageCount: 0,
				queuedMessageCount: 0,
				steeringMode: "one-at-a-time",
				followUpMode: "all",
				interruptMode: "wait",
			},
		});
		expect((await untilResponse(client.client, "state-after-kill-throw")).response.ok).toBe(true);
		expect(appserver.snapshot(sid("s1"))?.ref).toMatchObject({ status: "idle" });
		expect(appserver.snapshot(sid("s1"))?.ref.liveState).not.toHaveProperty("runtimeCrashed");

		respawned.release();
		await respawned.exited;
		await closeClients([client.client]);
		await appserver.stop();
	});

	test("archive observes a real RPC child's lock release after lifecycle quiesce", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-lifecycle-real-lock-live-"));
		const sessionPath = join(root, "session.jsonl");
		await writeFile(sessionPath, `${JSON.stringify({ type: "session", id: "s1", cwd: root })}\n`);
		const session = record("s1");
		session.path = sessionPath;
		session.cwd = root;
		const authority = new FakeAuthority([session]);
		const factory = new BunRpcChildFactory({ executable: process.execPath, prefixArgv: [RPC_LOCK_CHILD] });
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			childFactory: factory,
			lockCheck: appserverLockCheck,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "sessions.prompt"]);

		client.client.sendJson(
			command("real-lock-prompt", "real-lock-prompt", "session.prompt", "s1", { message: "done" }),
		);
		const prompted = await untilResponse(client.client, "real-lock-prompt");
		expect(prompted.response).toMatchObject({ ok: true, result: { accepted: true } });
		await untilSessionStatus(client.client, "idle");
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("idle");

		// Drain the prompt's scheduled state refresh through a correlated state
		// request before asking lifecycle management to quiesce the idle child.
		client.client.sendJson(command("real-lock-state", "real-lock-state", "session.state.get", "s1", {}));
		expect((await untilResponse(client.client, "real-lock-state")).response.ok).toBe(true);
		expect(inspectSessionLock(sessionPath)).toMatchObject({ status: "live", processAlive: true });

		client.client.sendJson({
			...command("real-lock-archive", "real-lock-archive", "session.archive", "s1", {}),
			expectedRevision: appserver.snapshot(sid("s1"))!.revision,
		});
		const archived = await untilResponse(client.client, "real-lock-archive");
		expect(archived.response).toMatchObject({ ok: true, result: { archived: true } });
		expect(inspectSessionLock(sessionPath).status).toBe("missing");
		expect(appserver.childFor(sid("s1"))).toBeUndefined();
		expect(authority.lifecycle).toEqual(["archive:s1"]);

		await closeClients([client.client]);
		await appserver.stop();
	});

	test("a real RPC child releases its session lock when stdin reaches EOF", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-rpc-eof-lock-live-"));
		const sessionPath = join(root, "session.jsonl");
		await writeFile(sessionPath, `${JSON.stringify({ type: "session", id: "s1", cwd: root })}\n`);
		const child = Bun.spawn([process.execPath, RPC_LOCK_CHILD, "--session", sessionPath], {
			cwd: root,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = child.stdout.getReader();
		let ready = "";
		while (!ready.includes("\n")) {
			const chunk = await reader.read();
			if (chunk.done) break;
			ready += new TextDecoder().decode(chunk.value);
		}
		reader.releaseLock();
		expect(JSON.parse(ready.trim())).toEqual({ type: "ready" });
		expect(inspectSessionLock(sessionPath)).toMatchObject({ status: "live", processAlive: true });

		await child.stdin.end();
		expect(await child.exited).toBe(0);
		expect(inspectSessionLock(sessionPath).status).toBe("missing");
	});

	test("a child that survives forced termination stays owned and blocks lifecycle retries", async () => {
		const values = [record("s1")];
		const authority = new FakeAuthority(values);
		const factory = new LiveFactory("manual");
		const root = await mkdtemp(join(tmpdir(), "omp-lifecycle-supervisor-stuck-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			childFactory: factory,
			lifecycleQuiesceTimeoutMs: 20,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "sessions.prompt"]);
		const child = await startIdleSessionRuntime(client.client, factory, "state-before-stuck");
		const revision = appserver.snapshot(sid("s1"))!.revision;

		for (const requestId of ["archive-stuck-first", "archive-stuck-retry"]) {
			client.client.sendJson({
				...command(requestId, requestId, "session.archive", "s1", {}),
				expectedRevision: revision,
			});
			const refused = await untilResponse(client.client, requestId);
			expect(refused.response).toMatchObject({ ok: false, error: { code: "session_busy" } });
			expect(appserver.childFor(sid("s1"))).toBe(child);
			expect(authority.lifecycle).toEqual([]);
		}
		expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);

		child.release();
		client.client.sendJson({
			...command("archive-after-exit", "archive-after-exit", "session.archive", "s1", {}),
			expectedRevision: revision,
		});
		const archived = await untilResponse(client.client, "archive-after-exit");
		expect(archived.response).toMatchObject({ ok: true, result: { archived: true } });
		expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);
		expect(appserver.childFor(sid("s1"))).toBeUndefined();
		expect(authority.lifecycle).toEqual(["archive:s1"]);

		await closeClients([client.client]);
		await appserver.stop();
	});

	test("an opposite lifecycle request cannot report a no-op success while archive is in flight", async () => {
		const values = [record("s1")];
		const authority = new FakeAuthority(values);
		const archiveStarted = Promise.withResolvers<void>();
		const releaseArchive = Promise.withResolvers<void>();
		authority.archive = async (session, archivedAt) => {
			archiveStarted.resolve();
			await releaseArchive.promise;
			authority.lifecycle.push(`archive:${session.sessionId}`);
			session.archivedAt = archivedAt;
		};
		const root = await mkdtemp(join(tmpdir(), "omp-lifecycle-opposite-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage"]);
		const initialRevision = appserver.snapshot(sid("s1"))!.revision;
		client.client.sendJson({
			...command("archive-slow", "archive-slow", "session.archive", "s1", {}),
			expectedRevision: initialRevision,
		});
		await archiveStarted.promise;
		client.client.sendJson({
			...command("restore-racing", "restore-racing", "session.restore", "s1", {}),
			expectedRevision: initialRevision,
		});
		const refused = await untilResponse(client.client, "restore-racing");
		expect(refused.response).toMatchObject({ ok: false, error: { code: "session_busy" } });
		releaseArchive.resolve();
		expect((await untilResponse(client.client, "archive-slow")).response).toMatchObject({
			ok: true,
			result: { archived: true },
		});
		expect(appserver.snapshot(sid("s1"))?.ref.archivedAt).toBeDefined();
		await closeClients([client.client]);
		await appserver.stop();
	});

	test("confirmed close fences a second close and archive while quiescing the runtime", async () => {
		const values = [record("s1")];
		const authority = new FakeAuthority(values);
		const factory = new LiveFactory("manual");
		const root = await mkdtemp(join(tmpdir(), "omp-close-lifecycle-fence-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			childFactory: factory,
			lifecycleQuiesceTimeoutMs: 500,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "sessions.prompt"]);
		const child = await startIdleSessionRuntime(client.client, factory, "state-before-close-fence");
		const revision = appserver.snapshot(sid("s1"))!.revision;

		client.client.sendJson({
			...command("close-fence-first", "close-fence-first", "session.close", "s1", {}),
			expectedRevision: revision,
		});
		const firstChallenge = await client.client.nextServer();
		expect(firstChallenge.type).toBe("confirmation");
		if (firstChallenge.type !== "confirmation") throw new Error("missing first close confirmation");
		client.client.sendJson({
			...command("close-fence-second", "close-fence-second", "session.close", "s1", {}),
			expectedRevision: revision,
		});
		const secondChallenge = await client.client.nextServer();
		expect(secondChallenge.type).toBe("confirmation");
		if (secondChallenge.type !== "confirmation") throw new Error("missing second close confirmation");

		client.client.sendJson(
			confirmFrame(
				"close-fence-first-confirm",
				String(firstChallenge.confirmationId),
				"close-fence-first",
				"approve",
				"s1",
			),
		);
		await child.killed.promise;
		client.client.sendJson({
			...command("archive-during-close", "archive-during-close", "session.archive", "s1", {}),
			expectedRevision: revision,
		});
		expect((await untilResponse(client.client, "archive-during-close")).response).toMatchObject({
			ok: false,
			error: { code: "session_busy" },
		});
		client.client.sendJson(
			confirmFrame(
				"close-fence-second-confirm",
				String(secondChallenge.confirmationId),
				"close-fence-second",
				"approve",
				"s1",
			),
		);
		expect((await untilResponse(client.client, "close-fence-second")).response).toMatchObject({
			ok: false,
			error: { code: "session_busy" },
		});

		child.release();
		expect((await untilResponse(client.client, "close-fence-first")).response).toMatchObject({
			ok: true,
			result: { closed: true },
		});
		expect(authority.lifecycle).toEqual([]);
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("closed");

		await closeClients([client.client]);
		await appserver.stop();
	});

	test("coalesces prompt and external promotion into one child", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-promotion-coalesce-"));
		const transcriptPath = join(root, "s1.jsonl");
		await replaceTranscript(transcriptPath, transcript("s1"));
		const gate = new Gate();
		const factory = new LiveFactory("graceful", undefined, { entryCount: 0, lastEntryId: null });
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			discovery: new StaticDiscovery([{ ...record("s1"), path: transcriptPath }]),
			childFactory: factory,
			lockCheck: () => gate.lock(),
			lockStatus: () => "missing",
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.prompt"]);
		try {
			client.client.sendJson(
				command("promotion-prompt", "promotion-prompt", "session.prompt", "s1", { message: "prompt" }),
			);
			await gate.started.promise;
			client.client.sendJson(command("promotion-attach", "promotion-attach", "session.attach", "s1", {}));
			gate.opened.resolve();
			const child = await factory.child();
			const prompt = await waitForRpcWrite(child, "prompt");
			child.push({ type: "response", id: prompt.frame.id, command: "prompt", success: true, data: {} });
			const first = await untilResponse(client.client, "promotion-prompt");
			expect(first.response.ok).toBe(true);
			const second = await untilResponse(client.client, "promotion-attach");
			expect(second.response.ok).toBe(true);
			expect(factory.children).toHaveLength(1);
		} finally {
			await closeClients([client.client]);
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("ready then immediate child exit never publishes writable state", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-promotion-exit-"));
		const factory = new LiveFactory("ready-exits", undefined, { entryCount: 0, lastEntryId: null });
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			discovery: new StaticDiscovery([record("s1")]),
			childFactory: factory,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.prompt"]);
		try {
			client.client.sendJson(command("exit-prompt", "exit-prompt", "session.prompt", "s1", { message: "prompt" }));
			const child = await factory.child();
			await child.exited;
			expect((await untilResponse(client.client, "exit-prompt")).response.ok).toBe(false);
			expect(appserver.childFor(sid("s1"))).toBeUndefined();
			expect(appserver.snapshot(sid("s1"))?.ref.liveState?.sessionControl).toBeUndefined();
		} finally {
			await closeClients([client.client]);
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("promotion final poll requires matching child watermark and live child", async () => {
		const cases = [
			["matching", "graceful", { entryCount: 1, lastEntryId: "last" }, true],
			["mismatched", "graceful", { entryCount: 0, lastEntryId: null }, false],
			["ready-exits", "ready-exits", { entryCount: 1, lastEntryId: "last" }, false],
		] as const;
		for (const [label, exitMode, readyWatermark, writable] of cases) {
			const root = await mkdtemp(join(tmpdir(), `omp-promotion-final-${label}-`));
			const transcriptPath = join(root, "s1.jsonl");
			await replaceTranscript(transcriptPath, transcript("s1"));
			let lockStatus: "live" | "missing" = "live";
			const factory = new LiveFactory(exitMode, undefined, readyWatermark);
			const appserver = createAppserver({
				hostId: host,
				epoch,
				socketPath: join(root, "app.sock"),
				discovery: new StaticDiscovery([{ ...record("s1"), path: transcriptPath }]),
				childFactory: factory,
				lockStatus: () => lockStatus,
				lockCheck: () => {},
			});
			await appserver.start();
			const client = await readyClient(appserver.socketPath, ["sessions.read"]);
			const attach = async (name: string) => {
				client.client.sendJson(command(name, name, "session.attach", "s1", {}));
				expect((await untilResponse(client.client, name)).response.ok).toBe(true);
				await client.client.nextServer();
			};
			try {
				await attach(`${label}-a`);
				await replaceTranscript(transcriptPath, transcriptWithEntry("s1"));
				lockStatus = "missing";
				await attach(`${label}-b`);
				await attach(`${label}-c`);
				if (exitMode === "ready-exits") await (await factory.child()).exited;
				const control = appserver.snapshot(sid("s1"))?.ref.liveState?.sessionControl;
				if (writable) expect(control).toBeUndefined();
				else expect(control).toMatchObject({ mode: "reconciling" });
				if (factory.children.length !== 1)
					throw new Error(`${label}: expected one promoted child, got ${factory.children.length}`);
				if (writable) expect(appserver.snapshot(sid("s1"))?.entries).toHaveLength(1);
			} finally {
				await closeClients([client.client]);
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		}
	});

	test("promotion stays reconciling for an unresolved tool call, then promotes after its result", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-promotion-pending-tool-"));
		const transcriptPath = join(root, "s1.jsonl");
		const toolCall = JSON.stringify({
			type: "message",
			id: "assistant-call",
			parentId: null,
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "pending-call", name: "read", arguments: { path: "file" } }],
			},
		});
		const toolResult = JSON.stringify({
			type: "message",
			id: "tool-result",
			parentId: null,
			timestamp: stamp,
			message: {
				role: "toolResult",
				toolCallId: "pending-call",
				content: [{ type: "text", text: "done" }],
			},
		});
		await replaceTranscript(transcriptPath, `${transcript("s1")}${toolCall}\n`);
		let lockStatus: "live" | "missing" = "live";
		const factory = new LiveFactory("graceful", undefined, { entryCount: 2, lastEntryId: "tool-result" });
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			discovery: new StaticDiscovery([{ ...record("s1"), path: transcriptPath }]),
			childFactory: factory,
			lockStatus: () => lockStatus,
			lockCheck: () => {},
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read"]);
		const attach = async (name: string) => {
			client.client.sendJson(command(name, name, "session.attach", "s1", {}));
			expect((await untilResponse(client.client, name)).response.ok).toBe(true);
			await client.client.nextServer();
		};
		try {
			await attach("pending-a");
			lockStatus = "missing";
			await attach("pending-b");
			await attach("pending-c");
			expect(factory.children).toHaveLength(0);
			expect(appserver.snapshot(sid("s1"))?.ref.liveState?.sessionControl).toMatchObject({ mode: "reconciling" });

			await replaceTranscript(transcriptPath, `${transcript("s1")}${toolCall}\n${toolResult}\n`);
			await attach("settled-a");
			await attach("settled-b");
			expect(factory.children).toHaveLength(1);
			expect(appserver.snapshot(sid("s1"))?.ref.liveState?.sessionControl).toBeUndefined();
			expect(appserver.snapshot(sid("s1"))?.entries.filter(entry => entry.kind === "tool-use")).toHaveLength(1);
		} finally {
			await closeClients([client.client]);
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("replacement with empty, title-only, or wrong-session content never promotes", async () => {
		const replacements = [
			["empty", ""],
			["title-only", `${JSON.stringify({ type: "title", v: 1, title: "Only title" })}\n`],
			["wrong-session", transcript("other")],
		] as const;
		for (const [label, replacement] of replacements) {
			const root = await mkdtemp(join(tmpdir(), `omp-promotion-${label}-`));
			const transcriptPath = join(root, "s1.jsonl");
			await replaceTranscript(transcriptPath, transcript("s1"));
			let lockStatus: "live" | "missing" = "live";
			const factory = new LiveFactory("graceful", undefined, { entryCount: 0, lastEntryId: null });
			const appserver = createAppserver({
				hostId: host,
				epoch,
				socketPath: join(root, "app.sock"),
				discovery: new StaticDiscovery([{ ...record("s1"), path: transcriptPath }]),
				childFactory: factory,
				lockStatus: () => lockStatus,
				lockCheck: () => {},
			});
			await appserver.start();
			const client = await readyClient(appserver.socketPath, ["sessions.read"]);
			try {
				client.client.sendJson(command(`${label}-attach-a`, `${label}-attach-a`, "session.attach", "s1", {}));
				expect((await untilResponse(client.client, `${label}-attach-a`)).response.ok).toBe(true);
				await client.client.nextServer();
				if (factory.children.length !== 0) throw new Error(`${label}: child appeared during live observer attach`);
				expect(appserver.snapshot(sid("s1"))?.ref.liveState?.sessionControl?.mode).toBe("observer");
				await replaceTranscript(transcriptPath, replacement);
				lockStatus = "missing";
				client.client.sendJson(command(`${label}-attach-b`, `${label}-attach-b`, "session.attach", "s1", {}));
				expect((await untilResponse(client.client, `${label}-attach-b`)).response.ok).toBe(true);
				await client.client.nextServer();
				if (factory.children.length !== 0)
					throw new Error(`${label}: invalid replacement promoted ${factory.children.length} child`);
			} finally {
				await closeClients([client.client]);
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		}
	});

	test("disconnect during attach leaves no child or observer runtime", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-observer-disconnect-"));
		const transcriptPath = join(root, "s1.jsonl");
		await replaceTranscript(transcriptPath, transcript("s1"));
		const inspected = Promise.withResolvers<void>();
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			discovery: new StaticDiscovery([{ ...record("s1"), path: transcriptPath }]),
			lockStatus: () => {
				inspected.resolve();
				return "live";
			},
			childFactory: new LiveFactory(),
		});
		await appserver.start();
		const disconnected = await readyClient(appserver.socketPath, ["sessions.read"]);
		try {
			disconnected.client.sendJson(command("disconnect-attach", "disconnect-attach", "session.attach", "s1", {}));
			await inspected.promise;
			disconnected.client.destroy();
			await disconnected.client.closed();
			expect(appserver.childFor(sid("s1"))).toBeUndefined();
			const reconnected = await readyClient(appserver.socketPath, ["sessions.read"]);
			try {
				reconnected.client.sendJson(
					command("disconnect-attach-retry", "disconnect-attach-retry", "session.attach", "s1", {}),
				);
				expect((await untilResponse(reconnected.client, "disconnect-attach-retry")).response.ok).toBe(true);
				await reconnected.client.nextServer();
				expect(appserver.snapshot(sid("s1"))?.ref.liveState?.sessionControl?.mode).toBe("observer");
			} finally {
				await closeClients([reconnected.client]);
			}
		} finally {
			await closeClients([disconnected.client]);
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("disconnect cleanup restarts cached attach observation", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-observer-reconnect-"));
		const transcriptPath = join(root, "s1.jsonl");
		await replaceTranscript(transcriptPath, transcript("s1"));
		let lockStatus: "live" | "missing" = "live";
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			discovery: new StaticDiscovery([{ ...record("s1"), path: transcriptPath }]),
			lockStatus: () => lockStatus,
			childFactory: new LiveFactory(),
		});
		await appserver.start();
		const first = await readyClient(appserver.socketPath, ["sessions.read"]);
		try {
			first.client.sendJson(command("cached-attach", "cached-attach", "session.attach", "s1", {}));
			expect((await untilResponse(first.client, "cached-attach")).response.ok).toBe(true);
			await first.client.nextServer();
			expect(appserver.snapshot(sid("s1"))?.ref.liveState?.sessionControl?.mode).toBe("observer");
			first.client.destroy();
			await first.client.closed();

			lockStatus = "missing";
			await replaceTranscript(transcriptPath, transcript("s1", "Replaced"));
			const second = await readyClient(appserver.socketPath, ["sessions.read"]);
			try {
				second.client.sendJson(command("cached-attach-replay", "cached-attach", "session.attach", "s1", {}));
				expect((await untilResponse(second.client, "cached-attach-replay")).response.ok).toBe(true);
				await second.client.nextServer();
				// The observer interval is the production reconnect trigger; wait for that real event, not a guessed state.
				await Bun.sleep(300);
				expect(appserver.snapshot(sid("s1"))?.ref.liveState?.sessionControl?.mode).toBe("reconciling");
			} finally {
				await closeClients([second.client]);
			}
		} finally {
			await closeClients([first.client]);
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("failed attach output leaves no observer", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-observer-attach-failure-"));
		const transcriptPath = join(root, "s1.jsonl");
		await replaceTranscript(transcriptPath, transcript("s1"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			discovery: new StaticDiscovery([{ ...record("s1"), path: transcriptPath }]),
			lockStatus: () => "live",
			childFactory: new LiveFactory(),
		});
		await appserver.start();
		const failed = await readyClient(appserver.socketPath, ["sessions.read"]);
		try {
			failed.client.sendJson(
				command("attach-bad-cursor", "attach-bad-cursor", "session.attach", "s1", { cursor: "bad" }),
			);
			expect(await failed.client.nextServer()).toMatchObject({ type: "error", code: "invalid_frame" });
			await failed.client.closed();
			expect(appserver.snapshot(sid("s1"))?.ref.liveState?.sessionControl).toBeUndefined();
			const valid = await readyClient(appserver.socketPath, ["sessions.read"]);
			try {
				valid.client.sendJson(command("attach-after-failure", "attach-after-failure", "session.attach", "s1", {}));
				expect((await untilResponse(valid.client, "attach-after-failure")).response.ok).toBe(true);
				await valid.client.nextServer();
				expect(appserver.snapshot(sid("s1"))?.ref.liveState?.sessionControl?.mode).toBe("observer");
			} finally {
				await closeClients([valid.client]);
			}
		} finally {
			await closeClients([failed.client]);
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("observer and reconciling sessions reject raw terminal mutations and state reads", async () => {
		for (const target of ["observer", "reconciling"] as const) {
			const root = await mkdtemp(join(tmpdir(), `omp-observer-barrier-${target}-`));
			const transcriptPath = join(root, "s1.jsonl");
			await replaceTranscript(transcriptPath, transcript("s1"));
			let lockStatus: "live" | "missing" = "live";
			const appserver = createAppserver({
				hostId: host,
				epoch,
				socketPath: join(root, "app.sock"),
				discovery: new StaticDiscovery([{ ...record("s1"), path: transcriptPath }]),
				lockStatus: () => lockStatus,
				childFactory: new LiveFactory(),
			});
			await appserver.start();
			const client = await readyClient(appserver.socketPath, ["sessions.read"]);
			try {
				client.client.sendJson(
					command(`barrier-attach-${target}`, `barrier-attach-${target}`, "session.attach", "s1", {}),
				);
				expect((await untilResponse(client.client, `barrier-attach-${target}`)).response.ok).toBe(true);
				await client.client.nextServer();
				if (target === "reconciling") {
					lockStatus = "missing";
					client.client.sendJson(command("barrier-reconcile", "barrier-reconcile", "session.attach", "s1", {}));
					expect((await untilResponse(client.client, "barrier-reconcile")).response.ok).toBe(true);
					await client.client.nextServer();
				}
				expect(appserver.snapshot(sid("s1"))?.ref.liveState?.sessionControl?.mode).toBe(target);
				client.client.sendJson({
					v: "omp-app/1",
					type: "terminal.input",
					hostId: host,
					sessionId: sid("s1"),
					terminalId: "terminal",
					data: "x",
				});
				expect(await client.client.nextServer()).toMatchObject({ type: "error", code: "SESSION_LOCKED" });
				client.client.sendJson(
					command(`barrier-state-${target}`, `barrier-state-${target}`, "session.state.get", "s1", {}),
				);
				expect((await untilResponse(client.client, `barrier-state-${target}`)).response).toMatchObject({
					ok: false,
					error: { code: "session_locked" },
				});
				expect(appserver.childFor(sid("s1"))).toBeUndefined();
			} finally {
				await closeClients([client.client]);
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		}
	});

	test("stale first attach publishes reconciling, rejects writes, and promotes only after lock removal", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-observer-stale-first-attach-"));
		const transcriptPath = join(root, "s1.jsonl");
		await replaceTranscript(transcriptPath, transcriptWithEntry("s1"));
		let lockStatus: "stale" | "missing" = "stale";
		const factory = new LiveFactory("graceful", undefined, { entryCount: 1, lastEntryId: "last" });
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			discovery: new StaticDiscovery([{ ...record("s1"), path: transcriptPath }]),
			childFactory: factory,
			lockStatus: () => lockStatus,
			lockCheck: () => {},
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.prompt"]);
		try {
			client.client.sendJson(command("stale-attach", "stale-attach", "session.attach", "s1", {}));
			const firstAttachFrames: ServerFrame[] = [];
			for (;;) {
				const frame = await client.client.nextServer();
				firstAttachFrames.push(frame);
				if (frame.type === "snapshot") break;
			}
			expect(firstAttachFrames).toContainEqual(expect.objectContaining({ type: "response", ok: true }));
			expect(firstAttachFrames).toContainEqual(
				expect.objectContaining({
					type: "session.delta",
					upsert: expect.objectContaining({
						liveState: expect.objectContaining({
							sessionControl: { mode: "reconciling", transcript: "live" },
						}),
					}),
				}),
			);
			expect(appserver.snapshot(sid("s1"))?.ref.liveState?.sessionControl).toMatchObject({
				mode: "reconciling",
			});
			expect(factory.children).toHaveLength(0);

			client.client.sendJson(
				command("stale-prompt", "stale-prompt", "session.prompt", "s1", { message: "blocked" }),
			);
			expect((await untilResponse(client.client, "stale-prompt")).response).toMatchObject({
				ok: false,
				error: { code: "session_locked" },
			});
			expect(factory.children).toHaveLength(0);
			client.client.sendJson({
				v: "omp-app/1",
				type: "terminal.input",
				hostId: host,
				sessionId: sid("s1"),
				terminalId: "stale-terminal",
				data: "blocked",
			});
			expect(await client.client.nextServer()).toMatchObject({ type: "error", code: "SESSION_LOCKED" });
			expect(factory.children).toHaveLength(0);

			lockStatus = "missing";
			client.client.sendJson(command("stale-removed", "stale-removed", "session.attach", "s1", {}));
			const removedAttachFrames: ServerFrame[] = [];
			for (;;) {
				const frame = await client.client.nextServer();
				removedAttachFrames.push(frame);
				if (frame.type === "snapshot") break;
			}
			expect(removedAttachFrames).toContainEqual(expect.objectContaining({ type: "response", ok: true }));
			expect(factory.children).toHaveLength(1);
			expect(appserver.snapshot(sid("s1"))?.ref.liveState?.sessionControl).toBeUndefined();
		} finally {
			await closeClients([client.client]);
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("session list reconciliation broadcasts newly discovered safe metadata", async () => {
		const records: SessionRecord[] = [{ ...record("s1"), title: "Session" }];
		const factory = new LiveFactory();
		let terminalCloses = 0;
		const operationsAuthority: DesktopOperationsAuthority = {
			termOpen: async () => ({ terminalId: "term-external" }),
			terminalInput: async () => {},
			terminalResize: async () => {},
			terminalClose: async () => {
				terminalCloses++;
			},
		};
		const root = await mkdtemp(join(tmpdir(), "omp-reconcile-live-"));
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			discovery: new StaticDiscovery(records),
			childFactory: factory,
			operationsAuthority,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.prompt", "term.open"]);
		const observer = await readyClient(appserver.socketPath, ["sessions.read"]);
		client.client.sendJson(command("attach-reconcile", "attach-reconcile", "session.attach", "s1", {}));
		await responseAndSnapshot(client.client, "attach-reconcile");

		records[0] = {
			...records[0]!,
			projectName: "tmp",
			title: "Discovered title",
			updatedAt: "2026-01-01T00:00:01.000Z",
		};
		client.client.sendJson(hostCommand("list-reconcile", "list-reconcile", "session.list", {}));
		const reconciled = await untilResponse(client.client, "list-reconcile");
		expect(reconciled.frames).toHaveLength(2);
		expect(reconciled.frames[0]).toMatchObject({
			type: "session.delta",
			upsert: { project: { projectId: "project-test", name: "tmp" }, title: "Discovered title" },
		});
		expect(reconciled.response).toMatchObject({
			ok: true,
			result: {
				sessions: [{ project: { projectId: "project-test", name: "tmp" }, title: "Discovered title" }],
			},
		});
		expect(await observer.client.nextServer()).toMatchObject({
			type: "session.delta",
			upsert: { sessionId: sid("s1"), title: "Discovered title" },
		});

		records[0] = {
			...records[0]!,
			projectName: "stale-project-name",
			title: "Stale discovered title",
			updatedAt: "2026-01-01T00:00:02.000Z",
		};
		client.client.sendJson(hostCommand("list-stale", "list-stale", "session.list", {}));
		const stale = await untilResponse(client.client, "list-stale");
		expect(stale.frames.map(frame => frame.type)).toEqual(["response"]);
		expect(appserver.snapshot(sid("s1"))?.ref).toMatchObject({
			project: { projectId: "project-test", name: "tmp" },
			title: "Discovered title",
		});

		records.push(record("s2"));
		client.client.sendJson(hostCommand("list-added", "list-added", "session.list", {}));
		const added = await untilResponse(client.client, "list-added");
		expect(added.frames[0]).toMatchObject({
			type: "session.delta",
			upsert: { sessionId: sid("s2") },
		});
		expect(await observer.client.nextServer()).toMatchObject({
			type: "session.delta",
			upsert: { sessionId: sid("s2") },
		});
		client.client.sendJson(command("attach-added", "attach-added", "session.attach", "s2", {}));
		await responseAndSnapshot(client.client, "attach-added");
		client.client.sendJson(command("term-added", "term-added", "term.open", "s2", {}));
		const terminalChallenge = await client.client.nextServer();
		if (terminalChallenge.type !== "confirmation") throw new Error("missing external terminal confirmation");
		client.client.sendJson(
			confirmFrame("term-added-confirm", String(terminalChallenge.confirmationId), "term-added", "approve", "s2"),
		);
		expect((await untilResponse(client.client, "term-added")).response.ok).toBe(true);
		client.client.sendJson(command("state-added", "state-added", "session.state.get", "s2", {}));
		const child = await factory.child();
		await child.waitForWrites(1);
		const stateCall = JSON.parse(child.writes[0] ?? "{}") as { id?: string };
		if (!stateCall.id) throw new Error("external session state RPC id missing");
		child.push({
			type: "response",
			id: stateCall.id,
			command: "get_state",
			success: true,
			data: {
				isStreaming: false,
				isCompacting: false,
				isPaused: false,
				messageCount: 0,
				queuedMessageCount: 0,
				steeringMode: "one-at-a-time",
				followUpMode: "all",
				interruptMode: "wait",
			},
		});
		const stateOutcome = await untilResponse(client.client, "state-added");
		for (const frame of stateOutcome.frames)
			if (frame.type === "session.delta") expect((await observer.client.nextServer()).type).toBe("session.delta");

		records.pop();
		client.client.sendJson(hostCommand("list-removed-first", "list-removed-first", "session.list", {}));
		const firstMiss = await untilResponse(client.client, "list-removed-first");
		expect(firstMiss.frames.map(frame => frame.type)).toEqual(["response"]);
		client.client.sendJson(hostCommand("list-removed-second", "list-removed-second", "session.list", {}));
		const removed = await untilResponse(client.client, "list-removed-second");
		expect(removed.frames[0]).toMatchObject({ type: "session.delta", remove: sid("s2") });
		expect(await observer.client.nextServer()).toMatchObject({ type: "session.delta", remove: sid("s2") });
		expect(await child.killed.promise).toBeUndefined();
		expect(terminalCloses).toBe(1);
		await closeClients([client.client, observer.client]);
		await appserver.stop();
	});

	test("revalidates project identity and directory availability immediately before session creation", async () => {
		const authority = new FakeAuthority();
		const root = await mkdtemp(join(tmpdir(), "omp-create-project-fence-live-"));
		const projectRoot = join(root, "project");
		await mkdir(projectRoot);
		let removeBeforeReturn = false;
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			projectRootForProject: async () => {
				if (removeBeforeReturn) await rm(projectRoot, { recursive: true, force: true });
				return projectRoot;
			},
		});
		try {
			await appserver.start();
			const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage"]);
			client.client.sendJson(
				hostCommand("create-mismatch", "create-mismatch", "session.create", {
					projectId: "project-mismatch",
				}),
			);
			const mismatch = await untilResponse(client.client, "create-mismatch");
			expect(mismatch.frames.map(frame => frame.type)).toEqual(["response"]);
			expect(mismatch.response.ok).toBe(false);
			expect(authority.createCalls).toBe(0);

			removeBeforeReturn = true;
			client.client.sendJson(
				hostCommand("create-removed", "create-removed", "session.create", {
					projectId: stableProjectId(projectRoot),
				}),
			);
			const removed = await untilResponse(client.client, "create-removed");
			expect(removed.frames.map(frame => frame.type)).toEqual(["response"]);
			expect(removed.response.ok).toBe(false);
			expect(authority.createCalls).toBe(0);
			await closeClients([client.client]);
		} finally {
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("canonicalizes a project resolver alias before session creation", async () => {
		const authority = new FakeAuthority();
		const root = await mkdtemp(join(tmpdir(), "omp-create-project-alias-live-"));
		const projectRoot = join(root, "project");
		const projectAlias = join(root, "project-alias");
		await mkdir(projectRoot);
		await symlink(projectRoot, projectAlias);
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			projectRootForProject: () => projectAlias,
		});
		try {
			await appserver.start();
			const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage"]);
			client.client.sendJson(
				hostCommand("create-alias", "create-alias", "session.create", {
					projectId: stableProjectId(projectAlias),
				}),
			);
			const outcome = await untilResponse(client.client, "create-alias");
			expect(outcome.response.ok).toBe(true);
			await expect(authority.created.promise).resolves.toEqual({
				cwd: await realpath(projectRoot),
				title: undefined,
			});
			await closeClients([client.client]);
		} finally {
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("created sessions publish project names and live fallback and explicit titles", async () => {
		const authority = new FakeAuthority();
		const factory = new LiveFactory();
		const root = await mkdtemp(join(tmpdir(), "omp-created-title-live-"));
		const authorityRoot = join(root, "authority");
		await mkdir(authorityRoot);
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			projectRootForProject: () => authorityRoot,
			childFactory: factory,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "sessions.prompt"]);
		client.client.sendJson(
			hostCommand("create-live", "create-live", "session.create", { projectId: stableProjectId(authorityRoot) }),
		);
		const createdOutcome = await untilResponse(client.client, "create-live");
		expect(createdOutcome.frames.map(frame => frame.type)).toEqual(["session.delta", "response"]);
		const created = createdOutcome.response;
		expect(created).toMatchObject({
			type: "response",
			ok: true,
			result: {
				session: {
					sessionId: "created",
					project: { projectId: expect.any(String), name: "authority" },
					title: "Session",
				},
			},
		});

		client.client.sendJson(command("attach-created", "attach-created", "session.attach", "created", {}));
		await responseAndSnapshot(client.client, "attach-created");
		client.client.sendJson(
			command("prompt-created", "prompt-created", "session.prompt", "created", { message: "First live request" }),
		);
		const child = await factory.child();
		await child.waitForWrites(1);
		const publication = await acceptedPromptPublication(client.client, "prompt-created", "First live request");
		if (publication.active.type !== "session.delta" || !publication.active.upsert)
			throw new Error("created prompt did not become active");
		expect(publication.active.upsert.project.name).toBe("authority");
		expect(publication.active.upsert.title).toBe("Session");
		child.push({
			type: "session_entry",
			entry: {
				id: "user-live",
				parentId: null,
				type: "message",
				timestamp: stamp,
				message: { role: "user", content: "First live request" },
			},
		});
		const userEntry = await client.client.nextServer();
		const fallbackTitle = await client.client.nextServer();
		expect(userEntry.type).toBe("entry");
		expect(fallbackTitle).toMatchObject({
			type: "session.delta",
			upsert: { project: { name: "authority" }, title: "First live request" },
		});
		child.push({
			type: "session_entry",
			entry: {
				id: "title-live",
				parentId: "user-live",
				type: "title_change",
				timestamp: stamp,
				title: "Explicit title",
			},
		});
		const explicitTitle = await client.client.nextServer();
		expect(explicitTitle).toMatchObject({
			type: "session.delta",
			upsert: { project: { name: "authority" }, title: "Explicit title" },
		});
		const prompt = JSON.parse(child.writes[0] ?? "{}") as { id?: string };
		if (!prompt.id) throw new Error("created prompt RPC id missing");
		child.push({
			type: "response",
			id: prompt.id,
			command: "prompt",
			success: true,
			data: { agentInvoked: false },
		});
		const prompted = await untilResponse(client.client, "prompt-created");
		expect(prompted.response.ok).toBe(true);
		const terminalState = await waitForRpcWriteId(child, "get_state", "prompt-created:terminal:state");
		respondState(child, terminalState.frame);
		await untilSessionStatus(client.client, "idle");

		const replayClient = await readyClient(appserver.socketPath, ["sessions.read"]);
		replayClient.client.sendJson(
			command("attach-created-replay", "attach-created-replay", "session.attach", "created", {
				cursor: { epoch, seq: 0 },
			}),
		);
		const replayResponse = await replayClient.client.nextServer();
		const replay = [
			await replayClient.client.nextServer(),
			await replayClient.client.nextServer(),
			await replayClient.client.nextServer(),
		];
		expect(replayResponse.type).toBe("response");
		expect(replay.map(frame => frame.type)).toEqual(["event", "entry", "event"]);
		await closeClients([client.client, replayClient.client]);
		await appserver.stop();
	});

	test("create without title uses authority, and prompt lock failure recovers status for retry", async () => {
		const authority = new FakeAuthority();
		const factory = new LiveFactory();
		const root = await mkdtemp(join(tmpdir(), "omp-authority-live-"));
		const authorityRoot = join(root, "authority");
		await mkdir(authorityRoot);
		const appserver = createAppserver({
			hostId: host,
			epoch,
			socketPath: join(root, "app.sock"),
			sessionAuthority: authority,
			projectRootForProject: () => authorityRoot,
			childFactory: factory,
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "sessions.prompt"]);
		client.client.sendJson(
			hostCommand("create", "create", "session.create", { projectId: stableProjectId(authorityRoot) }),
		);
		const createdOutcome = await untilResponse(client.client, "create");
		expect(createdOutcome.frames.map(frame => frame.type)).toEqual(["session.delta", "response"]);
		const created = createdOutcome.response;
		expect(created.type).toBe("response");
		expect((await authority.created.promise).title).toBeUndefined();
		if (created.type === "response") {
			expect(created.result).toMatchObject({
				session: {
					sessionId: "created",
					project: { projectId: expect.any(String), name: "authority" },
					title: "Session",
				},
			});
			expect(JSON.stringify(created.result)).not.toContain(authorityRoot);
		}
		await closeClients([client.client]);
		await appserver.stop();
		const failing = new LiveFactory();
		let fail = true;
		const lockApp = createAppserver({
			hostId: host,
			epoch: "lock",
			socketPath: join(root, "lock.sock"),
			discovery: new StaticDiscovery([record("s1")]),
			childFactory: failing,
			lockCheck: () => {
				if (fail) throw new Error("lock busy");
			},
		});
		await lockApp.start();
		const lockClient = await readyClient(lockApp.socketPath, ["sessions.read", "sessions.prompt"]);
		lockClient.client.sendJson(command("fail", "fail", "session.prompt", "s1", { message: "x" }));
		const failure = await untilResponse(lockClient.client, "fail");
		expect(failure.frames.map(frame => frame.type)).toEqual(["response"]);
		expect(failure.response.ok).toBe(false);
		expect(lockApp.snapshot(sid("s1"))?.ref.status).toBe("idle");
		fail = false;
		lockClient.client.sendJson(command("retry", "retry", "session.prompt", "s1", { message: "x" }));
		const child = await failing.child();
		await child.waitForWrites(1);
		responseFor(child, "prompt");
		const retried = await untilResponse(lockClient.client, "retry");
		expect(retried.response.ok).toBe(true);
		await closeClients([lockClient.client]);
		await lockApp.stop();
	});

	test("close rejects a stale pending-start revision, then prevents child resurrection", async () => {
		const gate = new Gate();
		const factory = new LiveFactory();
		const root = await mkdtemp(join(tmpdir(), "omp-close-lock-"));
		const appserver = createAppserver({
			hostId: host,
			epoch: "close-lock",
			socketPath: join(root, "app.sock"),
			discovery: new StaticDiscovery([record("s1")]),
			childFactory: factory,
			lockCheck: () => gate.lock(),
		});
		await appserver.start();
		const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "sessions.prompt"]);
		client.client.sendJson(command("attach", "attach", "session.attach", "s1", {}));
		const [, snapshot] = await responseAndSnapshot(client.client, "attach");
		client.client.sendJson(command("prompt", "prompt", "session.prompt", "s1", { message: "hold" }));
		await gate.started.promise;
		const close = command("close", "close", "session.close", "s1", {});
		(close as Record<string, unknown>).expectedRevision = snapshot.revision;
		client.client.sendJson(close);
		const closeChallenge = await client.client.nextServer();
		expect(closeChallenge.type).toBe("confirmation");
		if (closeChallenge.type === "confirmation") gate.opened.resolve();
		const active = await client.client.nextServer();
		expect(active).toMatchObject({ type: "session.delta", upsert: expect.objectContaining({ status: "active" }) });
		if (closeChallenge.type === "confirmation")
			client.client.sendJson(
				confirmFrame("approve-stale-close", String(closeChallenge.confirmationId), "close", "approve", "s1"),
			);
		const stale = await untilResponse(client.client, "close");
		expect(stale.response).toMatchObject({ ok: false, error: { code: "stale_revision" } });

		const currentClose = command("close-current", "close-current", "session.close", "s1", {});
		(currentClose as Record<string, unknown>).expectedRevision = appserver.snapshot(sid("s1"))!.revision;
		client.client.sendJson(currentClose);
		const currentChallenge = await client.client.nextServer();
		expect(currentChallenge.type).toBe("confirmation");
		if (currentChallenge.type === "confirmation")
			client.client.sendJson(
				confirmFrame(
					"approve-current-close",
					String(currentChallenge.confirmationId),
					"close-current",
					"approve",
					"s1",
				),
			);
		const outputs = await untilResponse(client.client, "close-current");
		expect(outputs.response).toMatchObject({ ok: true });
		expect(factory.children).toHaveLength(1);
		expect(await factory.children[0]!.killed.promise).toBeUndefined();
		expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("closed");
		await closeClients([client.client]);
		await appserver.stop();
	});
});
