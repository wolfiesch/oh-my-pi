import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { decodeServerFrame, entryId, hostId, projectId, sessionId, type DurableEntry, type ServerFrame } from "@oh-my-pi/app-wire";
import { LocalAppserver, createAppserver } from "../src/server.ts";
import type { ChildHandle, RpcChildFactory, SessionAuthority, SessionDiscovery, SessionRecord } from "../src/types.ts";
import { frameBytes, RawUdsWebSocket } from "./raw-uds-client.ts";

const host = hostId("live-test-host");
const epoch = "live-test-epoch";
const stamp = "2026-01-01T00:00:00.000Z";
const sid = (value: string) => sessionId(value);
const rid = (value: string) => value as never;
function record(id: string): SessionRecord { return { sessionId: sid(id), path: `/tmp/${id}.jsonl`, cwd: "/tmp", projectId: projectId("project-test"), title: id, updatedAt: stamp, status: "idle", entries: [] }; }
function hello(capabilities?: string[], authentication = false): Record<string, unknown> { return { v: "omp-app/1", type: "hello", protocol: { min: "omp-app/1", max: "omp-app/1" }, client: { name: "raw-test", version: "1", build: "test", platform: "linux" }, requestedFeatures: ["resume"], savedCursors: [], ...(capabilities ? { capabilities: { client: capabilities } } : {}), ...(authentication ? { authentication: { deviceId: "device", deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } } : {}) }; }
function command(requestId: string, commandId: string, name: string, session: string, args: Record<string, unknown>): Record<string, unknown> { return { v: "omp-app/1", type: "command", requestId: rid(requestId), commandId: rid(commandId), hostId: host, sessionId: sid(session), command: name, args }; }
function hostCommand(requestId: string, commandId: string, name: string, args: Record<string, unknown>): Record<string, unknown> { return { v: "omp-app/1", type: "command", requestId: rid(requestId), commandId: rid(commandId), hostId: host, command: name, args }; }
function confirmFrame(requestId: string, confirmationId: string, commandId: string, decision: "approve" | "deny", session?: string): Record<string, unknown> { return { v: "omp-app/1", type: "confirm", requestId: rid(requestId), confirmationId: rid(confirmationId), commandId: rid(commandId), hostId: host, ...(session ? { sessionId: sid(session) } : {}), decision }; }
class StaticDiscovery implements SessionDiscovery {
  constructor(private readonly values: SessionRecord[]) {}
  async list(): Promise<SessionRecord[]> { return this.values; }
}
class FakeAuthority implements SessionAuthority {
  readonly created = Promise.withResolvers<{ cwd: string; title?: string }>();
  constructor(private readonly values: SessionRecord[] = []) {}
  async list(): Promise<SessionRecord[]> { return this.values; }
  async create(cwd: string, title?: string) { this.created.resolve({ cwd, title }); return { sessionId: sid("created"), path: "/tmp/created.jsonl", cwd, title, entries: [] }; }
}
class Gate {
  readonly opened = Promise.withResolvers<void>();
  readonly started = Promise.withResolvers<void>();
  calls = 0;
  async lock(): Promise<void> { this.calls += 1; this.started.resolve(); await this.opened.promise; }
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

