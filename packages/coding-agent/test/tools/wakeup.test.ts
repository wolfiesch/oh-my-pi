import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createTools } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import { WakeupTool } from "@oh-my-pi/pi-coding-agent/tools/wakeup";

describe("WakeupTool", () => {
	let manager: AsyncJobManager;
	let completions: Array<{ jobId: string; text: string }>;
	let session: ToolSession;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(Date, "now").mockReturnValue(new Date("2026-07-17T12:00:00.000Z").getTime());
		completions = [];
		manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});
		session = {
			cwd: "/tmp/test",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			settings: Settings.isolated(),
			asyncJobManager: manager,
		};
	});

	afterEach(async () => {
		manager.cancelAll();
		await manager.dispose();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("is an essential builtin when async delivery is available", async () => {
		const tools = await createTools(session);
		const wakeup = tools.find(tool => tool.name === "wakeup");

		expect(wakeup).toBeDefined();
		expect(wakeup?.loadMode).toBe("essential");
		expect(wakeup?.description).toContain("wake yourself");
	});

	it("sanitizes the prompt shown in execution approval details", () => {
		const tool = new WakeupTool(session);
		const details = tool.formatApprovalDetails?.({
			delaySeconds: 60,
			prompt: `first\tsecond\n${"x".repeat(200)}`,
		});

		expect(details).toBeDefined();
		expect(details?.[1]).toStartWith("Prompt: first second ");
		expect(details?.[1]).not.toContain("\t");
		expect(details?.[1]).not.toContain("\n");
		expect(Bun.stringWidth(details?.[1] ?? "")).toBeLessThanOrEqual(88);
	});

	it("delivers the saved prompt once after the requested delay", async () => {
		const tool = new WakeupTool(session);
		const result = await tool.execute("call-1", {
			delaySeconds: 60,
			prompt: "Check CI again and report the result.",
		});
		const details = result.details;
		if (!details) throw new Error("Expected wakeup result details");

		expect(result.content.map(block => (block.type === "text" ? block.text : "")).join("\n")).toContain(
			"Scheduled wakeup",
		);
		expect(details.scheduledAt).toBe("2026-07-17T12:01:00.000Z");
		expect(manager.getJob(details.jobId)).toMatchObject({
			type: "wakeup",
			status: "running",
			ownerId: "Main",
			passive: true,
		});

		vi.advanceTimersByTime(59_999);
		await Promise.resolve();
		expect(completions).toEqual([]);

		vi.advanceTimersByTime(1);
		await manager.waitForAll();
		await manager.drainDeliveries();

		expect(completions).toEqual([
			{
				jobId: details.jobId,
				text: expect.stringContaining("Check CI again and report the result."),
			},
		]);
		expect(manager.getJob(details.jobId)?.status).toBe("completed");
	});

	it("lists and cancels a pending wakeup through hub", async () => {
		const tool = new WakeupTool(session);
		const result = await tool.execute("call-2", {
			delaySeconds: 600,
			prompt: "This should never be delivered.",
		});
		const details = result.details;
		if (!details) throw new Error("Expected wakeup result details");

		const hub = new HubTool(session);
		const jobsResult = await hub.execute("hub-jobs", { op: "jobs" });
		const jobsText = jobsResult.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		expect(jobsText).toContain(details.jobId);
		expect(jobsText).toContain("wakeup");

		await hub.execute("hub-cancel", { op: "cancel", ids: [details.jobId] });
		await manager.waitForAll();
		await manager.drainDeliveries();

		expect(manager.getJob(details.jobId)?.status).toBe("cancelled");
		expect(completions).toEqual([]);
	});
});
