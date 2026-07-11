import { afterEach, describe, expect, test } from "bun:test";
import {
	createRpcSessionEntrySubscription,
	type RpcSessionEntryFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

type EntryListener = (entry: SessionEntry) => void;

class FakeSessionManager {
	readonly listeners = new Set<EntryListener>();
	subscribeCalls = 0;
	unsubscribeCalls = 0;

	subscribeEntryAppended(listener: EntryListener): () => void {
		this.subscribeCalls += 1;
		this.listeners.add(listener);
		return () => {
			this.unsubscribeCalls += 1;
			this.listeners.delete(listener);
		};
	}

	append(entry: SessionEntry): void {
		for (const listener of this.listeners) listener(entry);
	}
}

function entry(id: string, parentId: string | null, timestamp: string): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp,
		customType: "rpc-test",
		data: { id },
	};
}

describe("RPC durable session-entry frames", () => {
	const originalStdoutWrite = process.stdout.write;

	afterEach(() => {
		process.stdout.write = originalStdoutWrite;
	});

	test("emits one exact frame per durable append in append order", () => {
		const manager = new FakeSessionManager();
		const frames: RpcSessionEntryFrame[] = [];
		const subscription = createRpcSessionEntrySubscription(frame => frames.push(frame));
		subscription.bind(manager);

		const first = entry("entry-1", null, "2026-07-11T12:00:00.000Z");
		const second = entry("entry-2", "entry-1", "2026-07-11T12:00:01.000Z");
		manager.append(first);
		manager.append(second);

		expect(frames).toEqual([
			{ type: "session_entry", entry: first },
			{ type: "session_entry", entry: second },
		]);
		expect(frames.map(frame => [frame.entry.id, frame.entry.parentId, frame.entry.timestamp])).toEqual([
			["entry-1", null, "2026-07-11T12:00:00.000Z"],
			["entry-2", "entry-1", "2026-07-11T12:00:01.000Z"],
		]);
		expect(manager.subscribeCalls).toBe(1);
		subscription.dispose();
	});

	test("switch detaches the old manager and dispose detaches the active manager", () => {
		const oldManager = new FakeSessionManager();
		const newManager = new FakeSessionManager();
		const frames: RpcSessionEntryFrame[] = [];
		const subscription = createRpcSessionEntrySubscription(frame => frames.push(frame));
		subscription.bind(oldManager);
		subscription.switchTo(newManager);

		oldManager.append(entry("old", null, "2026-07-11T12:01:00.000Z"));
		newManager.append(entry("new", null, "2026-07-11T12:01:01.000Z"));
		expect(frames.map(frame => frame.entry.id)).toEqual(["new"]);
		expect(oldManager.unsubscribeCalls).toBe(1);
		expect(newManager.subscribeCalls).toBe(1);

		subscription.dispose();
		newManager.append(entry("after-dispose", null, "2026-07-11T12:01:02.000Z"));
		expect(frames.map(frame => frame.entry.id)).toEqual(["new"]);
		expect(newManager.unsubscribeCalls).toBe(1);
	});

	test("failed session changes can rebind the active manager", () => {
		const manager = new FakeSessionManager();
		const frames: RpcSessionEntryFrame[] = [];
		const subscription = createRpcSessionEntrySubscription(frame => frames.push(frame));
		subscription.bind(manager);

		subscription.unbind();
		try {
			throw new Error("switch rejected");
		} catch {
			subscription.bind(manager);
		}
		manager.append(entry("after-failed-switch", null, "2026-07-11T12:01:03.000Z"));

		expect(frames.map(frame => frame.entry.id)).toEqual(["after-failed-switch"]);
		expect(manager.subscribeCalls).toBe(2);
		expect(manager.unsubscribeCalls).toBe(1);
		subscription.dispose();
	});

	test("writer error cleans up the subscription", () => {
		const manager = new FakeSessionManager();
		let writes = 0;
		const subscription = createRpcSessionEntrySubscription(() => {
			writes += 1;
			throw new Error("writer closed");
		});
		subscription.bind(manager);

		expect(() => manager.append(entry("failed", null, "2026-07-11T12:02:00.000Z"))).toThrow("writer closed");
		manager.append(entry("ignored", null, "2026-07-11T12:02:01.000Z"));
		expect(writes).toBe(1);
		expect(manager.unsubscribeCalls).toBe(1);
	});

	test("subscription never writes directly to stdout", () => {
		let stdoutWrites = 0;
		process.stdout.write = (() => {
			stdoutWrites += 1;
			return true;
		}) as typeof process.stdout.write;
		const manager = new FakeSessionManager();
		const frames: RpcSessionEntryFrame[] = [];
		const subscription = createRpcSessionEntrySubscription(frame => frames.push(frame));
		subscription.bind(manager);
		manager.append(entry("no-stdout", null, "2026-07-11T12:03:00.000Z"));

		expect(frames).toHaveLength(1);
		expect(stdoutWrites).toBe(0);
		subscription.dispose();
	});
});
