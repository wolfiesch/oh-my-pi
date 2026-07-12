import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { entryId, hostId, parseBounded, projectId, sessionId } from "@oh-my-pi/app-wire";
import type { DurableEntry, EntryId, HostId, ProjectId, SessionId } from "@oh-my-pi/app-wire";
import type { FileSystem, SessionDiscovery, SessionRecord } from "./types.ts";

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 1000;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_SNAPSHOT_NODES = 16_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const realFs: FileSystem = {
	mkdir: async (path, options) => {
		await mkdir(path, options);
	},
	chmod: async (path, mode) => {
		await chmod(path, mode);
	},
	unlink: async path => {
		try {
			await unlink(path);
		} catch {}
	},
	stat: async path => await stat(path),
	readdir: async path => (await readdir(path, { withFileTypes: true })).map(entry => join(path, entry.name)),
	readFile: async path => await readFile(path),
};

function boundUtf8(value: string, maxBytes: number): string {
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return decoder.decode(bytes.slice(0, end));
}

function redactString(value: string): string {
	return value
		.replace(/(?<![:/A-Za-z0-9_])\/(?:[^\s"'`/]+\/)+[^\s"'`]+/g, "[path]")
		.replace(/(?:\/(?:home|tmp|var|root|Users|private|workspace)\/[^\s"'`]+|[A-Za-z]:\\[^\s"'`]+)/g, "[path]")
		.replace(
			/\b(token|password|passwd|secret|credential|authorization|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
			"$1=[redacted]",
		)
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
}

export function cleanText(value: string, maxBytes: number, collapseWhitespace = false): string {
	const withoutControls = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
	const normalized = collapseWhitespace ? withoutControls.replace(/\s+/gu, " ").trim() : withoutControls;
	return boundUtf8(redactString(normalized), maxBytes);
}

function isSensitiveKey(key: string): boolean {
	return /(?:secret|token|password|api[_-]?key|authorization|cookie|credential|auth)/iu.test(key);
}

function safeValue(value: unknown, key = "", depth = 0): unknown {
	if (isSensitiveKey(key)) return "[redacted]";
	if (depth >= 8) return "[omitted]";
	if (typeof value === "string") return cleanText(value, MAX_TEXT_BYTES);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) return value.slice(0, 64).map(item => safeValue(item, "", depth + 1));
	if (typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const [name, item] of Object.entries(value).slice(0, 64)) {
			if (isSensitiveKey(name)) continue;
			output[name] = safeValue(item, name, depth + 1);
		}
		return output;
	}
	return undefined;
}
function jsonNodeCount(value: unknown): number {
	if (value === null || typeof value !== "object") return 1;
	if (Array.isArray(value)) return 1 + value.reduce((count, item) => count + jsonNodeCount(item), 0);
	return 1 + Object.values(value).reduce((count, item) => count + jsonNodeCount(item), 0);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return cleanText(content, MAX_TEXT_BYTES);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		const block = asObject(item);
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return cleanText(parts.join(""), MAX_TEXT_BYTES);
}

function basename(cwd: string): string {
	const pieces = cwd.replace(/[\\/]+$/u, "").split(/[\\/]/u);
	return cleanText(pieces.at(-1) ?? "", 256, true);
}

function uniqueEntryId(base: string, used: Set<string>): EntryId {
	const first = entryId(boundUtf8(base, 256));
	if (!used.has(first)) return first;
	const suffix = createHash("sha256").update(base).digest("hex").slice(0, 16);
	return entryId(`snapshot-${suffix}-${used.size}`);
}

type ProjectionMode = "batch" | "live";

interface PendingToolCall {
	callId: string;
	tool: string;
	title: string;
	args: unknown;
	parentId: EntryId | null;
	idBase: string;
	timestamp: string;
}

interface ProjectedToolResult {
	ok: boolean;
	text: string;
	timestamp: string;
}

function validRawEntry(raw: Record<string, unknown>): boolean {
	return (
		typeof raw.id === "string" &&
		Boolean(raw.id) &&
		typeof raw.type === "string" &&
		Boolean(raw.type) &&
		(raw.parentId === undefined || raw.parentId === null || typeof raw.parentId === "string") &&
		typeof raw.timestamp === "string" &&
		Number.isFinite(Date.parse(raw.timestamp))
	);
}

export class SessionEntryProjector {
	readonly entries: DurableEntry[] = [];
	readonly mode: ProjectionMode;
	#host: HostId;
	#session: SessionId;
	#aliases = new Map<string, EntryId | null>();
	#pendingCalls = new Map<string, PendingToolCall>();
	#pendingResults = new Map<string, ProjectedToolResult>();
	#settledCalls = new Set<string>();
	#usedIds = new Set<string>();
	#firstUserText?: string;
	#titleChange?: string;
	#model?: string;
	#thinking?: string;
	#knownEntryIds = new Set<string>();

	constructor(host: HostId, session: SessionId, mode: ProjectionMode, knownEntries: readonly DurableEntry[] = []) {
		this.#host = host;
		this.#session = session;
		this.mode = mode;
		for (const entry of knownEntries) this.#knownEntryIds.add(entry.id);
	}

	get firstUserText(): string | undefined {
		return this.#firstUserText;
	}
	get titleChange(): string | undefined {
		return this.#titleChange;
	}
	get model(): string | undefined {
		return this.#model;
	}
	get thinking(): string | undefined {
		return this.#thinking;
	}

	#resolveParent(raw: unknown): EntryId | null {
		if (typeof raw !== "string") return null;
		const seen = new Set<string>();
		let current: string | undefined = raw;
		while (current && !seen.has(current)) {
			seen.add(current);
			const alias = this.#aliases.get(current);
			if (alias === undefined) {
				try {
					const known = entryId(current);
					return this.#knownEntryIds.has(known) ? known : null;
				} catch {
					return null;
				}
			}
			if (alias !== null) return alias;
			current = undefined;
		}
		return null;
	}

	#add(
		raw: Record<string, unknown>,
		kind: string,
		data: Record<string, unknown>,
		parentId: EntryId | null,
		idBase = String(raw.id),
	): DurableEntry {
		const id = uniqueEntryId(idBase, this.#usedIds);
		this.#usedIds.add(id);
		const entry: DurableEntry = {
			id,
			parentId,
			hostId: this.#host,
			sessionId: this.#session,
			kind,
			timestamp: String(raw.timestamp),
			data,
		};
		this.entries.push(entry);
		return entry;
	}

	#tool(raw: Record<string, unknown>, call: PendingToolCall, result: ProjectedToolResult): DurableEntry {
		return this.#add(
			{ ...raw, timestamp: result.timestamp },
			"tool-use",
			{
				toolCallId: call.callId,
				tool: call.tool,
				title: call.title,
				args: call.args,
				ok: result.ok,
				result: { output: boundUtf8(result.text, MAX_RESULT_BYTES) },
			},
			call.parentId,
			call.idBase,
		);
	}

	#rememberUserText(role: string, text: string): void {
		if (role === "user" && text && this.#firstUserText === undefined) this.#firstUserText = text;
	}

	project(raw: Record<string, unknown>): DurableEntry[] {
		if (!validRawEntry(raw)) return [];
		const before = this.entries.length;
		const parentId = this.#resolveParent(raw.parentId);
		const nested = asObject(raw.message);
		const message = nested ?? raw;
		const role =
			typeof message.role === "string"
				? message.role
				: raw.type === "message" && typeof raw.text === "string"
					? "assistant"
					: raw.type === "message" && typeof raw.message === "string"
						? "user"
						: undefined;

		if (raw.type === "message" && (role === "user" || role === "assistant")) {
			const content = message.content ?? message.text ?? (nested ? message.message : (raw.text ?? raw.message));
			const text = contentText(content);
			const reasoningParts: string[] = [];
			const toolCalls: PendingToolCall[] = [];
			if (role === "assistant" && Array.isArray(message.content)) {
				for (const item of message.content) {
					const block = asObject(item);
					if (block?.type === "thinking" && typeof block.thinking === "string")
						reasoningParts.push(block.thinking);
					if (block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
						const args = safeValue(block.arguments ?? block.args ?? {});
						const argsBytes = encoder.encode(JSON.stringify(args) ?? "").byteLength;
						toolCalls.push({
							callId: block.id,
							tool: cleanText(block.name, 256, true),
							title:
								typeof block.title === "string"
									? cleanText(block.title, 256, true)
									: cleanText(block.name, 256, true),
							args:
								argsBytes <= MAX_ARGUMENT_BYTES
									? args
									: { omitted: "Tool arguments exceeded the app-wire display budget." },
							parentId: null,
							idBase: `${raw.id}:tool:${block.id}`,
							timestamp: String(raw.timestamp),
						});
					}
				}
			}
			const reasoning = cleanText(reasoningParts.join(""), MAX_TEXT_BYTES);
			const messageEntry =
				text || reasoning || role === "user"
					? this.#add(raw, "message", { role, text, ...(reasoning ? { reasoning } : {}) }, parentId)
					: undefined;
			this.#rememberUserText(role, text);
			const alias = messageEntry?.id ?? parentId;
			this.#aliases.set(String(raw.id), alias);
			for (const call of toolCalls) {
				call.parentId = alias;
				this.#pendingCalls.set(call.callId, call);
				const pending = this.#pendingResults.get(call.callId);
				if (pending) {
					this.#tool(raw, call, pending);
					this.#pendingResults.delete(call.callId);
					this.#pendingCalls.delete(call.callId);
					this.#settledCalls.add(call.callId);
				}
			}
		} else if (raw.type === "message" && role === "toolResult") {
			const callId =
				typeof message.toolCallId === "string"
					? message.toolCallId
					: typeof raw.toolCallId === "string"
						? raw.toolCallId
						: undefined;
			if (callId && !this.#settledCalls.has(callId)) {
				const result: ProjectedToolResult = {
					ok: message.isError !== true,
					text: contentText(message.content ?? message.text ?? raw.text),
					timestamp: String(raw.timestamp),
				};
				const call = this.#pendingCalls.get(callId);
				if (call) {
					this.#tool(raw, call, result);
					this.#pendingCalls.delete(callId);
					this.#settledCalls.add(callId);
				} else {
					this.#pendingResults.set(callId, result);
				}
			}
			this.#aliases.set(String(raw.id), parentId);
		} else if (raw.type === "custom_message" && raw.display === true) {
			const text = contentText(raw.content ?? raw.text);
			const customRole = raw.attribution === "agent" ? "assistant" : "user";
			const entry = this.#add(raw, "message", { role: customRole, text }, parentId);
			this.#aliases.set(String(raw.id), entry.id);
			this.#rememberUserText(customRole, text);
		} else if (raw.type === "compaction" && typeof raw.summary === "string") {
			const entry = this.#add(
				raw,
				"compaction",
				{
					summary: cleanText(raw.summary, MAX_RESULT_BYTES),
					...(typeof raw.shortSummary === "string"
						? { shortSummary: cleanText(raw.shortSummary, MAX_TEXT_BYTES) }
						: {}),
				},
				parentId,
			);
			this.#aliases.set(String(raw.id), entry.id);
		} else {
			if (raw.type === "title_change" && typeof raw.title === "string" && cleanText(raw.title, 512, true))
				this.#titleChange = cleanText(raw.title, 512, true);
			if (raw.type === "model_change" && typeof raw.model === "string" && cleanText(raw.model, 256, true))
				this.#model = cleanText(raw.model, 256, true);
			if (raw.type === "thinking_level_change") {
				const candidate = typeof raw.configured === "string" ? raw.configured : raw.thinkingLevel;
				if (typeof candidate === "string" && cleanText(candidate, 256, true))
					this.#thinking = cleanText(candidate, 256, true);
			}
			this.#aliases.set(String(raw.id), parentId);
		}
		return this.entries.slice(before);
	}

	finish(): DurableEntry[] {
		const before = this.entries.length;
		if (this.mode === "batch") {
			for (const call of this.#pendingCalls.values()) {
				this.#tool({ id: call.idBase, timestamp: call.timestamp }, call, {
					ok: false,
					text: "",
					timestamp: call.timestamp,
				});
				this.#settledCalls.add(call.callId);
			}
		}
		this.#pendingCalls.clear();
		this.#pendingResults.clear();
		return this.entries.slice(before);
	}
}

