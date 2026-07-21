import candidateSettings from "./candidate-settings.json" with { type: "json" };
import { queryTokenWeights } from "./query";
import type { CandidateSelectionSettings, SourceUnit, ToolOutputPackRequest } from "./types";

const ERROR_SUMMARY_RE =
	/(?:\btest result\b|\btests?\s+(?:failed|passed)\b|\bcommand exited\b|\bexit code\b|\b(?:failures?|errors?):|\b\d+\s+(?:failed|passed|errors?)\b)/iu;

const CANDIDATE_EVALUATIONS_PER_KIB = 32;
const MIN_CANDIDATE_EVALUATIONS = 64;

interface RankedSourceUnit {
	id: string;
	kind: SourceUnit["kind"];
	lineNumber: number;
	score: number;
}

interface SearchGroup {
	end: number;
	overlap: number;
	start: number;
}

export function candidateEvaluationLimit(maxBytes: number): number {
	return Math.max(MIN_CANDIDATE_EVALUATIONS, Math.ceil(Math.max(0, maxBytes) / 1024) * CANDIDATE_EVALUATIONS_PER_KIB);
}

function compareRanked(left: RankedSourceUnit, right: RankedSourceUnit): number {
	return right.score - left.score || left.lineNumber - right.lineNumber;
}

function compareSearchGroups(left: SearchGroup, right: SearchGroup): number {
	return right.overlap - left.overlap || left.start - right.start;
}

function retainBestCandidate(
	ranked: RankedSourceUnit[],
	id: string,
	kind: SourceUnit["kind"],
	lineNumber: number,
	score: number,
	limit: number,
): void {
	if (ranked.length >= limit) {
		const worst = ranked[0];
		const comparison = worst.score - score || lineNumber - worst.lineNumber;
		if (comparison >= 0) return;
	}
	const candidate = { id, kind, lineNumber, score };
	if (ranked.length < limit) {
		ranked.push(candidate);
		let index = ranked.length - 1;
		while (index > 0) {
			const parent = Math.floor((index - 1) / 2);
			if (compareRanked(ranked[index], ranked[parent]) <= 0) break;
			[ranked[index], ranked[parent]] = [ranked[parent], ranked[index]];
			index = parent;
		}
		return;
	}

	ranked[0] = candidate;
	let index = 0;
	while (true) {
		const left = index * 2 + 1;
		const right = left + 1;
		let worse = index;
		if (left < ranked.length && compareRanked(ranked[left], ranked[worse]) > 0) worse = left;
		if (right < ranked.length && compareRanked(ranked[right], ranked[worse]) > 0) worse = right;
		if (worse === index) return;
		[ranked[index], ranked[worse]] = [ranked[worse], ranked[index]];
		index = worse;
	}
}

function overlapScore(normalizedLine: string, tokenWeights: ReadonlyMap<string, number>): number {
	let score = 0;
	for (const [token, weight] of tokenWeights) {
		if (normalizedLine.includes(token)) score += weight;
	}
	return score;
}

function kindWeight(unit: SourceUnit, settings: CandidateSelectionSettings): number {
	switch (unit.kind) {
		case "error":
			return settings.errorWeight;
		case "path":
			return /(?:^|\s)\/\/\s/u.test(unit.text) ? 0 : settings.pathWeight;
		case "summary":
			return settings.summaryWeight;
		case "json_key":
		case "structure":
		case "table_header":
			return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/u.test(unit.text) ? 0 : settings.structureWeight;
		default:
			return 0;
	}
}

function fallbackRankedIds(units: readonly SourceUnit[], limit: number): string[] {
	const ranked: string[] = [];
	for (let head = 0, tail = units.length - 1; head <= tail && ranked.length < limit; head++, tail--) {
		ranked.push(units[head].id);
		if (tail !== head && ranked.length < limit) ranked.push(units[tail].id);
	}
	return ranked;
}

/**
 * Editable autoresearch surface. Return source unit IDs in descending value.
 * The fixed planner resolves dependencies, applies the byte budget, and renders
 * exact source text, so this function cannot rewrite tool output.
 */
