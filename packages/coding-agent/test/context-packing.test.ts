import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import { Settings } from "../src/config/settings";
import { SessionManager } from "../src/session/session-manager";
import { packToolOutput, rankSourceUnits, segmentToolOutput } from "../src/tools/context-packing";
import { type OutputMeta, wrapToolWithMetaNotice } from "../src/tools/output-meta";

function textContent(result: { content: readonly { text?: string; type: string }[] }): string {
	return result.content
		.filter(
			(block): block is { text: string; type: "text" } => block.type === "text" && typeof block.text === "string",
		)
		.map(block => block.text)
		.join("\n");
}

function createToolContext(
	settings: Settings,
	sessionManager: SessionManager = SessionManager.inMemory(),
): AgentToolContext {
	return {
		abort: () => {},
		hasQueuedMessages: () => false,
		isIdle: () => true,
		model: undefined,
		modelRegistry: { find: () => undefined, getAll: () => [], getApiKey: async () => undefined },
		sessionManager,
		settings,
	} as unknown as AgentToolContext;
}

describe("evidence-aware tool-output packing", () => {
	it("returns deterministic exact source spans within the byte budget", () => {
		const content = [
			...Array.from({ length: 180 }, (_, index) => `routine line ${index}`),
			"Error: cache checksum mismatch",
			"src/cache/index.ts:73",
			...Array.from({ length: 180 }, (_, index) => `later line ${index}`),
		].join("\n");
		const request = {
			content,
			maxBytes: 1024,
			taskGoal: "Find the cache checksum error and source path",
			toolName: "bash",
		};
		const first = packToolOutput(request);
		const second = packToolOutput(request);

		expect(first).toEqual(second);
		expect(first.outputBytes).toBeLessThanOrEqual(request.maxBytes);
		expect(first.content).toContain("Error: cache checksum mismatch");
		expect(first.content).toContain("src/cache/index.ts:73");
		expect(first.content).toContain("source lines");
		expect(first.content).not.toContain("routine line 100");
	});

	it("retains trailing task intent after bounded query tokenization", () => {
		const target = "needle-final";
		const content = Array.from({ length: 1_000 }, (_, index) =>
			index === 500 ? target : `opaque result ${index}`,
		).join("\n");
		const taskContext = Array.from({ length: 1_000 }, (_, index) => `contexttoken${index}`).join(" ");
		const packed = packToolOutput({
			content,
			maxBytes: 512,
			taskGoal: `${taskContext} Find ${target}`,
			toolName: "custom",
		});

		expect(packed.outputBytes).toBeLessThanOrEqual(512);
		expect(packed.content).toContain(target);
	});

	it("retains leading task intent at the minimum dynamic token limit", () => {
		const target = "needle-start";
		const content = Array.from({ length: 700_000 }, (_, index) => (index === 350_000 ? target : "x")).join("\n");
		const taskContext = Array.from({ length: 1_000 }, (_, index) => `contexttoken${index}`).join(" ");
		const packed = packToolOutput({
			content,
			maxBytes: 1_024,
			taskGoal: `${target} ${taskContext}`,
			toolName: "custom",
		});

		expect(packed.outputBytes).toBeLessThanOrEqual(1_024);
		expect(packed.content).toContain(target);
	}, 30_000);

	it("returns an empty selection when provenance markers cannot fit the byte budget", () => {
		const packed = packToolOutput({
			content: "alpha\nbeta",
			maxBytes: 1,
			taskGoal: "Find alpha",
			toolName: "demo",
		});

		expect(packed.content).toBe("");
		expect(packed.outputBytes).toBe(0);
		expect(packed.selectedLineNumbers).toEqual([]);
		expect(packed.spans).toEqual([]);
	});

	it("retains exact evidence fragments from oversized selected lines", () => {
		const headTarget = "needle-head";
		const middleTarget = "needle-middle";
		const tailTarget = "needle-😀-tail";
		const cases = [
			{
				content: JSON.stringify({ target: headTarget, filler: "x".repeat(50_000) }),
				fragmentCount: 1,
				target: headTarget,
				taskGoal: `Find ${headTarget}`,
			},
			{
				content: JSON.stringify({
					before: "x".repeat(25_000),
					target: middleTarget,
					after: "x".repeat(25_000),
				}),
				target: middleTarget,
				fragmentCount: 1,
				taskGoal: `Find ${middleTarget}`,
			},
			{
				content: JSON.stringify({ filler: "😀".repeat(15_000), target: tailTarget }),
				fragmentCount: 1,
				target: tailTarget,
				taskGoal: `Find ${tailTarget}`,
			},
			{
				content: JSON.stringify({ investigate: "x".repeat(50_000), needle: "value" }),
				fragmentCount: 2,
				target: '"needle":"value"',
				taskGoal: "Investigate needle",
			},
			{
				content: JSON.stringify({ output: "x".repeat(50_000), needle: "value" }),
				fragmentCount: 2,
				target: '"needle":"value"',
				taskGoal: "Find needle in output",
			},
		];

		for (const { content, fragmentCount, target, taskGoal } of cases) {
			const packed = packToolOutput({
				content,
				kind: "json",
				maxBytes: 1_024,
				taskGoal,
				toolName: "custom",
			});

			expect(packed.outputBytes).toBeLessThanOrEqual(1_024);
			expect(packed.outputBytes).toBeGreaterThan(900);
			expect(packed.content).toContain("partial source-line fragment");
			expect(packed.content).toContain(target);
			expect(packed.content).not.toContain("\uFFFD");
			expect(packed.selectedLineNumbers).toEqual([1]);
			expect(content).toContain(packed.spans[0].text);
			expect(packed.spans[0].fragments).toHaveLength(fragmentCount);
			for (const fragment of packed.spans[0].fragments ?? []) {
				expect(content.slice(fragment.startOffset, fragment.endOffset)).toBe(fragment.text);
			}
		}
	});

	it("fragments an oversized matching JSON leaf when its closure cannot fit", () => {
		const target = "needle-value";
		const content = `{\n  "${target}": "${"x".repeat(50_000)}",\n}`;
		const packed = packToolOutput({
			content,
			kind: "json",
			maxBytes: 1_024,
			taskGoal: `Find ${target}`,
			toolName: "custom",
		});

		expect(packed.outputBytes).toBeLessThanOrEqual(1_024);
		expect(packed.content).toContain("partial source-line fragment");
		expect(packed.content).toContain(target);
		expect(packed.selectedLineNumbers).toEqual([2]);
		expect(packed.spans[0].fragments).toHaveLength(1);
	});

	it("keeps higher-ranked bounded evidence over a lower-ranked oversized JSON leaf", () => {
		const content = `{\n  "message": "Error: critical needle",\n  "needle": "${"x".repeat(50_000)}"\n}`;
		const packed = packToolOutput({
			content,
			kind: "json",
			maxBytes: 1_024,
			taskGoal: "Find the critical needle error",
			toolName: "custom",
		});

		expect(packed.outputBytes).toBeLessThanOrEqual(1_024);
		expect(packed.content).toContain("Error: critical needle");
		expect(packed.content).not.toContain("partial source-line fragment");
		expect(packed.selectedLineNumbers).toContain(2);
		expect(packed.selectedLineNumbers).not.toContain(3);
	});

	it("falls back to bounded edge spans when no evidence is ranked", () => {
		const content = Array.from({ length: 2_000 }, (_, index) => `opaque-${index.toString().padStart(5, "0")}`).join(
			"\n",
		);
		const packed = packToolOutput({
			content,
			maxBytes: 512,
			taskGoal: "Inspect values",
			toolName: "custom",
		});

		expect(packed.outputBytes).toBeLessThanOrEqual(512);
		expect(packed.selectedLineNumbers.length).toBeGreaterThan(0);
		expect(packed.content).toContain("opaque-00000");
		expect(packed.content).toContain("opaque-01999");
	});

	it("retains the final diagnostic line for a failed tool result outside summary patterns", () => {
		const diagnostic = "fatal signal 9";
		const packed = packToolOutput({
			content: [...Array.from({ length: 100 }, (_, index) => `routine output ${index}`), diagnostic].join("\n"),
			isError: true,
			maxBytes: 512,
			taskGoal: "Run the command",
			toolName: "custom",
		});

		expect(packed.content).toContain(diagnostic);
		expect(packed.outputBytes).toBeLessThanOrEqual(512);
	});

	it("retains complete JSON source when its provenance rendering fits", () => {
		const content = '{\r\n  "outer": {\r\n    "needle": true\r\n  }\r\n}\r\n';
		const packed = packToolOutput({
			content,
			kind: "json",
			maxBytes: 160,
			taskGoal: "Find needle",
			toolName: "read",
		});

		expect(packed.content).toContain('"needle": true');
		expect(packed.omittedLines).toBe(0);
		expect(packed.selectedLineNumbers).toEqual([1, 2, 3, 4, 5, 6]);
		expect(packed.selectedSourceBytes).toBe(Buffer.byteLength(content, "utf8"));
	});

	it("retains enclosing JSON boundaries for a selected nested value", () => {
		const content = JSON.stringify(
			{
				routine: Array.from({ length: 100 }, (_, id) => ({ id, value: `routine-${id}` })),
				outer: { inner: { needle: true } },
			},
			null,
			2,
		);
		const packed = packToolOutput({
			content,
			kind: "json",
			maxBytes: 300,
			taskGoal: "Find needle",
			toolName: "custom",
		});

		expect(packed.outputBytes).toBeLessThanOrEqual(300);
		expect(packed.content).toContain('"outer": {');
		expect(packed.content).toContain('"inner": {');
		expect(packed.content).toContain('"needle": true');
	});

	it("bounds disjoint matching search groups to the selection limit", () => {
		const content = Array.from({ length: 10_000 }, (_, index) =>
			index % 2 === 0 ? `needle result ${index}` : `opaque result ${index}`,
		).join("\n");
		const request = {
			content,
			maxBytes: 1_024,
			taskGoal: "Find needle",
			toolName: "grep",
		};
		const units = segmentToolOutput(request);

		const first = rankSourceUnits(request, units);
		const second = rankSourceUnits(request, units);

		expect(first).toEqual(second);
		expect(first).toHaveLength(64);
		expect(first.at(-1)).toBe("line:127");
		for (const id of first) {
			const unit = units[Number(id.slice("line:".length)) - 1];
			expect(unit.text).toContain("needle");
		}
	});

	it("reserves a later higher-overlap search group over an earlier qualifying group", () => {
		const content = [
			...Array.from({ length: 64 }, (_, index) => `alpine basalt cobalt dunes ember fjord early-${index}`),
			"-- divider --",
			...Array.from(
				{ length: 64 },
				(_, index) => `garnet harbor indigo jasper krypton lumen maple nectar late-${index}`,
			),
		].join("\n");
		const packed = packToolOutput({
			content,
			kind: "search",
			maxBytes: 700,
			taskGoal: "alpine basalt cobalt dunes ember fjord garnet harbor indigo jasper krypton lumen maple nectar",
			toolName: "grep",
		});

		expect(packed.content).toContain("late-");
		expect(packed.content).not.toContain("early-");
	});

	it("keeps the strongest row of a contiguous search group that overflows the reservation cap", () => {
		const content = [
			...Array.from({ length: 64 }, (_, index) => `alpine weak-${index}`),
			"garnet harbor indigo jasper krypton lumen maple nectar needle",
			...Array.from({ length: 40 }, (_, index) => `opaque filler-${index}`),
		].join("\n");
		const packed = packToolOutput({
			content,
			kind: "search",
			maxBytes: 700,
			taskGoal: "alpine garnet harbor indigo jasper krypton lumen maple nectar",
			toolName: "grep",
		});

		expect(packed.content).toContain("needle");
	});

	it("retains late unique errors after a bounded repeated-line cache", () => {
		const content = Array.from({ length: 10_000 }, (_, index) => {
			const lineNumber = index + 1;
			if (lineNumber <= 64) return `opaque-${lineNumber}`;
			return lineNumber === 9_000 ? "Error: critical needle" : "Error: repeated";
		}).join("\n");
		const request = {
			content,
			maxBytes: 1_024,
			taskGoal: "Inspect failures",
			toolName: "custom",
		};
		const units = segmentToolOutput(request);

		const ranked = rankSourceUnits(request, units);

		expect(ranked).toHaveLength(64);
		expect(ranked).toContain("line:9000");
	});

	it("caps ranked candidates before sorting dense matching output", () => {
		const units = Array.from({ length: 10_000 }, (_, index) => {
			const lineNumber = index + 1;
			const finalError = lineNumber === 10_000;
			return {
				byteLength: 16,
				dependencies: [],
				id: `line:${lineNumber}`,
				kind: finalError ? ("error" as const) : ("summary" as const),
				lineNumber,
				text: finalError ? "Error: failed" : `summary-${lineNumber}`,
			};
		});
		const request = {
			content: "",
			maxBytes: 1_024,
			taskGoal: "Inspect summaries",
			toolName: "custom",
		};

		const first = rankSourceUnits(request, units);
		const second = rankSourceUnits(request, units);

		expect(first).toEqual(second);
		expect(first).toHaveLength(64);
		expect(first).toContain("line:1");
		expect(first).toContain("line:10000");
	});
	it("skips dependency graphs for oversized inferred JSON containers", () => {
		const content = [...Array.from({ length: 17_000 }, () => "{"), ...Array.from({ length: 17_000 }, () => "}")].join(
			"\n",
		);
		const units = segmentToolOutput({
			content,
			maxBytes: 1_024,
			taskGoal: "Inspect payload",
			toolName: "custom",
		});

		expect(units).toHaveLength(34_000);
		expect(units.every(unit => unit.dependencies.length === 0)).toBe(true);
	});

	it("keeps a matching JSON leaf when its dependency closure exceeds the budget", () => {
		const depth = 100;
		const content = [
			"{",
			...Array.from({ length: depth }, (_, index) => `"level-${index}": {`),
			'"needle": "value"',
			...Array.from({ length: depth + 1 }, () => "}"),
		].join("\n");
		const packed = packToolOutput({
			content,
			kind: "json",
			maxBytes: 512,
			taskGoal: "Find needle",
			toolName: "custom",
		});

		expect(packed.outputBytes).toBeLessThanOrEqual(512);
		expect(packed.content).toContain('"needle": "value"');
		expect(packed.selectedLineNumbers).toContain(depth + 2);
	});

	it("keeps deeply nested JSON dependencies linear", () => {
		const depth = 512;
		const content = [
			...Array.from({ length: depth }, () => "["),
			'"needle"',
			...Array.from({ length: depth }, () => "]"),
		].join("\n");
		const request = {
			content,
			kind: "json" as const,
			maxBytes: 16 * 1024,
			taskGoal: "Find needle",
			toolName: "custom",
		};
		const units = segmentToolOutput(request);
		const dependencyCount = units.reduce((sum, unit) => sum + unit.dependencies.length, 0);
		const packed = packToolOutput(request);

		expect(dependencyCount).toBeLessThanOrEqual(units.length * 4);
		expect(packed.outputBytes).toBeLessThanOrEqual(request.maxBytes);
		expect(packed.selectedLineNumbers).toHaveLength(units.length);
		expect(packed.content).toContain('"needle"');
	});

	it("adds a table header whenever a selected row depends on it", () => {
		const content = [
			"| File | Status |",
			"|---|---|",
			...Array.from({ length: 80 }, (_, index) => `| routine-${index} | ok |`),
			"| src/needle.ts:91 | failed |",
		].join("\n");
		const packed = packToolOutput({
			content,
			kind: "table",
			maxBytes: 700,
			taskGoal: "Find needle",
			toolName: "custom",
		});

		expect(packed.content).toContain("| src/needle.ts:91 | failed |");
		expect(packed.content).toContain("| File | Status |");
		expect(packed.content).toContain("|---|---|");
		expect(packed.selectedLineNumbers).toContain(1);
		expect(packed.selectedLineNumbers).toContain(2);
	});

	it("infers a table after bounded tool preamble lines", () => {
		const content = [
			...Array.from({ length: 20 }, (_, index) => `progress step ${index}`),
			"| Environment | Status |",
			"|---|---|",
			...Array.from({ length: 80 }, (_, index) => `| routine-${index} | ok |`),
			"| prod | failed |",
		].join("\n");
		const packed = packToolOutput({
			content,
			maxBytes: 700,
			taskGoal: "Find the prod failure",
			toolName: "custom",
		});

		expect(packed.content).toContain("| prod | failed |");
		expect(packed.content).toContain("| Environment | Status |");
		expect(packed.content).toContain("|---|---|");
		expect(packed.selectedLineNumbers).toContain(21);
		expect(packed.selectedLineNumbers).toContain(22);
	});

	it("does not detach a matching table row when its header exceeds the budget", () => {
		const row = "| needle | ok |";
		const content = [`| ${"File".repeat(300)} | Status |`, "|---|---|", row].join("\n");
		const packed = packToolOutput({
			content,
			kind: "table",
			maxBytes: 512,
			taskGoal: "Find needle",
			toolName: "custom",
		});

		expect(packed.outputBytes).toBeLessThanOrEqual(512);
		expect(packed.content).not.toContain(row);
		expect(packed.selectedLineNumbers).not.toContain(3);
	});

	it("falls back to data rows when table ranking is structural only", () => {
		const content = [
			"| File | Status |",
			"|---|---|",
			...Array.from({ length: 200 }, (_, index) => `| routine-${index} | ok |`),
		].join("\n");
		const packed = packToolOutput({
			content,
			kind: "table",
			maxBytes: 512,
			taskGoal: "What is the status?",
			toolName: "custom",
		});

		expect(packed.outputBytes).toBeLessThanOrEqual(512);
		expect(packed.content).toContain("| File | Status |");
		expect(packed.content).toContain("| routine-199 | ok |");
	});

	it("infers a text-only CSV table and retains the header for a selected error row", () => {
		const content = [
			"File,Status,Message",
			...Array.from(
				{ length: 80 },
				(_, index) =>
					`src/routine-${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}.ts,ok,checked`,
			),
			"src/needle.ts,failed,Missing header guard",
		].join("\n");
		const packed = packToolOutput({
			content,
			maxBytes: 700,
			taskGoal: "Find needle",
			toolName: "custom",
		});

		expect(packed.content).toContain("src/needle.ts,failed,Missing header guard");
		expect(packed.content).toContain("File,Status,Message");
		expect(packed.selectedLineNumbers).toContain(1);
	});

	it("does not infer a table from ordinary comma-separated prose", () => {
		const content = [
			"We came, we saw, we conquered the build.",
			"Later, after lunch, the suite ran again.",
			"Finally, without warnings, everything passed.",
		].join("\n");
		const packed = packToolOutput({
			content,
			maxBytes: 700,
			taskGoal: "Summarize the run",
			toolName: "custom",
		});

		expect(
			segmentToolOutput({ content, maxBytes: 700, taskGoal: "", toolName: "custom" }).every(
				unit => unit.kind !== "table_row" && unit.kind !== "table_header",
			),
		).toBe(true);
		expect(packed.content).toContain("we conquered");
	});

	it("selects a later table row with its own header instead of the first table's", () => {
		const content = [
			"| First | State |",
			"|---|---|",
			...Array.from({ length: 40 }, (_, index) => `| first-${index} | ok |`),
			"",
			"| Second | Result |",
			"|---|---|",
			...Array.from({ length: 40 }, (_, index) => `| second-${index} | ok |`),
			"| needle | failed |",
		].join("\n");
		const packed = packToolOutput({
			content,
			kind: "table",
			maxBytes: 700,
			taskGoal: "Find needle",
			toolName: "custom",
		});

		expect(packed.content).toContain("| needle | failed |");
		expect(packed.content).toContain("| Second | Result |\n|---|---|");
		expect(packed.selectedLineNumbers).toContain(44);
		expect(packed.selectedLineNumbers).toContain(45);
	});

	it("starts a new table when a pipe table directly follows a CSV table", () => {
		const content = [
			"File,Status,Message",
			...Array.from({ length: 20 }, (_, index) => `src/routine-${String.fromCharCode(97 + index)}.ts,ok,checked`),
			"| Env | Result |",
			"|---|---|",
			...Array.from({ length: 20 }, (_, index) => `| env-${index} | ok |`),
			"| needle | failed |",
		].join("\n");
		const request = { content, kind: "table" as const, maxBytes: 700, taskGoal: "Find needle", toolName: "custom" };
		const needle = segmentToolOutput(request).find(unit => unit.text === "| needle | failed |");
		expect(needle?.dependencies.toSorted()).toEqual(["line:22", "line:23"]);

		const packed = packToolOutput(request);
		expect(packed.content).toContain("| needle | failed |");
		expect(packed.content).toContain("| Env | Result |\n|---|---|");
		expect(packed.selectedLineNumbers).toContain(22);
		expect(packed.selectedLineNumbers).toContain(23);
	});

	it("starts a new table when a CSV table directly follows a pipe table", () => {
		const content = [
			"| First | State |",
			"|---|---|",
			...Array.from({ length: 20 }, (_, index) => `| first-${index} | ok |`),
			"Env,Status,Note",
			...Array.from({ length: 20 }, (_, index) => `env-${String.fromCharCode(97 + index)},ok,checked`),
			"prod,failed,Broken deploy",
		].join("\n");
		const request = {
			content,
			kind: "table" as const,
			maxBytes: 700,
			taskGoal: "Find the prod failure",
			toolName: "custom",
		};
		const needle = segmentToolOutput(request).find(unit => unit.text === "prod,failed,Broken deploy");
		expect(needle?.dependencies).toEqual(["line:23"]);

		const packed = packToolOutput(request);
		expect(packed.content).toContain("prod,failed,Broken deploy");
		expect(packed.content).toContain("Env,Status,Note");
		expect(packed.selectedLineNumbers).toContain(23);
	});

	it("promotes an adjacent pipe header after a separator-less first table", () => {
		const content = [
			"| First | State |",
			...Array.from({ length: 20 }, (_, index) => `| first-${index} | ok |`),
			"| Second | Result |",
			"|---|---|",
			...Array.from({ length: 20 }, (_, index) => `| second-${index} | ok |`),
			"| needle | failed |",
		].join("\n");
		const request = { content, kind: "table" as const, maxBytes: 700, taskGoal: "Find needle", toolName: "custom" };
		const needle = segmentToolOutput(request).find(unit => unit.text === "| needle | failed |");
		expect(needle?.dependencies.toSorted()).toEqual(["line:22", "line:23"]);

		const packed = packToolOutput(request);
		expect(packed.content).toContain("| needle | failed |");
		expect(packed.content).toContain("| Second | Result |\n|---|---|");
		expect(packed.selectedLineNumbers).toContain(22);
		expect(packed.selectedLineNumbers).toContain(23);
	});

	it("uses the opt-in packer while preserving a recoverable full-output artifact", async () => {
		const schema = type({ command: "string" });
		const content = [
			...Array.from({ length: 420 }, (_, index) => `routine generated record ${index}`),
			"needle-checksum-payload",
			...Array.from({ length: 420 }, (_, index) => `later generated record ${index}`),
		].join("\n");
		const tool: AgentTool<typeof schema, { meta?: OutputMeta }> = {
			description: "Return a large diagnostic result",
			execute: async () => ({ content: [{ type: "text", text: content }], details: {} }),
			label: "Diagnostic",
			name: "diagnostic",
			parameters: schema,
		};
		const wrapped = wrapToolWithMetaNotice(tool);
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({
			role: "user",
			content: "Find the needle-checksum-payload",
			timestamp: Date.now(),
		});
		const context = createToolContext(
			Settings.isolated({
				"tools.artifactHeadBytes": 1,
				"tools.artifactSpillThreshold": 1,
				"tools.artifactTailBytes": 1,
				"tools.evidenceAwarePacking": true,
			}),
			sessionManager,
		);

		const result = await wrapped.execute("call-1", { command: "bun test" }, undefined, undefined, context);
		const output = textContent(result);
		expect(result.details?.meta?.truncation?.direction).toBe("selection");
		expect(result.details?.meta?.truncation?.artifactId).toBeDefined();
		expect(output).toContain("needle-checksum-payload");
		expect(output).toContain("evidence-selected source");
		expect(output).not.toContain("routine generated record 200");
	});

	it("retains the prior substantive task goal after a continuation message", async () => {
		const schema = type({ command: "string" });
		const target = "needle-original-task";
		const content = Array.from({ length: 840 }, (_, index) =>
			index === 420 ? target : `routine generated record ${index}`,
		).join("\n");
		const tool: AgentTool<typeof schema, { meta?: OutputMeta }> = {
			description: "Return a large diagnostic result",
			execute: async () => ({ content: [{ type: "text", text: content }], details: {} }),
			label: "Diagnostic",
			name: "diagnostic",
			parameters: schema,
		};
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({
			role: "user",
			content: `Find ${target}`,
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "user",
			content: "continue",
			timestamp: Date.now(),
		});
		const context = createToolContext(
			Settings.isolated({
				"tools.artifactHeadBytes": 1,
				"tools.artifactSpillThreshold": 1,
				"tools.artifactTailBytes": 1,
				"tools.evidenceAwarePacking": true,
			}),
			sessionManager,
		);

		const result = await wrapToolWithMetaNotice(tool).execute(
			"call-continuation",
			{ command: "generate" },
			undefined,
			undefined,
			context,
		);

		expect(textContent(result)).toContain(target);
	});

	it("keeps a bounded fragment for oversized single-line tool output", async () => {
		const schema = type({ command: "string" });
		const target = "needle-tail";
		const content = JSON.stringify({ filler: "x".repeat(50_000), target });
		const tool: AgentTool<typeof schema, { meta?: OutputMeta }> = {
			description: "Return a large minified result",
			execute: async () => ({ content: [{ type: "text", text: content }], details: {} }),
			label: "Minified",
			name: "minified",
			parameters: schema,
		};
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({
			role: "user",
			content: `Find ${target}`,
			timestamp: Date.now(),
		});
		const context = createToolContext(
			Settings.isolated({
				"tools.artifactHeadBytes": 1,
				"tools.artifactSpillThreshold": 1,
				"tools.artifactTailBytes": 1,
				"tools.evidenceAwarePacking": true,
			}),
			sessionManager,
		);

		const result = await wrapToolWithMetaNotice(tool).execute(
			"call-oversized",
			{ command: "generate" },
			undefined,
			undefined,
			context,
		);
		const output = textContent(result);
		expect(result.details?.meta?.truncation?.outputBytes).toBeLessThanOrEqual(2_048);
		expect(output).toContain("partial source-line fragment");
		expect(output).toContain(target);
		expect(result.details?.meta?.truncation?.selectedRanges).toEqual([{ start: 1, end: 1 }]);
	});

	it("honors an empty inline budget and reports zero output lines", async () => {
		const schema = type({ command: "string" });
		const tool: AgentTool<typeof schema, { meta?: OutputMeta }> = {
			description: "Return a large opaque result",
			execute: async () => ({
				content: [
					{ type: "text", text: Array.from({ length: 1_000 }, (_, index) => `opaque-${index}`).join("\n") },
				],
				details: {},
			}),
			label: "Opaque",
			name: "opaque",
			parameters: schema,
		};
		const context = createToolContext(
			Settings.isolated({
				"tools.artifactHeadBytes": 0,
				"tools.artifactSpillThreshold": 1,
				"tools.artifactTailBytes": 0,
				"tools.evidenceAwarePacking": true,
			}),
		);

		const result = await wrapToolWithMetaNotice(tool).execute(
			"call-empty",
			{ command: "generate" },
			undefined,
			undefined,
			context,
		);
		expect(result.details?.meta?.truncation?.maxBytes).toBe(0);
		expect(result.details?.meta?.truncation?.outputBytes).toBe(0);
		expect(result.details?.meta?.truncation?.outputLines).toBe(0);
	});
});
