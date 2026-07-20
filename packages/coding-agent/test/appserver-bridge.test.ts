import { describe, expect, test } from "bun:test";
import { hostId, projectId, sessionId } from "@oh-my-pi/app-wire";
import {
	decodeOmpAuthorityBridgeServerFrame,
	encodeOmpAuthorityBridgeFrame,
	OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES,
	OMP_AUTHORITY_BRIDGE_PROTOCOL,
} from "@oh-my-pi/appserver";
import { runOmpAuthorityBridge } from "../src/cli/appserver-bridge-cli";

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

function session() {
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

function runtime() {
	const record = session();
	const sessionAuthority = {
		create: async () => ({ ...record }),
		list: async () => [record],
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

function request(id: string, method: "session.list" | "operation.termOpen", params: Record<string, unknown>) {
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
});
