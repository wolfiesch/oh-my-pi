import * as fs from "node:fs/promises";
import { parseBounded } from "@oh-my-pi/app-wire";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { AgentRegistry, type RegistryEvent } from "../../registry/agent-registry";
import type { FileEntry, SessionMessageEntry } from "../../session/session-entries";
import { parseSessionEntries } from "../../session/session-loader";
import {
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../../task";
import type { EventBus } from "../../utils/event-bus";
import type {
	RpcSubagentEventFrame,
	RpcSubagentFrame,
	RpcSubagentLifecyclePayload,
	RpcSubagentMessagesResult,
	RpcSubagentSnapshot,
	RpcSubagentStatus,
	RpcSubagentSubscriptionLevel,
	RpcSubagentTranscriptSelector,
} from "./rpc-types";

export type { RpcSubagentTranscriptSelector } from "./rpc-types";

type RpcSubagentOutput = (frame: RpcSubagentFrame) => void;

const MAX_RETAINED_TRANSCRIPT_REFERENCES = 256;
export const RPC_SUBAGENT_TRANSCRIPT_MAX_BYTES = 384 * 1024;
export const RPC_SUBAGENT_TRANSCRIPT_MAX_RECORDS = 256;
const RPC_SUBAGENT_TRANSCRIPT_PROBE_ID = "x".repeat(256);

export interface RpcSubagentTranscriptReadOptions {
	maxBytes?: number;
	includeMessages?: boolean;
}

function isSessionMessageEntry(entry: FileEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function statusFromLifecycle(status: SubagentLifecyclePayload["status"]): RpcSubagentStatus {
	return status === "started" ? "running" : status;
}
function compareCodeUnits(left: string, right: string): number {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index++) {
		const difference = left.charCodeAt(index) - right.charCodeAt(index);
		if (difference !== 0) return difference;
	}
	return left.length - right.length;
}

function hasSameOwner(
	payload: Pick<SubagentLifecyclePayload | SubagentProgressPayload, "parentToolCallId" | "sessionFile">,
	snapshot: RpcSubagentSnapshot,
): boolean {
	if (payload.parentToolCallId !== undefined && snapshot.parentToolCallId !== undefined) {
		return payload.parentToolCallId === snapshot.parentToolCallId;
	}
	if (payload.sessionFile !== undefined && snapshot.sessionFile !== undefined) {
		return payload.sessionFile === snapshot.sessionFile;
	}
	return true;
}

function addPruned(set: Set<string>, value: string, maxSize: number): void {
	set.delete(value);
	set.add(value);
	while (set.size > maxSize) {
		const oldest = set.keys().next();
		if (oldest.done) break;
		set.delete(oldest.value);
	}
}

function transcriptReadMaxBytes(value: number | undefined): number {
	if (value === undefined) return RPC_SUBAGENT_TRANSCRIPT_MAX_BYTES;
	if (!Number.isSafeInteger(value) || value <= 0 || value > RPC_SUBAGENT_TRANSCRIPT_MAX_BYTES) {
		throw new Error(`maxBytes must be an integer between 1 and ${RPC_SUBAGENT_TRANSCRIPT_MAX_BYTES}`);
	}
	return value;
}

interface RpcSubagentTranscriptRecord {
	endByte: number;
	entries: FileEntry[];
}

function transcriptResultForRecords(
	sessionFile: string,
	startByte: number,
	reset: boolean,
	records: readonly RpcSubagentTranscriptRecord[],
	recordCount: number,
	includeMessages: boolean,
): RpcSubagentMessagesResult {
	const entries = records.slice(0, recordCount).flatMap(record => record.entries);
	return {
		sessionFile,
		fromByte: startByte,
		nextByte: startByte + (recordCount > 0 ? records[recordCount - 1]!.endByte : 0),
		reset,
		entries,
		messages: includeMessages ? entries.filter(isSessionMessageEntry).map(entry => entry.message) : [],
	};
}

function isBoundedTranscriptResult(result: RpcSubagentMessagesResult): boolean {
	try {
		parseBounded(
			JSON.stringify({
				id: RPC_SUBAGENT_TRANSCRIPT_PROBE_ID,
				type: "response",
				command: "get_subagent_messages",
				success: true,
				data: result,
			}),
		);
		return true;
	} catch {
		return false;
	}
}

export async function readRpcSubagentTranscript(
	sessionFile: string,
	fromByte = 0,
	options: RpcSubagentTranscriptReadOptions = {},
): Promise<RpcSubagentMessagesResult> {
	let startByte = Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0;
	const maxBytes = transcriptReadMaxBytes(options.maxBytes);
	const includeMessages = options.includeMessages !== false;
	const file = Bun.file(sessionFile);
	let size: number;
	try {
		({ size } = await fs.stat(sessionFile));
	} catch (err) {
		if (!isEnoent(err)) throw err;
		return {
			sessionFile,
			fromByte: startByte,
			nextByte: startByte,
			reset: false,
			entries: [],
			messages: [],
		};
	}
	let reset = false;
	if (startByte > size) {
		startByte = 0;
		reset = true;
	}
	if (startByte > 0) {
		const previous = await file.slice(startByte - 1, startByte).bytes();
		if (previous.byteLength !== 1 || previous[0] !== 0x0a) {
			startByte = 0;
			reset = true;
		}
	}

	const available = Math.max(0, size - startByte);
	const readBytes = Math.min(maxBytes, available);
	const bytes = readBytes === 0 ? new Uint8Array() : await file.slice(startByte, startByte + readBytes).bytes();
	const lastNewline = bytes.lastIndexOf(0x0a);
	if (lastNewline < 0 && bytes.byteLength === maxBytes) {
		throw new Error(`subagent transcript entry exceeds maxBytes (${maxBytes})`);
	}
	const completeBytes = lastNewline < 0 ? new Uint8Array() : bytes.subarray(0, lastNewline + 1);
	const records: RpcSubagentTranscriptRecord[] = [];
	let recordStart = 0;
	for (let index = 0; index < completeBytes.byteLength; index++) {
		if (completeBytes[index] !== 0x0a) continue;
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(completeBytes.subarray(recordStart, index + 1));
		} catch {
			throw new Error("subagent transcript contains invalid UTF-8");
		}
		records.push({ endByte: index + 1, entries: parseSessionEntries(text) });
		recordStart = index + 1;
		if (records.length >= RPC_SUBAGENT_TRANSCRIPT_MAX_RECORDS) break;
	}

	let low = 0;
	let high = records.length;
	while (low < high) {
		const candidate = Math.ceil((low + high) / 2);
		const result = transcriptResultForRecords(sessionFile, startByte, reset, records, candidate, includeMessages);
		if (isBoundedTranscriptResult(result)) low = candidate;
		else high = candidate - 1;
	}
	if (records.length > 0 && low === 0) {
		throw new Error("subagent transcript entry exceeds RPC structural bounds");
	}
	return transcriptResultForRecords(sessionFile, startByte, reset, records, low, includeMessages);
}