  test("projects nested OMP records into safe flat durable entries", async () => {
    const factory = new LiveFactory(); const { appserver, path } = await liveServer(factory, [record("s1")]);
    const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
    client.client.sendJson(command("attach-project", "attach-project", "session.attach", "s1", {})); await responseAndSnapshot(client.client, "attach-project");
    client.client.sendJson(command("prompt-project", "prompt-project", "session.prompt", "s1", { message: "go" }));
    const child = await factory.child(); await child.waitForWrites(1);
    child.push({ type: "session_entry", entry: { id: "init", parentId: null, type: "session_init", timestamp: stamp, systemPrompt: "hidden /home/lycaon/system", token: "secret" } });
    child.push({ type: "session_entry", entry: { id: "hidden", parentId: "init", type: "custom_message", timestamp: stamp, display: false, content: "hidden custom /home/lycaon/private", authorization: "secret" } });
    child.push({ type: "session_entry", entry: { id: "user", parentId: "hidden", type: "message", timestamp: stamp, message: { role: "user", content: "Inspect /home/lycaon/project" } } });
    child.push({ type: "session_entry", entry: { id: "assistant", parentId: "user", type: "message", timestamp: stamp, message: { role: "assistant", content: [{ type: "thinking", thinking: "I will inspect safely." }, { type: "toolCall", id: "call-1", name: "read", title: "Read file", arguments: { path: "/home/lycaon/project/src/app.ts", authorization: "secret" } }] } } });
    const beforeResult = [await client.client.nextServer(), await client.client.nextServer()];
    expect(beforeResult.every(frame => frame.type === "entry" && frame.entry.kind !== "tool-use")).toBe(true);
    child.push({ type: "session_entry", entry: { id: "result", parentId: "assistant", type: "message", timestamp: stamp, message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "contents from /home/lycaon/project/src/app.ts" }], isError: false } } });
    child.push({ type: "session_entry", entry: { id: "shown", parentId: "result", type: "custom_message", timestamp: stamp, display: true, attribution: "agent", content: "Visible note" } });
    responseFor(child, "prompt");
    const output = await untilResponse(client.client, "prompt-project");
    const entries = [...beforeResult, ...output.frames].filter(frame => frame.type === "entry");
    expect(entries.map(frame => frame.type === "entry" ? frame.entry.kind : "")).toEqual(["message", "message", "tool-use", "message"]);
    if (entries[0]?.type === "entry") expect(entries[0].entry.data).toEqual({ role: "user", text: "Inspect [path]" });
    if (entries[1]?.type === "entry") expect(entries[1].entry.data).toEqual({ role: "assistant", text: "", reasoning: "I will inspect safely." });
    if (entries[2]?.type === "entry") expect(entries[2].entry.data).toMatchObject({ toolCallId: "call-1", tool: "read", title: "Read file", ok: true, result: { output: "contents from [path]" } });
    if (entries[3]?.type === "entry") expect(entries[3].entry.data).toEqual({ role: "assistant", text: "Visible note" });
    expect(JSON.stringify(output.frames)).not.toContain("systemPrompt");
    expect(JSON.stringify(output.frames)).not.toContain("authorization");
    expect(JSON.stringify(output.frames)).not.toContain("/home/lycaon");
    await closeClients([client.client]); await appserver.stop();
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
    const staleOwner = "22222222-2222-4222-8222-222222222222";
    await writeFile(`${path}.owner`, JSON.stringify({ version: 2, ownerId: staleOwner, pid: 999999, backingName: `.appserver-${staleOwner}.sock`, device: 0, inode: 0 }), { mode: 0o600 });
    const a = createAppserver({ hostId: host, epoch: "owner-b", socketPath: path, discovery: new StaticDiscovery([]) }); const b = createAppserver({ hostId: host, epoch: "owner-c", socketPath: path, discovery: new StaticDiscovery([]) });
    const results = await Promise.allSettled([a.start(), b.start()]); expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); await a.stop(); await b.stop();
    await writeFile(`${path}.owner`, "not-json", { mode: 0o600 }); const malformed = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) }); await expect(malformed.start()).rejects.toThrow("malformed appserver");
    const foreignOwner = "33333333-3333-4333-8333-333333333333";
    await writeFile(`${path}.owner`, JSON.stringify({ version: 2, ownerId: foreignOwner, pid: 999999, backingName: `.appserver-${foreignOwner}.sock`, device: 0, inode: 0 }), { mode: 0o600 }); const cleanup = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) }); await cleanup.start(); await writeFile(`${path}.owner`, JSON.stringify({ version: 2, ownerId: foreignOwner, pid: 999999, backingName: `.appserver-${foreignOwner}.sock`, device: 0, inode: 0 }), { mode: 0o600 }); await cleanup.stop(); expect(await stat(`${path}.owner`)).toBeDefined();
  });
});
describe("WS command boundary, authority, confirmation, and lock lifecycle", () => {
  test("real WS dispatch enforces arguments, idempotency, and raw path validation", async () => {
    const factory = new LiveFactory(); const { appserver, path } = await liveServer(factory, [record("s1")]);
    const client = await readyClient(path, ["sessions.read", "sessions.prompt"]);
    client.client.sendJson(hostCommand("list-a", "list", "session.list", {})); client.client.sendJson(hostCommand("list-b", "list", "session.list", {}));
    const first = await client.client.nextServer(); const replay = await client.client.nextServer(); expect(first.type).toBe("response"); expect(replay.type).toBe("response");
    client.client.sendJson(hostCommand("conflict", "list", "session.list", { bad: true })); const conflict = await client.client.nextServer(); expect(conflict.type).toBe("response"); if (conflict.type === "response") expect(conflict.error?.code).toBe("idempotency_conflict");
    client.client.sendJson(command("bad-args", "bad-args", "session.prompt", "s1", { message: "ok", extra: true })); const badArgs = await client.client.nextServer(); expect(badArgs.type).toBe("response"); if (badArgs.type === "response") expect(badArgs.error?.code).toBe("invalid_frame");
    client.client.sendJson(command("big", "big", "session.prompt", "s1", { message: "x".repeat(65_537) })); const big = await client.client.nextServer(); expect(big.type).toBe("response"); if (big.type === "response") expect(big.error?.code).toBe("invalid_frame");
    await closeClients([client.client]); await appserver.stop();
    const pathServer = await liveServer(new LiveFactory(), [record("s1")]); const pathClient = await readyClient(pathServer.path, ["files.read"]);
    pathClient.client.sendRaw(frameBytes(1, new TextEncoder().encode(JSON.stringify({ v: "omp-app/1", type: "command", requestId: "bad-path-r", commandId: "bad-path-c", hostId: host, command: "files.read", sessionId: "s1", args: { path: "/etc/passwd" } })))); const pathResult = await pathClient.client.nextOrClose(); expect(pathResult?.opcode === 1 || pathResult?.opcode === 8 || pathResult === undefined).toBe(true); pathClient.client.destroy(); await pathClient.client.closed(); await pathServer.appserver.stop();
  });

  test("confirmation challenge is one-shot, connection-bound, expiry-aware, and gated by revision", async () => {
    const factory = new LiveFactory(); const { appserver, path } = await liveServer(factory, [record("s1")]);
    const owner = await readyClient(path, ["sessions.read", "sessions.manage"]); const other = await readyClient(path, ["sessions.read", "sessions.manage"]);
    owner.client.sendJson(command("attach-close", "attach-close", "session.attach", "s1", {})); const [, snapshot] = await responseAndSnapshot(owner.client, "attach-close");
    const close = command("close", "close", "session.close", "s1", {}); (close as Record<string, unknown>).expectedRevision = snapshot.revision; owner.client.sendJson(close);
    const challenge = await owner.client.nextServer(); expect(challenge.type).toBe("confirmation"); if (challenge.type !== "confirmation") throw new Error("missing challenge");
    expect(challenge.commandHash).toMatch(/^[0-9a-f]{64}$/); expect(factory.children).toHaveLength(0);
    other.client.sendJson(confirmFrame("wrong", String(challenge.confirmationId), "close", "approve", "s1")); const wrong = await other.client.nextServer(); expect(wrong.type).toBe("response"); if (wrong.type === "response") expect(wrong.error?.code).toBe("confirmation_invalid");
    owner.client.sendJson(confirmFrame("deny", String(challenge.confirmationId), "close", "deny", "s1")); const denied = await owner.client.nextServer(); expect(denied.type).toBe("response"); if (denied.type === "response") expect(denied.error?.code).toBe("confirmation_denied");
    const bypass = command("bypass", "bypass", "session.close", "s1", {}); (bypass as Record<string, unknown>).expectedRevision = snapshot.revision; (bypass as Record<string, unknown>).confirmationId = "random-confirmation"; owner.client.sendJson(bypass); const bypassResult = await owner.client.nextServer(); expect(bypassResult.type).toBe("response"); if (bypassResult.type === "response") expect(bypassResult.error?.code).toBe("confirmation_invalid"); expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("idle");
    owner.client.sendJson(confirmFrame("reuse", String(challenge.confirmationId), "close", "approve", "s1")); const reused = await owner.client.nextServer(); expect(reused.type).toBe("response"); if (reused.type === "response") expect(reused.error?.code).toBe("confirmation_invalid");
    const stale = command("stale-close", "stale-close", "session.close", "s1", {}); (stale as Record<string, unknown>).expectedRevision = "wrong-revision"; owner.client.sendJson(stale); const staleChallenge = await owner.client.nextServer(); expect(staleChallenge.type).toBe("confirmation"); if (staleChallenge.type === "confirmation") { owner.client.sendJson(confirmFrame("stale-approve", String(staleChallenge.confirmationId), "stale-close", "approve", "s1")); const staleResult = await owner.client.nextServer(); expect(staleResult.type).toBe("response"); if (staleResult.type === "response") expect(staleResult.error?.code).toBe("stale_revision"); }
    const valid = command("valid-close", "valid-close", "session.close", "s1", {}); (valid as Record<string, unknown>).expectedRevision = snapshot.revision; owner.client.sendJson(valid); const validChallenge = await owner.client.nextServer(); expect(validChallenge.type).toBe("confirmation"); if (validChallenge.type === "confirmation") { owner.client.sendJson(confirmFrame("valid-approve", String(validChallenge.confirmationId), "valid-close", "approve", "s1")); const approved = await untilResponse(owner.client, "valid-close"); expect(approved.response.ok).toBe(true); } expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("closed");
    const expiring = command("expire", "expire", "session.close", "s1", {}); (expiring as Record<string, unknown>).expectedRevision = snapshot.revision; owner.client.sendJson(expiring); const expiringChallenge = await owner.client.nextServer(); const originalNow = Date.now; Date.now = () => Number.MAX_SAFE_INTEGER; try { if (expiringChallenge.type === "confirmation") { owner.client.sendJson(confirmFrame("expired", String(expiringChallenge.confirmationId), "expire", "approve", "s1")); const expired = await owner.client.nextServer(); expect(expired.type).toBe("response"); if (expired.type === "response") expect(expired.error?.code).toBe("confirmation_invalid"); } } finally { Date.now = originalNow; }
    await closeClients([owner.client, other.client]); await appserver.stop();
  });

  test("create without title uses authority, and prompt lock failure recovers status for retry", async () => {
    const authority = new FakeAuthority(); const factory = new LiveFactory(); const root = await mkdtemp(join(tmpdir(), "omp-authority-live-")); const appserver = createAppserver({ hostId: host, epoch, socketPath: join(root, "app.sock"), sessionAuthority: authority, projectRootForProject: () => "/tmp/authority", childFactory: factory }); await appserver.start();
    const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "sessions.prompt"]); client.client.sendJson(hostCommand("create", "create", "session.create", { projectId: "project-authority" })); const created = await client.client.nextServer(); expect(created.type).toBe("response"); expect((await authority.created.promise).title).toBeUndefined(); if (created.type === "response") { expect(created.result).toMatchObject({ session: { sessionId: "created", project: { projectId: expect.any(String) } } }); expect(JSON.stringify(created.result)).not.toContain("/tmp/authority"); }
    await closeClients([client.client]); await appserver.stop();
    const failing = new LiveFactory(); let fail = true; const lockApp = createAppserver({ hostId: host, epoch: "lock", socketPath: join(root, "lock.sock"), discovery: new StaticDiscovery([record("s1")]), childFactory: failing, lockCheck: () => { if (fail) throw new Error("lock busy"); } }); await lockApp.start(); const lockClient = await readyClient(lockApp.socketPath, ["sessions.read", "sessions.prompt"]); lockClient.client.sendJson(command("fail", "fail", "session.prompt", "s1", { message: "x" })); const failure = await lockClient.client.nextServer(); expect(failure.type).toBe("response"); expect(lockApp.snapshot(sid("s1"))?.ref.status).toBe("idle"); fail = false; lockClient.client.sendJson(command("retry", "retry", "session.prompt", "s1", { message: "x" })); const child = await failing.child(); await child.waitForWrites(1); responseFor(child, "prompt"); const retried = await untilResponse(lockClient.client, "retry"); expect(retried.response.ok).toBe(true); await closeClients([lockClient.client]); await lockApp.stop();
  });

  test("close waits for a pending lock start, then prevents child resurrection", async () => {
    const gate = new Gate(); const factory = new LiveFactory(); const root = await mkdtemp(join(tmpdir(), "omp-close-lock-")); const appserver = createAppserver({ hostId: host, epoch: "close-lock", socketPath: join(root, "app.sock"), discovery: new StaticDiscovery([record("s1")]), childFactory: factory, lockCheck: () => gate.lock() }); await appserver.start();
    const client = await readyClient(appserver.socketPath, ["sessions.read", "sessions.manage", "sessions.prompt"]); client.client.sendJson(command("attach", "attach", "session.attach", "s1", {})); const [, snapshot] = await responseAndSnapshot(client.client, "attach"); client.client.sendJson(command("prompt", "prompt", "session.prompt", "s1", { message: "hold" })); await gate.started.promise;
    const close = command("close", "close", "session.close", "s1", {}); (close as Record<string, unknown>).expectedRevision = snapshot.revision; client.client.sendJson(close); const closeChallenge = await client.client.nextServer(); expect(closeChallenge.type).toBe("confirmation"); if (closeChallenge.type === "confirmation") client.client.sendJson(confirmFrame("approve-close", String(closeChallenge.confirmationId), "close", "approve", "s1")); gate.opened.resolve();
    const outputs = await untilResponse(client.client, "close"); expect(outputs.response.ok).toBe(true); expect(factory.children).toHaveLength(1); expect(appserver.snapshot(sid("s1"))?.ref.status).toBe("closed"); await closeClients([client.client]); await appserver.stop();
  });
});
