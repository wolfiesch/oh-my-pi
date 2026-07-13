import { describe, expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DurableEntry, hostId, projectId, sessionId } from "@oh-my-pi/app-wire";
import { IdempotencyStore } from "../src/idempotency.ts";
import { SessionProjection } from "../src/projection.ts";
import { createAppserver } from "../src/server.ts";
import type { ChildHandle, RpcChildFactory, SessionDiscovery, SessionRecord } from "../src/types.ts";

const host = hostId("host-test");
function record(id: string): SessionRecord {
	return {
		sessionId: sessionId(id),
		path: `/tmp/${id}.jsonl`,
		cwd: "/tmp",
		projectId: projectId("project-test"),
		title: id,
		updatedAt: new Date(0).toISOString(),
		status: "idle",
		entries: [],
	};
}
class FakeChild implements ChildHandle {
	#queue = Promise.withResolvers<void>();
	output: string[] = [];
	killed = false;
	stdin = {
		write: (data: string) => {
			this.output.push(data);
		},
	};
	stdout: AsyncIterable<string> = this.stream();
	exited = Promise.resolve(0);
	async *stream() {
		yield `${JSON.stringify({ type: "ready" })}\n`;
		await this.#queue.promise;
	}
	push(value: Record<string, unknown>) {
		this.output.push(JSON.stringify(value));
	}
	kill() {
		this.killed = true;
		this.#queue.resolve();
	}
}
class FakeFactory implements RpcChildFactory {
	children: FakeChild[] = [];
	spawn() {
		const child = new FakeChild();
		this.children.push(child);
		return child;
	}
	argv(path: string) {
		return ["omp", "--mode", "rpc", "--session", path];
	}
}
class StaticDiscovery implements SessionDiscovery {
	constructor(private readonly records: SessionRecord[]) {}
	async list() {
		return this.records;
	}
}
function entry(id: string, parentId: string | null = null): DurableEntry {
	return {
		id: id as DurableEntry["id"],
		parentId: parentId as DurableEntry["parentId"],
		hostId: host,
		sessionId: sessionId("s"),
		kind: "message",
		timestamp: new Date(0).toISOString(),
		data: { id },
	};
}

describe("projection and replay", () => {
	test("deduplicates durable IDs and emits gap on ring eviction", () => {
		const projection = new SessionProjection(host, record("s"), "epoch-a", 1);
		expect(projection.appendEntry(entry("a"))).toBeDefined();
		expect(projection.appendEntry(entry("a"))).toBeUndefined();
		projection.appendEvent({ type: "live" });
		const replay = projection.replay({ epoch: "epoch-a", seq: 0 });
		expect(replay[0]?.type).toBe("gap");
		expect(projection.value.entries.map(value => String(value.id))).toEqual(["a"]);
	});
	test("publishes title changes and safely fills discovery metadata", () => {
		const source = { ...record("s"), title: "Session" };
		const projection = new SessionProjection(host, source, "epoch-a");
		const discovered = {
			...source,
			projectName: "tmp",
			title: "First substantive request",
			updatedAt: new Date(1).toISOString(),
		};
		const reconciled = projection.reconcileRecord(discovered);
		expect(reconciled).toMatchObject({
			type: "session.delta",
			cursor: { epoch: "epoch-a", seq: 1 },
			upsert: { project: { projectId: "project-test", name: "tmp" }, title: "First substantive request" },
		});
		if (!reconciled) throw new Error("expected discovery metadata delta");
		expect(projection.reconcileRecord(discovered)).toBeUndefined();

		const titled = projection.updateTitle("Explicit title");
		expect(titled).toMatchObject({
			type: "session.delta",
			cursor: { epoch: "epoch-a", seq: 2 },
			upsert: { title: "Explicit title" },
		});
		if (!titled) throw new Error("expected explicit title delta");
		expect(projection.updateTitle("Explicit title")).toBeUndefined();
		expect(
			projection.reconcileRecord({
				...discovered,
				projectName: "stale-project-name",
				title: "Stale discovered title",
			}),
		).toBeUndefined();
		expect(projection.value.ref).toMatchObject({
			project: { projectId: "project-test", name: "tmp" },
			title: "Explicit title",
		});
		expect(projection.replay({ epoch: "epoch-a", seq: 0 })).toEqual([reconciled, titled]);
	});
});
describe("idempotency", () => {
	test("same payload replays and changed payload conflicts", () => {
		const store = new IdempotencyStore();
		const id = "command-a" as never;
		expect(store.begin(id, { value: 1 }).kind).toBe("new");
		const outcome = { frame: { v: "omp-app/1", type: "error", code: "x", message: "x" } as never };
		store.complete(id, { value: 1 }, outcome);
		expect(store.begin(id, { value: 1 })).toMatchObject({ kind: "replay" });
		expect(store.begin(id, { value: 2 })).toMatchObject({ kind: "conflict" });
	});
});
describe("appserver lifecycle", () => {
	test("indexes three sessions, starts one child each, and removes socket", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-appserver-"));
		const socketPath = join(root, "run", "appserver.sock");
		const factory = new FakeFactory();
		const appserver = createAppserver({
			hostId: host,
			epoch: "epoch-test",
			socketPath,
			discovery: new StaticDiscovery([record("a"), record("b"), record("c")]),
			childFactory: factory,
		});
		await appserver.start();
		expect(factory.children).toHaveLength(0);
		const socket = await stat(socketPath);
		expect(socket.mode & 0o777).toBe(0o600);
		const parent = await stat(join(root, "run"));
		expect(parent.mode & 0o777).toBe(0o700);
		await appserver.stop();
		await expect(stat(socketPath)).rejects.toThrow();
		for (const child of factory.children) expect(child.killed).toBe(true);
	});
});
