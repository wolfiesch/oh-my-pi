import { fail } from "./errors.ts";
import {
  boundedArray,
  boundedMap,
  boundedText,
  controlFree,
  finiteNumber,
  inputObject,
  safeRelativePath,
  string,
  bool,
  safeSeq,
} from "./guards.ts";
import { PROTOCOL_VERSION, MAX_ARRAY_ITEMS, MAX_FILE_BYTES, MAX_TERMINAL_OUTPUT_BYTES } from "./limits.ts";
import {
  agentId,
  catalogId,
  hostId,
  leaseId,
  operationId,
  previewId,
  projectId,
  revision,
  sessionId,
  terminalId,
  watchId,
  type AgentId,
  type CatalogId,
  type HostId,
  type LeaseId,
  type OperationId,
  type PreviewId,
  type ProjectId,
  type Revision,
  type SessionId,
  type TerminalId,
  type WatchId,
} from "./ids.ts";
import { decodeCursor, type Cursor } from "./cursor.ts";

export const ADDITIVE_FEATURES = [
  "host.watch", "session.watch", "session.state", "session.delta", "controller.lease",
  "agent.lifecycle", "agent.progress", "agent.event", "agent.transcript",
  "terminal.io", "files.list", "files.diff", "audit.tail", "catalog.metadata",
  "settings.metadata", "preview.control",
] as const;
export type AdditiveFeature = (typeof ADDITIVE_FEATURES)[number];
export type WireFeature = AdditiveFeature | "resume";

