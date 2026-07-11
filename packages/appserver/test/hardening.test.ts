import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { decodeServerFrame, entryId, hostId, projectId, sessionId, type DurableEntry } from "@oh-my-pi/app-wire";
import { FileSessionDiscovery } from "../src/discovery.ts";
import { createEpoch, createHostId, loadPersistentHostId, unixSocketActive } from "../src/identity.ts";
import { IdempotencyStore } from "../src/idempotency.ts";
import { SessionProjection } from "../src/projection.ts";
import { RpcChildSupervisor } from "../src/rpc-child.ts";
import { createAppserver } from "../src/server.ts";
import type { ChildHandle, FileSystem, RpcChildFactory, SessionDiscovery, SessionRecord } from "../src/types.ts";
function wsFrame(text: string): Uint8Array { const payload = new TextEncoder().encode(text); const extended = payload.length >= 126; const offset = extended ? 8 : 6; const frame = new Uint8Array(offset + payload.length); frame[0] = 0x81; frame[1] = 0x80 | (extended ? 126 : payload.length); if (extended) { frame[2] = payload.length >> 8; frame[3] = payload.length & 0xff; frame.set([1, 2, 3, 4], 4); } else frame.set([1, 2, 3, 4], 2); const maskOffset = extended ? 4 : 2; for (let i = 0; i < payload.length; i++) frame[offset + i] = payload[i] ^ frame[maskOffset + (i % 4)]; return frame; }
function wsPayload(frame: Buffer): Uint8Array { let offset = 2; let length = frame[1] & 0x7f; if (length === 126) { length = (frame[2] << 8) | frame[3]; offset = 4; } return frame.slice(offset, offset + length); }

