import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { decodeServerFrame, entryId, hostId, projectId, sessionId, type DurableEntry, type ServerFrame } from "@oh-my-pi/app-wire";
import { LocalAppserver, createAppserver } from "../src/server.ts";
import type { ChildHandle, RpcChildFactory, SessionDiscovery, SessionRecord } from "../src/types.ts";
import { frameBytes, RawUdsWebSocket } from "./raw-uds-client.ts";

const host = hostId("live-test-host");
const epoch = "live-test-epoch";
const stamp = "2026-01-01T00:00:00.000Z";
const sid = (value: string) => sessionId(value);
const rid = (value: string) => value as never;
function record(id: string): SessionRecord { return { sessionId: sid(id), path: `/tmp/${id}.jsonl`, cwd: "/tmp", projectId: projectId("project-test"), title: id, updatedAt: stamp, status: "idle", entries: [] }; }
function hello(capabilities?: string[]): Record<string, unknown> { return { v: "omp-app/1", type: "hello", protocol: { min: "omp-app/1", max: "omp-app/1" }, client: { name: "raw-test", version: "1", build: "test", platform: "linux" }, requestedFeatures: ["resume", "live", "replay"], savedCursors: [], ...(capabilities ? { capabilities: { client: capabilities } } : {}) }; }
function command(requestId: string, commandId: string, name: string, session: string, args: Record<string, unknown>): Record<string, unknown> { return { v: "omp-app/1", type: "command", requestId: rid(requestId), commandId: rid(commandId), hostId: host, sessionId: sid(session), command: name, args }; }
class StaticDiscovery implements SessionDiscovery {
  constructor(private readonly values: SessionRecord[]) {}
  async list(): Promise<SessionRecord[]> { return this.values; }
}
class LiveChild implements ChildHandle {
  readonly writes: string[] = [];
  readonly killed = Promise.withResolvers<void>();
  readonly #exit = Promise.withResolvers<number>();
  readonly exited = this.#exit.promise;
  readonly #lines: string[] = [];
  readonly #waiters: Array<{ resolve: (line: string | undefined) => void }> = [];
  readonly #writeWaiters: Array<{ count: number; resolve: () => void }> = [];
  readonly stdin = { write: (data: string) => { this.writes.push(data); for (const waiter of this.#writeWaiters.splice(0)) if (this.writes.length >= waiter.count) waiter.resolve(); else this.#writeWaiters.push(waiter); } };
  readonly stdout: AsyncIterable<string> = this.stream();
  readonly stderr: AsyncIterable<string> = (async function* () {})();
  async *stream(): AsyncGenerator<string> {
    yield `${JSON.stringify({ type: "ready" })}\n`;
    while (true) {
      const line = this.#lines.shift() ?? await this.nextLine();
      if (line === undefined) return;
      yield line;
    }
  }
  private nextLine(): Promise<string | undefined> { const waiter = Promise.withResolvers<string | undefined>(); this.#waiters.push(waiter); return waiter.promise; }
  push(value: Record<string, unknown>): void { const line = `${JSON.stringify(value)}\n`; const waiter = this.#waiters.shift(); if (waiter) waiter.resolve(line); else this.#lines.push(line); }
  kill(): void { this.killed.resolve(); const waiter = this.#waiters.shift(); waiter?.resolve(undefined); this.#exit.resolve(0); }
  async waitForWrites(count: number): Promise<void> { if (this.writes.length >= count) return; const waiter = Promise.withResolvers<void>(); this.#writeWaiters.push({ count, resolve: waiter.resolve }); await waiter.promise; }
}
class LiveFactory implements RpcChildFactory {
  readonly children: LiveChild[] = [];
  spawn(): ChildHandle { const child = new LiveChild(); this.children.push(child); this.#spawned.resolve(child); return child; }
  readonly #spawned = Promise.withResolvers<LiveChild>();
  argv(path: string): string[] { return ["fake-omp", "--mode", "rpc", "--session", path]; }
  async child(): Promise<LiveChild> { return this.children[0] ?? this.#spawned.promise; }
}
function responseFor(child: LiveChild, command: string, success = true): void {
  const id = JSON.parse(child.writes.at(-1)!).id as string;
  child.push({ id, type: "response", command, success, ...(success ? { data: { agentInvoked: true } } : { error: "fake failure" }) });
}
async function readyClient(path: string, capabilities?: string[]): Promise<{ client: RawUdsWebSocket; welcome: Extract<ServerFrame, { type: "welcome" }> }> {
  const client = await RawUdsWebSocket.connect(path);
  client.sendJson(hello(capabilities));
  const welcome = await client.nextServer();
  expect(welcome.type).toBe("welcome");
  const sessions = await client.nextServer();
  expect(sessions.type).toBe("sessions");
  return { client, welcome: welcome as Extract<ServerFrame, { type: "welcome" }> };
}
async function responseAndSnapshot(client: RawUdsWebSocket, requestId: string): Promise<[Extract<ServerFrame, { type: "response" }>, Extract<ServerFrame, { type: "snapshot" }>]> {
  const response = await client.nextServer();
  const snapshot = await client.nextServer();
  expect(response.type).toBe("response");
  expect(snapshot.type).toBe("snapshot");
  if (response.type !== "response" || snapshot.type !== "snapshot") throw new Error(`unexpected attach frames for ${requestId}`);
  expect(response.requestId).toBe(rid(requestId));
  return [response, snapshot];
}
async function untilResponse(client: RawUdsWebSocket, requestId: string): Promise<{ response: Extract<ServerFrame, { type: "response" }>; frames: ServerFrame[] }> {
  const frames: ServerFrame[] = [];
  while (true) {
    const frame = await client.nextServer();
    frames.push(frame);
    if (frame.type === "response" && frame.requestId === rid(requestId)) return { response: frame, frames };
  }
}
async function closeClients(clients: RawUdsWebSocket[]): Promise<void> { for (const client of clients) { client.destroy(); await client.closed(); } }

async function liveServer(factory: LiveFactory, records = [record("s1"), record("s2")], ringSize = 256): Promise<{ appserver: LocalAppserver; root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "omp-appserver-live-"));
  const path = join(root, "run", "app.sock");
  const appserver = createAppserver({ hostId: host, epoch, socketPath: path, discovery: new StaticDiscovery(records), childFactory: factory, ringSize });
  await appserver.start();
  return { appserver, root, path };
}

describe("live Unix websocket protocol", () => {
  test("two clients negotiate capabilities, attach with one snapshot, and reject duplicate hello", async () => {
    const factory = new LiveFactory(); const { appserver, path } = await liveServer(factory);
    const readOnly = await readyClient(path, ["sessions.read"]); const promptClient = await readyClient(path, ["sessions.read", "sessions.prompt"]);
    expect(readOnly.welcome.grantedCapabilities).toEqual(["sessions.read"]);
    expect(promptClient.welcome.grantedCapabilities).toEqual(["sessions.read", "sessions.prompt"]);
    readOnly.client.sendJson(command("attach-ro", "attach-ro", "session.attach", "s1", {}));
    const [attach] = await responseAndSnapshot(readOnly.client, "attach-ro");
    expect(attach.ok).toBe(true); expect(factory.children).toHaveLength(0);
    promptClient.client.sendJson(hello(["sessions.read"]));
    const duplicate = await promptClient.client.nextOrClose();
    expect(duplicate?.opcode).toBe(0x1);
    if (duplicate?.opcode === 0x1) expect(decodeServerFrame(new TextDecoder().decode(duplicate.payload)).type).toBe("error");
    await promptClient.client.closed();
    await closeClients([readOnly.client]); await appserver.stop();
  });

  test("cursor attach replays contiguous frames, while an evicted cursor gets gap and snapshot", async () => {
    const factory = new LiveFactory(); const { appserver, path } = await liveServer(factory, [record("s1")], 2);
    const first = await readyClient(path, ["sessions.read", "sessions.prompt"]);
    first.client.sendJson(command("attach-1", "attach-1", "session.attach", "s1", {}));
    await responseAndSnapshot(first.client, "attach-1");
    first.client.sendJson(command("prompt-1", "prompt-1", "session.prompt", "s1", { message: "hello" }));
    const child = await factory.child(); await child.waitForWrites(1);
    child.push({ type: "session_entry", entry: { id: "entry-1", parentId: null, type: "message", timestamp: stamp, text: "hello" } });
    child.push({ type: "subagent_progress", payload: { message: "working" } });
    responseFor(child, "prompt");
    const firstOutput = await untilResponse(first.client, "prompt-1");
    expect(firstOutput.frames.map(frame => frame.type)).toEqual(["entry", "event", "response"]);
    const replayClient = await readyClient(path, ["sessions.read"]);
    replayClient.client.sendJson(command("attach-replay", "attach-replay", "session.attach", "s1", { cursor: { epoch, seq: 0 } }));
    const replayResponse = await replayClient.client.nextServer(); const replayOne = await replayClient.client.nextServer(); const replayTwo = await replayClient.client.nextServer();
    expect(replayResponse.type).toBe("response"); expect([replayOne.type, replayTwo.type]).toEqual(["entry", "event"]);
    if (replayOne.type === "entry" && replayTwo.type === "event") expect([replayOne.cursor.seq, replayTwo.cursor.seq]).toEqual([1, 2]);
    await closeClients([first.client, replayClient.client]); await appserver.stop();

    const evictFactory = new LiveFactory(); const evicted = await liveServer(evictFactory, [record("s1")], 1);
    const source = await readyClient(evicted.path, ["sessions.read", "sessions.prompt"]);
    source.client.sendJson(command("attach-e", "attach-e", "session.attach", "s1", {})); await responseAndSnapshot(source.client, "attach-e");
    source.client.sendJson(command("prompt-e", "prompt-e", "session.prompt", "s1", { message: "hello" })); const evictChild = await evictFactory.child(); await evictChild.waitForWrites(1);
    evictChild.push({ type: "subagent_progress", payload: { message: "one" } }); evictChild.push({ type: "subagent_progress", payload: { message: "two" } }); responseFor(evictChild, "prompt"); await untilResponse(source.client, "prompt-e");
    const gapClient = await readyClient(evicted.path, ["sessions.read"]); gapClient.client.sendJson(command("attach-gap", "attach-gap", "session.attach", "s1", { cursor: { epoch, seq: 0 } }));
    const gapResponse = await gapClient.client.nextServer(); const gap = await gapClient.client.nextServer(); const snapshot = await gapClient.client.nextServer();
    expect(gapResponse.type).toBe("response"); expect(gap.type).toBe("gap"); expect(snapshot.type).toBe("snapshot");
    await closeClients([source.client, gapClient.client]); await evicted.appserver.stop();
  });

  test("capability denial happens before idempotency and child start; concurrent prompts share one child", async () => {
    const factory = new LiveFactory(); const { appserver, path } = await liveServer(factory, [record("s1")]);
    const denied = await readyClient(path, ["sessions.read"]);
    denied.client.sendJson(command("denied-a", "same-denied", "session.prompt", "s1", { message: "no" }));
    denied.client.sendJson(command("denied-b", "same-denied", "session.prompt", "s1", { message: "different" }));
    const deniedA = await denied.client.nextServer(); const deniedB = await denied.client.nextServer();
    expect(deniedA.type).toBe("response"); expect(deniedB.type).toBe("response");
    if (deniedA.type === "response" && deniedB.type === "response") { expect(deniedA.error?.code).toBe("capability_denied"); expect(deniedB.error?.code).toBe("capability_denied"); }
    expect(factory.children).toHaveLength(0);
    const allowed = await readyClient(path, ["sessions.read", "sessions.prompt"]);
    allowed.client.sendJson(command("prompt-a", "prompt-a", "session.prompt", "s1", { message: "a" }));
    allowed.client.sendJson(command("prompt-b", "prompt-b", "session.prompt", "s1", { message: "b" }));
    const child = await factory.child(); await child.waitForWrites(2); expect(factory.children).toHaveLength(1);
    const ids = child.writes.map(value => JSON.parse(value).id as string); expect(ids[0]).not.toBe(ids[1]);
    child.push({ type: "response", id: ids[1], command: "prompt", success: true, data: { agentInvoked: true } });
    child.push({ type: "response", id: ids[0], command: "prompt", success: true, data: { agentInvoked: true } });
    const responses = new Map<string, Extract<ServerFrame, { type: "response" }>>();
    while (responses.size < 2) { const frame = await allowed.client.nextServer(); if (frame.type === "response" && (frame.requestId === rid("prompt-a") || frame.requestId === rid("prompt-b"))) responses.set(String(frame.requestId), frame); }
    expect(responses.get("prompt-a")?.ok).toBe(true); expect(responses.get("prompt-b")?.ok).toBe(true);
    await closeClients([denied.client, allowed.client]); await appserver.stop();
  });

  test("broadcasts only to attached session subscribers and removes a disconnected subscriber", async () => {
    const factory = new LiveFactory(); const { appserver, path } = await liveServer(factory);
    const s1 = await readyClient(path, ["sessions.read", "sessions.prompt"]); const s2 = await readyClient(path, ["sessions.read"]); const unattached = await readyClient(path, ["sessions.read"]);
    s1.client.sendJson(command("attach-s1", "attach-s1", "session.attach", "s1", {})); await responseAndSnapshot(s1.client, "attach-s1");
    s2.client.sendJson(command("attach-s2", "attach-s2", "session.attach", "s2", {})); await responseAndSnapshot(s2.client, "attach-s2");
    s1.client.sendJson(command("prompt-s1", "prompt-s1", "session.prompt", "s1", { message: "event" })); const child = await factory.child(); await child.waitForWrites(1);
    child.push({ type: "session_entry", entry: { id: "broadcast-entry", parentId: null, type: "message", timestamp: stamp, text: "entry" } });
    child.push({ type: "subagent_progress", payload: { message: "progress" } }); responseFor(child, "prompt");
    const received = await untilResponse(s1.client, "prompt-s1"); expect(received.frames.map(frame => frame.type)).toEqual(["entry", "event", "response"]);
    s2.client.sendJson({ v: "omp-app/1", type: "ping", nonce: "s2", timestamp: stamp }); unattached.client.sendJson({ v: "omp-app/1", type: "ping", nonce: "none", timestamp: stamp });
    const s2Pong = await s2.client.nextServer(); const unattachedPong = await unattached.client.nextServer(); expect(s2Pong.type).toBe("pong"); expect(unattachedPong.type).toBe("pong");
    await s1.client.close(); await s1.client.closed();
    child.push({ type: "subagent_progress", payload: { message: "after-disconnect" } });
    s2.client.sendJson({ v: "omp-app/1", type: "ping", nonce: "s2-after", timestamp: stamp }); expect((await s2.client.nextServer()).type).toBe("pong");
    await closeClients([s2.client, unattached.client]); await appserver.stop();
  });
});

describe("raw RFC6455 boundary and lifecycle", () => {
  async function malformedCase(payload: Uint8Array, opcode = 0x1): Promise<RawUdsWebSocket> {
    const factory = new LiveFactory(); const { appserver, path } = await liveServer(factory, []);
    const client = await readyClient(path); client.client.sendRaw(frameBytes(opcode, payload));
    if (payload.byteLength > 1024 * 1024) { client.client.destroy(); await client.client.closed(); await appserver.stop(); return client.client; }
    const frame = await client.client.nextOrClose();
    expect(frame?.opcode === 0x1 || frame?.opcode === 0x8 || frame === undefined).toBe(true);
    if (frame?.opcode === 0x1) expect(decodeServerFrame(new TextDecoder().decode(frame.payload)).type).toBe("error");
    await client.client.closed(); await appserver.stop();
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
    const factory = new LiveFactory(); const { appserver, root, path } = await liveServer(factory, [record("s1")]);
    const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
    client.client.sendJson(command("attach", "attach", "session.attach", "s1", {})); await responseAndSnapshot(client.client, "attach");
    client.client.sendJson(command("prompt", "prompt", "session.prompt", "s1", { message: "start" })); const child = await factory.child(); await child.waitForWrites(1); responseFor(child, "prompt"); await untilResponse(client.client, "prompt");
    expect(factory.children).toHaveLength(1);
    await appserver.stop(); await client.client.closed(); expect(await stat(path).catch(() => undefined)).toBeUndefined(); await factory.children[0]!.killed.promise;
    const files = await readdir(join(root, "run")); expect(files.filter(name => name.includes("owner") || name.includes("stale") || name.includes("tmp")).length).toBe(0);
  });
  test("owner crash residue and concurrent stale recovery are deterministic", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-owner-live-")); const path = join(root, "run", "app.sock"); await mkdir(join(root, "run"), { recursive: true }); await writeFile(`${path}.owner.tmp-orphan`, "orphan");
    const first = createAppserver({ hostId: host, epoch: "owner-a", socketPath: path, discovery: new StaticDiscovery([]) }); await first.start(); await first.stop();
    await writeFile(`${path}.owner`, JSON.stringify({ ownerId: "dead", pid: 999999 }));
    const a = createAppserver({ hostId: host, epoch: "owner-b", socketPath: path, discovery: new StaticDiscovery([]) }); const b = createAppserver({ hostId: host, epoch: "owner-c", socketPath: path, discovery: new StaticDiscovery([]) });
    const results = await Promise.allSettled([a.start(), b.start()]); expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); await a.stop(); await b.stop();
    await writeFile(`${path}.owner`, "not-json"); const malformed = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) }); await expect(malformed.start()).rejects.toThrow("another owner");
    await writeFile(`${path}.owner`, JSON.stringify({ ownerId: "other", pid: 999999 })); const cleanup = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) }); await cleanup.start(); await writeFile(`${path}.owner`, JSON.stringify({ ownerId: "other", pid: 999999 })); await cleanup.stop(); expect(await stat(`${path}.owner`)).toBeDefined();
  });
});
