import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hostId, MAX_ARRAY_ITEMS, projectId, sessionId } from "@oh-my-pi/app-wire";
import {
	decodeOmpAuthorityBridgeServerFrame,
	encodeOmpAuthorityBridgeFrame,
	OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES,
	OMP_AUTHORITY_BRIDGE_PROTOCOL,
	type SessionRecord,
} from "@oh-my-pi/appserver";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { runOmpAuthorityBridge } from "../src/cli/appserver-bridge-cli";
import { CURRENT_SESSION_VERSION } from "../src/session/session-entries";
import { inspectSessionLock } from "../src/session/session-lock";

class AsyncQueue implements AsyncIterable<string> {
	readonly #values: string[] = [];
	readonly #waiters: Array<(value: IteratorResult<string>) => void> = [];
	#closed = false;
	push(value: string): void {
		const waiter = this.#waiters.shift();
		if (waiter) waiter({ done: false, value });
		else this.#values.push(value);
	}
	close(): void {
		this.#closed = true;
		for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
	}
	[Symbol.asyncIterator](): AsyncIterator<string> {
		return {
			next: () => {
				const value = this.#values.shift();
				if (value !== undefined) return Promise.resolve({ done: false, value });
				if (this.#closed) return Promise.resolve({ done: true, value: undefined });
				return new Promise(resolve => this.#waiters.push(resolve));
			},
		};
	}
}

function session(): SessionRecord {
	return {
		sessionId: sessionId("session-test"),
		path: "/tmp/session-test.jsonl",
		cwd: "/tmp/project",
		projectId: projectId("project-test"),
		title: "Test",
		updatedAt: new Date(0).toISOString(),
		status: "idle" as const,
		entries: [],
	};
}

function runtime(record: SessionRecord = session(), records: readonly SessionRecord[] = [record]) {
	const sessionAuthority = {
		create: async () => ({ ...record }),
		list: async () => records,
		archive: async () => {},
		restore: async () => {},
		delete: async () => {},
	};
	return {
		sessionAuthority,
		discovery: { list: sessionAuthority.list, load: async () => record },
		operationsAuthority: {
			termOpen: async (_args: unknown, context: { emitTerminalOutput?: (frame: unknown) => void }) => {
				context.emitTerminalOutput?.({
					v: "omp-app/1",
					type: "terminal.output",
					hostId: hostId("host-test"),
					sessionId: record.sessionId,
					terminalId: "terminal-test",
					cursor: { epoch: "terminal", seq: 1 },
					stream: "stdout",
					data: "ready",
				});
				return { terminalId: "terminal-test" };
			},
			terminalInput: async () => {},
			terminalResize: async () => {},
			terminalClose: async () => {},
		},
		projectRootForProject: async () => record.cwd,
		projectRootForSession: async () => record.cwd,
		lockCheck: () => {},
		lockStatus: () => "missing" as const,
		transcriptSearchAuthority: {},
	} as never;
}

function request(
	id: string,
	method: "session.list" | "discovery.load" | "operation.termOpen",
	params: Record<string, unknown>,
) {
	return encodeOmpAuthorityBridgeFrame({
		v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
		type: "request",
		id,
		method,
		params,
	});
}

describe("thin OMP authority bridge", () => {
	test("advertises concrete methods and serves sessions plus terminal events over stdio", async () => {
		const input = new AsyncQueue();
		const output: string[] = [];
		const running = runOmpAuthorityBridge({
			runtime: runtime(),
			input,
			write: line => {
				output.push(line);
			},
			identity: { ompVersion: "17.0.5", ompBuild: "bridge-test" },
		});
		input.push(request("list-1", "session.list", {}));
		input.push(
			request("term-1", "operation.termOpen", {
				args: {},
				context: {
					hostId: "host-test",
					sessionId: "session-test",
					deviceId: "device-test",
					connectionId: "connection-test",
					capabilities: ["term.open"],
				},
			}),
		);
		input.close();
		await running;
		const frames = output.map(line => decodeOmpAuthorityBridgeServerFrame(JSON.parse(line)));
		expect(frames[0]).toMatchObject({
			type: "ready",
			ompVersion: "17.0.5",
			methods: expect.arrayContaining(["host.info", "session.list", "operation.termOpen", "terminal.close"]),
		});
		expect(frames[0]).not.toMatchObject({ methods: expect.arrayContaining(["operation.filesRead"]) });
		expect(frames).toContainEqual(expect.objectContaining({ type: "response", id: "list-1", ok: true }));
		expect(frames).toContainEqual(expect.objectContaining({ type: "event", id: "term-1", event: "terminal" }));
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "response",
				id: "term-1",
				ok: true,
				result: { terminalId: "terminal-test" },
			}),
		);
	});

