import { describe, expect, test } from "bun:test";
import {
	APP_WIRE_VERSION,
	AppWireError,
	MAX_FILE_BYTES,
	MAX_INPUT_BYTES,
	COMMAND_DESCRIPTORS,
	COMMAND_ARGUMENT_DECODERS,
	COMMAND_RESULT_DECODERS,
	decodeClientFrame,
	decodeCommandArguments,
	decodeCommandResult,
	decodeDurableEntryFrame,
	decodeEntry,
	decodeServerFrame,
	decodeAdditiveServerFrame,
	inputObject,
	safeRelativePath,
	sameSession,
	isServerFrame,
} from "../src/index.ts";
const root = new URL("../fixtures/v1/", import.meta.url);
async function fixture(name: string): Promise<unknown> {
	return JSON.parse(await Bun.file(new URL(name, root)).text()) as unknown;
}

describe("app-wire authority", () => {
	const hello = {
		v: "omp-app/1",
		type: "hello",
		protocol: { min: "omp-app/1", max: "omp-app/1" },
		client: { name: "desktop", version: "1", build: "b", platform: "linux" },
		requestedFeatures: ["resume"],
		savedCursors: [{ hostId: "h", sessionId: "s", cursor: { epoch: "e1", seq: 1 } }],
	};
	test("every canonical golden decodes through public guards", async () => {
		const files = (await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: new URL(".", root).pathname }))).filter(name => !name.endsWith(".invalid.json")).sort();
		const client = new Set([
			"hello.json",
			"hello-auth.json",
			"command.json",
			"confirmation.json",
			"pair-start.json",
			"host-list.json",
			"ping.json",
		]);
		for (const name of files) {
			const value = await fixture(name);
			if (name === "entry.json") decodeEntry(value);
			else if (client.has(name)) decodeClientFrame(value);
			else expect(isServerFrame(value)).toBe(true);
		}
	});
	test("hello and durable lineage decode in string and parsed modes", () => {
		expect(decodeClientFrame(hello).type).toBe("hello");
		for (const protocol of [
			{ min: "omp-app/1", max: "omp-app/2" },
			{ min: "omp-app/1", max: "omp-app/10" },
		])
			expect(decodeClientFrame({ ...hello, protocol }).type).toBe("hello");
		for (const protocol of [
			{ min: "omp-app/2", max: "omp-app/1" },
			{ min: "omp-app/x", max: "omp-app/2" },
		])
			expect(() => decodeClientFrame({ ...hello, protocol })).toThrow(AppWireError);
		const frame = {
			v: "omp-app/1",
			type: "entry",
			cursor: { epoch: "e1", seq: 2 },
			revision: "rev-2",
			hostId: "h",
			sessionId: "s",
			entry: {
				id: "i2",
				parentId: "i1",
				hostId: "h",
				sessionId: "s",
				kind: "message",
				timestamp: "2026-01-01T00:00:00Z",
				data: { text: "ok" },
			},
		};
		expect(decodeDurableEntryFrame(JSON.stringify(frame)).entry.parentId).toBe("i1");
		expect(decodeDurableEntryFrame(new TextEncoder().encode(JSON.stringify(frame))).revision).toBe("rev-2");
	});
	test("cursor epochs are opaque bounded strings", () => {
		expect(() =>
			decodeServerFrame({
				v: "omp-app/1",
				type: "event",
				cursor: { epoch: 1, seq: 1 },
				hostId: "h",
				sessionId: "s",
				event: { type: "x" },
			}),
		).toThrow(AppWireError);
	});
	test("unknown families, duplicate keys, invalid UTF-8 and cycles reject", () => {
		expect(() => decodeServerFrame({ v: "omp-app/1", type: "future" })).toThrow(AppWireError);
		expect(() => inputObject('{"a":1,"a":2}')).toThrow(AppWireError);
		expect(() => inputObject(new Uint8Array([0xff]))).toThrow(AppWireError);
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(() => inputObject(cycle)).toThrow(AppWireError);
	});
	test("paths and protocol controls are safe", () => {
		expect(safeRelativePath("src/a.ts")).toBe("src/a.ts");
		for (const path of ["/etc/passwd", "../x", "a/../x", "C:/x", "\\\\server\\x", "a\\b"])
			expect(() => safeRelativePath(path)).toThrow(AppWireError);
	});
	test("input byte limit and additive fields", () => {
		expect(() => decodeServerFrame("{" + "x".repeat(MAX_INPUT_BYTES))).toThrow(AppWireError);
		const raw = {
			v: "omp-app/1",
			type: "event",
			cursor: { epoch: "e", seq: 1 },
			hostId: "h",
			sessionId: "s",
			event: { type: "future", added: true },
			addedByFuture: { safe: true },
		};
		expect((decodeServerFrame(raw) as Record<string, unknown>).addedByFuture).toEqual({ safe: true });
	});
	test("parsed-object approximate byte accounting covers keys and primitive values", () => {
		const huge = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ["k".repeat(60_000) + i, 1]));
		expect(() => inputObject(huge)).toThrow(AppWireError);
	});
	test("entry identity and empty file content are validated", () => {
		const entry = {
			id: "entry",
			parentId: null,
			hostId: "h",
			sessionId: "s",
			kind: "message",
			timestamp: "now",
			data: {},
		};
		expect(() => decodeEntry({ ...entry, id: undefined })).toThrow(AppWireError);
		expect(() => decodeEntry({ ...entry, parentId: 1 })).toThrow(AppWireError);
		expect(() => decodeEntry({ ...entry, parentId: "" })).toThrow(AppWireError);
		expect(
			decodeServerFrame({ v: "omp-app/1", type: "files", hostId: "h", sessionId: "s", path: "empty", content: "" }),
		).toMatchObject({ path: "empty" });
		expect(() =>
			decodeServerFrame({
				v: "omp-app/1",
				type: "files",
				hostId: "h",
				sessionId: "s",
				path: "x",
				content: "é".repeat(700000),
			}),
		).toThrow(AppWireError);
	});
	test("command scopes fail closed and file/frame bounds stay ordered", () => {
		expect(() =>
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "r",
				commandId: "c",
				hostId: "h",
				command: "unknown",
				args: {},
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "r",
				commandId: "c",
				hostId: "h",
				command: "session.list",
				args: {},
			}),
		).not.toThrow();
		expect(() =>
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "r",
				commandId: "c",
				hostId: "h",
				command: "session.prompt",
				args: {},
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "r",
				commandId: "c",
				hostId: "h",
				sessionId: "s",
				command: "session.list",
				args: {},
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "r",
				commandId: "c",
				hostId: "h",
				sessionId: "s",
				command: "files.write",
				args: {},
			}),
		).toThrow(AppWireError);
		const base = { v: "omp-app/1", type: "command", requestId: "r", commandId: "c", hostId: "h", args: {} } as const;
		expect(() => decodeClientFrame({ ...base, command: "session.create" })).not.toThrow();
		expect(() => decodeClientFrame({ ...base, command: "session.attach" })).toThrow(AppWireError);
		expect(() => decodeClientFrame({ ...base, sessionId: "s", command: "session.attach" })).not.toThrow();
		expect(() => decodeClientFrame({ ...base, command: "session.create", expectedRevision: "rev" })).toThrow(
			AppWireError,
		);
		expect(COMMAND_DESCRIPTORS["session.create"]).toEqual({
			capability: "sessions.manage",
			scope: "host",
			revision: "none",
			confirmation: "none",
		});
		expect(COMMAND_DESCRIPTORS["session.attach"]).toEqual({
			capability: "sessions.read",
			scope: "session",
			revision: "none",
			confirmation: "none",
		});
		expect(Object.values(COMMAND_DESCRIPTORS).every(descriptor => typeof descriptor.capability === "string")).toBe(
			true,
		);
		expect(MAX_FILE_BYTES).toBeLessThan(MAX_INPUT_BYTES);
		expect(APP_WIRE_VERSION).toBe("0.4.0");
	});
	test("exported wire version matches package metadata", async () => {
		const metadata = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };
		expect(APP_WIRE_VERSION).toBe(metadata.version);
	});
	test("session project wire data is opaque and live state is secret-free", () => {
		const session = { hostId: "h", sessionId: "s", project: { projectId: "p", name: "Demo" }, revision: "r", title: "Demo", status: "idle", updatedAt: "now", liveState: { phase: "work", phaseLabel: "human" } };
		const frame = { v: "omp-app/1", type: "sessions", cursor: { epoch: "e", seq: 1 }, sessions: [session] };
		const decoded = decodeServerFrame(frame);
		expect(JSON.stringify(decoded)).not.toContain("canonicalCwd");
		expect(JSON.stringify(decodeCommandResult("session.list", { cursor: { epoch: "e", seq: 1 }, sessions: [session] }))).not.toContain("/workspace");
		expect(() => decodeServerFrame({ ...frame, sessions: [{ ...session, liveState: { deviceToken: "x" } }] })).toThrow(AppWireError);
		expect(() => decodeServerFrame({ ...frame, sessions: [{ ...session, liveState: { nested: { session_key: "x" } } }] })).toThrow(AppWireError);
	});
	test("malicious secret metadata fixture is rejected", async () => {
		const malicious = await fixture("session-secret.invalid.json");
		expect(() => decodeServerFrame(malicious)).toThrow(AppWireError);
	});
	test("authenticated hello fixtures reject partial/bad auth without echoing token", async () => {
		const partial = await fixture("hello-auth-partial.invalid.json");
		const bad = await fixture("hello-auth-bad.invalid.json");
		expect(() => decodeClientFrame(partial)).toThrow(AppWireError);
		let caught: unknown;
		try { decodeClientFrame(bad); } catch (error) { caught = error; }
		expect(caught).toBeInstanceOf(AppWireError);
		expect(String(caught)).not.toContain("not-a-token");
	});
	test("additive watch, lease, PTY, files, audit, catalog, preview discriminants are bounded", () => {
		const frames = [
			{ v: "omp-app/1", type: "host.watch", watchId: "w", hostId: "h", cursor: { epoch: "e", seq: 1 }, state: "ready", revision: "r" },
			{ v: "omp-app/1", type: "session.delta", hostId: "h", sessionId: "s", cursor: { epoch: "e", seq: 2 }, revision: "r", upsert: { hostId: "h", sessionId: "s", project: { projectId: "p" }, revision: "r", title: "Demo", status: "idle", updatedAt: "now" } },
			{ v: "omp-app/1", type: "prompt.lease", hostId: "h", sessionId: "s", leaseId: "l", cursor: { epoch: "e", seq: 3 }, kind: "prompt", state: "acquired", owner: "desktop", expiresAt: "now" },
			{ v: "omp-app/1", type: "agent.progress", hostId: "h", sessionId: "s", agentId: "a", cursor: { epoch: "e", seq: 4 }, progress: 0.5, revision: "r" },
			{ v: "omp-app/1", type: "terminal.output", hostId: "h", sessionId: "s", terminalId: "t", cursor: { epoch: "e", seq: 5 }, stream: "stdout", data: "ok" },
			{ v: "omp-app/1", type: "files.diff", hostId: "h", sessionId: "s", path: "src/a.ts", diff: "@@\\n" },
			{ v: "omp-app/1", type: "audit.event", hostId: "h", cursor: { epoch: "e", seq: 1 }, event: { eventId: "op", hostId: "h", action: "read", actor: "desktop", timestamp: "now" } },
			{ v: "omp-app/1", type: "catalog", hostId: "h", revision: "r", items: [{ id: "tool", kind: "tool", name: "shell" }] },
			{ v: "omp-app/1", type: "preview.capture", hostId: "h", sessionId: "s", previewId: "p", content: "YQ==", encoding: "base64", mimeType: "image/png" },
		] as const;
		for (const value of frames) expect(decodeServerFrame(value).type).toBe(value.type);
		expect(() => decodeAdditiveServerFrame({ ...frames[0], state: "future" })).toThrow(AppWireError);
		expect(() => decodeAdditiveServerFrame({ ...frames[2], kind: "controller" })).toThrow(AppWireError);
		expect(() => decodeAdditiveServerFrame({ ...frames[4], data: "x", stream: "future" })).toThrow(AppWireError);
		expect(() => decodeAdditiveServerFrame({ ...frames[5], path: "../secret" })).toThrow(AppWireError);
		expect(() => decodeAdditiveServerFrame({ ...frames[6], event: { ...frames[6].event, hostId: "other" } })).toThrow(AppWireError);
	});
	test("every command has typed bounded argument and result decoders", () => {
		for (const command of Object.keys(COMMAND_DESCRIPTORS)) {
			expect(COMMAND_ARGUMENT_DECODERS[command]).toBeFunction();
			expect(COMMAND_RESULT_DECODERS[command]).toBeFunction();
			const descriptor = COMMAND_DESCRIPTORS[command];
			expect(descriptor).toBeDefined();
		}
	});
	test("terminal direction and command payload/result contracts are explicit", () => {
		const base = { v: "omp-app/1", hostId: "h", sessionId: "s", terminalId: "t" };
		expect(decodeClientFrame({ ...base, type: "terminal.input", data: "x" }).type).toBe("terminal.input");
		expect(decodeClientFrame({ ...base, type: "terminal.resize", cols: 80, rows: 24 }).type).toBe("terminal.resize");
		expect(() => decodeServerFrame({ ...base, type: "terminal.input", data: "x" })).toThrow(AppWireError);
		expect(decodeServerFrame({ ...base, type: "terminal.output", cursor: { epoch: "e", seq: 1 }, stream: "stdout", data: "x" }).type).toBe("terminal.output");
		expect(() => decodeClientFrame({ ...base, type: "terminal.output", cursor: { epoch: "e", seq: 1 }, stream: "stdout", data: "x" })).toThrow(AppWireError);
		expect(() => decodeCommandArguments("session.prompt", { prompt: "wrong" })).toThrow(AppWireError);
		expect(decodeCommandArguments("session.prompt", { message: "hello" }).message).toBe("hello");
		expect(() => decodeCommandArguments("preview.launch", { url: "javascript:alert(1)" })).toThrow(AppWireError);
		expect(() => decodeCommandArguments("settings.write", { apiKey: "secret" })).toThrow(AppWireError);
		expect(() => decodeClientFrame({ v: "omp-app/1", type: "command", requestId: "r", commandId: "c", hostId: "h", sessionId: "s", command: "session.prompt", args: { prompt: "wrong" } })).toThrow(AppWireError);
		expect(() => decodeClientFrame({ v: "omp-app/1", type: "command", requestId: "r", commandId: "c", hostId: "h", sessionId: "s", command: "files.list", args: { path: "../secret" } })).toThrow(AppWireError);
		expect(decodeCommandResult("session.list", { cursor: { epoch: "e", seq: 1 }, sessions: [] }).sessions).toEqual([]);
		expect(() => decodeCommandResult("session.list", { sessions: [] })).toThrow(AppWireError);
		expect(decodeCommandResult("session.attach", { attached: true, cursor: { epoch: "e", seq: 1 } }).attached).toBe(true);
		expect(() => decodeCommandResult("session.create", { session: {} })).toThrow(AppWireError);
		expect(decodeCommandResult("session.cancel", { cancelled: true }).cancelled).toBe(true);
		expect(() => decodeCommandResult("session.cancel", { ok: true })).toThrow(AppWireError);
		expect(decodeCommandResult("session.prompt", { accepted: true }).accepted).toBe(true);
		expect(decodeCommandResult("term.open", { terminalId: "t" }).terminalId).toBe("t");
		expect(() => decodeCommandResult("term.open", { terminalId: 1 })).toThrow(AppWireError);
		expect(() => decodeCommandResult("preview.capture", { content: "not-base64" })).toThrow(AppWireError);
		expect(decodeCommandResult("controller.lease.renew", { leaseId: "l", cursor: { epoch: "e", seq: 1 } }).leaseId).toBe("l");
		expect(() => decodeCommandResult("host.watch", { watchId: "w" })).toThrow(AppWireError);
		expect(() => decodeCommandArguments("settings.write", { values: { nested: [{ ok: true }] } })).not.toThrow();
		expect(() => decodeCommandArguments("settings.write", { values: { password: "nope" } })).toThrow(AppWireError);
		expect(() => decodeCommandArguments("settings.write", { value: Number.NaN })).toThrow(AppWireError);
		const deep: Record<string, unknown> = {};
		let node = deep;
		for (let i = 0; i < 40; i++) {
			const next: Record<string, unknown> = {};
			node.next = next;
			node = next;
		}
		expect(() => decodeCommandArguments("settings.write", deep)).toThrow(AppWireError);
		expect(() => decodeCommandArguments("settings.write", { values: Array.from({ length: 1001 }, () => true) })).toThrow(AppWireError);
	});
	test("session identity remains host scoped", () => {
		expect((decodeServerFrame({ v: "omp-app/1", type: "response", requestId: "r", hostId: "h", command: "session.cancel", ok: true, result: { cancelled: true } }) as Record<string, unknown>).result).toEqual({ cancelled: true });
		expect(sameSession({ hostId: "h", sessionId: "s" }, { hostId: "other", sessionId: "s" })).toBe(false);
	});
});
