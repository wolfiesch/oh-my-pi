import { candidateEvaluationLimit } from "./candidate";
import { boundedQueryTokens, boundedTaskQueryTokens } from "./query";
import type {
	PackedToolOutput,
	SelectedSourceFragment,
	SelectedSourceSpan,
	SourceUnit,
	ToolOutputPackRequest,
} from "./types";

function dependencyClosure(ids: ReadonlySet<string>, unitsById: ReadonlyMap<string, SourceUnit>): Set<string> {
	const closure = new Set(ids);
	const pending = [...ids];
	while (pending.length > 0) {
		const id = pending.pop();
		if (!id) continue;
		for (const dependency of unitsById.get(id)?.dependencies ?? []) {
			if (closure.has(dependency)) continue;
			closure.add(dependency);
			pending.push(dependency);
		}
	}
	return closure;
}

function hasOnlyJsonStructuralDependencies(unit: SourceUnit, unitsById: ReadonlyMap<string, SourceUnit>): boolean {
	return (
		unit.dependencies.length > 0 &&
		unit.dependencies.every(dependency => {
			const kind = unitsById.get(dependency)?.kind;
			return kind === "json_key" || kind === "structure";
		})
	);
}

function createSpans(selected: ReadonlySet<string>, unitsById: ReadonlyMap<string, SourceUnit>): SelectedSourceSpan[] {
	const lines: SourceUnit[] = [];
	for (const id of selected) {
		const unit = unitsById.get(id);
		if (unit) lines.push(unit);
	}
	lines.sort((left, right) => left.lineNumber - right.lineNumber);
	const spans: SelectedSourceSpan[] = [];
	for (const unit of lines) {
		const previous = spans.at(-1);
		if (previous && previous.endLine + 1 === unit.lineNumber) {
			previous.endLine = unit.lineNumber;
			previous.text += `\n${unit.text}`;
			continue;
		}
		spans.push({ endLine: unit.lineNumber, startLine: unit.lineNumber, text: unit.text });
	}
	return spans;
}

function renderSpans(request: ToolOutputPackRequest, spans: readonly SelectedSourceSpan[], totalLines: number): string {
	if (spans.length === 0) return `[tool=${request.toolName}; no source lines selected]`;
	const chunks: string[] = [];
	let previousEnd = 0;
	for (const span of spans) {
		if (span.startLine > previousEnd + 1) {
			chunks.push(`[... source lines ${previousEnd + 1}-${span.startLine - 1} omitted ...]`);
		}
		const range = span.startLine === span.endLine ? `${span.startLine}` : `${span.startLine}-${span.endLine}`;
		chunks.push(`[tool=${request.toolName}; source lines ${range}]\n${span.text}`);
		previousEnd = span.endLine;
	}
	if (previousEnd < totalLines) chunks.push(`[... source lines ${previousEnd + 1}-${totalLines} omitted ...]`);
	return chunks.join("\n");
}

function renderSelection(
	request: ToolOutputPackRequest,
	selected: ReadonlySet<string>,
	unitsById: ReadonlyMap<string, SourceUnit>,
	totalLines: number,
): { content: string; spans: SelectedSourceSpan[] } {
	const spans = createSpans(selected, unitsById);
	return { content: renderSpans(request, spans, totalLines), spans };
}

