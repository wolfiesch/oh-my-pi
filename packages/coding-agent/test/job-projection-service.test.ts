import { describe, expect, test, vi } from "bun:test";
import { AsyncJobManager, JobProjectionService } from "../src/async";
import { AgentRegistry } from "../src/registry/agent-registry";

describe("JobProjectionService", () => {
	test("filters every read and cancellation by authoritative owner and preserves queued state", async () => {
		const manager = new AsyncJobManager({ retentionMs: 5_000 });
		const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
		const ownId = manager.register("bash", "own", () => gates[0]!.promise, {
			id: "own-job",
			ownerId: "Main",
			queued: true,
		});
		const otherId = manager.register("bash", "other", () => gates[1]!.promise, {
			id: "other-job",
			ownerId: "Peer",
		});
		const projection = new JobProjectionService({ manager, ownerId: "Main" });

		expect(projection.list().jobs).toMatchObject([{ id: ownId, status: "running", queued: true }]);
		expect(projection.get(otherId)).toBeUndefined();
		expect(await projection.cancel([otherId])).toEqual([
			{ id: otherId, status: "not_found", message: `Background job not found: ${otherId}` },
		]);
		expect(manager.getJob(otherId)?.status).toBe("running");
		expect((await projection.cancel([ownId]))[0]?.status).toBe("cancelled");
		gates[1]!.resolve("done");
		await manager.dispose();
	});

	test("does not retarget a reused job id across the confirmation window", async () => {
		const manager = new AsyncJobManager({ retentionMs: 0 });
		const registerAbortable = (id: string) =>
			manager.register(
				"bash",
				id,
				({ signal }) =>
					new Promise<string>((_, reject) => {
						signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
					}),
				{ id, ownerId: "Main" },
			);
		registerAbortable("reused");
		registerAbortable("unchanged");
		const projection = new JobProjectionService({ manager, ownerId: "Main" });
		const resolved = projection.resolveCancellationTargets(["reused", "unchanged"]);
		const original = manager.getJob("reused")!;

		expect(manager.cancel("reused", { ownerId: "Main" })).toBe(true);
		await original.promise;
		expect(registerAbortable("reused")).toBe("reused");

		expect(await projection.cancelResolved(resolved)).toEqual([
			{
				id: "reused",
				status: "not_found",
				message: "Background job reused changed before it could be cancelled.",
			},
			{ id: "unchanged", status: "cancelled", message: "Cancelled background job unchanged." },
		]);
		expect(manager.getJob("reused")?.status).toBe("running");
		expect(manager.cancel("reused", { ownerId: "Main" })).toBe(true);
		await manager.dispose();
	});

	test("does not retarget a reused agent id in a mixed confirmation batch", async () => {
		const manager = new AsyncJobManager({ retentionMs: 0 });
		const registry = new AgentRegistry();
		const originalSession = { dispose: vi.fn(async () => {}) };
		const replacementSession = { dispose: vi.fn(async () => {}) };
		const unchangedSession = { dispose: vi.fn(async () => {}) };
		const newlyAppearedSession = { dispose: vi.fn(async () => {}) };
		const original = registry.register({
			id: "reused-agent",
			displayName: "Original",
			kind: "sub",
			parentId: "Main",
			session: originalSession as never,
			status: "idle",
		});
		registry.register({
			id: "unchanged-agent",
			displayName: "Unchanged",
			kind: "sub",
			parentId: "Main",
			session: unchangedSession as never,
			status: "idle",
		});
		const projection = new JobProjectionService({ manager, ownerId: "Main", registry });
		const resolved = projection.resolveCancellationTargets(["reused-agent", "unchanged-agent", "new-agent"]);

		registry.unregister("reused-agent", original);
		const replacement = registry.register({
			id: "reused-agent",
			displayName: "Replacement",
			kind: "sub",
			parentId: "Main",
			session: replacementSession as never,
			status: "idle",
		});
		const newlyAppeared = registry.register({
			id: "new-agent",
			displayName: "New",
			kind: "sub",
			parentId: "Main",
			session: newlyAppearedSession as never,
			status: "idle",
		});

		expect(await projection.cancelResolved(resolved)).toEqual([
			{
				id: "reused-agent",
				status: "not_found",
				message: "Agent reused-agent changed before it could be cancelled.",
			},
			{
				id: "unchanged-agent",
				status: "cancelled",
				message: "Cancelled agent unchanged-agent (killed session, dropped registration).",
			},
			{
				id: "new-agent",
				status: "not_found",
				message: "Background job not found: new-agent",
			},
		]);
		expect(registry.get("reused-agent")).toBe(replacement);
		expect(replacementSession.dispose).not.toHaveBeenCalled();
		expect(registry.get("new-agent")).toBe(newlyAppeared);
		expect(newlyAppearedSession.dispose).not.toHaveBeenCalled();
		expect(registry.get("unchanged-agent")).toBeUndefined();
		expect(unchangedSession.dispose).toHaveBeenCalledTimes(1);
		await manager.dispose();
	});

	test("retains bounded settled output until manager expiry", async () => {
		vi.useFakeTimers();
		try {
			const manager = new AsyncJobManager({ retentionMs: 5 });
			const id = manager.register("bash", "short", async () => "done", { ownerId: "Main" });
			await manager.getJob(id)!.promise;
			const projection = new JobProjectionService({ manager, ownerId: "Main" });
			expect(projection.get(id)).toMatchObject({ id, status: "completed", resultText: "done" });
			vi.advanceTimersByTime(6);
			expect(projection.get(id)).toBeUndefined();
			await manager.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});
