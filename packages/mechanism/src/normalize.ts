import * as fs from "node:fs/promises";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { modelFamilyToken } from "@oh-my-pi/pi-catalog/identity/family";
import type { MechFileEntry } from "./entries";

const DEFAULT_ACTIVITY_THRESHOLD_MS = 5_000;
const DEFAULT_STATUS_INTERVAL_MS = 1_000;
const TAIL_STATUS_BYTES = 32_768;
export const MAIN_AGENT_ID = "Main";

export type AgentStatus = "running" | "idle" | "parked" | "aborted";

export interface MechAgent {
	id: string;
	parentId: string | null;
	model: string;
	family: string;
	status: AgentStatus;
	depth: number;
	label: string;
	kind?: "main" | "sub" | "advisor";
}

export type MechEvent =
	| { t: "roster"; agents: MechAgent[] }
	| { t: "spawn"; agent: MechAgent }
	| { t: "status"; id: string; status: AgentStatus }
	| { t: "tool"; id: string; tool: string; phase: "start" | "update" | "end" }
	| { t: "irc"; from: string; to: string }
	| { t: "usage"; model: string; costUsd: number; tokensIn: number; tokensOut: number }
	| { t: "compaction"; id: string; phase: "start" | "end" }
	| { t: "retry"; id: string; phase: "start" | "end"; attempt?: number }
	| { t: "fallback"; id: string; fromModel: string; toModel: string }
	| { t: "thinking"; id: string; level: string }
	| { t: "notice"; id: string; level: "info" | "warning" | "error" };

export interface AgentFileSource {
	filePath: string;
	agentId: string;
	parentId: string | null;
	depth: number;
	isMain: boolean;
	mtimeMs?: number;
}

interface RuntimeAgentSourceFields {
	parentId?: string | null;
	model?: string;
	family?: string;
	status?: AgentStatus;
	depth?: number;
	label?: string;
	isMain?: boolean;
	kind?: "main" | "sub" | "advisor";
}

export type RuntimeAgentSource =
	| (RuntimeAgentSourceFields & { id: string; agentId?: string })
	| (RuntimeAgentSourceFields & { id?: string; agentId: string });

type RuntimeAgentEventExtras = Record<string, unknown>;

export type RuntimeAgentEvent =
	| ({ type: "agent_start" } & RuntimeAgentEventExtras)
	| ({ type: "agent_end"; messages?: unknown[]; telemetry?: unknown; coverage?: unknown } & RuntimeAgentEventExtras)
	| ({
			type: "tool_execution_start";
			toolCallId?: string;
			toolName: string;
			args?: unknown;
			intent?: string;
	  } & RuntimeAgentEventExtras)
	| ({
			type: "tool_execution_update";
			toolCallId?: string;
			toolName: string;
			args?: unknown;
			partialResult?: unknown;
	  } & RuntimeAgentEventExtras)
	| ({
			type: "tool_execution_end";
			toolCallId?: string;
			toolName: string;
			result?: unknown;
			isError?: boolean;
	  } & RuntimeAgentEventExtras);

export type StructuralAgentEvent = RuntimeAgentEvent;

export interface MechanismNormalizerOptions {
	activityThresholdMs?: number;
	statusIntervalMs?: number;
	now?: () => number;
}

interface AgentRecord {
	agent: MechAgent;
	filePath: string | null;
	lastAppendAt: number;
}

type StatusScanResult = AgentStatus | "unknown";
type MechEventListener = (event: MechEvent) => void;

interface UnknownObject {
	[key: string]: unknown;
}

function isObject(value: unknown): value is UnknownObject {
	return typeof value === "object" && value !== null;
}
function familyOf(model: string): string {
	return modelFamilyToken(model);
}

function cloneAgent(agent: MechAgent): MechAgent {
	return { ...agent };
}

function runtimeAgentId(source: RuntimeAgentSource): string {
	const id = source.id ?? source.agentId;
	if (!id) throw new Error("Runtime agent source requires id or agentId");
	return id;
}

function isMainRuntimeAgent(source: RuntimeAgentSource, id: string): boolean {
	return source.isMain === true || id === MAIN_AGENT_ID;
}

function agentMetadataChanged(previous: MechAgent, next: MechAgent): boolean {
	return (
		previous.parentId !== next.parentId ||
		previous.model !== next.model ||
		previous.family !== next.family ||
		previous.depth !== next.depth ||
		previous.label !== next.label ||
		previous.kind !== next.kind
	);
}

function isToolCallBlock(value: unknown): value is { type: "toolCall"; name: string } {
	return isObject(value) && value.type === "toolCall" && typeof value.name === "string";
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return isObject(value) && value.role === "assistant" && Array.isArray(value.content);
}

