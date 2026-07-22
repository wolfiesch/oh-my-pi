/**
 * Benchmark: native diff (N-API) vs jsdiff for line diffs and structured patches.
 *
 * Usage: bun bench/diff.ts
 * Records git sha, scenario, and iteration counts; prints a markdown table.
 */
import * as os from "node:os";
import { diffLines as nativeDiffLines, structuredPatchHunks } from "../native/index.js";
import * as Diff from "diff";

const WARMUP = Number(Bun.env.BENCH_WARMUP ?? 5);
const ITERATIONS = Number(Bun.env.BENCH_ITERATIONS ?? 50);

function makeRng(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function buildDoc(rng: () => number, lines: number): string {
	const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
	const out: string[] = [];
	for (let i = 0; i < lines; i++) {
		out.push(`${words[Math.floor(rng() * words.length)]} ${words[Math.floor(rng() * words.length)]} line${i}`);
	}
	return `${out.join("\n")}\n`;
}

function mutate(rng: () => number, text: string, density: number): string {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const roll = rng();
		if (roll < density / 3) lines[i] = `${lines[i]} edited`;
		else if (roll < (density * 2) / 3) {
			lines.splice(i, 1);
			i--;
		} else if (roll < density) lines.splice(i, 0, `ins ${Math.floor(rng() * 1e6)}`);
	}
	return lines.join("\n");
}

function bench(fn: () => unknown): { meanMs: number; iterations: number } {
	for (let i = 0; i < WARMUP; i++) fn();
	const start = performance.now();
	for (let i = 0; i < ITERATIONS; i++) fn();
	return { meanMs: (performance.now() - start) / ITERATIONS, iterations: ITERATIONS };
}

const sha = Bun.env.BENCH_SHA ?? Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
console.log(`# diff bench — sha ${sha}, warmup ${WARMUP}, iterations ${ITERATIONS}/scenario`);
console.log(`# host: ${os.cpus()[0]?.model ?? "unknown"}, ${os.platform()}-${os.arch()}, bun ${Bun.version}\n`);
console.log("| scenario | jsdiff diffLines | native diffLines | speedup | jsdiff structuredPatch | native hunks | speedup |");
console.log("|---|---|---|---|---|---|---|");

const MAX_LINES = Number(Bun.env.BENCH_MAX_LINES ?? Number.POSITIVE_INFINITY);
for (const lines of [100, 5_000, 50_000].filter(n => n <= MAX_LINES)) {
	for (const density of [0.01, 0.2]) {
		const rng = makeRng(lines * 31 + density * 1000);
		const oldText = buildDoc(rng, lines);
		const newText = mutate(rng, oldText, density);
		const jsLines = bench(() => Diff.diffLines(oldText, newText));
		// Native timings include the isWellFormed() guards the production call
		// sites pay before choosing the native path.
		const natLines = bench(() =>
			oldText.isWellFormed() && newText.isWellFormed() ? nativeDiffLines(oldText, newText) : undefined,
		);
		const jsPatch = bench(() => Diff.structuredPatch("", "", oldText, newText, "", "", { context: 3 }));
		const natPatch = bench(() =>
			oldText.isWellFormed() && newText.isWellFormed() ? structuredPatchHunks(oldText, newText, 3) : undefined,
		);
		const fmt = (ms: number) => (ms >= 1 ? `${ms.toFixed(2)}ms` : `${(ms * 1000).toFixed(1)}µs`);
		console.log(
			`| ${lines} lines / ${density * 100}% edits | ${fmt(jsLines.meanMs)} | ${fmt(natLines.meanMs)} | ${(jsLines.meanMs / natLines.meanMs).toFixed(1)}x | ${fmt(jsPatch.meanMs)} | ${fmt(natPatch.meanMs)} | ${(jsPatch.meanMs / natPatch.meanMs).toFixed(1)}x |`,
		);
	}
}
