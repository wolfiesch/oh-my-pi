/**
 * Crossing-inclusive benchmark of native batch vector kernels vs the TS
 * reference loops, at realistic mnemopi recall shapes (fastembed
 * bge-small-en-v1.5, dim=384; binarized stride=48 bytes).
 *
 * Run from the repo root: `bun packages/mnemopi/bench/native-vectors.bench.ts`
 */
import { execSync } from "node:child_process";
import {
	cosineSimilarityBatch,
	cosineSimilarityPairs,
	hammingDistanceBatch,
	hammingDistanceForDimBatch,
	vectorIndexTopK,
} from "@oh-my-pi/pi-natives";
import { hammingDistance, hammingDistanceForDimension } from "../src/core/binary-vectors";
import { jaccardSimilarity, mmrRerank } from "../src/core/mmr";
import { cosineSimilarity } from "../src/core/vector-math";

const DIM = 384;
const STRIDE = DIM / 8;
const COUNTS = [10, 100, 1000, 10000];
const WARMUP = 20;
const ITERATIONS = 200;

function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

let sink = 0;

function timeNs(fn: () => void, iterations = ITERATIONS, warmup = WARMUP): { ns: number; iterations: number } {
	for (let i = 0; i < warmup; i += 1) fn();
	const start = Bun.nanoseconds();
	for (let i = 0; i < iterations; i += 1) fn();
	return { ns: (Bun.nanoseconds() - start) / iterations, iterations };
}

interface Row {
	kernel: string;
	count: number;
	tsNs: number;
	nativeNs: number;
	speedup: number;
	tsIterations: number;
	nativeIterations: number;
}

function pushRow(kernel: string, count: number, ts: { ns: number; iterations: number }, native: { ns: number; iterations: number }): void {
	rows.push({
		kernel,
		count,
		tsNs: ts.ns,
		nativeNs: native.ns,
		speedup: ts.ns / native.ns,
		tsIterations: ts.iterations,
		nativeIterations: native.iterations,
	});
}

const rows: Row[] = [];
const rng = makeRng(0xbe4c4);

for (const count of COUNTS) {
	const query = Float64Array.from({ length: DIM }, () => rng() * 2 - 1);
	const flat = new Float64Array(count * DIM);
	for (let i = 0; i < flat.length; i += 1) flat[i] = rng() * 2 - 1;

	const ts = timeNs(() => {
		for (let row = 0; row < count; row += 1) {
			sink += cosineSimilarity(query, flat.subarray(row * DIM, (row + 1) * DIM));
		}
	});
	const native = timeNs(() => {
		sink += cosineSimilarityBatch(query, flat, DIM)[0] ?? 0;
	});
	pushRow("cosineSimilarityBatch", count, ts, native);
}

for (const count of COUNTS) {
	const matrix = new Float32Array(count * DIM);
	for (let i = 0; i < matrix.length; i += 1) matrix[i] = rng() * 2 - 1;
	const query = Float64Array.from({ length: DIM }, () => rng() * 2 - 1);
	let normSq = 0;
	for (const v of query) normSq += v * v;
	const norm = Math.sqrt(normSq);
	const limit = 10;

	const ts = timeNs(() => {
		const hits: Array<{ row: number; score: number }> = [];
		for (let row = 0; row < count; row += 1) {
			let score = 0;
			for (let col = 0; col < DIM; col += 1) {
				score += (matrix[row * DIM + col] ?? 0) * ((query[col] ?? 0) / norm);
			}
			hits.push({ row, score });
		}
		hits.sort((a, b) => b.score - a.score);
		sink += hits[0]?.score ?? 0;
	});
	const native = timeNs(() => {
		sink += vectorIndexTopK(matrix, DIM, query, limit).scores[0] ?? 0;
	});
	pushRow("vectorIndexTopK", count, ts, native);
}

for (const count of COUNTS) {
	const query = Uint8Array.from({ length: STRIDE }, () => Math.floor(rng() * 256));
	const packed = new Uint8Array(count * STRIDE);
	for (let i = 0; i < packed.length; i += 1) packed[i] = Math.floor(rng() * 256);
	const vectors: Uint8Array[] = [];
	for (let i = 0; i < count; i += 1) vectors.push(packed.subarray(i * STRIDE, (i + 1) * STRIDE));

	const ts = timeNs(() => {
		for (let i = 0; i < count; i += 1) sink += hammingDistance(query, vectors[i] ?? new Uint8Array());
	});
	const native = timeNs(() => {
		sink += hammingDistanceBatch(query, packed, STRIDE)[0] ?? 0;
	});
	pushRow("hammingDistanceBatch", count, ts, native);
}

