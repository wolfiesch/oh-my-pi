import type { SessionEvent } from "@oh-my-pi/app-wire";

export type TranscriptMessageEvent = {
	type: "message.update";
	entryId: string;
	role: "assistant";
	text: string;
	reasoning: string;
	at: string;
};
export type TranscriptToolStartEvent = {
	type: "tool.start";
	callId: string;
	tool: string;
	title: string;
	args: unknown;
	at: string;
};
export type TranscriptToolProgressEvent = {
	type: "tool.progress";
	callId: string;
	note?: string;
	chunk?: string;
	progress?: number;
	at: string;
};
export type TranscriptToolResultEvent = {
	type: "tool.result";
	callId: string;
	ok: boolean;
	result: unknown;
	at: string;
};
export type TranscriptEvent =
	| { type: "turn.start"; at: string }
	| { type: "turn.end"; at: string }
	| TranscriptMessageEvent
	| TranscriptToolStartEvent
	| TranscriptToolProgressEvent
	| TranscriptToolResultEvent;
export type AskRequestEvent = {
	type: "ask.request";
	askId: string;
	question: string;
	options?: Array<{ id: string; label: string }>;
	allowText: boolean;
	responseKind: "value";
	source: "rpc-ui";
	at: string;
};
export type ApprovalRequestEvent = {
	type: "approval.request";
	approvalId: string;
	title: string;
	message: string;
	responseKind: "confirmed";
	source: "rpc-ui";
	at: string;
};
export type AskResolvedEvent = { type: "ask.resolved"; askId: string; at: string };
export type ApprovalResolvedEvent = { type: "approval.resolved"; approvalId: string; at: string };
export type AppserverEvent =
	| TranscriptEvent
	| AskRequestEvent
	| ApprovalRequestEvent
	| AskResolvedEvent
	| ApprovalResolvedEvent;
export type PendingUiRequest = { kind: "ask" | "approval"; id: string };
interface MessageSnapshot {
	text: string;
	reasoning: string;
	at: string;
}
interface ActiveAssistant {
	entryId: string;
	last: MessageSnapshot | undefined;
	ended: boolean;
}
interface ToolState {
	state: "open" | "closed";
	at: string;
}
interface UiState {
	kind: "ask" | "approval";
	at: string;
}
const TEXT_BLOCK = "text";
const THINKING_BLOCK = "thinking";
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function safeDisplay(value: unknown, limit = 512): string {
	return (typeof value === "string" ? value : "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit);
}
function flattenParts(content: unknown): { text: string; reasoning: string } {
	if (typeof content === "string") return { text: content, reasoning: "" };
	if (!Array.isArray(content)) return { text: "", reasoning: "" };
	let text = "";
	let reasoning = "";
	for (const part of content) {
		if (typeof part === "string") text += part;
		else if (isRecord(part) && part.type === TEXT_BLOCK && typeof part.text === "string") text += part.text;
		else if (isRecord(part) && part.type === THINKING_BLOCK && typeof part.thinking === "string")
			reasoning += part.thinking;
		else if (isRecord(part) && part.type === "redactedThinking" && typeof part.data === "string")
			reasoning += part.data;
	}
	return { text, reasoning };
}
function stableTimestamp(value: unknown, fallback: () => string): string {
	if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MILLISECONDS)
		return new Date(value).toISOString();
	if (typeof value === "string") {
		const milliseconds = Date.parse(value);
		if (Number.isFinite(milliseconds)) return new Date(milliseconds).toISOString();
	}
	return fallback();
}
function valueAt(value: unknown, fallback: () => string): string {
	if (isRecord(value)) return stableTimestamp(value.timestamp, () => stableTimestamp(value.at, fallback));
	return fallback();
}
function assistantSnapshot(message: unknown, fallback: () => string): MessageSnapshot | undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	return { ...flattenParts(message.content), at: valueAt(message, fallback) };
}
function sourceId(message: unknown): string | undefined {
	if (!isRecord(message)) return undefined;
	for (const key of ["id", "responseId"]) {
		const id = asString(message[key]);
		if (id) return id;
	}
	return undefined;
}
function textFromUnknown(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return undefined;
	if (typeof value.text === "string") return value.text;
	if (typeof value.note === "string") return value.note;
	if (typeof value.output === "string") return value.output;
	const text = flattenParts(value.content).text;
	return text || undefined;
}
function sameSnapshot(a: MessageSnapshot | undefined, b: MessageSnapshot): boolean {
	return a !== undefined && a.text === b.text && a.reasoning === b.reasoning && a.at === b.at;
}

