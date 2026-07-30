import { describe, expect, test } from "bun:test";
import { sessionId } from "@oh-my-pi/app-wire";
import {
	decodeOmpAuthorityBridgeServerFrame,
	encodeOmpAuthorityBridgeFrame,
	OMP_AUTHORITY_BRIDGE_METHODS,
	OMP_AUTHORITY_BRIDGE_PROTOCOL,
	type OmpAuthorityBridgeMethod,
} from "../../appserver/src/omp-authority-bridge-contract";
import {
	type BridgeSessionRecord,
	type OmpAuthorityBridgeAuthority,
	runOmpAuthorityBridge,
} from "../src/cli/appserver-bridge-cli";
import { isSubcommand } from "../src/cli-commands";

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
				const gate = Promise.withResolvers<IteratorResult<string>>();
				this.#waiters.push(gate.resolve);
				return gate.promise;
			},
		};
	}
}

function fixture(): BridgeSessionRecord {
	return {
		sessionId: sessionId("session-test", "sessionId"),
		path: "/tmp/session-test.jsonl",
		cwd: "/tmp/project",
		projectId: "project-test",
		projectName: "project",
		title: "Test",
		updatedAt: new Date(0).toISOString(),
		status: "idle",
		entriesLoaded: false,
		entries: [],
	};
}
function authority(
	overrides: Partial<Pick<OmpAuthorityBridgeAuthority, "flush" | "quiesce">> = {},
): OmpAuthorityBridgeAuthority {
	const item = fixture();
	let current: BridgeSessionRecord | undefined = item;
	const operation = async (args: Record<string, unknown>): Promise<unknown> => structuredClone(args);
	const terminal = async (): Promise<void> => undefined;
	return {
		create: async () => (current = item),
		fork: async () => (current = item),
		list: async () => (current ? [current] : []),
		archive: async (session, archivedAt) => {
			current = { ...session, archivedAt };
		},
		restore: async session => {
			const { archivedAt: _archivedAt, ...restored } = session;
			current = restored;
		},
		delete: async session => {
			if (current?.sessionId === session.sessionId) current = undefined;
		},
		load: async session => ({ ...session, entriesLoaded: true }),
		page: async session => ({ entries: session.entries, hasMore: false, generation: "test" }),
		rootForProject: async () => item.cwd,
		rootForSession: async () => item.cwd,
		lockCheck: async () => undefined,
		lockStatus: async () => "missing",
		operations: {
			filesRead: operation,
			filesList: operation,
			filesDiff: operation,
			filesWrite: operation,
			filesPatch: operation,
			reviewRead: operation,
			reviewApply: operation,
			bashRun: operation,
			termOpen: operation,
			catalogGet: operation,
			settingsRead: operation,
			brokerStatus: operation,
			settingsWrite: operation,
			configWrite: operation,
			terminalInput: terminal,
			terminalResize: terminal,
			terminalClose: terminal,
		},
		usageRead: async () => ({ generatedAt: 0, reports: [], accountsWithoutUsage: [], capacity: {} }),
		flush: overrides.flush ?? (async () => {}),
		quiesce: overrides.quiesce ?? (async () => {}),
		shutdown: async () => undefined,
	};
}
function request(id: string, method: OmpAuthorityBridgeMethod, params: Record<string, unknown> = {}): string {
	return encodeOmpAuthorityBridgeFrame({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "request", id, method, params });
}

const identity = { ompVersion: "test", ompBuild: "test-build" };