function normalizeEntries(
	values: Record<string, unknown>[],
	host: HostId,
	sid: SessionId,
	headerTimestamp: string,
): {
	entries: DurableEntry[];
	firstUserText?: string;
	titleChange?: string;
	model?: string;
	thinking?: string;
} {
	const projector = new SessionEntryProjector(host, sid, "batch");
	for (const raw of values) {
		if (!validRawEntry(raw)) throw new Error("invalid transcript entry");
		entryId(String(raw.id));
		projector.project(raw);
	}
	projector.finish();
	const entries = projector.entries;
	const retainedReverse: DurableEntry[] = [];
	let payloadBytes = 2;
	let payloadNodes = 1;
	for (let i = entries.length - 1; i >= 0 && retainedReverse.length < MAX_SNAPSHOT_ENTRIES - 1; i--) {
		const entryBytes = encoder.encode(JSON.stringify(entries[i])).byteLength;
		const entryNodes = jsonNodeCount(entries[i]);
		const separatorBytes = retainedReverse.length === 0 ? 0 : 1;
		if (
			payloadBytes + separatorBytes + entryBytes > MAX_SNAPSHOT_BYTES ||
			payloadNodes + entryNodes > MAX_SNAPSHOT_NODES
		) {
			if (retainedReverse.length === 0) continue;
			break;
		}
		retainedReverse.push(entries[i]);
		payloadBytes += separatorBytes + entryBytes;
		payloadNodes += entryNodes;
	}
	const retained = retainedReverse.reverse();
	const omitted = entries.length - retained.length;
	if (omitted === 0)
		return {
			entries: retained,
			firstUserText: projector.firstUserText,
			titleChange: projector.titleChange,
			model: projector.model,
			thinking: projector.thinking,
		};
	const retainedIds = new Set(retained.map(entry => entry.id));
	for (let i = 0; i < retained.length; i++) {
		const parentId = retained[i].parentId;
		if (parentId && !retainedIds.has(parentId)) retained[i] = { ...retained[i], parentId: null };
	}
	const noticeTimestamp = retained[0]?.timestamp ?? headerTimestamp;
	const noticeId = uniqueEntryId(`snapshot-truncation-${sid}`, new Set(retained.map(entry => entry.id)));
	retained.unshift({
		id: noticeId,
		parentId: null,
		hostId: host,
		sessionId: sid,
		kind: "compaction",
		timestamp: noticeTimestamp,
		data: { summary: `Older transcript entries were omitted from this snapshot (${omitted} entries).`, omitted },
	});
	return {
		entries: retained,
		firstUserText: projector.firstUserText,
		titleChange: projector.titleChange,
		model: projector.model,
		thinking: projector.thinking,
	};
}

