import type { SourceUnit, SourceUnitKind, ToolOutputKind, ToolOutputPackRequest } from "./types";

const ERROR_RE =
	/(?:^|\b)(?:error|failed|failure|fatal|panic|exception|assertionerror|traceback|segmentation fault|not found|permission denied)(?:\b|:)/iu;
const SUMMARY_RE =
	/(?:tests?\s+(?:failed|passed)|\d+\s+(?:failed|passed|errors?)|command exited|exit code|summary|results?:|warnings?:)/iu;
const PATH_RE =
	/(?:^|\s)(?:\.\.?\/|\/|[A-Za-z]:\\)[^\s:]+|\b[^\s:]+\.(?:[cm]?[jt]sx?|py|rs|go|java|json|ya?ml|toml|md):\d+/u;
const JSON_KEY_RE = /^\s*"(?:[^"\\]|\\.)+"\s*:/u;
const JSON_STRUCTURE_RE = /^\s*[{}[\]],?\s*$/u;
const TABLE_SEPARATOR_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/u;
const MAX_JSON_INFERENCE_CHARS = 64 * 1024;
const MAX_TABLE_INFERENCE_LINES = 256;
const CSV_MIN_FIELDS = 3;

function isPipeTableLine(line: string): boolean {
	return line.split("|").length - 1 >= 2;
}

/**
 * Field count of a delimiter-structured CSV record, or 0 when the line reads
 * like ordinary comma-separated prose. CSV records keep every field non-empty
 * and flush against the delimiter, while prose and log clauses ("we came, we
 * saw, we conquered") pad fields with whitespace around each comma.
 */
function csvFieldCount(rawLine: string): number {
	const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
	if (!line.includes(",")) return 0;
	const fields = line.split(",");
	if (fields.length < CSV_MIN_FIELDS) return 0;
	for (const field of fields) {
		if (field.length === 0 || field !== field.trim()) return 0;
	}
	return fields.length;
}

/**
 * Bounded structural table detection: two pipe-table lines anywhere in the
 * prefix, or a header-like CSV record immediately followed by a record of the
 * same width (`File,Status,Message` over `src/a.ts,failed,...`).
 */
function hasTableStructure(lines: readonly string[]): boolean {
	const bounded = Math.min(lines.length, MAX_TABLE_INFERENCE_LINES);
	let pipeLines = 0;
	let previousCsvFields = 0;
	for (let index = 0; index < bounded; index++) {
		if (isPipeTableLine(lines[index])) {
			pipeLines++;
			if (pipeLines >= 2) return true;
		}
		const csvFields = csvFieldCount(lines[index]);
		if (csvFields > 0 && csvFields === previousCsvFields) return true;
		previousCsvFields = csvFields;
	}
	return false;
}

function hasJsonContainerBoundary(text: string): boolean {
	return (text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"));
}

export function inferToolOutputKind(request: ToolOutputPackRequest): ToolOutputKind {
	if (request.kind) return request.kind;
	const toolName = request.toolName.toLowerCase();
	if (toolName === "task" || toolName === "subagent") return "subagent";
	if (["grep", "search", "glob", "find"].includes(toolName)) return "search";
	const trimmed = request.content.trim();
	if (hasJsonContainerBoundary(trimmed)) {
		if (trimmed.length > MAX_JSON_INFERENCE_CHARS) return "json";
		try {
			JSON.parse(trimmed);
			return "json";
		} catch {
			// Small malformed payloads remain generic text. Large structural
			// payloads avoid allocating a parsed object graph during inference;
			// segmentation still preserves their exact source text.
		}
	}
	if (hasTableStructure(request.content.split("\n"))) return "table";
	if (["bash", "python", "ssh", "eval"].includes(toolName) || ERROR_RE.test(request.content)) return "test";
	return "text";
}

function classifyLine(
	line: string,
	kind: ToolOutputKind,
	isTableLine: boolean,
	isTableHeader: boolean,
): SourceUnitKind {
	if (line.length === 0 || line === "\r") return "blank";
	if (ERROR_RE.test(line)) return "error";
	if (SUMMARY_RE.test(line)) return "summary";
	if (PATH_RE.test(line)) return "path";
	if (kind === "json" && JSON_STRUCTURE_RE.test(line)) return "structure";
	if (kind === "json" && JSON_KEY_RE.test(line)) return "json_key";
	if (kind === "table" && isTableLine) return isTableHeader ? "table_header" : "table_row";
	return "text";
}

function jsonDependenciesByLine(lines: readonly string[]): string[][] {
	const frames: Array<{ closeLine: number | null; openLine: number; parentIndex: number | null }> = [];
	const stack: number[] = [];
	const directFrameByLine = lines.map((): number | null => null);
	let escaped = false;
	let inString = false;

	for (let index = 0; index < lines.length; index++) {
		const lineNumber = index + 1;
		directFrameByLine[index] = stack.at(-1) ?? null;

		for (const character of lines[index]) {
			if (inString) {
				if (escaped) {
					escaped = false;
				} else if (character === "\\") {
					escaped = true;
				} else if (character === '"') {
					inString = false;
				}
				continue;
			}
			if (character === '"') {
				inString = true;
				continue;
			}
			if (character === "{" || character === "[") {
				const frameIndex = frames.length;
				frames.push({ closeLine: null, openLine: lineNumber, parentIndex: stack.at(-1) ?? null });
				stack.push(frameIndex);
				directFrameByLine[index] = frameIndex;
				continue;
			}
			if (character === "}" || character === "]") {
				const frameIndex = stack.pop();
				if (frameIndex === undefined) continue;
				frames[frameIndex].closeLine = lineNumber;
			}
		}
	}

	const dependenciesByLine = lines.map(() => new Set<string>());
	const addFrameBoundaries = (lineIndex: number, frameIndex: number): void => {
		const dependencies = dependenciesByLine[lineIndex];
		const frame = frames[frameIndex];
		const lineNumber = lineIndex + 1;
		if (frame.openLine !== lineNumber) dependencies.add(`line:${frame.openLine}`);
		if (frame.closeLine !== null && frame.closeLine !== lineNumber) dependencies.add(`line:${frame.closeLine}`);
	};

	for (let index = 0; index < directFrameByLine.length; index++) {
		const frameIndex = directFrameByLine[index];
		if (frameIndex !== null) addFrameBoundaries(index, frameIndex);
	}
	for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
		const frame = frames[frameIndex];
		addFrameBoundaries(frame.openLine - 1, frameIndex);
		if (frame.closeLine !== null) addFrameBoundaries(frame.closeLine - 1, frameIndex);
		if (frame.parentIndex !== null) addFrameBoundaries(frame.openLine - 1, frame.parentIndex);
	}

	return dependenciesByLine.map(dependencies => [...dependencies]);
}

