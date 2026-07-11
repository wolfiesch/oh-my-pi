import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

describe("nested task policy", () => {
	it("inherits root delegation guidance when no nested policy is configured", () => {
		const root = Settings.isolated({ "task.eager": "preferred" });

		const child = createSubagentSettings(root);

		expect(child.get("task.eager")).toBe("preferred");
		expect(child.get("task.nestedEager")).toBe("inherit");
	});

	it("applies conservative delegation guidance to every descendant", () => {
		const root = Settings.isolated({
			"task.eager": "preferred",
			"task.nestedEager": "default",
		});

		const child = createSubagentSettings(root);
		const grandchild = createSubagentSettings(child);

		expect(root.get("task.eager")).toBe("preferred");
		expect(child.get("task.eager")).toBe("default");
		expect(grandchild.get("task.eager")).toBe("default");
	});

	it("renders a conservative GPT-5.6 prompt from the descendant override", async () => {
		const root = Settings.isolated({
			"task.eager": "preferred",
			"task.nestedEager": "default",
			"task.maxConcurrency": 12,
			"task.maxNestedConcurrency": 4,
		});
		const child = createSubagentSettings(root);
		const cwd = process.cwd();

		const { systemPrompt } = await buildSystemPrompt({
			cwd,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["task"],
			workspaceTree: { ...EMPTY_TREE, rootPath: cwd },
			activeRepoContext: null,
			model: "openai/gpt-5.6-luna",
			includeModelInPrompt: false,
			eagerTasks: child.get("task.eager") !== "default",
			eagerTasksAlways: child.get("task.eager") === "always",
			taskBatch: child.get("task.batch"),
			taskMaxConcurrency: child.get("task.maxConcurrency"),
		});
		const rendered = systemPrompt.join("\n\n");

		expect(rendered).toContain("Do not spawn sub-agents unless");
		expect(rendered).not.toContain("Proactive multi-agent delegation is active");
		expect(rendered).not.toContain("Maximize parallelism");
	});

	it("inherits the parent task concurrency when no nested limit is configured", () => {
		const root = Settings.isolated({ "task.maxConcurrency": 12 });

		const child = createSubagentSettings(root);

		expect(child.get("task.maxConcurrency")).toBe(12);
		expect(child.get("task.maxNestedConcurrency")).toBe(-1);
	});

	it("applies the per-child limit to every descendant", () => {
		const root = Settings.isolated({
			"task.maxConcurrency": 12,
			"task.maxNestedConcurrency": 4,
		});

		const child = createSubagentSettings(root);
		const grandchild = createSubagentSettings(child);

		expect(root.get("task.maxConcurrency")).toBe(12);
		expect(child.get("task.maxConcurrency")).toBe(4);
		expect(grandchild.get("task.maxConcurrency")).toBe(4);
	});

	it("retains unlimited nested concurrency when explicitly configured", () => {
		const root = Settings.isolated({
			"task.maxConcurrency": 12,
			"task.maxNestedConcurrency": 0,
		});

		const child = createSubagentSettings(root);

		expect(child.get("task.maxConcurrency")).toBe(0);
	});
});