export function stableProjectId(cwd: string): ProjectId {
	let canonical = resolve(cwd);
	try {
		canonical = realpathSync.native(canonical);
	} catch {}
	return projectId(`project-${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`);
}

function fallbackTitle(firstUserText: string | undefined): string | undefined {
	if (!firstUserText) return undefined;
	const lines = firstUserText.split(/\r?\n/u);
	const wrapper = /^Complete the assignment below,\s*thoroughly:\s*$/iu.test(lines[0]?.trim() ?? "");
	const changeIndex = wrapper ? lines.findIndex(line => /^#{1,6}\s*change\s*$/iu.test(line.trim())) : -1;
	const candidates = wrapper ? lines.slice(changeIndex >= 0 ? changeIndex + 1 : 1) : lines;
	for (const line of candidates) {
		const trimmed = line.trim();
		if (!trimmed || /^#{1,6}(?:\s|$)/u.test(trimmed)) continue;
		return cleanText(trimmed.replace(/^\d+[.)]\s*/u, ""), 120, true) || undefined;
	}
	return undefined;
}

function parseTranscript(input: string | Uint8Array, path: string, host: HostId): SessionRecord {
	const bytes = typeof input === "string" ? encoder.encode(input).byteLength : input.byteLength;
	if (bytes > MAX_TRANSCRIPT_BYTES) throw new Error("transcript exceeds limit");
	const lines: Array<string | Uint8Array> = [];
	if (typeof input === "string") {
		for (const line of input.split(/\r?\n/).filter(Boolean)) lines.push(line);
	} else {
		let start = 0;
		for (let i = 0; i <= input.byteLength; i++)
			if (i === input.byteLength || input[i] === 10) {
				const line = input.slice(start, i);
				if (line.byteLength) lines.push(line);
				start = i + 1;
			}
	}
	if (!lines.length) throw new Error("empty transcript");
	const values = lines.map(line => {
		if ((typeof line === "string" ? encoder.encode(line).byteLength : line.byteLength) > MAX_LINE_BYTES)
			throw new Error("transcript line exceeds limit");
		const value = parseBounded(line);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid transcript entry");
		return value as Record<string, unknown>;
	});
	let headerIndex = 0;
	const first = values[0];
	const fixedTitle =
		first.type === "title" && first.v === 1 && typeof first.title === "string"
			? cleanText(first.title, 512, true)
			: undefined;
	if (first.type === "title") {
		if (first.v !== 1 || typeof first.title !== "string") throw new Error("invalid transcript prelude");
		headerIndex = 1;
	}
	const header = values[headerIndex];
	if (
		!header ||
		header.type !== "session" ||
		typeof header.id !== "string" ||
		!header.id ||
		typeof header.cwd !== "string" ||
		!header.cwd ||
		typeof header.timestamp !== "string" ||
		!Number.isFinite(Date.parse(header.timestamp))
	)
		throw new Error("invalid transcript header");
	const sid = sessionId(header.id);
	const cwd = resolve(header.cwd);
	const normalized = normalizeEntries(values.slice(headerIndex + 1), host, sid, header.timestamp);
	const sessionTitle = typeof header.title === "string" ? cleanText(header.title, 512, true) : undefined;
	const title =
		fixedTitle || normalized.titleChange || sessionTitle || fallbackTitle(normalized.firstUserText) || "Untitled";
	return {
		sessionId: sid,
		path,
		cwd,
		projectId: stableProjectId(cwd),
		projectName: basename(cwd),
		title: cleanText(title, 512, true) || "Untitled",
		updatedAt: "",
		status: "idle",
		...(normalized.model ? { model: normalized.model } : {}),
		...(normalized.thinking ? { thinking: normalized.thinking } : {}),
		entries: normalized.entries,
	};
}

interface FileIndexEntry {
	readonly signature: string;
	readonly record: SessionRecord;
}

export function compareSessionRecords(a: SessionRecord, b: SessionRecord): number {
	if (a.updatedAt < b.updatedAt) return 1;
	if (a.updatedAt > b.updatedAt) return -1;
	if (a.sessionId < b.sessionId) return -1;
	if (a.sessionId > b.sessionId) return 1;
	return 0;
}

export class FileSessionDiscovery implements SessionDiscovery {
	private readonly index = new Map<string, FileIndexEntry>();

	constructor(
		private readonly root: string,
		private readonly fs: FileSystem = realFs,
		private readonly host: HostId = hostId("discovery"),
	) {}
	private async files(path: string): Promise<string[]> {
		const children = await this.fs.readdir(path);
		const output: string[] = [];
		for (const child of children.sort()) {
			let info;
			try {
				info = await this.fs.stat(child);
			} catch {
				continue;
			}
			if (info.isDirectory()) output.push(...(await this.files(child)));
			else if (info.isFile() && child.endsWith(".jsonl")) output.push(child);
		}
		return output;
	}
	async list(): Promise<SessionRecord[]> {
		let files: string[];
		try {
			files = await this.files(this.root);
		} catch {
			return [];
		}
		const found: SessionRecord[] = [];
		const seen = new Set<string>();
		files.sort();
		for (const path of files) {
			let identity: string;
			try {
				identity = realpathSync.native(path);
			} catch {
				identity = resolve(path);
			}
			if (seen.has(identity)) continue;
			seen.add(identity);
			try {
				const fileStat = await this.fs.stat(path);
				if (fileStat.size > MAX_TRANSCRIPT_BYTES) {
					this.index.delete(identity);
					continue;
				}
				const signature = `${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ctimeMs ?? ""}:${fileStat.dev ?? ""}:${fileStat.ino ?? ""}`;
				const cached = this.index.get(identity);
				let record = cached?.signature === signature ? cached.record : undefined;
				if (!record) {
					record = parseTranscript(await this.fs.readFile(path), path, this.host);
					record.updatedAt = new Date(fileStat.mtimeMs).toISOString();
					this.index.set(identity, { signature, record });
				} else if (record.path !== path) {
					record = { ...record, path };
					this.index.set(identity, { signature, record });
				}
				found.push(record);
			} catch {
				this.index.delete(identity);
			}
		}
		for (const identity of this.index.keys()) if (!seen.has(identity)) this.index.delete(identity);
		found.sort(compareSessionRecords);
		return found;
	}
}
export { realFs };
