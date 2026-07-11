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
  mkdir: async (path, options) => { await mkdir(path, options); },
  chmod: async (path, mode) => { await chmod(path, mode); },
  unlink: async path => { try { await unlink(path); } catch {} },
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
    .replace(/(?:\/(?:home|tmp|var|root|Users|private|workspace)\/[^\s"'`]+|[A-Za-z]:\\[^\s"'`]+)/g, "[path]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
}

function cleanText(value: string, maxBytes: number, collapseWhitespace = false): string {
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
    for (const [name, item] of Object.entries(value).slice(0, 64)) output[name] = safeValue(item, name, depth + 1);
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
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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

interface ToolResultProjection { ok: boolean; text: string }

function normalizeEntries(values: Record<string, unknown>[], host: HostId, sid: SessionId, headerTimestamp: string): {
  entries: DurableEntry[];
  firstUserText?: string;
  titleChange?: string;
  model?: string;
  thinking?: string;
} {
  const entries: DurableEntry[] = [];
  const aliases = new Map<string, EntryId | null>();
  const toolRows = new Map<string, { index: number; id: EntryId }>();
  const pendingResults = new Map<string, ToolResultProjection>();
  const usedIds = new Set<string>();
  let firstUserText: string | undefined;
  let titleChange: string | undefined;
  let model: string | undefined;
  let thinking: string | undefined;

  const resolveParent = (raw: unknown): EntryId | null => {
    if (typeof raw !== "string") return null;
    const seen = new Set<string>();
    let current: string | undefined = raw;
    while (current && !seen.has(current)) {
      seen.add(current);
      const alias = aliases.get(current);
      if (alias === undefined) return null;
      if (alias !== null) return alias;
      current = undefined;
    }
    return null;
  };
  const add = (raw: Record<string, unknown>, kind: string, data: Record<string, unknown>, parentId: EntryId | null, idBase = String(raw.id)): EntryId => {
    const id = uniqueEntryId(idBase, usedIds);
    usedIds.add(id);
    entries.push({ id, parentId, hostId: host, sessionId: sid, kind, timestamp: String(raw.timestamp), data });
    return id;
  };

  for (const raw of values) {
    if (typeof raw.id !== "string" || !raw.id || typeof raw.type !== "string" || !raw.type || (raw.parentId !== null && typeof raw.parentId !== "string") || typeof raw.timestamp !== "string" || !Number.isFinite(Date.parse(raw.timestamp))) throw new Error("invalid transcript entry");
    entryId(raw.id);
    const parentId = resolveParent(raw.parentId);
    const message = asObject(raw.message) ?? raw;
    const role = typeof message.role === "string" ? message.role : raw.type === "message" && typeof raw.message === "string" ? "user" : undefined;
    if (raw.type === "message" && (role === "user" || role === "assistant")) {
      const text = contentText(message.content ?? message.message);
      const reasoningParts: string[] = [];
      const toolCalls: Array<{ id: string; name: string; title: string; args: unknown }> = [];
      if (role === "assistant" && Array.isArray(message.content)) {
        for (const item of message.content) {
          const block = asObject(item);
          if (block?.type === "thinking" && typeof block.thinking === "string") reasoningParts.push(block.thinking);
          if (block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
            const args = safeValue(block.arguments ?? {});
            const argsBytes = encoder.encode(JSON.stringify(args) ?? "").byteLength;
            toolCalls.push({ id: block.id, name: cleanText(block.name, 256, true), title: typeof block.title === "string" ? cleanText(block.title, 256, true) : cleanText(block.name, 256, true), args: argsBytes <= MAX_ARGUMENT_BYTES ? args : { omitted: "Tool arguments exceeded the app-wire display budget." } });
          }
        }
      }
      const reasoning = cleanText(reasoningParts.join(""), MAX_TEXT_BYTES);
      const primary = text || reasoning || role === "user" ? add(raw, "message", { role, text, ...(reasoning ? { reasoning } : {}) }, parentId) : undefined;
      if (role === "user" && text && firstUserText === undefined) firstUserText = text;
      aliases.set(raw.id, primary ?? parentId);
      for (const call of toolCalls) {
        const toolId = add(raw, "tool-use", { toolCallId: call.id, tool: call.name, title: call.title, args: call.args ?? {}, ok: false, result: { output: "" } }, primary ?? parentId, `${raw.id}:tool:${call.id}`);
        toolRows.set(call.id, { index: entries.length - 1, id: toolId });
        const pending = pendingResults.get(call.id);
        if (pending) {
          entries[entries.length - 1] = { ...entries[entries.length - 1], data: { ...entries[entries.length - 1].data, ok: pending.ok, result: { output: pending.text } } };
          pendingResults.delete(call.id);
        }
      }
      continue;
    }

    if (raw.type === "message" && role === "toolResult") {
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      if (callId) {
        const result: ToolResultProjection = { ok: message.isError !== true, text: contentText(message.content) };
        const row = toolRows.get(callId);
        if (row) entries[row.index] = { ...entries[row.index], data: { ...entries[row.index].data, ok: result.ok, result: { output: boundUtf8(result.text, MAX_RESULT_BYTES) } } };
        else pendingResults.set(callId, result);
      }
      aliases.set(raw.id, parentId);
      continue;
    }

    if (raw.type === "custom_message" && raw.display === true) {
      const text = contentText(raw.content);
      const customRole = raw.attribution === "agent" ? "assistant" : "user";
      const id = add(raw, "message", { role: customRole, text }, parentId);
      aliases.set(raw.id, id);
      if (customRole === "user" && text && firstUserText === undefined) firstUserText = text;
      continue;
    }

    if (raw.type === "compaction" && typeof raw.summary === "string") {
      const id = add(raw, "compaction", { summary: cleanText(raw.summary, MAX_RESULT_BYTES), ...(typeof raw.shortSummary === "string" ? { shortSummary: cleanText(raw.shortSummary, MAX_TEXT_BYTES) } : {}) }, parentId);
      aliases.set(raw.id, id);
      continue;
    }

    if (raw.type === "title_change" && typeof raw.title === "string" && cleanText(raw.title, 512, true)) titleChange = cleanText(raw.title, 512, true);
    if (raw.type === "model_change" && typeof raw.model === "string" && cleanText(raw.model, 256, true)) model = cleanText(raw.model, 256, true);
    if (raw.type === "thinking_level_change") {
      const candidate = typeof raw.configured === "string" ? raw.configured : raw.thinkingLevel;
      if (typeof candidate === "string" && cleanText(candidate, 256, true)) thinking = cleanText(candidate, 256, true);
    }
    aliases.set(raw.id, parentId);
  }

  const retainedReverse: DurableEntry[] = [];
  let payloadBytes = 2;
  let payloadNodes = 1;
  for (let i = entries.length - 1; i >= 0 && retainedReverse.length < MAX_SNAPSHOT_ENTRIES - 1; i--) {
    const entryBytes = encoder.encode(JSON.stringify(entries[i])).byteLength;
    const entryNodes = jsonNodeCount(entries[i]);
    const separatorBytes = retainedReverse.length === 0 ? 0 : 1;
    if (payloadBytes + separatorBytes + entryBytes > MAX_SNAPSHOT_BYTES || payloadNodes + entryNodes > MAX_SNAPSHOT_NODES) {
      if (retainedReverse.length === 0) continue;
      break;
    }
    retainedReverse.push(entries[i]);
    payloadBytes += separatorBytes + entryBytes;
    payloadNodes += entryNodes;
  }
  const retained = retainedReverse.reverse();
  const omitted = entries.length - retained.length;
  if (omitted === 0) return { entries: retained, firstUserText, titleChange, model, thinking };
  const retainedIds = new Set(retained.map(entry => entry.id));
  for (let i = 0; i < retained.length; i++) {
    const parentId = retained[i].parentId;
    if (parentId && !retainedIds.has(parentId)) retained[i] = { ...retained[i], parentId: null };
  }
  const noticeTimestamp = retained[0]?.timestamp ?? headerTimestamp;
  const noticeId = uniqueEntryId(`snapshot-truncation-${sid}`, new Set(retained.map(entry => entry.id)));
  retained.unshift({ id: noticeId, parentId: null, hostId: host, sessionId: sid, kind: "compaction", timestamp: noticeTimestamp, data: { summary: `Older transcript entries were omitted from this snapshot (${omitted} entries).`, omitted } });
  return { entries: retained, firstUserText, titleChange, model, thinking };
}

export function stableProjectId(cwd: string): ProjectId {
  let canonical = resolve(cwd);
  try { canonical = realpathSync.native(canonical); } catch {}
  return projectId(`project-${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`);
}

function parseTranscript(input: string | Uint8Array, path: string, host: HostId): SessionRecord {
  const bytes = typeof input === "string" ? encoder.encode(input).byteLength : input.byteLength;
  if (bytes > MAX_TRANSCRIPT_BYTES) throw new Error("transcript exceeds limit");
  const lines: Array<string | Uint8Array> = [];
  if (typeof input === "string") {
    for (const line of input.split(/\r?\n/).filter(Boolean)) lines.push(line);
  } else {
    let start = 0;
    for (let i = 0; i <= input.byteLength; i++) if (i === input.byteLength || input[i] === 10) {
      const line = input.slice(start, i); if (line.byteLength) lines.push(line); start = i + 1;
    }
  }
  if (!lines.length) throw new Error("empty transcript");
  const values = lines.map(line => {
    if ((typeof line === "string" ? encoder.encode(line).byteLength : line.byteLength) > MAX_LINE_BYTES) throw new Error("transcript line exceeds limit");
    const value = parseBounded(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid transcript entry");
    return value as Record<string, unknown>;
  });
  let headerIndex = 0;
  const first = values[0];
  const fixedTitle = first.type === "title" && first.v === 1 && typeof first.title === "string" ? cleanText(first.title, 512, true) : undefined;
  if (first.type === "title") {
    if (first.v !== 1 || typeof first.title !== "string") throw new Error("invalid transcript prelude");
    headerIndex = 1;
  }
  const header = values[headerIndex];
  if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id || typeof header.cwd !== "string" || !header.cwd || typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp))) throw new Error("invalid transcript header");
  const sid = sessionId(header.id);
  const cwd = resolve(header.cwd);
  const normalized = normalizeEntries(values.slice(headerIndex + 1), host, sid, header.timestamp);
  const sessionTitle = typeof header.title === "string" ? cleanText(header.title, 512, true) : undefined;
  const title = fixedTitle || normalized.titleChange || sessionTitle || normalized.firstUserText || "Untitled";
  return { sessionId: sid, path, cwd, projectId: stableProjectId(cwd), projectName: basename(cwd), title: cleanText(title, 512, true) || "Untitled", updatedAt: "", status: "idle", ...(normalized.model ? { model: normalized.model } : {}), ...(normalized.thinking ? { thinking: normalized.thinking } : {}), entries: normalized.entries };
}

export class FileSessionDiscovery implements SessionDiscovery {
  constructor(private readonly root: string, private readonly fs: FileSystem = realFs, private readonly host: HostId = hostId("discovery")) {}
  private async files(path: string): Promise<string[]> {
    const children = await this.fs.readdir(path);
    const output: string[] = [];
    for (const child of children.sort()) {
      let info;
      try { info = await this.fs.stat(child); } catch { continue; }
      if (info.isDirectory()) output.push(...await this.files(child));
      else if (info.isFile() && child.endsWith(".jsonl")) output.push(child);
    }
    return output;
  }
  async list(): Promise<SessionRecord[]> {
    let files: string[];
    try { files = await this.files(this.root); } catch { return []; }
    const found: SessionRecord[] = [];
    for (const path of files) {
      try {
        const fileStat = await this.fs.stat(path);
        if (fileStat.size > MAX_TRANSCRIPT_BYTES) continue;
        const record = parseTranscript(await this.fs.readFile(path), path, this.host);
        record.updatedAt = new Date(fileStat.mtimeMs).toISOString();
        found.push(record);
      } catch {}
    }
    found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId));
    return found;
  }
}
export { realFs };