describe("OMP authority bridge lifecycle", () => {
	test("routes bridge as a top-level CLI command", () => {
		expect(isSubcommand("bridge")).toBe(true);
	});

	test("returns generation-bound durable acknowledgements and keeps reads available after quiesce", async () => {
		const input = new AsyncQueue();
		const output: string[] = [];
		const calls: string[] = [];
		const running = runOmpAuthorityBridge({
			authority: authority({
				flush: async () => {
					calls.push("flush");
				},
				quiesce: async options => {
					calls.push(`quiesce:${options.interrupt}`);
				},
			}),
			input,
			write: line => {
				output.push(line);
			},
			identity,
			generation: "gen_test_0001",
		});
		input.push(request("health", "host.info"));
		input.push(request("flush", "authority.flush", { generation: "gen_test_0001", timeoutMs: 1000 }));
		input.push(
			request("quiesce", "authority.quiesce", { generation: "gen_test_0001", timeoutMs: 1000, interrupt: true }),
		);
		input.push(request("mutate", "session.create", { cwd: "/tmp/project" }));
		input.push(request("list", "session.list"));
		input.push(request("flush-after", "authority.flush"));
		input.close();
		await running;
		const frames = output.map(line => decodeOmpAuthorityBridgeServerFrame(JSON.parse(line)));
		expect(frames[0]).toMatchObject({ type: "ready", methods: OMP_AUTHORITY_BRIDGE_METHODS });
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "response",
				id: "health",
				ok: true,
				result: { transcriptImageRoot: expect.any(String) },
			}),
		);
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "response",
				id: "flush",
				ok: true,
				result: { schemaVersion: 1, generation: "gen_test_0001", durable: true },
			}),
		);
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "response",
				id: "quiesce",
				ok: true,
				result: { schemaVersion: 1, generation: "gen_test_0001", durable: true, quiesced: true },
			}),
		);
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "response",
				id: "mutate",
				ok: false,
				error: { code: "QUIESCED", message: "authority is quiesced" },
			}),
		);
		expect(frames).toContainEqual(expect.objectContaining({ type: "response", id: "list", ok: true }));
		expect(frames).toContainEqual(expect.objectContaining({ type: "response", id: "flush-after", ok: true }));
		expect(calls).toEqual(["flush", "quiesce:true", "flush"]);
	});

	test("fails stale generations closed without invoking durability work", async () => {
		let flushed = false;
		const input = new AsyncQueue();
		const output: string[] = [];
		const running = runOmpAuthorityBridge({
			authority: authority({
				flush: async () => {
					flushed = true;
				},
			}),
			input,
			write: line => {
				output.push(line);
			},
			identity,
			generation: "gen_current",
		});
		input.push(request("flush", "authority.flush", { generation: "gen_stale" }));
		input.close();
		await running;
		expect(flushed).toBe(false);
		expect(output.map(line => decodeOmpAuthorityBridgeServerFrame(JSON.parse(line)))).toContainEqual(
			expect.objectContaining({
				type: "response",
				id: "flush",
				ok: false,
				error: { code: "STALE_GENERATION", message: "runtime generation is stale" },
			}),
		);
	});

	test("rolls the mutation fence back if quiesce fails", async () => {
		const input = new AsyncQueue();
		const output: string[] = [];
		const running = runOmpAuthorityBridge({
			authority: authority({ quiesce: () => Promise.withResolvers<void>().promise }),
			input,
			write: line => {
				output.push(line);
				const frame = decodeOmpAuthorityBridgeServerFrame(JSON.parse(line));
				if (frame.type === "response" && frame.id === "quiesce") {
					input.push(request("create", "session.create", { cwd: "/tmp/project" }));
					input.close();
				}
			},
			identity,
			generation: "gen_current",
		});
		input.push(request("quiesce", "authority.quiesce", { timeoutMs: 5 }));
		await running;
		const frames = output.map(line => decodeOmpAuthorityBridgeServerFrame(JSON.parse(line)));
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "response",
				id: "quiesce",
				ok: false,
				error: { code: "TIMEOUT", message: "operation timed out" },
			}),
		);
		expect(frames).toContainEqual(expect.objectContaining({ type: "response", id: "create", ok: true }));
	});

	test("rejects unknown frame fields before invoking authority", async () => {
		const input = new AsyncQueue();
		const running = runOmpAuthorityBridge({ authority: authority(), input, write: () => {}, identity });
		input.push(
			`${JSON.stringify({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "request", id: "bad", method: "host.info", params: {}, extra: true })}\n`,
		);
		input.close();
		await expect(running).rejects.toThrow("unknown or missing fields");
	});
});