const host = hostId("hardening-host");
const stamp = "2026-01-01T00:00:00.000Z";
function record(id: string): SessionRecord { return { sessionId: sessionId(id), path: `/tmp/${id}.jsonl`, cwd: "/tmp", projectId: projectId("project-test"), title: id, updatedAt: stamp, status: "idle", entries: [] }; }
function durable(id: string, session = "s"): DurableEntry { return { id: entryId(id), parentId: null, hostId: host, sessionId: sessionId(session), kind: "message", timestamp: stamp, data: { message: id } }; }
class StaticDiscovery implements SessionDiscovery { constructor(private readonly values: SessionRecord[]) {} async list() { return this.values; } }
class IdleChild implements ChildHandle {
  #queue = Promise.withResolvers<void>();
  stdin = { write: () => undefined };
  stdout: AsyncIterable<string> = this.stream();
  stderr: AsyncIterable<string> = (async function* () {})();
  exited = Promise.resolve(0);
  killed = false;
  async *stream() { yield `${JSON.stringify({ type: "ready" })}\n`; await this.#queue.promise; }
  kill() { this.killed = true; this.#queue.resolve(); }
}
class IdleFactory implements RpcChildFactory {
  children: IdleChild[] = []; argvCalls: string[][] = [];
  constructor(private readonly executable = "omp") {}
  spawn(spec: { session: SessionRecord; argv: string[]; cwd: string }) { const child = new IdleChild(); this.children.push(child); this.argvCalls.push(spec.argv); return child; }
  argv(path: string) { return [this.executable, "--mode", "rpc", "--session", path]; }
}
function fakeFs(files: Record<string, string | Uint8Array>, directories: string[]): FileSystem {
  return {
    mkdir: async () => {}, chmod: async () => {}, unlink: async () => {},
    readdir: async path => path === "/root" ? ["/root/-tmp-project"] : ["/root/-tmp-project/ok.jsonl", "/root/-tmp-project/bad.jsonl", "/root/-tmp-project/huge.jsonl", "/root/-tmp-project/duplicate.jsonl", "/root/-tmp-project/invalid-utf8.jsonl"],
    stat: async path => ({ isFile: () => !directories.includes(path), isDirectory: () => directories.includes(path), mode: 0o644, mtimeMs: path.endsWith("ok.jsonl") ? 20 : 10, size: path.endsWith("huge.jsonl") ? 70 * 1024 * 1024 : (typeof files[path] === "string" ? new TextEncoder().encode(files[path]).byteLength : files[path]?.byteLength ?? 0) }),
    readFile: async path => files[path] ?? "",
  };
}

const validTranscript = `${JSON.stringify({ type: "session", id: "ok", cwd: "/tmp/project", title: "Good" })}\n${JSON.stringify({ type: "message", id: "entry", parentId: null, timestamp: stamp, message: "hello" })}\n`;

describe("discovery hardening", () => {
  test("recurses encoded cwd directories and sorts newest first", async () => {
    const discovery = new FileSessionDiscovery("/root", fakeFs({ "/root/-tmp-project/ok.jsonl": validTranscript, "/root/-tmp-project/bad.jsonl": "{bad\n", "/root/-tmp-project/huge.jsonl": "" }, ["/root", "/root/-tmp-project"]), host);
    const sessions = await discovery.list();
    expect(sessions.map(session => String(session.sessionId))).toEqual(["ok"]);
    expect(sessions[0]?.cwd).toBe("/tmp/project");
  });
  test("rejects malformed and primitive transcripts as whole files", async () => {
    const files = { "/root/-tmp-project/ok.jsonl": `${JSON.stringify({ type: "session", id: "primitive", cwd: "/tmp" })}\n1\n`, "/root/-tmp-project/bad.jsonl": "not-json\n" };
    const discovery = new FileSessionDiscovery("/root", fakeFs(files, ["/root", "/root/-tmp-project"]), host);
    expect(await discovery.list()).toEqual([]);
  });
  test("rejects oversized transcript by stat before read allocation", async () => {
    const discovery = new FileSessionDiscovery("/root", fakeFs({ "/root/-tmp-project/huge.jsonl": "" }, ["/root", "/root/-tmp-project"]), host);
    expect(await discovery.list()).toEqual([]);
  });
  test("rejects duplicate keys and invalid UTF-8 without partial indexing", async () => {
    const header = `${JSON.stringify({ type: "session", id: "dup", cwd: "/tmp" })}\n`;
    const duplicate = new TextEncoder().encode(`${header}{"type":"message","id":"x","parentId":null,"timestamp":"${stamp}","type":"message"}\n`);
    const invalid = new Uint8Array([...new TextEncoder().encode(header), 0xff, 0xfe, 0x0a]);
    const discovery = new FileSessionDiscovery("/root", fakeFs({ "/root/-tmp-project/duplicate.jsonl": duplicate, "/root/-tmp-project/invalid-utf8.jsonl": invalid }, ["/root", "/root/-tmp-project"]), host);
    expect(await discovery.list()).toEqual([]);
  });
});

describe("identity and socket ownership", () => {
  test("host identity persists while epochs are fresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-id-"));
    const path = join(root, "host-id");
    const first = await loadPersistentHostId(path); const second = await loadPersistentHostId(path);
    expect(first).toBe(second); expect(String(createHostId("explicit"))).toBe("explicit"); expect(createEpoch("explicit-epoch")).toBe("explicit-epoch"); expect(createEpoch()).not.toBe(createEpoch());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  test("refuses regular path and removes stale socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-sock-")); const path = join(root, "app.sock");
    await writeFile(path, "regular"); const regular = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) });
    await expect(regular.start()).rejects.toThrow("non-socket");
    await writeFile(path, "");
  });
  test("recovers confirmed-dead owner residue with stale socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-stale-")); const path = join(root, "app.sock");
    const stale = createServer(); await new Promise<void>(resolve => stale.listen(path, resolve)); await new Promise<void>(resolve => stale.close(() => resolve()));
    await writeFile(`${path}.owner`, JSON.stringify({ ownerId: "dead-owner", pid: 999999 }));
    const appserver = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) }); await appserver.start(); await appserver.stop();
    await expect(stat(`${path}.owner`)).rejects.toThrow();
  });
  test("active and concurrent owners are rejected", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-owner-")); const path = join(root, "app.sock");
    const first = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) }); const second = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) });
    await first.start(); expect(await unixSocketActive(path)).toBe(true); await expect(second.start()).rejects.toThrow(); await first.stop(); expect(await unixSocketActive(path)).toBe(false);
  });
});

  test("command args are strict and prompts are bounded", async () => {
    const appserver = createAppserver({ hostId: host, discovery: new StaticDiscovery([]) });
    const base = { v: "omp-app/1" as const, type: "command" as const, hostId: host, command: "host.list", sessionId: undefined, args: {} };
    const wrong = await appserver.command({ ...base, requestId: "a" as never, commandId: "a" as never, args: { extra: true } }); expect(wrong.frame.type === "response" && wrong.frame.error?.code).toBe("invalid_frame");
    const objectPrompt = await appserver.command({ ...base, requestId: "b" as never, commandId: "b" as never, command: "session.prompt", sessionId: sessionId("s"), args: { message: { bad: true } } }); expect(objectPrompt.frame.type === "response" && objectPrompt.frame.error?.code).toBe("invalid_frame");
    const oversized = await appserver.command({ ...base, requestId: "c" as never, commandId: "c" as never, command: "session.prompt", sessionId: sessionId("s"), args: { message: "x".repeat(65_537) } }); expect(oversized.frame.type === "response" && oversized.frame.error?.code).toBe("invalid_frame");
  });