export function segmentToolOutput(request: ToolOutputPackRequest): SourceUnit[] {
	const kind = inferToolOutputKind(request);
	const lines = request.content.split("\n");
	const jsonDependencies =
		kind === "json" && request.content.length <= MAX_JSON_INFERENCE_CHARS ? jsonDependenciesByLine(lines) : [];
	let tableHeaderLine: number | null = null;
	let tableSeparatorId: string | null = null;
	let tableDelimiter: "csv" | "pipe" | null = null;
	let tableCsvFields = 0;

	const units: SourceUnit[] = [];
	for (let index = 0; index < lines.length; index++) {
		const lineNumber = index + 1;
		const text = lines[index];
		const isPipeLine = kind === "table" && isPipeTableLine(text);
		const csvFields = kind === "table" && !isPipeLine ? csvFieldCount(text) : 0;
		const delimiter = isPipeLine ? "pipe" : csvFields > 0 ? "csv" : null;
		const isTableLine = delimiter !== null;
		if (delimiter !== tableDelimiter || (delimiter === "csv" && tableCsvFields > 0 && csvFields !== tableCsvFields)) {
			// A non-table line, a delimiter change (CSV<->pipe adjacency), or a
			// CSV width change ends the current table, so later rows depend on
			// their own header rather than the first one.
			tableHeaderLine = null;
			tableSeparatorId = null;
			tableDelimiter = null;
			tableCsvFields = 0;
		}
		const isTableSeparator = isPipeLine && TABLE_SEPARATOR_RE.test(text);
		const nextLine = index + 1 < lines.length ? lines[index + 1] : null;
		// An adjacent pipe table announces itself with a separator directly under
		// its header row; promote that row instead of chaining it to the old table.
		const startsAdjacentTable =
			isPipeLine &&
			!isTableSeparator &&
			tableHeaderLine !== null &&
			nextLine !== null &&
			isPipeTableLine(nextLine) &&
			TABLE_SEPARATOR_RE.test(nextLine);
		const isTableHeader = isTableLine && (tableHeaderLine === null || isTableSeparator || startsAdjacentTable);
		if (isTableLine && (tableHeaderLine === null || startsAdjacentTable)) {
			tableHeaderLine = lineNumber;
			tableSeparatorId = null;
			tableDelimiter = delimiter;
			tableCsvFields = csvFields;
		}
		if (isTableSeparator) tableSeparatorId = `line:${lineNumber}`;

		const unitKind = classifyLine(text, kind, isTableLine, isTableHeader);
		const dependencies = [...(jsonDependencies[index] ?? [])];
		if (isTableLine && !isTableHeader && tableHeaderLine !== null) {
			dependencies.push(`line:${tableHeaderLine}`);
			if (tableSeparatorId) dependencies.push(tableSeparatorId);
		}

		units.push({
			byteLength: Buffer.byteLength(text, "utf8"),
			dependencies,
			id: `line:${lineNumber}`,
			kind: unitKind,
			lineNumber,
			text,
		});
	}
	return units;
}