export class RpcSubagentRegistry {
	#subagents = new Map<string, RpcSubagentSnapshot>();
	#terminalSubagents = new Map<string, RpcSubagentSnapshot>();
	#transcriptSessionFilesBySubagentId = new Map<string, string>();
	#staleSubagentIds = new Set<string>();
	#unsubscribers: Array<() => void> = [];
	#output: RpcSubagentOutput;
	#subscriptionLevel: RpcSubagentSubscriptionLevel = "off";

	constructor(eventBus: EventBus, output: RpcSubagentOutput, subscriptionLevel: RpcSubagentSubscriptionLevel = "off") {
		this.#output = output;
		this.#subscriptionLevel = subscriptionLevel;
		this.#unsubscribers.push(
			eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
				this.handleLifecycle(data as SubagentLifecyclePayload);
			}),
			eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
				this.handleProgress(data as SubagentProgressPayload);
			}),
			eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, data => {
				this.handleEvent(data as SubagentEventPayload);
			}),
			AgentRegistry.global().onChange(event => {
				this.#handleRegistryChange(event);
			}),
		);
	}

	dispose(): void {
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers = [];
		this.#subagents.clear();
		this.#terminalSubagents.clear();
		this.#transcriptSessionFilesBySubagentId.clear();
		this.#staleSubagentIds.clear();
	}

	clear(): void {
		for (const subagentId of this.#subagents.keys()) {
			addPruned(this.#staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
		}
		for (const subagentId of this.#terminalSubagents.keys()) {
			addPruned(this.#staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
		}
		for (const subagentId of this.#transcriptSessionFilesBySubagentId.keys()) {
			addPruned(this.#staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
		}
		this.#subagents.clear();
		this.#terminalSubagents.clear();
		this.#transcriptSessionFilesBySubagentId.clear();
	}

	setSubscriptionLevel(level: RpcSubagentSubscriptionLevel): void {
		this.#subscriptionLevel = level;
	}

	getSubscriptionLevel(): RpcSubagentSubscriptionLevel {
		return this.#subscriptionLevel;
	}

	getSubagents(): RpcSubagentSnapshot[] {
		return [...this.#subagents.values()].sort(
			(left, right) => left.index - right.index || compareCodeUnits(left.id, right.id),
		);
	}

	#setSnapshot(snapshot: RpcSubagentSnapshot): void {
		this.#subagents.delete(snapshot.id);
		this.#subagents.set(snapshot.id, snapshot);
		while (this.#subagents.size > MAX_RETAINED_TRANSCRIPT_REFERENCES) {
			const oldest = this.#subagents.keys().next();
			if (oldest.done) break;
			this.#subagents.delete(oldest.value);
			addPruned(this.#staleSubagentIds, oldest.value, MAX_RETAINED_TRANSCRIPT_REFERENCES);
		}
	}

	#setTerminalSnapshot(snapshot: RpcSubagentSnapshot): void {
		this.#terminalSubagents.delete(snapshot.id);
		this.#terminalSubagents.set(snapshot.id, snapshot);
		while (this.#terminalSubagents.size > MAX_RETAINED_TRANSCRIPT_REFERENCES) {
			const oldest = this.#terminalSubagents.keys().next();
			if (oldest.done) break;
			this.#terminalSubagents.delete(oldest.value);
		}
	}

	#rememberTranscriptSession(subagentId: string, sessionFile: string | undefined): void {
		if (!sessionFile) return;
		this.#transcriptSessionFilesBySubagentId.delete(subagentId);
		this.#transcriptSessionFilesBySubagentId.set(subagentId, sessionFile);
		while (this.#transcriptSessionFilesBySubagentId.size > MAX_RETAINED_TRANSCRIPT_REFERENCES) {
			const oldest = this.#transcriptSessionFilesBySubagentId.keys().next();
			if (oldest.done) break;
			this.#transcriptSessionFilesBySubagentId.delete(oldest.value);
		}
	}

	#hasTranscriptSessionFile(sessionFile: string): boolean {
		for (const snapshot of this.#subagents.values()) {
			if (snapshot.sessionFile === sessionFile) return true;
		}
		for (const transcriptSessionFile of this.#transcriptSessionFilesBySubagentId.values()) {
			if (transcriptSessionFile === sessionFile) return true;
		}
		return false;
	}

	handleLifecycle(payload: SubagentLifecyclePayload): void {
		const existing = this.#subagents.get(payload.id);
		if (existing && !hasSameOwner(payload, existing)) return;
		if (!existing && payload.status !== "started") return;
		if (payload.status === "started") this.#staleSubagentIds.delete(payload.id);
		const sessionFile = payload.sessionFile ?? existing?.sessionFile;
		const lastUpdate = Date.now();
		const snapshot: RpcSubagentSnapshot = {
			id: payload.id,
			index: payload.index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			description: payload.description ?? existing?.description,
			status: statusFromLifecycle(payload.status),
			task: existing?.task,
			assignment: existing?.assignment,
			sessionFile,
			parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
			lastUpdate,
			progress: existing?.progress,
			resumable: existing?.resumable,
		};
		this.#rememberTranscriptSession(payload.id, sessionFile);
		if (payload.status === "started") {
			this.#terminalSubagents.delete(snapshot.id);
			this.#setSnapshot(snapshot);
		} else {
			this.#subagents.delete(snapshot.id);
			this.#setTerminalSnapshot(snapshot);
		}
		if (this.#subscriptionLevel !== "off") {
			const framePayload: RpcSubagentLifecyclePayload = {
				...payload,
				status: snapshot.status,
				task: snapshot.task,
				lastUpdate,
				resumable: snapshot.resumable,
			};
			this.#output({ type: "subagent_lifecycle", payload: framePayload });
		}
	}

	handleProgress(payload: SubagentProgressPayload): void {
		const progress = payload.progress;
		if (this.#staleSubagentIds.has(progress.id)) return;
		const existing = this.#subagents.get(progress.id);
		if (!existing) return;
		if (!hasSameOwner(payload, existing)) return;
		const sessionFile = payload.sessionFile ?? existing?.sessionFile;
		this.#rememberTranscriptSession(progress.id, sessionFile);
		this.#setSnapshot({
			id: progress.id,
			index: payload.index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			description: progress.description ?? existing?.description,
			status: progress.status,
			task: payload.task,
			assignment: payload.assignment,
			sessionFile,
			lastUpdate: Date.now(),
			parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
			progress,
			resumable: existing?.resumable,
		});
		if (this.#subscriptionLevel !== "off") {
			this.#output({ type: "subagent_progress", payload });
		}
	}

	#handleRegistryChange(event: RegistryEvent): void {
		if (event.ref.kind !== "sub") return;
		const existing = this.#subagents.get(event.ref.id) ?? this.#terminalSubagents.get(event.ref.id);
		if (!existing) return;
		if (event.type === "removed") {
			this.#subagents.delete(event.ref.id);
			this.#terminalSubagents.delete(event.ref.id);
			addPruned(this.#staleSubagentIds, event.ref.id, MAX_RETAINED_TRANSCRIPT_REFERENCES);
			return;
		}
		const resumable = event.ref.status === "idle" || event.ref.status === "parked";
		const snapshot: RpcSubagentSnapshot = {
			...existing,
			status: event.ref.status,
			lastUpdate: event.ref.lastActivity,
			resumable,
		};
		if (resumable || event.ref.status === "running") {
			this.#terminalSubagents.delete(snapshot.id);
			this.#setSnapshot(snapshot);
		} else {
			this.#subagents.delete(snapshot.id);
			this.#setTerminalSnapshot(snapshot);
		}
		if (this.#subscriptionLevel === "off") return;
		const payload: RpcSubagentLifecyclePayload = {
			id: snapshot.id,
			index: snapshot.index,
			agent: snapshot.agent,
			agentSource: snapshot.agentSource,
			description: snapshot.description,
			status: snapshot.status,
			sessionFile: snapshot.sessionFile,
			parentToolCallId: snapshot.parentToolCallId,
			task: snapshot.task,
			lastUpdate: snapshot.lastUpdate,
			resumable,
		};
		this.#output({ type: "subagent_lifecycle", payload });
	}

	handleEvent(payload: SubagentEventPayload): void {
		if (this.#staleSubagentIds.has(payload.id)) return;
		if (this.#subscriptionLevel !== "events") return;
		this.#output({ type: "subagent_event", payload } satisfies RpcSubagentEventFrame);
	}

	resolveSessionFile(selector: RpcSubagentTranscriptSelector): string {
		if (selector.subagentId) {
			const snapshot = this.#subagents.get(selector.subagentId);
			const sessionFile = snapshot?.sessionFile ?? this.#transcriptSessionFilesBySubagentId.get(selector.subagentId);
			if (!sessionFile) {
				throw new Error(`Unknown subagent or session file unavailable: ${selector.subagentId}`);
			}
			return sessionFile;
		}

		if (selector.sessionFile) {
			if (this.#hasTranscriptSessionFile(selector.sessionFile)) return selector.sessionFile;
			throw new Error("Unknown subagent session file");
		}

		throw new Error("get_subagent_messages requires subagentId or sessionFile");
	}
}