function isToolResultMessage(value: unknown): value is ToolResultMessage {
	return isObject(value) && value.role === "toolResult" && typeof value.toolName === "string";
}

function isNormalAssistantStop(message: AssistantMessage): boolean {
	if (message.errorMessage) return false;
	if (message.stopReason === "error" || message.stopReason === "aborted") return false;
	if (message.stopReason === "toolUse") return false;
	return !message.content.some(isToolCallBlock);
}

function statusFromMessage(message: unknown): StatusScanResult {
	if (isAssistantMessage(message)) {
		if (message.errorMessage || message.stopReason === "error" || message.stopReason === "aborted") {
			return "aborted";
		}
		return isNormalAssistantStop(message) ? "idle" : "running";
	}
	if (
		isObject(message) &&
		(message.role === "user" || message.role === "developer" || message.role === "toolResult")
	) {
		return "running";
	}
	return "unknown";
}

function eventListWith<T extends MechEvent>(events: MechEvent[], event: T | null): void {
	if (event) events.push(event);
}

function readIrcRelayDetails(details: unknown): { from: string; to: string } | null {
	if (!isObject(details)) return null;
	if (typeof details.from !== "string" || typeof details.to !== "string") return null;
	return { from: details.from, to: details.to };
}

function readJsonLine(line: string): unknown | null {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return null;
	}
}

function rosterSort(a: MechAgent, b: MechAgent): number {
	return a.depth - b.depth || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

export function deriveStatusFromTailText(suffix: string): StatusScanResult {
	if (!suffix) return "unknown";
	let sawSessionHeader = false;
	const lines = suffix.split("\n");

	for (let i = lines.length - 1; i >= 0; i--) {
		const rawLine = lines[i];
		if (!rawLine) continue;
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.charCodeAt(0) !== 123) continue;
		const entry = readJsonLine(line);
		if (!isObject(entry)) continue;
		if (entry.type === "message") return statusFromMessage(entry.message);
		if (entry.type === "session") sawSessionHeader = true;
	}

	return sawSessionHeader ? "running" : "unknown";
}

export async function deriveStatusFromTail(filePath: string): Promise<StatusScanResult> {
	let handle: fs.FileHandle | null = null;
	try {
		const stat = await fs.stat(filePath);
		const start = Math.max(0, stat.size - TAIL_STATUS_BYTES);
		const length = stat.size - start;
		if (length <= 0) return "unknown";
		handle = await fs.open(filePath, "r");
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		return deriveStatusFromTailText(buffer.subarray(0, bytesRead).toString("utf8"));
	} catch {
		return "unknown";
	} finally {
		await handle?.close();
	}
}

export class MechanismNormalizer {
	#agents = new Map<string, AgentRecord>();
	#listeners = new Set<MechEventListener>();
	#activityThresholdMs: number;
	#statusIntervalMs: number;
	#now: () => number;
	#statusTimer: NodeJS.Timeout | null = null;
	#checkingStatuses = false;

	constructor(options: MechanismNormalizerOptions = {}) {
		this.#activityThresholdMs = options.activityThresholdMs ?? DEFAULT_ACTIVITY_THRESHOLD_MS;
		this.#statusIntervalMs = options.statusIntervalMs ?? DEFAULT_STATUS_INTERVAL_MS;
		this.#now = options.now ?? Date.now;
	}