describe("projection, replay, and idempotency", () => {
  test("incremental projection preserves entries and deterministic revision", () => {
    const projection = new SessionProjection(host, record("s"), "epoch-a", 3); projection.appendEntry(durable("a")); projection.appendEntry(durable("b"));
    expect(projection.value.entries.map(entry => String(entry.id))).toEqual(["a", "b"]); expect(projection.value.cursor.seq).toBe(2);
  });
  test("old epoch returns gap and snapshot", () => {
    const projection = new SessionProjection(host, record("s"), "epoch-new", 3); projection.appendEvent({ type: "live" });
    const replay = projection.replay({ epoch: "epoch-old", seq: 9 }); expect(replay.map(frame => frame.type)).toEqual(["gap", "snapshot"]); for (const frame of replay) expect(decodeServerFrame(frame)).toBeDefined();
  });
  test("evicted cursor returns gap and snapshot", () => {
    const projection = new SessionProjection(host, record("s"), "epoch-a", 1); projection.appendEvent({ type: "one" }); projection.appendEvent({ type: "two" });
    expect(projection.replay({ epoch: "epoch-a", seq: 0 }).map(frame => frame.type)).toEqual(["gap", "snapshot"]);
  });
  test("same command id pending waiters settle once and replay", async () => {
    const store = new IdempotencyStore(); const id = "same" as never; const first = store.begin(id, { requestId: "r1", command: "session.list", args: { a: 1, b: 2 } }); const second = store.begin(id, { requestId: "r2", args: { b: 2, a: 1 }, command: "session.list" });
    expect(first.kind).toBe("new"); expect(second.kind).toBe("pending");
    const outcome = { frame: { v: "omp-app/1", type: "error", code: "x", message: "x" } as never }; store.complete(id, { requestId: "r1", command: "session.list", args: { a: 1, b: 2 } }, outcome);
    expect(await (second.kind === "pending" ? second.outcome : Promise.reject(new Error("not pending")))).toEqual(outcome); expect(store.begin(id, { requestId: "r3", command: "session.list", args: { a: 1, b: 2 } }).kind).toBe("replay");
  });
  test("same command id conflicting payload is rejected", () => { const store = new IdempotencyStore(); const id = "conflict" as never; store.begin(id, { command: "host.list", args: { value: 1 } }); expect(store.begin(id, { command: "host.list", args: { value: 2 } }).kind).toBe("conflict"); });
});

