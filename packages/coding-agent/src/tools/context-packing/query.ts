import type { ToolOutputPackRequest } from "./types";

const TOKEN_RE = /[\p{L}\p{N}_./:-]{2,}/gu;
const MAX_QUERY_TOKENS = 256;
const MAX_QUERY_LINE_COMPARISONS = 4_000_000;

function appendQueryTokens(tokens: Set<string>, source: string | undefined, limit: number): void {
	if (!source || limit <= 0) return;
	const headLimit = Math.floor(limit / 2);
	const tailLimit = limit - headLimit;
	const tail: string[] = [];
	const tailSet = new Set<string>();
	let headAdded = 0;
	let tailCursor = 0;

	for (const match of source.toLowerCase().matchAll(TOKEN_RE)) {
		const token = match[0];
		if (token.length < 3 || tokens.has(token) || tailSet.has(token)) continue;
		if (headAdded < headLimit) {
			tokens.add(token);
			headAdded++;
			continue;
		}
		if (tail.length < tailLimit) {
			tail.push(token);
			tailSet.add(token);
			continue;
		}
		if (tailLimit === 0) continue;
		tailSet.delete(tail[tailCursor]);
		tail[tailCursor] = token;
		tailSet.add(token);
		tailCursor = (tailCursor + 1) % tailLimit;
	}

	const tailStart = tail.length === tailLimit ? tailCursor : 0;
	for (let offset = 0; offset < tail.length; offset++) {
		tokens.add(tail[(tailStart + offset) % tail.length]);
	}
}

function queryTokenLimit(unitCount: number): number {
	return Math.max(2, Math.min(MAX_QUERY_TOKENS, Math.floor(MAX_QUERY_LINE_COMPARISONS / Math.max(1, unitCount * 2))));
}

export function boundedTaskQueryTokens(request: ToolOutputPackRequest, unitCount: number): readonly string[] {
	const limit = queryTokenLimit(unitCount);
	const tokens = new Set<string>();
	appendQueryTokens(tokens, request.taskGoal, Math.min(limit, Math.max(2, Math.floor(limit * 0.75))));
	return [...tokens];
}

export function boundedQueryTokens(request: ToolOutputPackRequest, unitCount: number): Set<string> {
	const limit = queryTokenLimit(unitCount);
	const tokens = new Set(boundedTaskQueryTokens(request, unitCount));
	appendQueryTokens(tokens, request.toolArguments, limit - tokens.size);
	appendQueryTokens(tokens, request.toolName, limit - tokens.size);
	return tokens;
}

export function queryTokenWeights(
	request: ToolOutputPackRequest,
	normalizedUnits: readonly string[],
): Map<string, number> {
	const tokens = boundedQueryTokens(request, normalizedUnits.length);
	const weights = new Map<string, number>();
	for (const token of tokens) {
		let documentFrequency = 0;
		for (const normalized of normalizedUnits) {
			if (normalized.includes(token)) documentFrequency++;
		}
		const weight = Math.log2((normalizedUnits.length + 1) / (documentFrequency + 1));
		if (weight >= 0.5) weights.set(token, weight);
	}
	return weights;
}
