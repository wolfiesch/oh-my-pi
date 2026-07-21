import { rankSourceUnits } from "./candidate";
import { renderRankedSelection } from "./render";
import { segmentToolOutput } from "./segment";
import type { PackedToolOutput, ToolOutputPackRequest } from "./types";

export * from "./candidate";
export * from "./render";
export * from "./segment";
export * from "./types";

export function packToolOutput(request: ToolOutputPackRequest): PackedToolOutput {
	const units = segmentToolOutput(request);
	const rankedIds = rankSourceUnits(request, units);
	return renderRankedSelection(request, units, rankedIds);
}

export function formatToolArgumentsForPacking(value: unknown): string {
	if (value === undefined) return "";
	try {
		const serialized = typeof value === "string" ? value : JSON.stringify(value);
		return serialized.slice(0, 4096);
	} catch {
		return String(value).slice(0, 4096);
	}
}