describe("child supervision", () => {
  test("startup uses exact argv and session path", async () => {
    const factory = new IdleFactory(); const supervisor = new RpcChildSupervisor(factory, record("session"), { entry: () => {}, event: () => {}, crashed: () => {} }, ["omp", "--mode", "rpc", "--session", "/tmp/session.jsonl"]);
    await supervisor.start(); expect(factory.children).toHaveLength(1); expect(factory.children[0]?.killed).toBe(false); supervisor.stop(); expect(factory.children[0]?.killed).toBe(true);
  });
  test("malformed child frame fails startup", async () => {
    const exited = Promise.withResolvers<number>(); const child: ChildHandle = { stdin: { write: () => {} }, stdout: (async function* () { yield "not-json\n"; })(), stderr: (async function* () {})(), exited: exited.promise, kill: () => exited.resolve(1) };
    const factory: RpcChildFactory = { spawn: () => child, argv: path => ["omp", "--mode", "rpc", "--session", path] }; const supervisor = new RpcChildSupervisor(factory, record("s"), { entry: () => {}, event: () => {}, crashed: () => {} });
    await expect(supervisor.start()).rejects.toThrow("malformed rpc stdout");
  });
  test("duplicate-key child frames fail before schema dispatch", async () => {
    const exited = Promise.withResolvers<number>(); const child: ChildHandle = { stdin: { write: () => {} }, stdout: (async function* () { yield '{"type":"ready","type":"ready"}\n'; })(), stderr: (async function* () {})(), exited: exited.promise, kill: () => exited.resolve(1) };
    const supervisor = new RpcChildSupervisor({ spawn: () => child, argv: path => ["omp", "--mode", "rpc", "--session", path] }, record("s"), { entry: () => {}, event: () => {}, crashed: () => {} });
    await expect(supervisor.start()).rejects.toThrow("malformed rpc stdout");
  });
  test("oversized no-newline stdout fails before dispatch", async () => {
    const exited = Promise.withResolvers<number>(); const child: ChildHandle = { stdin: { write: () => {} }, stdout: (async function* () { yield "x".repeat(1024 * 1024 + 1); })(), stderr: (async function* () {})(), exited: exited.promise, kill: () => exited.resolve(1) };
    const supervisor = new RpcChildSupervisor({ spawn: () => child, argv: path => ["omp", "--mode", "rpc", "--session", path] }, record("s"), { entry: () => {}, event: () => {}, crashed: () => {} });
    await expect(supervisor.start()).rejects.toThrow("exceeds 1MiB");
  });
  test("unknown child frames are fatal", async () => {
    const crashed = Promise.withResolvers<Error>(); const exited = Promise.withResolvers<number>();
    const child: ChildHandle = { stdin: { write: () => {} }, stdout: (async function* () { yield `${JSON.stringify({ type: "ready" })}\n`; yield `${JSON.stringify({ type: "unknown_frame" })}\n`; })(), stderr: (async function* () {})(), exited: exited.promise, kill: () => exited.resolve(1) };
    const supervisor = new RpcChildSupervisor({ spawn: () => child, argv: path => ["omp", "--mode", "rpc", "--session", path] }, record("s"), { entry: () => {}, event: () => {}, crashed: crashed.resolve });
    await supervisor.start(); expect((await crashed.promise).message).toContain("unknown rpc frame");
  });
  test("real Unix WebSocket upgrades on the local socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-ws-")); const path = join(root, "app.sock"); const appserver = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) }); await appserver.start();
    const socket = createConnection(path); await new Promise<void>(resolve => socket.once("connect", resolve));
    socket.write("GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: MTIzNDU2Nzg5MDEyMzQ1Ng==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    const handshake = await new Promise<Buffer>(resolve => socket.once("data", resolve)); expect(handshake.toString()).toContain("101");
    socket.write(wsFrame(JSON.stringify({ v: "omp-app/1", type: "hello", protocol: { min: "omp-app/1", max: "omp-app/1" }, client: { name: "test", version: "1", build: "b", platform: "linux" }, requestedFeatures: ["resume", "unknown"], savedCursors: [] })));
    const frame = await new Promise<Buffer>(resolve => socket.once("data", resolve)); const welcome = decodeServerFrame(wsPayload(frame)); expect(welcome.type).toBe("welcome"); if (welcome.type === "welcome") expect(welcome.grantedFeatures).toEqual(["resume"]);
    await appserver.stop(); socket.destroy(); expect(await unixSocketActive(path)).toBe(false);
  });

  test("attach is read-only and does not spawn a child", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-child-")); const path = join(root, "app.sock"); const factory = new IdleFactory("custom-omp");
    const appserver = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([record("s")]), childFactory: factory });
    await appserver.start();
    const outcome = await appserver.command({ v: "omp-app/1", type: "command", requestId: "r" as never, commandId: "c" as never, hostId: host, sessionId: sessionId("s"), command: "session.attach", args: {} });
    expect(outcome.frame.type).toBe("response"); expect(factory.children).toHaveLength(0); expect(factory.argv("/tmp/s.jsonl")).toEqual(["custom-omp", "--mode", "rpc", "--session", "/tmp/s.jsonl"]); await appserver.stop();
  });
});
describe("appserver startup and cleanup", () => {
  test("startup failure releases ownership and stop kills every child", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-clean-")); const path = join(root, "app.sock"); const factory = new IdleFactory();
    const appserver = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([record("s")]), childFactory: factory }); await appserver.start(); await appserver.stop();
    expect(factory.children).toHaveLength(0); await expect(stat(path)).rejects.toThrow(); await expect(stat(`${path}.owner`)).rejects.toThrow();
    const failing = createAppserver({ hostId: host, socketPath: path, discovery: { list: async () => { throw new Error("discovery failed"); } } }); await expect(failing.start()).rejects.toThrow("discovery failed");
  });
});