function utf8Head(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let windowEnd = Math.min(text.length, maxBytes);
	const lastCodeUnit = text.charCodeAt(windowEnd - 1);
	if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) windowEnd++;
	const window = text.substring(0, windowEnd);
	const bytes = Buffer.from(window, "utf8");
	if (bytes.length <= maxBytes) return window;
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function utf8Tail(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let windowStart = Math.max(0, text.length - maxBytes);
	const firstCodeUnit = text.charCodeAt(windowStart);
	if (firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) windowStart--;
	const window = text.substring(windowStart);
	const bytes = Buffer.from(window, "utf8");
	if (bytes.length <= maxBytes) return window;
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

function utf8Before(text: string, end: number, maxBytes: number): string {
	let start = Math.max(0, end - maxBytes);
	const firstCodeUnit = text.charCodeAt(start);
	if (firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) start--;
	return utf8Tail(text.slice(start, end), maxBytes);
}

function utf8After(text: string, start: number, maxBytes: number): string {
	let end = Math.min(text.length, start + maxBytes);
	const lastCodeUnit = text.charCodeAt(end - 1);
	if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end++;
	return utf8Head(text.slice(start, end), maxBytes);
}

function utf8Window(text: string, matchStart: number, matchEnd: number, maxBytes: number): SelectedSourceFragment {
	const match = text.slice(matchStart, matchEnd);
	const matchBytes = Buffer.byteLength(match, "utf8");
	if (matchBytes >= maxBytes) {
		const fragment = utf8Head(match, maxBytes);
		return { endOffset: matchStart + fragment.length, startOffset: matchStart, text: fragment };
	}
	const remaining = maxBytes - matchBytes;
	const beforeBudget = Math.floor(remaining / 2);
	const afterBudget = remaining - beforeBudget;
	let before = utf8Before(text, matchStart, beforeBudget);
	let after = utf8After(text, matchEnd, afterBudget);
	const beforeBytes = Buffer.byteLength(before, "utf8");
	const afterBytes = Buffer.byteLength(after, "utf8");
	if (before.length === matchStart) {
		after = utf8After(text, matchEnd, afterBudget + beforeBudget - beforeBytes);
	} else if (matchEnd + after.length === text.length) {
		before = utf8Before(text, matchStart, beforeBudget + afterBudget - afterBytes);
	}
	return {
		endOffset: matchEnd + after.length,
		startOffset: matchStart - before.length,
		text: `${before}${match}${after}`,
	};
}

function queryMatches(
	request: ToolOutputPackRequest,
	unit: SourceUnit,
	unitCount: number,
): { end: number; start: number }[] {
	const normalized = unit.text.toLowerCase();
	const matches: { end: number; start: number }[] = [];
	const seenStarts = new Set<number>();
	const taskTokens = boundedTaskQueryTokens(request, unitCount);
	for (let index = taskTokens.length - 1; index >= 0 && matches.length < 4; index--) {
		const token = taskTokens[index];
		const start = normalized.indexOf(token);
		if (start < 0 || seenStarts.has(start)) continue;
		seenStarts.add(start);
		matches.push({ end: Math.min(unit.text.length, start + token.length), start });
	}
	if (matches.length > 0) return matches;

	let best: { end: number; start: number } | undefined;
	for (const token of boundedQueryTokens(request, unitCount)) {
		const start = normalized.indexOf(token);
		if (start < 0 || (best && token.length <= best.end - best.start)) continue;
		best = { end: Math.min(unit.text.length, start + token.length), start };
	}
	return best ? [best] : [];
}

function mergeFragments(text: string, fragments: SelectedSourceFragment[]): SelectedSourceFragment[] {
	fragments.sort((left, right) => left.startOffset - right.startOffset);
	const merged: SelectedSourceFragment[] = [];
	for (const fragment of fragments) {
		const previous = merged.at(-1);
		if (previous && fragment.startOffset <= previous.endOffset) {
			previous.endOffset = Math.max(previous.endOffset, fragment.endOffset);
			previous.text = text.slice(previous.startOffset, previous.endOffset);
		} else {
			merged.push(fragment);
		}
	}
	return merged;
}

function renderOversizedUnit(
	request: ToolOutputPackRequest,
	unit: SourceUnit,
	totalLines: number,
	maxBytes: number,
): { content: string; spans: SelectedSourceSpan[] } | undefined {
	const before = unit.lineNumber > 1 ? `[... source lines 1-${unit.lineNumber - 1} omitted ...]\n` : "";
	const header = `[tool=${request.toolName}; source line ${unit.lineNumber}; partial source-line fragments]\n`;
	const after =
		unit.lineNumber < totalLines ? `\n[... source lines ${unit.lineNumber + 1}-${totalLines} omitted ...]` : "";
	const fragmentMarker = "\n[... source bytes omitted within line ...]\n";
	const fragmentBudget = maxBytes - Buffer.byteLength(`${before}${header}${after}`, "utf8");
	const matches = queryMatches(request, unit, totalLines);
	const admitted: { end: number; start: number }[] = [];
	let tokenBytes = 0;
	for (const match of matches) {
		const matchBytes = Buffer.byteLength(unit.text.slice(match.start, match.end), "utf8");
		const markerBytes = admitted.length === 0 ? 0 : Buffer.byteLength(fragmentMarker, "utf8");
		if (tokenBytes + matchBytes + markerBytes > fragmentBudget) continue;
		admitted.push(match);
		tokenBytes += matchBytes + markerBytes;
	}

	let fragments: SelectedSourceFragment[];
	if (admitted.length === 0) {
		const fragment = utf8Tail(unit.text, fragmentBudget);
		if (fragment.length === 0) return undefined;
		fragments = [{ endOffset: unit.text.length, startOffset: unit.text.length - fragment.length, text: fragment }];
	} else {
		const contextBytes = Math.max(0, fragmentBudget - tokenBytes);
		const contextPerFragment = Math.floor(contextBytes / admitted.length);
		fragments = mergeFragments(
			unit.text,
			admitted.map((match, index) =>
				utf8Window(
					unit.text,
					match.start,
					match.end,
					Buffer.byteLength(unit.text.slice(match.start, match.end), "utf8") +
						contextPerFragment +
						(index === admitted.length - 1 ? contextBytes % admitted.length : 0),
				),
			),
		);
		if (fragments.length === 1) {
			let matchStart = admitted[0].start;
			let matchEnd = admitted[0].end;
			for (const match of admitted) {
				matchStart = Math.min(matchStart, match.start);
				matchEnd = Math.max(matchEnd, match.end);
			}
			fragments[0] = utf8Window(unit.text, matchStart, matchEnd, fragmentBudget);
		}
	}
	const fragmentText = fragments.map(fragment => fragment.text).join(fragmentMarker);
	const content = `${before}${header}${fragmentText}${after}`;
	if (Buffer.byteLength(content, "utf8") > maxBytes) return undefined;
	return {
		content,
		spans: [
			{
				endLine: unit.lineNumber,
				fragments,
				startLine: unit.lineNumber,
				text: fragments[0].text,
			},
		],
	};
}

export function renderRankedSelection(
	request: ToolOutputPackRequest,
	units: readonly SourceUnit[],
	rankedIds: readonly string[],
): PackedToolOutput {
	const unitsById = new Map(units.map(unit => [unit.id, unit]));
	const rankById = new Map(rankedIds.map((id, index) => [id, index]));
	const maxBytes = Math.max(0, request.maxBytes);
	const totalBytes = Buffer.byteLength(request.content, "utf8");
	let selected = new Set<string>();
	if (totalBytes <= maxBytes) {
		const allSelected = new Set(units.map(unit => unit.id));
		const complete = renderSelection(request, allSelected, unitsById, units.length);
		if (Buffer.byteLength(complete.content, "utf8") <= maxBytes) selected = allSelected;
	}
	let pending = selected.size === units.length ? [] : [...new Set(rankedIds)].filter(id => unitsById.has(id));
	const maxCandidateEvaluations = candidateEvaluationLimit(maxBytes);
	let candidateEvaluations = 0;
	let oversizedCandidate: SourceUnit | undefined;
	let bestAdmittedSubstantiveRank = Number.POSITIVE_INFINITY;
	while (pending.length > 0 && candidateEvaluations < maxCandidateEvaluations) {
		let admitted = false;
		const deferred: string[] = [];
		for (const id of pending) {
			if (candidateEvaluations >= maxCandidateEvaluations) break;
			candidateEvaluations++;
			const unit = unitsById.get(id);
			if (!unit) continue;
			const proposed = dependencyClosure(new Set([...selected, id]), unitsById);
			const rendered = renderSelection(request, proposed, unitsById, units.length);
			if (Buffer.byteLength(rendered.content, "utf8") <= maxBytes) {
				selected = proposed;
				admitted = true;
				if (unit.kind !== "structure") {
					bestAdmittedSubstantiveRank = Math.min(bestAdmittedSubstantiveRank, rankById.get(id) ?? Infinity);
				}
			} else {
				if (
					!hasOnlyJsonStructuralDependencies(unit, unitsById) ||
					queryMatches(request, unit, units.length).length === 0
				) {
					deferred.push(id);
					continue;
				}
				const direct = new Set(selected).add(id);
				const directRendered = renderSelection(request, direct, unitsById, units.length);
				if (Buffer.byteLength(directRendered.content, "utf8") <= maxBytes) {
					selected = direct;
					admitted = true;
					if (unit.kind !== "structure") {
						bestAdmittedSubstantiveRank = Math.min(bestAdmittedSubstantiveRank, rankById.get(id) ?? Infinity);
					}
				} else {
					oversizedCandidate ??= unit;
					deferred.push(id);
				}
			}
		}
		if (!admitted) break;
		pending = deferred;
	}

	let rendered = renderSelection(request, selected, unitsById, units.length);
	const oversizedUnit =
		oversizedCandidate ??
		(selected.size === 0
			? rankedIds
					.map(id => unitsById.get(id))
					.find((unit): unit is SourceUnit => unit !== undefined && unit.dependencies.length === 0)
			: undefined);
	const oversized = oversizedUnit && renderOversizedUnit(request, oversizedUnit, units.length, maxBytes);
	if (oversized && oversizedUnit && (rankById.get(oversizedUnit.id) ?? Infinity) < bestAdmittedSubstantiveRank) {
		selected = new Set([oversizedUnit.id]);
		rendered = oversized;
	}
	if (Buffer.byteLength(rendered.content, "utf8") > maxBytes) {
		selected = new Set();
		rendered = { content: "", spans: [] };
	}
	const selectedUnits = units.filter(unit => selected.has(unit.id));
	const selectedSourceBytes = rendered.spans.reduce(
		(sum, span) =>
			sum +
			(span.fragments ?? [{ text: span.text }]).reduce(
				(fragmentSum, fragment) => fragmentSum + Buffer.byteLength(fragment.text, "utf8"),
				0,
			),
		0,
	);
	const outputBytes = Buffer.byteLength(rendered.content, "utf8");
	return {
		content: rendered.content,
		estimatedTokens: Math.ceil(outputBytes / 4),
		omittedLines: Math.max(0, units.length - selectedUnits.length),
		outputBytes,
		selectedLineNumbers: selectedUnits.map(unit => unit.lineNumber),
		selectedSourceBytes,
		spans: rendered.spans,
		totalBytes,
		totalLines: units.length,
	};
}
