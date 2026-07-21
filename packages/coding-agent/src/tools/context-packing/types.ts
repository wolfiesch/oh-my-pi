export type ToolOutputKind = "json" | "search" | "subagent" | "table" | "test" | "text";

export type SourceUnitKind =
	| "blank"
	| "error"
	| "json_key"
	| "path"
	| "structure"
	| "summary"
	| "table_header"
	| "table_row"
	| "text";

export interface ToolOutputPackRequest {
	content: string;
	isError?: boolean;
	exitCode?: number;
	kind?: ToolOutputKind;
	maxBytes: number;
	taskGoal: string;
	toolArguments?: string;
	toolName: string;
}

export interface SourceUnit {
	byteLength: number;
	dependencies: readonly string[];
	id: string;
	kind: SourceUnitKind;
	lineNumber: number;
	text: string;
}

export interface CandidateSelectionSettings {
	dedupeExactLines: boolean;
	errorWeight: number;
	headWeight: number;
	neighborRadius: number;
	neighborWeight: number;
	pathWeight: number;
	queryWeight: number;
	structureWeight: number;
	summaryWeight: number;
	tailWeight: number;
}

export interface SelectedSourceFragment {
	endOffset: number;
	startOffset: number;
	text: string;
}

export interface SelectedSourceSpan {
	endLine: number;
	startLine: number;
	fragments?: readonly SelectedSourceFragment[];
	text: string;
}

export interface PackedToolOutput {
	content: string;
	estimatedTokens: number;
	omittedLines: number;
	outputBytes: number;
	selectedLineNumbers: readonly number[];
	selectedSourceBytes: number;
	spans: readonly SelectedSourceSpan[];
	totalBytes: number;
	totalLines: number;
}