export function rankSourceUnits(
	request: ToolOutputPackRequest,
	units: readonly SourceUnit[],
	settings: CandidateSelectionSettings = candidateSettings,
): string[] {
	const normalizedUnits = units.map(unit => unit.text.toLowerCase());
	const tokenWeights = queryTokenWeights(request, normalizedUnits);
	const overlaps = Float64Array.from(normalizedUnits, normalized => overlapScore(normalized, tokenWeights));
	const lastLine = units.at(-1)?.lineNumber ?? 1;
	const fallbackErrorLine =
		request.isError || (request.exitCode !== undefined && request.exitCode !== 0)
			? units.findLast(unit => unit.text.trim().length > 0)?.lineNumber
			: undefined;
	const neighborDistances = new Float64Array(units.length);
	neighborDistances.fill(Number.POSITIVE_INFINITY);
	let closestHitLine = Number.NEGATIVE_INFINITY;
	for (let index = 0; index < units.length; index++) {
		const unit = units[index];
		if (overlaps[index] >= 0.5) closestHitLine = unit.lineNumber;
		neighborDistances[index] = unit.lineNumber - closestHitLine;
	}
	closestHitLine = Number.POSITIVE_INFINITY;
	for (let index = units.length - 1; index >= 0; index--) {
		const unit = units[index];
		if (overlaps[index] >= 0.5) closestHitLine = unit.lineNumber;
		neighborDistances[index] = Math.min(neighborDistances[index], closestHitLine - unit.lineNumber);
	}
	const exhaustiveQuery = /\b(?:all|both|complete|each|entire|every|list|multiple)\b/iu.test(request.taskGoal);
	const rankedLimit = candidateEvaluationLimit(request.maxBytes);
	const relevantEvidence = new Uint8Array(units.length);
	for (let index = 0; index < units.length; index++) {
		const unit = units[index];
		if (overlaps[index] >= 0.5 || (unit.kind === "path" && !/(?:^|\s)\/\/\s/u.test(unit.text))) {
			relevantEvidence[index] = 1;
		}
	}
	let bestTableRowOverlap = 0;
	for (let index = 0; index < units.length; index++) {
		if (units[index].kind === "table_row") bestTableRowOverlap = Math.max(bestTableRowOverlap, overlaps[index]);
	}
	const isSearchOutput =
		request.kind === "search" || ["find", "glob", "grep", "search"].includes(request.toolName.toLowerCase());
	let bestSearchGroupOverlap = 0;
	const searchGroups: SearchGroup[] = [];
	if (isSearchOutput) {
		for (let start = 0; start < units.length; ) {
			if (overlaps[start] < 0.5) {
				start++;
				continue;
			}
			let end = start + 1;
			let groupOverlap = overlaps[start];
			while (end < units.length && overlaps[end] >= 0.5 && units[end - 1].lineNumber + 1 === units[end].lineNumber) {
				groupOverlap += overlaps[end];
				end++;
			}
			bestSearchGroupOverlap = Math.max(bestSearchGroupOverlap, groupOverlap);
			searchGroups.push({ end, overlap: groupOverlap, start });
			// Each reserved group contributes at least one line, so only the top
			// rankedLimit groups can ever be reserved; bounded truncation keeps
			// dense alternating matches from accumulating unbounded group state.
			if (searchGroups.length > rankedLimit * 2) {
				searchGroups.sort(compareSearchGroups);
				searchGroups.length = rankedLimit;
			}
			start = end;
		}
	}
	const selectedSearchLines = new Set<number>();
	if (searchGroups.length > 0) {
		// Reserve lines from the strongest groups first so an early qualifying
		// group cannot exhaust the cap before a later higher-overlap group.
		searchGroups.sort(compareSearchGroups);
		for (const group of searchGroups) {
			const remaining = rankedLimit - selectedSearchLines.size;
			if (remaining <= 0 || group.overlap < bestSearchGroupOverlap * 0.7) break;
			if (group.end - group.start <= remaining) {
				for (let index = group.start; index < group.end; index++) {
					selectedSearchLines.add(units[index].lineNumber);
				}
				continue;
			}
			// The group overflows the reservation cap: keep its strongest rows
			// (overlap desc, line asc) instead of the first rows in source order,
			// so a weak prefix cannot exclude a later stronger match.
			const strongest: RankedSourceUnit[] = [];
			for (let index = group.start; index < group.end; index++) {
				const unit = units[index];
				retainBestCandidate(strongest, unit.id, unit.kind, unit.lineNumber, overlaps[index], remaining);
			}
			for (const row of strongest) selectedSearchLines.add(row.lineNumber);
			break;
		}
	}

	const structuralContext = new Uint8Array(units.length);
	for (let index = 0; index < units.length; index++) {
		const unit = units[index];
		if (/^\s*@@/u.test(unit.text) && index + 1 < units.length) structuralContext[index + 1] = 1;
		if (
			/(?:decoder error|deseriali[sz]ation|invalid json|parseerror|syntaxerror|unexpected end)/iu.test(unit.text) &&
			index > 0
		) {
			structuralContext[index - 1] = 1;
		}
	}

	const hasRelevantEvidenceNearby = (index: number): boolean => {
		const lineNumber = units[index].lineNumber;
		for (let neighbor = Math.max(0, index - 2); neighbor <= Math.min(units.length - 1, index + 2); neighbor++) {
			if (
				neighbor !== index &&
				relevantEvidence[neighbor] === 1 &&
				Math.abs(units[neighbor].lineNumber - lineNumber) <= 2
			) {
				return true;
			}
		}
		return false;
	};
	let hasNonStructuralRanking = false;
	let rankedCandidateCount = 0;
	const ranked: RankedSourceUnit[] = [];
	const seenLines = new Set<string>();
	for (let index = 0; index < units.length; index++) {
		const unit = units[index];
		const normalized = normalizedUnits[index].trim();
		const duplicate = settings.dedupeExactLines && normalized.length > 0 && seenLines.has(normalized);
		if (settings.dedupeExactLines && normalized.length > 0) {
			if (duplicate) {
				seenLines.delete(normalized);
			} else if (seenLines.size >= rankedLimit) {
				const oldest = seenLines.values().next().value;
				if (oldest !== undefined) seenLines.delete(oldest);
			}
			seenLines.add(normalized);
		}
		const overlap = overlaps[index];
		const supportsRelevantError =
			unit.lineNumber === fallbackErrorLine ||
			unit.kind !== "error" ||
			exhaustiveQuery ||
			overlap >= 0.5 ||
			ERROR_SUMMARY_RE.test(unit.text) ||
			hasRelevantEvidenceNearby(index);

		const neighborDistance = neighborDistances[index];
		const neighborBonus =
			neighborDistance <= settings.neighborRadius
				? settings.neighborWeight * (settings.neighborRadius - neighborDistance + 1)
				: 0;
		const edgeBonus =
			unit.lineNumber <= 3
				? settings.headWeight * (4 - unit.lineNumber)
				: unit.lineNumber > lastLine - 4
					? settings.tailWeight * (unit.lineNumber - (lastLine - 4))
					: 0;
		const fallbackErrorBonus = unit.lineNumber === fallbackErrorLine ? settings.errorWeight : 0;
		const score =
			kindWeight(unit, settings) +
			fallbackErrorBonus +
			overlap * settings.queryWeight +
			neighborBonus +
			(structuralContext[index] === 1 ? settings.neighborWeight : 0) +
			edgeBonus -
			(duplicate ? 500 : 0);
		if (
			score <= 0 ||
			!supportsRelevantError ||
			(isSearchOutput && !exhaustiveQuery && overlap >= 0.5 && !selectedSearchLines.has(unit.lineNumber)) ||
			(unit.kind === "table_row" && !exhaustiveQuery && overlap < bestTableRowOverlap * 0.5)
		) {
			continue;
		}
		rankedCandidateCount++;
		if (unit.kind !== "structure" && unit.kind !== "table_header") hasNonStructuralRanking = true;
		retainBestCandidate(ranked, unit.id, unit.kind, unit.lineNumber, score, rankedLimit);
	}
	ranked.sort(compareRanked);
	const structuralOnlyTableRanking =
		units.some(unit => unit.kind === "table_header") && rankedCandidateCount > 0 && !hasNonStructuralRanking;
	return rankedCandidateCount === 0 || structuralOnlyTableRanking
		? fallbackRankedIds(units, rankedLimit)
		: ranked.map(item => item.id);
}
