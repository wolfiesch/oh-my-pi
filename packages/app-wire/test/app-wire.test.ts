import { describe, expect, test } from "bun:test";
import {
	ADDITIVE_FEATURES,
	APP_WIRE_VERSION,
	AppWireError,
	COMMAND_ARGUMENT_DECODERS,
	COMMAND_DESCRIPTORS,
	COMMAND_RESULT_DECODERS,
	DESKTOP_CATALOG_COMMANDS,
	decodeAdditiveServerFrame,
	decodeClientFrame,
	decodeCommandArguments,
	decodeCommandResult,
	decodeDurableEntryFrame,
	decodeEntry,
	decodeServerFrame,
	decodeSessionListResult,
	IMAGE_UPLOAD_CHUNK_BYTES,
	inputObject,
	isServerFrame,
	MAX_FILE_BYTES,
	MAX_INPUT_BYTES,
	MAX_MAP_KEYS,
	PROMPT_IMAGE_MAX_COUNT,
	PROTOCOL_FEATURES,
	safeRelativePath,
	sameSession,
	TRANSCRIPT_IMAGE_CHUNK_BYTES,
	TRANSCRIPT_IMAGE_MAX_BYTES,
	validateCommandDescriptor,
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
		const files = (await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: new URL(".", root).pathname })))
			.filter(name => !name.endsWith(".invalid.json"))
			.sort();
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
	test("session list metadata remains bounded at the wire cap", () => {
		const sessions = Array.from({ length: 1_000 }, (_, index) => ({
			hostId: "h",
			sessionId: `session-${index}`,
			project: { projectId: "project-test" },
			revision: "revision-test",
			title: `Session ${index}`,
			status: "idle",
			updatedAt: new Date(index).toISOString(),
		}));
		const result = decodeSessionListResult({
			cursor: { epoch: "epoch", seq: 0 },
			sessions,
			totalCount: 5_000,
			truncated: true,
			future: "keep",
		});
		expect(result.sessions).toHaveLength(1_000);
		expect(result.totalCount).toBe(5_000);
		expect(result.truncated).toBe(true);
		expect((result as unknown as Record<string, unknown>).future).toBe("keep");
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
		expect(() => decodeServerFrame(`{${"x".repeat(MAX_INPUT_BYTES)}`)).toThrow(AppWireError);
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
		expect(() =>
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "r",
				commandId: "c",
				hostId: "h",
				sessionId: "s",
				command: "files.write",
				args: { path: "a", content: "x" },
			}),
		).toThrow(AppWireError);
		const base = { v: "omp-app/1", type: "command", requestId: "r", commandId: "c", hostId: "h", args: {} } as const;
		expect(() =>
			decodeClientFrame({ ...base, command: "session.create", args: { projectId: "project-1" } }),
		).not.toThrow();
		expect(() => decodeClientFrame({ ...base, command: "session.create", args: { cwd: "/tmp/project" } })).toThrow(
			AppWireError,
		);
		expect(() => decodeCommandArguments("term.open", { cwd: "/tmp/project" })).toThrow(AppWireError);
		expect(() => decodeCommandArguments("term.open", { cwd: "../project" })).toThrow(AppWireError);
		expect(decodeCommandArguments("term.open", { cwd: "src/project" }).cwd).toBe("src/project");
		expect(() => decodeClientFrame({ ...base, command: "session.attach" })).toThrow(AppWireError);
		expect(() => decodeClientFrame({ ...base, sessionId: "s", command: "session.attach" })).not.toThrow();
		expect(() => decodeClientFrame({ ...base, command: "session.create", expectedRevision: "rev" })).toThrow(
			AppWireError,
		);
		expect(COMMAND_DESCRIPTORS["session.create"]).toEqual({
			capability: "sessions.manage",
			scope: "host",
			revision: "none",
			revisionOwner: "none",
			confirmation: "none",
			desktopCatalog: true,
		});
		expect(COMMAND_DESCRIPTORS["session.attach"]).toEqual({
			capability: "sessions.read",
			scope: "session",
			revision: "none",
			revisionOwner: "none",
			confirmation: "none",
		});
		expect(Object.values(COMMAND_DESCRIPTORS).every(descriptor => typeof descriptor.capability === "string")).toBe(
			true,
		);
		expect(MAX_FILE_BYTES).toBeLessThan(MAX_INPUT_BYTES);
		expect(APP_WIRE_VERSION).toBe("0.5.5");
	});
	test("welcome identity requires every version and build field", async () => {
		const welcome = (await fixture("welcome.json")) as Record<string, unknown>;
		for (const field of ["ompVersion", "ompBuild", "appserverVersion", "appserverBuild"]) {
			expect(() => decodeServerFrame({ ...welcome, [field]: undefined })).toThrow(AppWireError);
			expect(() => decodeServerFrame({ ...welcome, [field]: "bad\nidentity" })).toThrow(AppWireError);
		}
	});
	test("session lifecycle commands require revision, use empty args, and decode exact results", () => {
		for (const name of ["session.archive", "session.restore"] as const) {
			expect(COMMAND_DESCRIPTORS[name]).toEqual({
				capability: "sessions.manage",
				scope: "session",
				revision: "required",
				revisionOwner: "session",
				confirmation: "none",
				desktopCatalog: true,
			});
		}
		expect(COMMAND_DESCRIPTORS["session.delete"]).toEqual({
			capability: "sessions.manage",
			scope: "session",
			revision: "required",
			revisionOwner: "session",
			confirmation: "challenge",
			desktopCatalog: true,
		});
		expect(COMMAND_DESCRIPTORS["session.close"]).toEqual({
			capability: "sessions.manage",
			scope: "session",
			revision: "required",
			revisionOwner: "session",
			confirmation: "challenge",
			desktopCatalog: true,
		});
		for (const name of ["session.archive", "session.restore", "session.delete"] as const) {
			expect(decodeCommandArguments(name, {})).toEqual({});
			expect(() => decodeCommandArguments(name, { leaseId: "lease" })).toThrow(AppWireError);
		}
		expect(decodeCommandArguments("session.close", {})).toEqual({});
		expect(decodeCommandArguments("session.close", { leaseId: "lease" })).toEqual({ leaseId: "lease" });
		expect(() => decodeCommandArguments("session.close", { extra: true })).toThrow(AppWireError);
		expect(decodeCommandResult("session.archive", { archived: true })).toEqual({ archived: true });
		expect(decodeCommandResult("session.restore", { restored: true })).toEqual({ restored: true });
		expect(decodeCommandResult("session.delete", { deleted: true })).toEqual({ deleted: true });
		expect(decodeCommandResult("session.close", { closed: true })).toEqual({ closed: true });
		expect(() => decodeCommandResult("session.delete", { deleted: true, sessionId: "s" })).toThrow(AppWireError);
		const base = {
			v: "omp-app/1",
			type: "command",
			requestId: "r",
			commandId: "c",
			hostId: "h",
			sessionId: "s",
			args: {},
		};
		expect(() => decodeClientFrame({ ...base, command: "session.archive" })).toThrow(AppWireError);
		expect(() =>
			decodeClientFrame({ ...base, command: "session.archive", expectedRevision: "revision" }),
		).not.toThrow();
	});
	test("archivedAt is canonical ISO metadata and sessions host identity remains additive", () => {
		const session = {
			hostId: "h",
			sessionId: "s",
			project: { projectId: "p" },
			revision: "r",
			title: "Archived",
			status: "idle",
			updatedAt: "now",
			archivedAt: "2026-07-13T12:34:56.000Z",
		};
		const legacy = {
			v: "omp-app/1",
			type: "sessions",
			cursor: { epoch: "e", seq: 0 },
			sessions: [session],
		};
		expect(decodeServerFrame(legacy)).toMatchObject({ sessions: [{ archivedAt: session.archivedAt }] });
		expect(decodeServerFrame({ ...legacy, hostId: "h" })).toMatchObject({ hostId: "h" });
		expect(() => decodeServerFrame({ ...legacy, hostId: 1 })).toThrow(AppWireError);
		expect(() => decodeServerFrame({ ...legacy, sessions: [{ ...session, archivedAt: "next Tuesday" }] })).toThrow(
			AppWireError,
		);
	});
	test("exported wire version matches package metadata", async () => {
		const metadata = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };
		expect(APP_WIRE_VERSION).toBe(metadata.version);
	});
	test("session project wire data is opaque and live state is secret-free", () => {
		const session = {
			hostId: "h",
			sessionId: "s",
			project: { projectId: "p", name: "Demo" },
			revision: "r",
			title: "Demo",
			status: "idle",
			updatedAt: "now",
			liveState: { phase: "work", phaseLabel: "human" },
		};
		const frame = { v: "omp-app/1", type: "sessions", cursor: { epoch: "e", seq: 1 }, sessions: [session] };
		const decoded = decodeServerFrame(frame);
		expect(JSON.stringify(decoded)).not.toContain("canonicalCwd");
		expect(
			JSON.stringify(decodeCommandResult("session.list", { cursor: { epoch: "e", seq: 1 }, sessions: [session] })),
		).not.toContain("/workspace");
		expect(() =>
			decodeServerFrame({ ...frame, sessions: [{ ...session, liveState: { deviceToken: "x" } }] }),
		).toThrow(AppWireError);
		expect(() =>
			decodeServerFrame({ ...frame, sessions: [{ ...session, liveState: { nested: { session_key: "x" } } }] }),
		).toThrow(AppWireError);
	});
	test("malicious secret metadata fixture is rejected", async () => {
		const malicious = await fixture("session-secret.invalid.json");
		expect(() => decodeServerFrame(malicious)).toThrow(AppWireError);
	});
	test("session delta removals cannot target another session", () => {
		const delta = {
			v: "omp-app/1",
			type: "session.delta",
			hostId: "h",
			sessionId: "s",
			cursor: { epoch: "e", seq: 1 },
			revision: "r",
			remove: "s",
		};
		expect(decodeAdditiveServerFrame(delta)).toMatchObject({ sessionId: "s", remove: "s" });
		expect(() => decodeAdditiveServerFrame({ ...delta, remove: "other" })).toThrow(AppWireError);
	});
	test("pairing success requires a bounded expiration and preserves it", async () => {
		const pairing = (await fixture("pairing.json")) as Record<string, unknown>;
		expect(decodeServerFrame(pairing)).toMatchObject({
			type: "pair.ok",
			expiresAt: pairing.expiresAt,
		});
		const missingExpiration = { ...pairing };
		delete missingExpiration.expiresAt;
		expect(() => decodeServerFrame(missingExpiration)).toThrow(AppWireError);
		expect(() => decodeServerFrame({ ...pairing, expiresAt: 1 })).toThrow(AppWireError);
		expect(() => decodeServerFrame({ ...pairing, expiresAt: "x".repeat(129) })).toThrow(AppWireError);
	});
	test("preview captures require the declared base64 encoding", async () => {
		const capture = (await fixture("preview-capture.json")) as Record<string, unknown>;
		expect(decodeServerFrame(capture)).toMatchObject({ type: "preview.capture", encoding: "base64" });
		const missingEncoding = { ...capture };
		delete missingEncoding.encoding;
		expect(() => decodeServerFrame(missingEncoding)).toThrow(AppWireError);
		expect(() => decodeServerFrame({ ...capture, encoding: "utf8" })).toThrow(AppWireError);
	});
	test("authenticated hello fixtures reject partial/bad auth without echoing token", async () => {
		const partial = await fixture("hello-auth-partial.invalid.json");
		const bad = await fixture("hello-auth-bad.invalid.json");
		expect(() => decodeClientFrame(partial)).toThrow(AppWireError);
		let caught: unknown;
		try {
			decodeClientFrame(bad);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AppWireError);
		expect(String(caught)).not.toContain("not-a-token");
	});
	test("additive watch, lease, PTY, files, audit, catalog, preview discriminants are bounded", () => {
		const frames = [
			{
				v: "omp-app/1",
				type: "host.watch",
				watchId: "w",
				hostId: "h",
				cursor: { epoch: "e", seq: 1 },
				state: "ready",
				revision: "r",
			},
			{
				v: "omp-app/1",
				type: "session.delta",
				hostId: "h",
				sessionId: "s",
				cursor: { epoch: "e", seq: 2 },
				revision: "r",
				upsert: {
					hostId: "h",
					sessionId: "s",
					project: { projectId: "p" },
					revision: "r",
					title: "Demo",
					status: "idle",
					updatedAt: "now",
				},
			},
			{
				v: "omp-app/1",
				type: "prompt.lease",
				hostId: "h",
				sessionId: "s",
				leaseId: "l",
				cursor: { epoch: "e", seq: 3 },
				kind: "prompt",
				state: "acquired",
				owner: "desktop",
				expiresAt: "now",
			},
			{
				v: "omp-app/1",
				type: "agent.progress",
				hostId: "h",
				sessionId: "s",
				agentId: "a",
				cursor: { epoch: "e", seq: 4 },
				progress: 0.5,
				revision: "r",
			},
			{
				v: "omp-app/1",
				type: "terminal.output",
				hostId: "h",
				sessionId: "s",
				terminalId: "t",
				cursor: { epoch: "e", seq: 5 },
				stream: "stdout",
				data: "ok",
			},
			{ v: "omp-app/1", type: "files.diff", hostId: "h", sessionId: "s", path: "src/a.ts", diff: "@@\\n" },
			{
				v: "omp-app/1",
				type: "audit.event",
				hostId: "h",
				cursor: { epoch: "e", seq: 1 },
				event: { eventId: "op", hostId: "h", action: "read", actor: "desktop", timestamp: "now" },
			},
			{
				v: "omp-app/1",
				type: "catalog",
				hostId: "h",
				revision: "r",
				items: [{ id: "tool", kind: "tool", name: "shell" }],
			},
			{
				v: "omp-app/1",
				type: "preview.capture",
				hostId: "h",
				sessionId: "s",
				previewId: "p",
				content: "YQ==",
				encoding: "base64",
				mimeType: "image/png",
			},
		] as const;
		for (const value of frames) expect(decodeServerFrame(value).type).toBe(value.type);
		expect(() => decodeAdditiveServerFrame({ ...frames[0], state: "future" })).toThrow(AppWireError);
		expect(() => decodeAdditiveServerFrame({ ...frames[2], kind: "controller" })).toThrow(AppWireError);
		expect(() => decodeAdditiveServerFrame({ ...frames[4], data: "x", stream: "future" })).toThrow(AppWireError);
		expect(() => decodeAdditiveServerFrame({ ...frames[5], path: "../secret" })).toThrow(AppWireError);
		expect(() => decodeAdditiveServerFrame({ ...frames[6], event: { ...frames[6].event, hostId: "other" } })).toThrow(
			AppWireError,
		);
	});
	test("every command has typed bounded argument and result decoders", () => {
		for (const command of Object.keys(COMMAND_DESCRIPTORS)) {
			expect(COMMAND_ARGUMENT_DECODERS[command]).toBeFunction();
			expect(COMMAND_RESULT_DECODERS[command]).toBeFunction();
			const descriptor = COMMAND_DESCRIPTORS[command];
			expect(descriptor).toBeDefined();
		}
	});
	test("every descriptor declares an exhaustive revision owner", () => {
		const expected: Record<string, string> = {
			"session.prompt": "session",
			"session.image.begin": "none",
			"session.image.chunk": "none",
			"session.image.discard": "none",
			"session.image.read": "none",
			"session.cancel": "session",
			"session.close": "session",
			"agent.cancel": "session",
			"bash.run": "session",
			"term.open": "session",
			"session.state.get": "none",
			"session.steer": "session",
			"session.followUp": "session",
			"session.rename": "session",
			"session.retry": "session",
			"session.compact": "session",
			"session.pause": "session",
			"session.resume": "session",
			"session.archive": "session",
			"session.restore": "session",
			"session.delete": "session",
			"session.model.set": "session",
			"session.thinking.set": "session",
			"session.fast.set": "session",
			"session.ui.respond": "session",
			"controller.lease.acquire": "session",
			"controller.lease.renew": "session",
			"controller.lease.release": "session",
			"prompt.lease.acquire": "session",
			"prompt.lease.renew": "session",
			"prompt.lease.release": "session",
			"preview.launch": "session",
			"preview.state": "session",
			"preview.navigate": "session",
			"preview.capture": "session",
			"files.read": "authority",
			"files.write": "authority",
			"files.patch": "authority",
			"files.list": "authority",
			"files.diff": "authority",
			"review.read": "authority",
			"review.apply": "authority",
			"config.write": "authority",
			"settings.write": "authority",
			"host.list": "none",
			"session.list": "none",
			"session.create": "none",
			"session.attach": "none",
			"audit.read": "none",
			"audit.tail": "none",
			"settings.read": "none",
			"catalog.get": "none",
			"host.watch": "none",
			"session.watch": "none",
		};
		expect(Object.keys(COMMAND_DESCRIPTORS).sort()).toEqual(Object.keys(expected).sort());
		for (const [command, descriptor] of Object.entries(COMMAND_DESCRIPTORS)) {
			expect(descriptor.revisionOwner).toBe(expected[command]);
			expect(descriptor.revision === "none").toBe(descriptor.revisionOwner === "none");
		}
	});
	test("desktop catalog commands are an explicit canonical descriptor subset", () => {
		const expected = [
			"session.create",
			"session.rename",
			"session.archive",
			"session.restore",
			"session.delete",
			"session.close",
			"session.model.set",
			"session.thinking.set",
			"session.fast.set",
			"session.cancel",
		];
		expect([...DESKTOP_CATALOG_COMMANDS].sort()).toEqual(expected.sort());
		for (const command of DESKTOP_CATALOG_COMMANDS) expect(COMMAND_DESCRIPTORS[command].desktopCatalog).toBe(true);
	});
	test("descriptor validator rejects mismatched revision policy and owner", () => {
		expect(() =>
			validateCommandDescriptor("invalid", {
				capability: "files.read",
				scope: "host",
				revision: "none",
				revisionOwner: "authority",
				confirmation: "none",
			}),
		).toThrow(AppWireError);
		expect(() =>
			validateCommandDescriptor("invalid", {
				capability: "files.read",
				scope: "host",
				revision: "required",
				revisionOwner: "none",
				confirmation: "none",
			}),
		).toThrow(AppWireError);
	});
	test("terminal direction and command payload/result contracts are explicit", () => {
		const base = { v: "omp-app/1", hostId: "h", sessionId: "s", terminalId: "t" };
		expect(decodeClientFrame({ ...base, type: "terminal.input", data: "x" }).type).toBe("terminal.input");
		expect(decodeClientFrame({ ...base, type: "terminal.resize", cols: 80, rows: 24 }).type).toBe("terminal.resize");
		expect(() => decodeServerFrame({ ...base, type: "terminal.input", data: "x" })).toThrow(AppWireError);
		expect(
			decodeServerFrame({
				...base,
				type: "terminal.output",
				cursor: { epoch: "e", seq: 1 },
				stream: "stdout",
				data: "x",
			}).type,
		).toBe("terminal.output");
		expect(() =>
			decodeClientFrame({
				...base,
				type: "terminal.output",
				cursor: { epoch: "e", seq: 1 },
				stream: "stdout",
				data: "x",
			}),
		).toThrow(AppWireError);
		expect(() => decodeCommandArguments("session.prompt", { prompt: "wrong" })).toThrow(AppWireError);
		expect(decodeCommandArguments("session.prompt", { message: "hello" }).message).toBe("hello");
		expect(decodeCommandArguments("session.prompt", { message: "hello", leaseId: "lease-1" })).toMatchObject({
			message: "hello",
			leaseId: "lease-1",
		});
		expect(() => decodeCommandArguments("session.prompt", { message: "hello", unexpected: true })).toThrow(
			AppWireError,
		);
		expect(() => decodeCommandArguments("session.prompt", { message: "" })).toThrow(AppWireError);
		expect(() => decodeCommandArguments("session.prompt", { message: "hello", leaseId: "bad\u0000lease" })).toThrow(
			AppWireError,
		);
		expect(() => decodeCommandArguments("preview.launch", { url: "javascript:alert(1)" })).toThrow(AppWireError);
		expect(
			decodeCommandArguments("session.model.set", { selector: "openai/gpt-5.5", persistence: "session" }),
		).toMatchObject({ selector: "openai/gpt-5.5", persistence: "session" });
		expect(decodeCommandArguments("session.model.set", { role: "slow", persistence: "settings" })).toMatchObject({
			role: "slow",
			persistence: "settings",
		});
		expect(() =>
			decodeCommandArguments("session.model.set", {
				selector: "openai/gpt-5.5",
				role: "slow",
				persistence: "session",
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeCommandArguments("session.model.set", { selector: "openai/gpt-5.5", persistence: "bad" }),
		).toThrow(AppWireError);
		expect(() => decodeCommandArguments("session.thinking.set", { level: "auto" })).not.toThrow();
		expect(() => decodeCommandArguments("session.thinking.set", { level: "unsupported" })).toThrow(AppWireError);
		expect(decodeCommandArguments("session.fast.set", { enabled: true })).toMatchObject({ enabled: true });
		expect(() => decodeCommandArguments("session.fast.set", { enabled: "yes" })).toThrow(AppWireError);
		expect(() => decodeCommandArguments("settings.write", { apiKey: "secret" })).toThrow(AppWireError);
		const state = {
			isStreaming: false,
			isCompacting: false,
			isPaused: false,
			messageCount: 0,
			queuedMessageCount: 0,
			steeringMode: "all",
			followUpMode: "all",
			interruptMode: "immediate",
		};
		expect(() => decodeCommandResult("session.state.get", { ...state, thinking: "bogus" })).toThrow(AppWireError);
		for (const level of ["inherit", "off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			expect(() => decodeCommandResult("session.state.get", { ...state, thinking: level })).not.toThrow();
		}
		for (const level of ["invalid", "ultra", "extreme"]) {
			expect(() => decodeCommandResult("session.state.get", { ...state, thinking: level })).toThrow(AppWireError);
		}
		expect(() =>
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "r",
				commandId: "c",
				hostId: "h",
				sessionId: "s",
				command: "session.prompt",
				args: { prompt: "wrong" },
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
				command: "files.list",
				args: { path: "../secret" },
			}),
		).toThrow(AppWireError);
		expect(decodeCommandResult("session.list", { cursor: { epoch: "e", seq: 1 }, sessions: [] }).sessions).toEqual(
			[],
		);
		expect(() => decodeCommandResult("session.list", { sessions: [] })).toThrow(AppWireError);
		expect(decodeCommandResult("session.attach", { attached: true, cursor: { epoch: "e", seq: 1 } }).attached).toBe(
			true,
		);
		expect(() => decodeCommandResult("session.create", { session: {} })).toThrow(AppWireError);
		expect(decodeCommandResult("session.cancel", { cancelled: true }).cancelled).toBe(true);
		expect(() => decodeCommandResult("session.cancel", { ok: true })).toThrow(AppWireError);
		expect(decodeCommandResult("session.prompt", { accepted: true }).accepted).toBe(true);
		expect(decodeCommandResult("term.open", { terminalId: "t" }).terminalId).toBe("t");
		expect(() => decodeCommandResult("term.open", { terminalId: 1 })).toThrow(AppWireError);
		expect(() => decodeCommandResult("preview.capture", { content: "not-base64" })).toThrow(AppWireError);
		expect(
			decodeCommandResult("controller.lease.renew", { leaseId: "l", cursor: { epoch: "e", seq: 1 } }).leaseId,
		).toBe("l");
		expect(() => decodeCommandResult("host.watch", { watchId: "w" })).toThrow(AppWireError);
		expect(() => decodeCommandArguments("settings.write", { values: { nested: [{ ok: true }] } })).not.toThrow();
		const supportedSettings = Object.fromEntries(
			Array.from({ length: 410 }, (_, index) => [`setting-${index}`, { configured: true, sensitive: false }]),
		);
		expect(() =>
			decodeCommandResult("settings.read", { revision: "revision-1", settings: supportedSettings }),
		).not.toThrow();
		expect(() =>
			decodeCommandResult("settings.read", {
				revision: "revision-1",
				settings: {
					...supportedSettings,
					"auth.broker.token": {
						configured: true,
						effectiveSource: "global",
						sensitive: true,
					},
				},
			}),
		).not.toThrow();
		const settingsFrame = decodeAdditiveServerFrame({
			v: "omp-app/1",
			type: "settings",
			hostId: "real-host",
			revision: "revision-1",
			settings: {
				...supportedSettings,
				"auth.broker.token": { configured: true, sensitive: true },
			},
		});
		expect(settingsFrame).toMatchObject({
			type: "settings",
			hostId: "real-host",
			settings: { "auth.broker.token": { configured: true, sensitive: true } },
		});
		expect(() =>
			decodeAdditiveServerFrame({
				v: "omp-app/1",
				type: "settings",
				hostId: "real-host",
				revision: "revision-1",
				settings: { "auth.broker.token": { sensitive: true, default: "must-not-cross" } },
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeAdditiveServerFrame({
				v: "omp-app/1",
				type: "settings",
				hostId: "real-host",
				revision: "revision-1",
				settings: { "visible.setting": { metadata: { token: "must-not-cross" } } },
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeCommandResult("settings.read", {
				revision: "revision-1",
				settings: {
					"auth.broker.token": {
						configured: true,
						effective: "must-not-cross",
						sensitive: true,
					},
				},
			}),
		).toThrow(AppWireError);
		const oversizedSettings = Object.fromEntries(
			Array.from({ length: MAX_MAP_KEYS + 1 }, (_, index) => [`setting-${index}`, index]),
		);
		expect(() =>
			decodeCommandResult("settings.read", { revision: "revision-1", settings: oversizedSettings }),
		).toThrow(AppWireError);
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
		expect(() =>
			decodeCommandArguments("settings.write", { values: Array.from({ length: 1001 }, () => true) }),
		).toThrow(AppWireError);
	});
	test("managed prompt images have strict bounded upload contracts", () => {
		expect(ADDITIVE_FEATURES).toContain("prompt.images");
		expect(PROTOCOL_FEATURES).toContain("prompt.images");
		const id = "123e4567-e89b-42d3-a456-426614174000";
		const digest = "a".repeat(64);
		expect(decodeCommandArguments("session.prompt", { message: "", images: [{ imageId: id }] })).toMatchObject({
			message: "",
			images: [{ imageId: id }],
		});
		expect(() => decodeCommandArguments("session.prompt", { message: "", images: [] })).toThrow(AppWireError);
		expect(() =>
			decodeCommandArguments("session.prompt", {
				message: "images",
				images: Array.from({ length: PROMPT_IMAGE_MAX_COUNT + 1 }, () => ({ imageId: id })),
			}),
		).toThrow(AppWireError);
		for (const invalid of ["../secret", id.toUpperCase(), "123e4567-e89b-12d3-a456-426614174000"])
			expect(() =>
				decodeCommandArguments("session.prompt", { message: "image", images: [{ imageId: invalid }] }),
			).toThrow(AppWireError);

		expect(
			decodeCommandArguments("session.image.begin", {
				mimeType: "image/png",
				size: 8,
				sha256: digest,
			}),
		).toEqual({ mimeType: "image/png", size: 8, sha256: digest });
		for (const value of [
			{ mimeType: "image/svg+xml", size: 8, sha256: digest },
			{ mimeType: "image/png", size: 0, sha256: digest },
			{ mimeType: "image/png", size: 8, sha256: digest.toUpperCase() },
		])
			expect(() => decodeCommandArguments("session.image.begin", value)).toThrow(AppWireError);

		expect(decodeCommandArguments("session.image.chunk", { imageId: id, offset: 0, content: "AQ==" })).toEqual({
			imageId: id,
			offset: 0,
			content: "AQ==",
		});
		for (const content of ["AR==", "AQJ=", "AQ", "%%%%"])
			expect(() => decodeCommandArguments("session.image.chunk", { imageId: id, offset: 0, content })).toThrow(
				AppWireError,
			);
		expect(() =>
			decodeCommandArguments("session.image.chunk", {
				imageId: id,
				offset: 0,
				content: Buffer.alloc(IMAGE_UPLOAD_CHUNK_BYTES + 1).toString("base64"),
			}),
		).toThrow(AppWireError);
		expect(decodeCommandArguments("session.image.discard", { imageId: id })).toEqual({ imageId: id });
		expect(() => decodeCommandArguments("session.image.discard", { imageId: id, extra: true })).toThrow(AppWireError);

		expect(decodeCommandResult("session.image.begin", { imageId: id, chunkBytes: IMAGE_UPLOAD_CHUNK_BYTES })).toEqual(
			{ imageId: id, chunkBytes: IMAGE_UPLOAD_CHUNK_BYTES },
		);
		expect(decodeCommandResult("session.image.chunk", { imageId: id, received: 1, complete: true })).toEqual({
			imageId: id,
			received: 1,
			complete: true,
		});
		expect(decodeCommandResult("session.image.discard", { discarded: true })).toEqual({ discarded: true });
		expect(() => decodeCommandResult("session.image.discard", { discarded: true, extra: true })).toThrow(
			AppWireError,
		);
		expect(() =>
			decodeCommandResult("session.image.begin", {
				imageId: id,
				chunkBytes: IMAGE_UPLOAD_CHUNK_BYTES,
				extra: true,
			}),
		).toThrow(AppWireError);

		const frame = {
			v: "omp-app/1",
			type: "command",
			requestId: "request",
			commandId: "command",
			hostId: "host",
			sessionId: "session",
			command: "session.image.begin",
			args: { mimeType: "image/png", size: 8, sha256: digest },
		};
		expect(() => decodeClientFrame(frame)).not.toThrow();
		expect(() => decodeClientFrame({ ...frame, expectedRevision: "revision" })).toThrow(AppWireError);
	});
	test("transcript images expose ordered metadata and bounded read chunks", () => {
		expect(ADDITIVE_FEATURES).toContain("transcript.images");
		expect(PROTOCOL_FEATURES).toContain("transcript.images");
		const digest = "a".repeat(64);
		const entry = {
			id: "entry-image",
			parentId: null,
			hostId: "host",
			sessionId: "session",
			kind: "message",
			timestamp: "2026-07-14T12:00:00.000Z",
			data: {
				role: "user",
				text: "look",
				images: [
					{ sha256: digest, mimeType: "image/png" },
					{ sha256: "b".repeat(64), mimeType: "image/webp" },
				],
			},
		};
		expect(decodeEntry(entry).data.images).toEqual(entry.data.images);
		for (const images of [
			[{ sha256: digest.toUpperCase(), mimeType: "image/png" }],
			[{ sha256: digest, mimeType: "image/svg+xml" }],
			[{ sha256: digest, mimeType: "image/png", content: "AQ==" }],
		])
			expect(() => decodeEntry({ ...entry, data: { ...entry.data, images } })).toThrow(AppWireError);

		expect(decodeCommandArguments("session.image.read", { entryId: entry.id, sha256: digest, offset: 0 })).toEqual({
			entryId: entry.id,
			sha256: digest,
			offset: 0,
		});
		for (const args of [
			{ entryId: entry.id, sha256: digest.toUpperCase(), offset: 0 },
			{ entryId: "bad\nentry", sha256: digest, offset: 0 },
			{ entryId: entry.id, sha256: digest, offset: TRANSCRIPT_IMAGE_MAX_BYTES },
			{ entryId: entry.id, sha256: digest, offset: 0, path: "/tmp/image" },
		])
			expect(() => decodeCommandArguments("session.image.read", args)).toThrow(AppWireError);

		const result = {
			sha256: digest,
			mimeType: "image/png",
			size: 4,
			offset: 0,
			nextOffset: 3,
			complete: false,
			content: "AQID",
		};
		expect(decodeCommandResult("session.image.read", result)).toEqual(result);
		for (const invalid of [
			{ ...result, nextOffset: 2 },
			{ ...result, complete: true },
			{ ...result, content: "AQJ=" },
			{ ...result, path: "/tmp/image" },
		])
			expect(() => decodeCommandResult("session.image.read", invalid)).toThrow(AppWireError);
		expect(() =>
			decodeCommandResult("session.image.read", {
				...result,
				size: TRANSCRIPT_IMAGE_CHUNK_BYTES + 1,
				nextOffset: TRANSCRIPT_IMAGE_CHUNK_BYTES + 1,
				content: Buffer.alloc(TRANSCRIPT_IMAGE_CHUNK_BYTES + 1).toString("base64"),
			}),
		).toThrow(AppWireError);
	});
	test("session identity remains host scoped", () => {
		expect(
			(
				decodeServerFrame({
					v: "omp-app/1",
					type: "response",
					requestId: "r",
					hostId: "h",
					command: "session.cancel",
					ok: true,
					result: { cancelled: true },
				}) as Record<string, unknown>
			).result,
		).toEqual({ cancelled: true });
		expect(sameSession({ hostId: "h", sessionId: "s" }, { hostId: "other", sessionId: "s" })).toBe(false);
	});
});