export class TranscriptEventTranslator {
	#messageCounter = 0;
	#activeAssistant: ActiveAssistant | undefined;
	#toolStates = new Map<string, ToolState>();
	#pendingUi = new Map<string, UiState>();
	#turnAt: string | undefined;
	readonly #now: () => number;
	constructor(now: () => number = Date.now) {
		this.#now = now;
	}
	#nowIso(): string {
		return stableTimestamp(this.#now(), () => new Date(0).toISOString());
	}
	pendingUiRequests(): PendingUiRequest[] {
		return [...this.#pendingUi].map(([id, value]) => ({ id, kind: value.kind }));
	}
	pendingUiRequest(id: string): PendingUiRequest | undefined {
		const pending = this.#pendingUi.get(id);
		return pending ? { id, kind: pending.kind } : undefined;
	}
	resolveUiRequest(id: string): AskResolvedEvent | ApprovalResolvedEvent | undefined {
		const pending = this.#pendingUi.get(id);
		if (!pending) return undefined;
		this.#pendingUi.delete(id);
		const at = this.#nowIso();
		return pending.kind === "ask"
			? { type: "ask.resolved", askId: id, at }
			: { type: "approval.resolved", approvalId: id, at };
	}
	translate(frame: Record<string, unknown>): AppserverEvent[] {
		const type = asString(frame.type);
		if (!type) return [];
		switch (type) {
			case "turn_start":
				this.#turnAt = this.#nowIso();
				this.#activeAssistant = undefined;
				return [{ type: "turn.start", at: this.#turnAt }];
			case "turn_end": {
				const at = this.#turnAt ?? this.#nowIso();
				this.#turnAt = undefined;
				this.#activeAssistant = this.#activeAssistant?.ended ? undefined : this.#activeAssistant;
				return [{ type: "turn.end", at }];
			}
			case "message_start":
				return this.messageStart(frame.message);
			case "message_update":
				return this.messageUpdate(frame.message);
			case "message_end":
				return this.messageEnd(frame.message);
			case "tool_execution_start":
				return this.toolStart(frame);
			case "tool_execution_update":
				return this.toolProgress(frame);
			case "tool_execution_end":
				return this.toolResult(frame);
			case "extension_ui_request":
				return this.extensionUi(frame);
			default:
				return [];
		}
	}
	private extensionUi(frame: Record<string, unknown>): AppserverEvent[] {
		const id = asString(frame.id);
		const method = asString(frame.method);
		if (!id || !method) return [];
		if (method === "cancel") {
			const target = asString(frame.targetId);
			const pending = target ? this.#pendingUi.get(target) : undefined;
			if (!target || !pending) return [];
			this.#pendingUi.delete(target);
			return pending.kind === "ask"
				? [{ type: "ask.resolved", askId: target, at: pending.at }]
				: [{ type: "approval.resolved", approvalId: target, at: pending.at }];
		}
		const at = this.#nowIso();
		if (method === "select") {
			const raw = Array.isArray(frame.options) ? frame.options : [];
			const options = raw.flatMap((option, index) => {
				if (typeof option !== "string") return [];
				const label = safeDisplay(option, 256);
				if (!label) return [];
				const optionId = option.length <= 256 && !/[\u0000-\u001f\u007f]/.test(option) ? option : `option-${index}`;
				return [{ id: optionId, label }];
			});
			this.#pendingUi.set(id, { kind: "ask", at });
			return [
				{
					type: "ask.request",
					askId: id,
					question: safeDisplay(frame.title),
					options,
					allowText: false,
					responseKind: "value",
					source: "rpc-ui",
					at,
				},
			];
		}
		if (method === "input" || method === "editor") {
			this.#pendingUi.set(id, { kind: "ask", at });
			return [
				{
					type: "ask.request",
					askId: id,
					question: safeDisplay(frame.title),
					allowText: true,
					responseKind: "value",
					source: "rpc-ui",
					at,
				},
			];
		}
		if (method === "confirm") {
			this.#pendingUi.set(id, { kind: "approval", at });
			return [
				{
					type: "approval.request",
					approvalId: id,
					title: safeDisplay(frame.title),
					message: safeDisplay(frame.message),
					responseKind: "confirmed",
					source: "rpc-ui",
					at,
				},
			];
		}
		return [];
	}
	observeSessionEntry(entry: Record<string, unknown>): void {
		if (entry.type !== "message") return;
		const snapshot = assistantSnapshot(entry.message, () => this.#activeAssistant?.last?.at ?? this.#nowIso());
		if (snapshot && this.#activeAssistant?.ended && sameSnapshot(this.#activeAssistant.last, snapshot))
			this.#activeAssistant = undefined;
	}
	private messageStart(message: unknown): TranscriptEvent[] {
		const snapshot = assistantSnapshot(message, () => this.#activeAssistant?.last?.at ?? this.#nowIso());
		if (!snapshot) return [];
		const active = this.#activeAssistant;
		const entryId = sourceId(message)
			? `assistant:${sourceId(message)}`
			: active && !active.ended
				? active.entryId
				: `assistant:${++this.#messageCounter}`;
		this.#activeAssistant = { entryId, last: active?.entryId === entryId ? active.last : undefined, ended: false };
		if (!snapshot.text && !snapshot.reasoning) {
			this.#activeAssistant.last = snapshot;
			return [];
		}
		return this.emitMessage(snapshot);
	}
	private messageUpdate(message: unknown): TranscriptEvent[] {
		const snapshot = assistantSnapshot(message, () => this.#activeAssistant?.last?.at ?? this.#nowIso());
		if (!snapshot) return [];
		if (!this.#activeAssistant || this.#activeAssistant.ended)
			this.#activeAssistant = {
				entryId: sourceId(message) ? `assistant:${sourceId(message)}` : `assistant:${++this.#messageCounter}`,
				last: undefined,
				ended: false,
			};
		return this.emitMessage(snapshot);
	}
	private messageEnd(message: unknown): TranscriptEvent[] {
		const snapshot = assistantSnapshot(message, () => this.#activeAssistant?.last?.at ?? this.#nowIso());
		if (!snapshot || !this.#activeAssistant || this.#activeAssistant.ended) return [];
		const output = this.emitMessage(snapshot);
		this.#activeAssistant.ended = true;
		return output;
	}
	private emitMessage(snapshot: MessageSnapshot): TranscriptEvent[] {
		const active = this.#activeAssistant;
		if (!active || sameSnapshot(active.last, snapshot)) return [];
		active.last = snapshot;
		return [
			{
				type: "message.update",
				entryId: active.entryId,
				role: "assistant",
				text: snapshot.text,
				reasoning: snapshot.reasoning,
				at: snapshot.at,
			},
		];
	}
	private toolStart(frame: Record<string, unknown>): TranscriptEvent[] {
		const callId = asString(frame.toolCallId);
		if (!callId || this.#toolStates.has(callId)) return [];
		const at = valueAt(frame, this.#nowIso.bind(this));
		const tool = asString(frame.toolName) ?? "tool";
		this.#toolStates.set(callId, { state: "open", at });
		return [{ type: "tool.start", callId, tool, title: tool, args: frame.args, at }];
	}
	private toolProgress(frame: Record<string, unknown>): TranscriptEvent[] {
		const callId = asString(frame.toolCallId);
		const state = callId ? this.#toolStates.get(callId) : undefined;
		if (!callId || !state || state.state !== "open") return [];
		const partial = frame.partialResult;
		const event: TranscriptToolProgressEvent = {
			type: "tool.progress",
			callId,
			at: valueAt(partial, () => state.at),
		};
		const text = textFromUnknown(partial);
		if (typeof partial === "string") event.chunk = partial;
		else if (text !== undefined) event.note = text;
		const progress = isRecord(partial) ? asFiniteNumber(partial.progress) : asFiniteNumber(partial);
		if (progress !== undefined) event.progress = progress;
		return [event];
	}
	private toolResult(frame: Record<string, unknown>): TranscriptEvent[] {
		const callId = asString(frame.toolCallId);
		const state = callId ? this.#toolStates.get(callId) : undefined;
		if (!callId || !state || state.state === "closed") return [];
		state.state = "closed";
		return [
			{
				type: "tool.result",
				callId,
				ok: frame.isError !== true,
				result: frame.result,
				at: valueAt(frame, () => state.at),
			},
		];
	}
}
export function asAppWireEvent(event: AppserverEvent): SessionEvent {
	return event;
}
