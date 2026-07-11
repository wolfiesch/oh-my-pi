import { describe, expect, test } from "bun:test";
import {
	AppWireError,
	MAX_FILE_BYTES,
	MAX_INPUT_BYTES,
	COMMAND_DESCRIPTORS,
	decodeClientFrame,
	decodeDurableEntryFrame,
	decodeEntry,
	decodeServerFrame,
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
		const files = (await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: new URL(".", root).pathname }))).sort();
		const client = new Set([
			"hello.json",
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
		expect(Object.values(COMMAND_DESCRIPTORS).every(descriptor => typeof descriptor.capability === "string")).toBe(
			true,
		);
		expect(MAX_FILE_BYTES).toBeLessThan(MAX_INPUT_BYTES);
	});
	test("session identity remains host scoped", () => {
		expect(sameSession({ hostId: "h", sessionId: "s" }, { hostId: "other", sessionId: "s" })).toBe(false);
	});
});