	onEvent(listener: MechEventListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	reset(): MechEvent[] {
		this.#agents.clear();
		return [this.snapshotRoster()];
	}

	startStatusPolling(): void {
		if (this.#statusTimer) return;
		this.#statusTimer = setInterval(() => {
			void this.checkStatuses();
		}, this.#statusIntervalMs);
		this.#statusTimer.unref?.();
	}

	stopStatusPolling(): void {
		if (!this.#statusTimer) return;
		clearInterval(this.#statusTimer);
		this.#statusTimer = null;
	}

	stop(): void {
		this.stopStatusPolling();
		this.#listeners.clear();
	}

	snapshotRoster(): MechEvent {
		return { t: "roster", agents: this.#snapshotAgents() };
	}

	pushRoster(agents: RuntimeAgentSource[], observedAt = this.#now()): MechEvent[] {
		this.#agents.clear();
		for (const source of agents) {
			const agent = this.#runtimeAgentFromSource(source);
			this.#agents.set(agent.id, { agent, filePath: null, lastAppendAt: observedAt });
		}
		return [this.snapshotRoster()];
	}

	pushAgent(agent: RuntimeAgentSource, observedAt = this.#now()): MechEvent[] {
		return this.#upsertRuntimeAgent(agent, observedAt);
	}

	removeAgent(agentId: string): MechEvent[] {
		if (!this.#agents.has(agentId)) return [];
		const removeIds = new Set<string>([agentId]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const [id, record] of this.#agents) {
				const parentId = record.agent.parentId;
				if (parentId && removeIds.has(parentId) && !removeIds.has(id)) {
					removeIds.add(id);
					changed = true;
				}
			}
		}
		for (const id of removeIds) this.#agents.delete(id);
		return [this.snapshotRoster()];
	}

	pushStatus(agentId: string, status: AgentStatus, observedAt = this.#now()): MechEvent[] {
		const events = this.#upsertRuntimeAgent({ id: agentId, status }, observedAt);
		const record = this.#agents.get(agentId);
		if (record && status === "running") record.lastAppendAt = Math.max(record.lastAppendAt, observedAt);
		eventListWith(events, this.#setStatus(agentId, status));
		return events;
	}

	pushEntry(agent: RuntimeAgentSource, entry: MechFileEntry, observedAt = this.#now()): MechEvent[] {
		const events = this.#upsertRuntimeAgent(agent, observedAt);
		events.push(...this.#eventsFromEntry(runtimeAgentId(agent), entry, observedAt));
		return events;
	}

	pushAgentEvent(agentId: string, event: RuntimeAgentEvent, observedAt = this.#now()): MechEvent[] {
		switch (event.type) {
			case "agent_start":
				return this.pushStatus(agentId, "running", observedAt);
			case "agent_end":
				return this.pushStatus(agentId, "idle", observedAt);
			case "tool_execution_start": {
				const events = this.pushStatus(agentId, "running", observedAt);
				events.push({ t: "tool", id: agentId, tool: event.toolName, phase: "start" });
				return events;
			}
			case "tool_execution_update": {
				const events = this.pushStatus(agentId, "running", observedAt);
				events.push({ t: "tool", id: agentId, tool: event.toolName, phase: "update" });
				return events;
			}
			case "tool_execution_end": {
				const events = this.#upsertRuntimeAgent({ id: agentId }, observedAt);
				events.push({ t: "tool", id: agentId, tool: event.toolName, phase: "end" });
				return events;
			}
		}
		return [];
	}

	pushIrc(from: string, to: string): MechEvent[] {
		return [{ t: "irc", from, to }];
	}

	registerAgentFile(source: AgentFileSource): MechEvent[] {
		const existing = this.#agents.get(source.agentId);
		if (existing) {
			existing.filePath = source.filePath;
			existing.agent.parentId = source.parentId;
			existing.agent.depth = source.depth;
			if (source.mtimeMs !== undefined) existing.lastAppendAt = source.mtimeMs;
			return [];
		}

		const now = this.#now();
		const lastAppendAt = source.mtimeMs ?? now;
		const status: AgentStatus = now - lastAppendAt <= this.#activityThresholdMs ? "running" : "idle";
		const agent: MechAgent = {
			id: source.agentId,
			parentId: source.parentId,
			model: "",
			family: "",
			status,
			depth: source.depth,
			label: source.agentId,
		};
		this.#agents.set(source.agentId, { agent, filePath: source.filePath, lastAppendAt });

		if (source.isMain) return [this.snapshotRoster()];
		return [{ t: "spawn", agent: cloneAgent(agent) }];
	}

	processEntry(source: AgentFileSource, entry: MechFileEntry, observedAt = this.#now()): MechEvent[] {
		const events: MechEvent[] = [];
		events.push(...this.registerAgentFile({ ...source, mtimeMs: source.mtimeMs ?? observedAt }));
		events.push(...this.#eventsFromEntry(source.agentId, entry, observedAt));
		return events;
	}

	#runtimeAgentFromSource(source: RuntimeAgentSource): MechAgent {
		const id = runtimeAgentId(source);
		const existing = this.#agents.get(id);
		const parentId = source.parentId !== undefined ? source.parentId : (existing?.agent.parentId ?? null);
		const parent = parentId ? this.#agents.get(parentId) : undefined;
		const model = source.model ?? existing?.agent.model ?? "";
		const existingFamily = existing?.agent.family ?? (model ? familyOf(model) : "");
		const family = source.family ?? (source.model !== undefined ? (model ? familyOf(model) : "") : existingFamily);
		return {
			id,
			parentId,
			model,
			family,
			status: source.status ?? existing?.agent.status ?? "running",
			depth: source.depth ?? existing?.agent.depth ?? (parent ? parent.agent.depth + 1 : parentId ? 1 : 0),
			label: source.label ?? existing?.agent.label ?? id,
			kind: source.kind ?? existing?.agent.kind,
		};
	}

	#upsertRuntimeAgent(source: RuntimeAgentSource, observedAt: number): MechEvent[] {
		const agent = this.#runtimeAgentFromSource(source);
		const existing = this.#agents.get(agent.id);
		if (!existing) {
			this.#agents.set(agent.id, { agent, filePath: null, lastAppendAt: observedAt });
			if (isMainRuntimeAgent(source, agent.id)) return [this.snapshotRoster()];
			return [{ t: "spawn", agent: cloneAgent(agent) }];
		}

		const previous = cloneAgent(existing.agent);
		existing.agent = agent;
		existing.filePath = null;
		existing.lastAppendAt = Math.max(existing.lastAppendAt, observedAt);
		if (agentMetadataChanged(previous, agent)) return [this.snapshotRoster()];
		if (previous.status !== agent.status) return [{ t: "status", id: agent.id, status: agent.status }];
		return [];
	}

	#eventsFromEntry(agentId: string, entry: MechFileEntry, observedAt: number): MechEvent[] {
		const events: MechEvent[] = [];
		eventListWith(events, this.#touchAgent(agentId, observedAt));

		switch (entry.type) {
			case "session":
				break;
			case "session_init":
				break;
			case "model_change":
				eventListWith(events, this.#setModel(agentId, entry.model));
				break;
			case "custom_message":
				if (entry.customType === "irc:relay") {
					const details = readIrcRelayDetails(entry.details);
					if (details) events.push({ t: "irc", from: details.from, to: details.to });
				}
				break;
			case "message":
				events.push(...this.#eventsFromMessage(agentId, entry.message));
				break;
		}

		return events;
	}

	async checkStatuses(): Promise<MechEvent[]> {
		if (this.#checkingStatuses) return [];
		this.#checkingStatuses = true;
		const events: MechEvent[] = [];
		try {
			const now = this.#now();
			for (const record of this.#agents.values()) {
				const nextStatus = await this.#deriveStatus(record, now);
				eventListWith(events, this.#setStatus(record.agent.id, nextStatus));
			}
		} finally {
			this.#checkingStatuses = false;
		}
		this.#emit(events);
		return events;
	}

	#eventsFromMessage(agentId: string, message: unknown): MechEvent[] {
		const events: MechEvent[] = [];
		if (isAssistantMessage(message)) {
			eventListWith(events, this.#setModel(agentId, message.model));
			for (const block of message.content) {
				if (isToolCallBlock(block)) events.push({ t: "tool", id: agentId, tool: block.name, phase: "start" });
			}
			events.push({
				t: "usage",
				model: message.model,
				costUsd: message.usage.cost.total,
				tokensIn: message.usage.input,
				tokensOut: message.usage.output,
			});
			return events;
		}

		if (isToolResultMessage(message)) {
			events.push({ t: "tool", id: agentId, tool: message.toolName, phase: "end" });
		}
		return events;
	}

	#touchAgent(agentId: string, observedAt: number): MechEvent | null {
		const record = this.#agents.get(agentId);
		if (!record) return null;
		record.lastAppendAt = Math.max(record.lastAppendAt, observedAt);
		if (this.#now() - observedAt > this.#activityThresholdMs) return null;
		return this.#setStatus(agentId, "running");
	}

	#setModel(agentId: string, model: string): MechEvent | null {
		const record = this.#agents.get(agentId);
		if (!record || record.agent.model === model) return null;
		record.agent.model = model;
		record.agent.family = familyOf(model);
		return this.snapshotRoster();
	}

	#setStatus(agentId: string, status: AgentStatus): MechEvent | null {
		const record = this.#agents.get(agentId);
		if (!record || record.agent.status === status) return null;
		record.agent.status = status;
		return { t: "status", id: agentId, status };
	}

	async #deriveStatus(record: AgentRecord, now: number): Promise<AgentStatus> {
		if (record.agent.parentId) {
			const parent = this.#agents.get(record.agent.parentId);
			if (parent?.agent.status === "aborted") return "aborted";
		}
		if (now - record.lastAppendAt <= this.#activityThresholdMs) return "running";
		if (!record.filePath) return record.agent.status;
		const scanned = await deriveStatusFromTail(record.filePath);
		if (scanned === "unknown") return record.agent.status;
		return scanned;
	}

	#snapshotAgents(): MechAgent[] {
		return Array.from(this.#agents.values(), record => cloneAgent(record.agent)).sort(rosterSort);
	}

	#emit(events: MechEvent[]): void {
		if (events.length === 0) return;
		const listeners = Array.from(this.#listeners);
		for (const event of events) {
			for (const listener of listeners) listener(event);
		}
	}

	pushCompaction(agentId: string, phase: "start" | "end"): MechEvent[] {
		const events = this.pushStatus(agentId, "running");
		events.push({ t: "compaction", id: agentId, phase });
		return events;
	}

	pushRetry(agentId: string, phase: "start" | "end", attempt?: number): MechEvent[] {
		const events = this.pushStatus(agentId, "running");
		events.push({ t: "retry", id: agentId, phase, ...(attempt !== undefined && { attempt }) });
		return events;
	}

	pushFallback(agentId: string, fromModel: string, toModel: string): MechEvent[] {
		const events: MechEvent[] = [{ t: "fallback", id: agentId, fromModel, toModel }];
		// Also update the agent's model
		const modelEvents = this.pushAgent({ id: agentId, model: toModel });
		events.push(...modelEvents);
		return events;
	}

	pushThinking(agentId: string, level: string): MechEvent[] {
		return [{ t: "thinking", id: agentId, level }];
	}

	pushNotice(agentId: string, level: "info" | "warning" | "error"): MechEvent[] {
		return [{ t: "notice", id: agentId, level }];
	}
}

export interface MockFeed {
	subscribe(listener: MechEventListener): () => void;
	start(): void;
	stop(): void;
	snapshot(): MechEvent;
}

export interface MockFeedOptions {
	intervalMs?: number;
	loop?: boolean;
}

class ScriptedMockFeed implements MockFeed {
	#listeners = new Set<MechEventListener>();
	#events: MechEvent[];
	#timer: NodeJS.Timeout | null = null;
	#index = 0;
	#intervalMs: number;
	#loop: boolean;

	constructor(events: MechEvent[], options: MockFeedOptions) {
		this.#events = events;
		this.#intervalMs = options.intervalMs ?? 650;
		this.#loop = options.loop ?? true;
	}

	subscribe(listener: MechEventListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	start(): void {
		if (this.#timer) return;
		this.#emit(this.#events[0]);
		this.#index = 1;
		this.#timer = setInterval(() => this.#tick(), this.#intervalMs);
		this.#timer.unref?.();
	}

	stop(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = null;
	}

	snapshot(): MechEvent {
		return this.#events[0];
	}

	#tick(): void {
		if (this.#index >= this.#events.length) {
			if (!this.#loop) {
				this.stop();
				return;
			}
			this.#index = 1;
		}
		this.#emit(this.#events[this.#index]);
		this.#index += 1;
	}

	#emit(event: MechEvent): void {
		for (const listener of Array.from(this.#listeners)) listener(event);
	}
}

export function createMockFeed(options: MockFeedOptions = {}): MockFeed {
	const agents: MechAgent[] = [
		{
			id: MAIN_AGENT_ID,
			parentId: null,
			model: "openrouter/openai/gpt-5.5",
			family: "openai",
			status: "running",
			depth: 0,
			label: MAIN_AGENT_ID,
		},
	];
	const scout: MechAgent = {
		id: "SchemaScout",
		parentId: MAIN_AGENT_ID,
		model: "openrouter/anthropic/claude-sonnet-4.5",
		family: "anthropic",
		status: "running",
		depth: 1,
		label: "SchemaScout",
	};
	return new ScriptedMockFeed(
		[
			{ t: "roster", agents },
			{ t: "spawn", agent: scout },
			{ t: "tool", id: MAIN_AGENT_ID, tool: "read", phase: "start" },
			{ t: "usage", model: "openrouter/openai/gpt-5.5", costUsd: 0.0132, tokensIn: 1840, tokensOut: 392 },
			{ t: "compaction", id: MAIN_AGENT_ID, phase: "start" },
			{ t: "irc", from: "SchemaScout", to: MAIN_AGENT_ID },
			{ t: "compaction", id: MAIN_AGENT_ID, phase: "end" },
			{ t: "retry", id: "SchemaScout", phase: "start", attempt: 1 },
			{ t: "retry", id: "SchemaScout", phase: "end", attempt: 1 },
			{
				t: "fallback",
				id: "SchemaScout",
				fromModel: "openrouter/anthropic/claude-sonnet-4.5",
				toModel: "openrouter/openai/gpt-5.5",
			},
			{ t: "tool", id: MAIN_AGENT_ID, tool: "read", phase: "end" },
			{ t: "status", id: "SchemaScout", status: "idle" },
			{ t: "status", id: MAIN_AGENT_ID, status: "idle" },
		],
		options,
	);
}