	test("emits sparse session-list records before the bridge frame is encoded", async () => {
		using tempDir = TempDir.createSync("@omp-bridge-list-");
		const input = new AsyncQueue();
		const output: string[] = [];
		const sessionPath = path.join(tempDir.path(), "session.jsonl");
		await Bun.write(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "session-test",
				timestamp: new Date(0).toISOString(),
				cwd: "/tmp/project",
				authorityProtocol: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			})}\n`,
		);
		const large: SessionRecord = {
			...session(),
			path: sessionPath,
			entries: [
				{
					id: "large-entry" as never,
					parentId: null,
					hostId: hostId("host-test"),
					sessionId: sessionId("session-test"),
					kind: "message",
					timestamp: new Date(0).toISOString(),
					data: { text: "x".repeat(OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES + 1) },
				},
			],
		};
		const running = runOmpAuthorityBridge({
			runtime: runtime(large),
			input,
			write: line => {
				output.push(line);
			},
			identity: { ompVersion: "17.0.5", ompBuild: "bridge-test" },
		});
		input.push(request("list-large", "session.list", {}));
		input.close();
		await running;

		const response = output
			.map(line => decodeOmpAuthorityBridgeServerFrame(JSON.parse(line)))
			.find(frame => frame.type === "response" && frame.id === "list-large");
		expect(response).toMatchObject({
			type: "response",
			ok: true,
			result: {
				sessions: [
					{
						...large,
						authorityProtocol: OMP_AUTHORITY_BRIDGE_PROTOCOL,
						entriesLoaded: false,
						entries: [],
					},
				],
			},
		});
		expect(Buffer.byteLength(output.find(line => line.includes('"list-large"'))!, "utf8")).toBeLessThanOrEqual(
			OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES,
		);
	});

	test("preserves the transcript authority marker when loading a session", async () => {
		using tempDir = TempDir.createSync("@omp-bridge-load-");
		const sessionPath = path.join(tempDir.path(), "session.jsonl");
		await Bun.write(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "session-test",
				timestamp: new Date(0).toISOString(),
				cwd: "/tmp/project",
				authorityProtocol: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			})}\n`,
		);
		const record: SessionRecord = { ...session(), path: sessionPath };
		const input = new AsyncQueue();
		const output: string[] = [];
		const running = runOmpAuthorityBridge({
			runtime: runtime(record),
			input,
			write: line => {
				output.push(line);
			},
			identity: { ompVersion: "17.0.5", ompBuild: "bridge-test" },
		});
		input.push(request("load-1", "discovery.load", { session: record }));
		input.close();
		await running;
		const response = output
			.map(line => decodeOmpAuthorityBridgeServerFrame(JSON.parse(line)))
			.find(frame => frame.type === "response" && frame.id === "load-1");
		expect(response).toMatchObject({
			type: "response",
			ok: true,
			result: { authorityProtocol: OMP_AUTHORITY_BRIDGE_PROTOCOL },
		});
	});

	test("returns a complete bounded session inventory", async () => {
		const input = new AsyncQueue();
		const output: string[] = [];
		const collected: unknown[] = [];
		const continuationCursors = new Set<string>();
		let pageNumber = 0;
		const sessions = Array.from({ length: MAX_ARRAY_ITEMS }, (_, index) => ({
			...session(),
			sessionId: sessionId(`session-${index}`),
			path: `/tmp/session-${index}.jsonl`,
			title: `Session ${index} ${"x".repeat(2048)}`,
		}));
		const running = runOmpAuthorityBridge({
			runtime: runtime(session(), sessions),
			input,
			write: line => {
				output.push(line);
				const frame = decodeOmpAuthorityBridgeServerFrame(JSON.parse(line));
				if (frame.type !== "response" || !frame.id.startsWith("list-page-") || !frame.ok) return;
				if (!frame.result || typeof frame.result !== "object" || Array.isArray(frame.result))
					throw new Error("session list page is unavailable");
				const page = frame.result as Record<string, unknown>;
				if (!Array.isArray(page.sessions)) throw new Error("session list page sessions are unavailable");
				collected.push(...page.sessions);
				if (typeof page.nextCursor === "string") {
					if (continuationCursors.has(page.nextCursor)) throw new Error("session list cursor repeated");
					continuationCursors.add(page.nextCursor);
					pageNumber += 1;
					input.push(request(`list-page-${pageNumber}`, "session.list", { cursor: page.nextCursor }));
				} else {
					input.close();
				}
			},
			identity: { ompVersion: "17.0.5", ompBuild: "bridge-test" },
		});
		input.push(request("list-page-0", "session.list", {}));
		await running;

		const responseLines = output.filter(line => line.includes('"id":"list-page-'));
		expect(responseLines.length).toBeGreaterThan(2);
		expect(continuationCursors.size).toBe(responseLines.length - 1);
		expect(responseLines.every(line => Buffer.byteLength(line, "utf8") <= OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES)).toBe(
			true,
		);
		expect(collected).toHaveLength(MAX_ARRAY_ITEMS);
		const lastIndex = MAX_ARRAY_ITEMS - 1;
		expect(collected[0]).toMatchObject({ sessionId: "session-0" });
		expect(collected[lastIndex]).toMatchObject({ sessionId: `session-${lastIndex}` });
	});

	test("marks an over-limit inventory partial instead of treating omissions as complete", async () => {
		const input = new AsyncQueue();
		const output: string[] = [];
		const sessions = Array.from({ length: MAX_ARRAY_ITEMS + 1 }, (_, index) => ({
			...session(),
			sessionId: sessionId(`session-${index}`),
			path: `/tmp/session-${index}.jsonl`,
		}));
		const running = runOmpAuthorityBridge({
			runtime: runtime(session(), sessions),
			input,
			write: line => {
				output.push(line);
			},
			identity: { ompVersion: "17.0.5", ompBuild: "bridge-test" },
		});
		input.push(request("list-too-large", "session.list", {}));
		input.close();
		await running;

		const response = output
			.map(line => decodeOmpAuthorityBridgeServerFrame(JSON.parse(line)))
			.find(frame => frame.type === "response" && frame.id === "list-too-large");
		expect(response).toMatchObject({
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "response",
			id: "list-too-large",
			ok: true,
			result: {
				complete: false,
				totalCount: MAX_ARRAY_ITEMS + 1,
			},
		});
		if (response?.type !== "response" || !response.ok)
			throw new Error("partial session inventory response is unavailable");
		const page = response.result as { sessions: unknown[] };
		expect(page.sessions).toHaveLength(MAX_ARRAY_ITEMS);
	});

	test("rejects malformed frames before invoking authority code", async () => {
		const input = new AsyncQueue();
		const running = runOmpAuthorityBridge({
			runtime: runtime(),
			input,
			write: () => {},
			identity: { ompVersion: "17.0.5", ompBuild: "bridge-test" },
		});
		input.push(
			`${JSON.stringify({
				v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
				type: "request",
				id: "bad-1",
				method: "session.list",
				params: {},
				extra: true,
			})}\n`,
		);
		input.close();
		await expect(running).rejects.toThrow("unknown or missing fields");
	});

	test("rejects an oversized unfinished input frame", async () => {
		const input = new AsyncQueue();
		const running = runOmpAuthorityBridge({
			runtime: runtime(),
			input,
			write: () => {},
			identity: { ompVersion: "17.0.5", ompBuild: "bridge-test" },
		});
		input.push("x".repeat(OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES + 1));
		await expect(running).rejects.toThrow("bridge input exceeds the line limit");
	});

	test("forks a session into an unlocked copy and never writes the source", async () => {
		using tempDir = TempDir.createSync("@omp-bridge-fork-");
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		try {
			const cwd = path.join(tempDir.path(), "project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(cwd, { recursive: true });
			await fs.mkdir(sessionDir, { recursive: true });
			const sourceFile = path.join(sessionDir, "source.jsonl");
			const timestamp = new Date().toISOString();
			const sourceText = `${JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "bridge-fork-source",
				timestamp,
				cwd,
			})}\n${JSON.stringify({
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "carried across", timestamp: Date.now() },
			})}\n`;
			await Bun.write(sourceFile, sourceText);
			const record: SessionRecord = {
				...session(),
				sessionId: sessionId("bridge-fork-source"),
				path: sourceFile,
				cwd,
			};
			const input = new AsyncQueue();
			const output: string[] = [];
			const running = runOmpAuthorityBridge({
				runtime: runtime(record),
				input,
				write: line => {
					output.push(line);
				},
				identity: { ompVersion: "17.0.5", ompBuild: "bridge-test" },
			});
			input.push(
				encodeOmpAuthorityBridgeFrame({
					v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
					type: "request",
					id: "fork-1",
					method: "session.fork",
					params: { session: record },
				}),
			);
			input.close();
			await running;
			const frames = output.map(line => decodeOmpAuthorityBridgeServerFrame(JSON.parse(line)));
			expect(frames[0]).toMatchObject({
				type: "ready",
				methods: expect.arrayContaining(["session.fork"]),
			});
			const forked = frames.find(frame => frame.type === "response" && frame.id === "fork-1");
			if (forked?.type !== "response") throw new Error("expected a fork response");
			if (!forked.ok) throw new Error("fork request was rejected");
			const result = forked.result;
			if (!result || typeof result !== "object") throw new Error("expected a fork result");
			if (!("path" in result) || typeof result.path !== "string") throw new Error("expected a fork path");
			if (!("sessionId" in result) || typeof result.sessionId !== "string")
				throw new Error("expected a fork session id");
			expect(result.path).not.toBe(sourceFile);
			expect(result.sessionId).not.toBe("bridge-fork-source");
			// The source is read, never written.
			expect(await Bun.file(sourceFile).text()).toBe(sourceText);
			// The copy carries the history and arrives unlocked, so the host can
			// start its own writer instead of seeing the fork as live elsewhere.
			expect(await Bun.file(result.path).text()).toContain("carried across");
			expect(inspectSessionLock(result.path).status).toBe("missing");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	// Historic transcripts routinely name a project directory that has since been
	// deleted. The copy is a new session and has to live somewhere real, so the
	// caller may name an existing directory for it.
	test("forks a session whose recorded directory is gone into a caller-chosen one", async () => {
		using tempDir = TempDir.createSync("@omp-bridge-fork-cwd-");
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		try {
			const goneCwd = path.join(tempDir.path(), "deleted-project");
			const chosenCwd = path.join(tempDir.path(), "chosen-project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(chosenCwd, { recursive: true });
			await fs.mkdir(sessionDir, { recursive: true });
			const sourceFile = path.join(sessionDir, "gone-source.jsonl");
			const timestamp = new Date().toISOString();
			const sourceText = `${JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "bridge-fork-gone",
				timestamp,
				cwd: goneCwd,
			})}\n${JSON.stringify({
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "carried across", timestamp: Date.now() },
			})}\n`;
			await Bun.write(sourceFile, sourceText);
			const record: SessionRecord = {
				...session(),
				sessionId: sessionId("bridge-fork-gone"),
				path: sourceFile,
				cwd: goneCwd,
			};
			const input = new AsyncQueue();
			const output: string[] = [];
			const running = runOmpAuthorityBridge({
				runtime: runtime(record),
				input,
				write: line => {
					output.push(line);
				},
				identity: { ompVersion: "17.0.5", ompBuild: "bridge-test" },
			});
			input.push(
				encodeOmpAuthorityBridgeFrame({
					v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
					type: "request",
					id: "fork-gone",
					method: "session.fork",
					params: { session: record, cwd: chosenCwd },
				}),
			);
			input.push(
				encodeOmpAuthorityBridgeFrame({
					v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
					type: "request",
					id: "fork-missing",
					method: "session.fork",
					params: { session: record, cwd: path.join(tempDir.path(), "not-there") },
				}),
			);
			input.close();
			await running;
			const frames = output.map(line => decodeOmpAuthorityBridgeServerFrame(JSON.parse(line)));
			const forked = frames.find(frame => frame.type === "response" && frame.id === "fork-gone");
			if (forked?.type !== "response") throw new Error("expected a fork response");
			if (!forked.ok) throw new Error("fork request was rejected");
			const result = forked.result;
			if (!result || typeof result !== "object") throw new Error("expected a fork result");
			if (!("cwd" in result) || typeof result.cwd !== "string") throw new Error("expected a fork cwd");
			if (!("path" in result) || typeof result.path !== "string") throw new Error("expected a fork path");
			// The copy runs where the caller asked, and the header carries it, so
			// the choice survives rediscovery instead of living only in memory.
			expect(result.cwd).toBe(chosenCwd);
			expect(await Bun.file(result.path).text()).toContain(chosenCwd);
			expect(await Bun.file(result.path).text()).toContain("carried across");
			// The source is still only read.
			expect(await Bun.file(sourceFile).text()).toBe(sourceText);
			// A directory that does not exist is refused rather than substituted.
			const refused = frames.find(frame => frame.type === "response" && frame.id === "fork-missing");
			if (refused?.type !== "response") throw new Error("expected a refusal response");
			expect(refused.ok).toBe(false);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});
});