// cosineSimilarityPairs: O(n²) pair scan — TS baseline is the pre-native shmr
// clustering loop. Capped at 1k candidates and given adaptive iterations (the
// TS side at n=1000 is ~500k pair cosines × 384 dims per run).
for (const count of COUNTS.filter(n => n <= 1000)) {
	const flat = new Float64Array(count * DIM);
	for (let i = 0; i < flat.length; i += 1) flat[i] = rng() * 2 - 1;
	const threshold = 0.15;

	const pairIterations = count >= 1000 ? 10 : ITERATIONS;
	const pairWarmup = count >= 1000 ? 2 : WARMUP;
	const ts = timeNs(
		() => {
			let pairs = 0;
			for (let i = 0; i < count; i += 1) {
				const a = flat.subarray(i * DIM, (i + 1) * DIM);
				for (let j = i + 1; j < count; j += 1) {
					if (cosineSimilarity(a, flat.subarray(j * DIM, (j + 1) * DIM)) >= threshold) pairs += 1;
				}
			}
			sink += pairs;
		},
		pairIterations,
		pairWarmup,
	);
	const native = timeNs(() => {
		sink += cosineSimilarityPairs(flat, count, DIM, threshold).length;
	}, pairIterations, pairWarmup);
	pushRow("cosineSimilarityPairs", count, ts, native);
}

// hammingDistanceForDimBatch: ragged/dim-masked variant used by BinaryVectorStore.search.
for (const count of COUNTS) {
	const query = Uint8Array.from({ length: STRIDE }, () => Math.floor(rng() * 256));
	const packed = new Uint8Array(count * STRIDE);
	for (let i = 0; i < packed.length; i += 1) packed[i] = Math.floor(rng() * 256);
	const dims = Uint32Array.from({ length: count }, () => (rng() < 0.5 ? DIM : DIM / 2));
	const vectors: Uint8Array[] = [];
	for (let i = 0; i < count; i += 1) vectors.push(packed.subarray(i * STRIDE, (i + 1) * STRIDE));

	const ts = timeNs(() => {
		for (let i = 0; i < count; i += 1) {
			sink += hammingDistanceForDimension(query, vectors[i] ?? new Uint8Array(), dims[i] ?? DIM);
		}
	});
	const native = timeNs(() => {
		sink += hammingDistanceForDimBatch(query, packed, STRIDE, dims)[0] ?? 0;
	});
	pushRow("hammingDistanceForDimBatch", count, ts, native);
}

// mmrRerank production paths: the TS side wraps jaccardSimilarity in a lambda,
// defeating the identity check so the exact pre-native selection loop runs; the
// native side calls mmrRerank with the default similarity, exercising the real
// fast path including its sort and wrapper overhead.
const tsJaccard = (a: string, b: string): number => jaccardSimilarity(a, b);
for (const count of COUNTS.filter(n => n <= 1000)) {
	const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
	const results: Array<{ content: string; score: number }> = [];
	for (let i = 0; i < count; i += 1) {
		const n = 5 + Math.floor(rng() * 20);
		results.push({
			content: Array.from({ length: n }, () => words[Math.floor(rng() * words.length)]).join(" "),
			score: rng(),
		});
	}
	const topK = 10;

	const ts = timeNs(() => {
		sink += mmrRerank(results, 0.7, topK, tsJaccard).length;
	});
	const native = timeNs(() => {
		sink += mmrRerank(results, 0.7, topK).length;
	});
	pushRow("mmrRerankIndices (via mmrRerank)", count, ts, native);
}

const sha = execSync("git rev-parse HEAD").toString().trim();
const report = {
	sha,
	date: new Date().toISOString(),
	scenario: `dim=${DIM}, stride=${STRIDE}B, warmup=${WARMUP}, iterations=${ITERATIONS} (adaptive for O(n²) rows, see per-row fields), crossing-inclusive`,
	runtime: `bun ${Bun.version}`,
	rows: rows.map(r => ({
		kernel: r.kernel,
		count: r.count,
		ts_us: +(r.tsNs / 1000).toFixed(2),
		native_us: +(r.nativeNs / 1000).toFixed(2),
		speedup: +r.speedup.toFixed(2),
		ts_iterations: r.tsIterations,
		native_iterations: r.nativeIterations,
	})),
	sink,
};

console.log(JSON.stringify(report, null, 2));