function frame(input: unknown, type: string): Record<string, unknown> {
  const x = inputObject(input);
  if (x.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
  if (x.type !== type) fail("INVALID_FRAME", `expected ${type} frame`, "type");
  return x;
}
function owner(x: Record<string, unknown>, path: string): { hostId: HostId; sessionId: SessionId } {
  const host = hostId(x.hostId, `${path}.hostId`);
  const session = sessionId(x.sessionId, `${path}.sessionId`);
  return { hostId: host, sessionId: session };
}
function optionalRevision(value: unknown, path: string): Revision | undefined {
  return value === undefined ? undefined : revision(value, path);
}
function known(value: unknown, path: string, values: readonly string[]): string {
  const result = controlFree(value, path, 64);
  if (!values.includes(result)) fail("UNKNOWN_FRAME", `unknown discriminant ${result}`, path);
  return result;
}
function cursor(value: unknown, path = "cursor"): Cursor { return decodeCursor(value, path); }
function boundedObject(value: unknown, path: string): Record<string, unknown> {
  return boundedMap(value, path);
}

export interface HostWatchFrame {
  v: typeof PROTOCOL_VERSION; type: "host.watch"; watchId: WatchId; hostId: HostId; cursor: Cursor;
  state: "started" | "stopped" | "ready"; revision: Revision; [key: string]: unknown;
}
export interface SessionWatchFrame {
  v: typeof PROTOCOL_VERSION; type: "session.watch"; watchId: WatchId; hostId: HostId; sessionId: SessionId;
  cursor: Cursor; state: "started" | "stopped" | "ready"; revision: Revision; [key: string]: unknown;
}
export interface SessionStateFrame {
  v: typeof PROTOCOL_VERSION; type: "session.state"; hostId: HostId; sessionId: SessionId;
  cursor: Cursor; revision: Revision; state: string; [key: string]: unknown;
}
export interface SessionDeltaFrame {
  v: typeof PROTOCOL_VERSION; type: "session.delta"; hostId: HostId; sessionId: SessionId;
  cursor: Cursor; revision: Revision; changes: Record<string, unknown>; [key: string]: unknown;
}
export type WatchFrame = HostWatchFrame | SessionWatchFrame | SessionStateFrame | SessionDeltaFrame;
const WATCH_STATES = ["started", "stopped", "ready"] as const;
export function decodeWatch(input: unknown): WatchFrame {
  const x = frame(input, String((inputObject(input)).type));
  const type = known(x.type, "type", ["host.watch", "session.watch", "session.state", "session.delta"]);
  if (type === "host.watch") {
    return { ...x, type, watchId: watchId(x.watchId), hostId: hostId(x.hostId), cursor: cursor(x.cursor),
      state: known(x.state, "state", WATCH_STATES) as HostWatchFrame["state"], revision: revision(x.revision) } as HostWatchFrame;
  }
  const own = owner(x, "frame");
  if (type === "session.watch") return { ...x, type, watchId: watchId(x.watchId), ...own, cursor: cursor(x.cursor),
    state: known(x.state, "state", WATCH_STATES) as SessionWatchFrame["state"], revision: revision(x.revision) } as SessionWatchFrame;
  const rev = revision(x.revision);
  const cur = cursor(x.cursor);
  if (type === "session.state") return { ...x, type, ...own, cursor: cur, revision: rev, state: controlFree(x.state, "state", 128) } as SessionStateFrame;
  return { ...x, type, ...own, cursor: cur, revision: rev, changes: boundedObject(x.changes, "changes") } as SessionDeltaFrame;
}

export type LeaseKind = "controller" | "prompt";
export type LeaseState = "acquired" | "renewed" | "released" | "expired";
export interface LeaseFrame {
  v: typeof PROTOCOL_VERSION; type: "lease" | "prompt.lease"; hostId: HostId; sessionId: SessionId; leaseId: LeaseId;
  kind: LeaseKind; state: LeaseState; owner: string; expiresAt: string; revision?: Revision; [key: string]: unknown;
}
export interface PromptLeaseFrame extends LeaseFrame { type: "prompt.lease"; kind: "prompt"; }
const LEASE_KINDS = ["controller", "prompt"] as const;
const LEASE_STATES = ["acquired", "renewed", "released", "expired"] as const;
export function decodeLease(input: unknown): LeaseFrame | PromptLeaseFrame {
  const x = inputObject(input);
  const type = known(x.type, "type", ["lease", "prompt.lease"]);
  if (x.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
  const own = owner(x, "frame");
  const kind = known(x.kind, "kind", LEASE_KINDS) as LeaseKind;
  if (type === "prompt.lease" && kind !== "prompt") fail("INVALID_FRAME", "prompt lease must have prompt kind", "kind");
  const result = { ...x, type, ...own, leaseId: leaseId(x.leaseId), kind,
    state: known(x.state, "state", LEASE_STATES) as LeaseState,
    owner: controlFree(x.owner, "owner", 256), expiresAt: controlFree(x.expiresAt, "expiresAt", 128) } as LeaseFrame;
  const rev = optionalRevision(x.revision, "revision");
  if (rev !== undefined) result.revision = rev;
  return type === "prompt.lease" ? result as PromptLeaseFrame : result;
}

export type AgentLifecycle = "created" | "started" | "running" | "completed" | "failed" | "cancelled";
export interface AgentStateFrame { v: typeof PROTOCOL_VERSION; type: "agent.state"; hostId: HostId; sessionId: SessionId; agentId: AgentId; state: AgentLifecycle; revision: Revision; [key: string]: unknown; }
export interface AgentLifecycleFrame { v: typeof PROTOCOL_VERSION; type: "agent.lifecycle"; hostId: HostId; sessionId: SessionId; agentId: AgentId; lifecycle: AgentLifecycle; revision: Revision; [key: string]: unknown; }
export interface AgentProgressFrame { v: typeof PROTOCOL_VERSION; type: "agent.progress"; hostId: HostId; sessionId: SessionId; agentId: AgentId; progress: number; revision: Revision; detail?: Record<string, unknown>; [key: string]: unknown; }
export interface AgentEventFrame { v: typeof PROTOCOL_VERSION; type: "agent.event"; hostId: HostId; sessionId: SessionId; agentId: AgentId; event: string; revision: Revision; data?: Record<string, unknown>; [key: string]: unknown; }
export interface AgentTranscriptFrame { v: typeof PROTOCOL_VERSION; type: "agent.transcript"; hostId: HostId; sessionId: SessionId; agentId: AgentId; entries: Record<string, unknown>[]; revision: Revision; [key: string]: unknown; }
export type AgentAdditiveFrame = AgentStateFrame | AgentLifecycleFrame | AgentProgressFrame | AgentEventFrame | AgentTranscriptFrame;
const AGENT_STATES = ["created", "started", "running", "completed", "failed", "cancelled"] as const;
export function decodeAgentAdditive(input: unknown): AgentAdditiveFrame {
  const x = frame(input, String((inputObject(input)).type));
  const type = known(x.type, "type", ["agent.state", "agent.lifecycle", "agent.progress", "agent.event", "agent.transcript"]);
  const own = owner(x, "frame"); const aid = agentId(x.agentId); const rev = revision(x.revision);
  if (type === "agent.state") return { ...x, type, ...own, agentId: aid, state: known(x.state, "state", AGENT_STATES) as AgentLifecycle, revision: rev } as AgentStateFrame;
  if (type === "agent.lifecycle") return { ...x, type, ...own, agentId: aid, lifecycle: known(x.lifecycle, "lifecycle", AGENT_STATES) as AgentLifecycle, revision: rev } as AgentLifecycleFrame;
  if (type === "agent.progress") {
    const progress = finiteNumber(x.progress, "progress"); if (progress < 0 || progress > 1) fail("BOUNDS", "progress must be between zero and one", "progress");
    const result = { ...x, type, ...own, agentId: aid, progress, revision: rev } as AgentProgressFrame;
    if (x.detail !== undefined) result.detail = boundedObject(x.detail, "detail"); return result;
  }
  if (type === "agent.event") {
    const result = { ...x, type, ...own, agentId: aid, event: controlFree(x.event, "event", 128), revision: rev } as AgentEventFrame;
    if (x.data !== undefined) result.data = boundedObject(x.data, "data"); return result;
  }
  const entries = boundedArray(x.entries, "entries").map((value, i) => boundedObject(value, `entries[${i}]`));
  return { ...x, type, ...own, agentId: aid, entries, revision: rev } as AgentTranscriptFrame;
}

export interface TerminalInputFrame { v: typeof PROTOCOL_VERSION; type: "terminal.input"; hostId: HostId; sessionId: SessionId; terminalId: TerminalId; data: string; encoding?: "utf8" | "base64"; [key: string]: unknown; }
export interface TerminalOutputFrame { v: typeof PROTOCOL_VERSION; type: "terminal.output"; hostId: HostId; sessionId: SessionId; terminalId: TerminalId; stream: "stdout" | "stderr"; data: string; encoding?: "utf8" | "base64"; [key: string]: unknown; }
export interface TerminalResizeFrame { v: typeof PROTOCOL_VERSION; type: "terminal.resize"; hostId: HostId; sessionId: SessionId; terminalId: TerminalId; cols: number; rows: number; [key: string]: unknown; }
export interface TerminalCloseFrame { v: typeof PROTOCOL_VERSION; type: "terminal.close"; hostId: HostId; sessionId: SessionId; terminalId: TerminalId; reason?: string; [key: string]: unknown; }
export interface TerminalExitFrame { v: typeof PROTOCOL_VERSION; type: "terminal.exit"; hostId: HostId; sessionId: SessionId; terminalId: TerminalId; exitCode: number; signal?: string; [key: string]: unknown; }
export type TerminalAdditiveFrame = TerminalInputFrame | TerminalOutputFrame | TerminalResizeFrame | TerminalCloseFrame | TerminalExitFrame;
const TERMINAL_TYPES = ["terminal.input", "terminal.output", "terminal.resize", "terminal.close", "terminal.exit"] as const;
function positiveDimension(value: unknown, path: string): number { const n = safeSeq(value, path); if (n === 0 || n > 1_000_000) fail("BOUNDS", "terminal dimension out of range", path); return n; }
export function decodeTerminalAdditive(input: unknown): TerminalAdditiveFrame {
  const x = frame(input, String((inputObject(input)).type)); const type = known(x.type, "type", TERMINAL_TYPES);
  const own = owner(x, "frame"); const tid = terminalId(x.terminalId);
  if (type === "terminal.input" || type === "terminal.output") {
    const data = boundedText(x.data, "data", MAX_TERMINAL_OUTPUT_BYTES);
    const encoding = x.encoding === undefined ? undefined : known(x.encoding, "encoding", ["utf8", "base64"]) as "utf8" | "base64";
    if (encoding === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) fail("BOUNDS", "invalid base64 terminal payload", "data");
    if (type === "terminal.input") { const result = { ...x, type, ...own, terminalId: tid, data } as TerminalInputFrame; if (encoding !== undefined) result.encoding = encoding; return result; }
    const stream = known(x.stream, "stream", ["stdout", "stderr"]) as "stdout" | "stderr";
    const result = { ...x, type, ...own, terminalId: tid, stream, data } as TerminalOutputFrame; if (encoding !== undefined) result.encoding = encoding; return result;
  }
  if (type === "terminal.resize") return { ...x, type, ...own, terminalId: tid, cols: positiveDimension(x.cols, "cols"), rows: positiveDimension(x.rows, "rows") } as TerminalResizeFrame;
  if (type === "terminal.close") { const result = { ...x, type, ...own, terminalId: tid } as TerminalCloseFrame; if (x.reason !== undefined) result.reason = controlFree(x.reason, "reason", 256); return result; }
  const code = x.exitCode; if (typeof code !== "number" || !Number.isSafeInteger(code)) fail("INVALID_FRAME", "exitCode must be a safe integer", "exitCode");
  const result = { ...x, type, ...own, terminalId: tid, exitCode: code } as TerminalExitFrame; if (x.signal !== undefined) result.signal = controlFree(x.signal, "signal", 128); return result;
}

export interface FileListEntry { path: string; kind: "file" | "directory" | "symlink"; size?: number; revision?: Revision; [key: string]: unknown; }
export interface FilesListFrame { v: typeof PROTOCOL_VERSION; type: "files.list"; hostId: HostId; sessionId: SessionId; path: string; entries: FileListEntry[]; cursor?: Cursor; revision?: Revision; [key: string]: unknown; }
export interface FilesReadFrame { v: typeof PROTOCOL_VERSION; type: "files.read"; hostId: HostId; sessionId: SessionId; path: string; content: string; encoding?: "utf8" | "base64"; revision?: Revision; [key: string]: unknown; }
export interface FilesWriteFrame { v: typeof PROTOCOL_VERSION; type: "files.write"; hostId: HostId; sessionId: SessionId; path: string; content: string; encoding?: "utf8" | "base64"; revision: Revision; [key: string]: unknown; }
export interface FilesPatchFrame { v: typeof PROTOCOL_VERSION; type: "files.patch"; hostId: HostId; sessionId: SessionId; path: string; patch: string; revision: Revision; [key: string]: unknown; }
export interface FilesDiffFrame { v: typeof PROTOCOL_VERSION; type: "files.diff"; hostId: HostId; sessionId: SessionId; path: string; diff: string; fromRevision?: Revision; toRevision?: Revision; [key: string]: unknown; }
export type FilesAdditiveFrame = FilesListFrame | FilesReadFrame | FilesWriteFrame | FilesPatchFrame | FilesDiffFrame;
const FILE_TYPES = ["files.list", "files.read", "files.write", "files.patch", "files.diff"] as const;
function fileEntry(value: unknown, path: string): FileListEntry { const x = boundedMap(value, path); const kind = known(x.kind, `${path}.kind`, ["file", "directory", "symlink"]) as FileListEntry["kind"]; const result = { ...x, path: safeRelativePath(x.path, `${path}.path`), kind } as FileListEntry; if (x.size !== undefined) { const size = safeSeq(x.size, `${path}.size`); if (size > MAX_FILE_BYTES * 1024) fail("BOUNDS", "file size exceeds protocol limit", `${path}.size`); result.size = size; } if (x.revision !== undefined) result.revision = revision(x.revision, `${path}.revision`); return result; }
export function decodeFilesAdditive(input: unknown): FilesAdditiveFrame {
  const x = frame(input, String((inputObject(input)).type)); const type = known(x.type, "type", FILE_TYPES); const own = owner(x, "frame"); const path = safeRelativePath(x.path);
  if (type === "files.list") { const result = { ...x, type, ...own, path, entries: boundedArray(x.entries, "entries").map((v, i) => fileEntry(v, `entries[${i}]`)) } as FilesListFrame; if (x.cursor !== undefined) result.cursor = cursor(x.cursor); if (x.revision !== undefined) result.revision = revision(x.revision); return result; }
  if (type === "files.read") { const result = { ...x, type, ...own, path, content: boundedText(x.content, "content", MAX_FILE_BYTES) } as FilesReadFrame; if (x.encoding !== undefined) result.encoding = known(x.encoding, "encoding", ["utf8", "base64"]) as "utf8" | "base64"; if (x.revision !== undefined) result.revision = revision(x.revision); return result; }
  if (type === "files.write") { const result = { ...x, type, ...own, path, content: boundedText(x.content, "content", MAX_FILE_BYTES), revision: revision(x.revision) } as FilesWriteFrame; if (x.encoding !== undefined) result.encoding = known(x.encoding, "encoding", ["utf8", "base64"]) as "utf8" | "base64"; return result; }
  if (type === "files.patch") return { ...x, type, ...own, path, patch: boundedText(x.patch, "patch", MAX_FILE_BYTES), revision: revision(x.revision) } as FilesPatchFrame;
  const result = { ...x, type, ...own, path, diff: boundedText(x.diff, "diff", MAX_FILE_BYTES) } as FilesDiffFrame; if (x.fromRevision !== undefined) result.fromRevision = revision(x.fromRevision); if (x.toRevision !== undefined) result.toRevision = revision(x.toRevision); return result;
}

export interface AuditTailFrame { v: typeof PROTOCOL_VERSION; type: "audit.tail"; hostId: HostId; cursor: Cursor; events: AuditEvent[]; [key: string]: unknown; }
export interface AuditEvent { eventId: OperationId; hostId: HostId; sessionId?: SessionId; action: string; actor: string; timestamp: string; detail?: Record<string, unknown>; [key: string]: unknown; }
export interface AuditEventFrame { v: typeof PROTOCOL_VERSION; type: "audit.event"; hostId: HostId; event: AuditEvent; cursor: Cursor; [key: string]: unknown; }
function auditEvent(value: unknown, path: string): AuditEvent { const x = boundedMap(value, path); const result = { ...x, eventId: operationId(x.eventId, `${path}.eventId`), hostId: hostId(x.hostId, `${path}.hostId`), action: controlFree(x.action, `${path}.action`, 128), actor: controlFree(x.actor, `${path}.actor`, 256), timestamp: controlFree(x.timestamp, `${path}.timestamp`, 128) } as AuditEvent; if (x.sessionId !== undefined) result.sessionId = sessionId(x.sessionId, `${path}.sessionId`); if (x.detail !== undefined) result.detail = boundedObject(x.detail, `${path}.detail`); return result; }
export function decodeAuditAdditive(input: unknown): AuditTailFrame | AuditEventFrame { const x = frame(input, String((inputObject(input)).type)); const type = known(x.type, "type", ["audit.tail", "audit.event"]); if (type === "audit.tail") return { ...x, type, hostId: hostId(x.hostId), cursor: cursor(x.cursor), events: boundedArray(x.events, "events").map((v, i) => auditEvent(v, `events[${i}]`)) } as AuditTailFrame; const event = auditEvent(x.event, "event"); if (event.hostId !== hostId(x.hostId)) fail("INVALID_FRAME", "audit event belongs to another host", "event.hostId"); return { ...x, type, hostId: hostId(x.hostId), event, cursor: cursor(x.cursor) } as AuditEventFrame; }

export interface CatalogItem { id: CatalogId; kind: "tool" | "model" | "command"; name: string; description?: string; capabilities?: string[]; [key: string]: unknown; }
export interface CatalogFrame { v: typeof PROTOCOL_VERSION; type: "catalog"; hostId: HostId; revision: Revision; items: CatalogItem[]; [key: string]: unknown; }
export interface SettingsFrame { v: typeof PROTOCOL_VERSION; type: "settings"; hostId: HostId; revision: Revision; settings: Record<string, string | number | boolean | null>; [key: string]: unknown; }
function catalogItem(value: unknown, path: string): CatalogItem { const x = boundedMap(value, path); const result = { ...x, id: catalogId(x.id, `${path}.id`), kind: known(x.kind, `${path}.kind`, ["tool", "model", "command"]) as CatalogItem["kind"], name: controlFree(x.name, `${path}.name`, 256) } as CatalogItem; if (x.description !== undefined) result.description = boundedText(x.description, `${path}.description`, 4096); if (x.capabilities !== undefined) result.capabilities = boundedArray(x.capabilities, `${path}.capabilities`, 128).map((v, i) => controlFree(v, `${path}.capabilities[${i}]`, 128)); return result; }
function settingMap(value: unknown, path: string): Record<string, string | number | boolean | null> { const x = boundedMap(value, path); const out: Record<string, string | number | boolean | null> = {}; for (const [key, value] of Object.entries(x)) { controlFree(key, `${path}.${key}`, 256); if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") fail("INVALID_FRAME", "setting must be scalar", `${path}.${key}`); if (typeof value === "number" && !Number.isFinite(value)) fail("INVALID_FRAME", "setting number must be finite", `${path}.${key}`); out[key] = value; } return out; }
export function decodeCatalog(input: unknown): CatalogFrame | SettingsFrame { const x = frame(input, String((inputObject(input)).type)); const type = known(x.type, "type", ["catalog", "settings"]); const resultBase = { ...x, type, hostId: hostId(x.hostId), revision: revision(x.revision) }; if (type === "catalog") return { ...resultBase, items: boundedArray(x.items, "items").map((v, i) => catalogItem(v, `items[${i}]`)) } as CatalogFrame; return { ...resultBase, settings: settingMap(x.settings, "settings") } as SettingsFrame; }

export type PreviewState = "launching" | "ready" | "running" | "stopped" | "failed";
export interface PreviewLaunchFrame { v: typeof PROTOCOL_VERSION; type: "preview.launch"; hostId: HostId; sessionId: SessionId; previewId: PreviewId; url: string; revision: Revision; [key: string]: unknown; }
export interface PreviewStateFrame { v: typeof PROTOCOL_VERSION; type: "preview.state"; hostId: HostId; sessionId: SessionId; previewId: PreviewId; state: PreviewState; revision: Revision; error?: string; [key: string]: unknown; }
export interface PreviewNavigationFrame { v: typeof PROTOCOL_VERSION; type: "preview.navigation"; hostId: HostId; sessionId: SessionId; previewId: PreviewId; url: string; [key: string]: unknown; }
export interface PreviewCaptureFrame { v: typeof PROTOCOL_VERSION; type: "preview.capture"; hostId: HostId; sessionId: SessionId; previewId: PreviewId; content: string; encoding: "base64"; mimeType: string; [key: string]: unknown; }
export interface PreviewErrorFrame { v: typeof PROTOCOL_VERSION; type: "preview.error"; hostId: HostId; sessionId: SessionId; previewId: PreviewId; code: string; message: string; [key: string]: unknown; }
export type PreviewFrame = PreviewLaunchFrame | PreviewStateFrame | PreviewNavigationFrame | PreviewCaptureFrame | PreviewErrorFrame;
export function decodePreview(input: unknown): PreviewFrame { const x = frame(input, String((inputObject(input)).type)); const type = known(x.type, "type", ["preview.launch", "preview.state", "preview.navigation", "preview.capture", "preview.error"]); const own = owner(x, "frame"); const pid = previewId(x.previewId); if (type === "preview.launch") return { ...x, type, ...own, previewId: pid, url: controlFree(x.url, "url", 4096), revision: revision(x.revision) } as PreviewLaunchFrame; if (type === "preview.state") { const result = { ...x, type, ...own, previewId: pid, state: known(x.state, "state", ["launching", "ready", "running", "stopped", "failed"]) as PreviewState, revision: revision(x.revision) } as PreviewStateFrame; if (x.error !== undefined) result.error = boundedText(x.error, "error", 2048); return result; } if (type === "preview.navigation") return { ...x, type, ...own, previewId: pid, url: controlFree(x.url, "url", 4096) } as PreviewNavigationFrame; if (type === "preview.capture") return { ...x, type, ...own, previewId: pid, content: boundedText(x.content, "content", MAX_FILE_BYTES), encoding: known(x.encoding, "encoding", ["base64"]) as "base64", mimeType: controlFree(x.mimeType, "mimeType", 128) } as PreviewCaptureFrame; return { ...x, type, ...own, previewId: pid, code: controlFree(x.code, "code", 128), message: boundedText(x.message, "message", 2048) } as PreviewErrorFrame; }

export type AdditiveServerFrame = WatchFrame | LeaseFrame | PromptLeaseFrame | AgentAdditiveFrame | TerminalAdditiveFrame | FilesAdditiveFrame | AuditTailFrame | AuditEventFrame | CatalogFrame | SettingsFrame | PreviewFrame;
export function decodeAdditiveServerFrame(input: unknown): AdditiveServerFrame {
  const x = inputObject(input); const type = x.type;
  if (typeof type !== "string") fail("INVALID_FRAME", "frame type must be a string", "type");
  if (["host.watch", "session.watch", "session.state", "session.delta"].includes(type)) return decodeWatch(x);
  if (["lease", "prompt.lease"].includes(type)) return decodeLease(x);
  if (["agent.state", "agent.lifecycle", "agent.progress", "agent.event", "agent.transcript"].includes(type)) return decodeAgentAdditive(x);
  if ([...TERMINAL_TYPES].includes(type as (typeof TERMINAL_TYPES)[number])) return decodeTerminalAdditive(x);
  if ([...FILE_TYPES].includes(type as (typeof FILE_TYPES)[number])) return decodeFilesAdditive(x);
  if (type === "audit.tail" || type === "audit.event") return decodeAuditAdditive(x);
  if (type === "catalog" || type === "settings") return decodeCatalog(x);
  if (["preview.launch", "preview.state", "preview.navigation", "preview.capture", "preview.error"].includes(type)) return decodePreview(x);
  fail("UNKNOWN_FRAME", "unknown additive server frame family", "type");
}

export function isNegotiatedFeature(feature: string, granted: readonly string[]): boolean { return granted.includes(feature); }
