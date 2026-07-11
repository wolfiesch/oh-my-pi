import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { entryId, hostId, parseBounded, projectId, sessionId } from "@oh-my-pi/app-wire";
import type { DurableEntry, EntryId, HostId, ProjectId, SessionId } from "@oh-my-pi/app-wire";
import type { FileSystem, SessionDiscovery, SessionRecord } from "./types.ts";

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const realFs: FileSystem = {
  mkdir: async (path, options) => { await mkdir(path, options); },
  chmod: async (path, mode) => { await chmod(path, mode); },
  unlink: async path => { try { await unlink(path); } catch {} },
  stat: async path => await stat(path),
  readdir: async path => (await readdir(path, { withFileTypes: true })).map(entry => join(path, entry.name)),
  readFile: async path => await readFile(path),
};
export function stableProjectId(cwd: string): ProjectId {
  let canonical = resolve(cwd);
  try { canonical = realpathSync.native(canonical); } catch {}
  return projectId(`project-${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`);
}

function asEntry(raw: Record<string, unknown>, host: HostId, session: SessionId): DurableEntry {
  if (typeof raw.id !== "string" || typeof raw.type !== "string" || !raw.type || (raw.parentId !== null && typeof raw.parentId !== "string") || typeof raw.timestamp !== "string" || !Number.isFinite(Date.parse(raw.timestamp))) throw new Error("invalid transcript entry");
  const id = entryId(raw.id as EntryId);
  const parentId = raw.parentId as EntryId | null;
  const { id: _id, parentId: _parent, timestamp: _ts, type, ...data } = raw;
  return { id, parentId, hostId: host, sessionId: session, kind: type, timestamp: raw.timestamp, data };
}

function parseTranscript(input: string | Uint8Array, path: string, host: HostId): SessionRecord {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input).byteLength : input.byteLength;
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
    if ((typeof line === "string" ? new TextEncoder().encode(line).byteLength : line.byteLength) > MAX_LINE_BYTES) throw new Error("transcript line exceeds limit");
    const value = parseBounded(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid transcript entry");
    return value as Record<string, unknown>;
  });
  const header = values[0];
  if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") throw new Error("invalid transcript header");
  const sid = sessionId(header.id);
  const entries = values.slice(1).map(value => asEntry(value, host, sid));
  const cwd = resolve(header.cwd);
  const first = entries.find(entry => entry.kind === "message");
  const title = typeof header.title === "string" && header.title ? header.title : first ? String(first.data.message ?? "Untitled") : "Untitled";
  return { sessionId: sid, path, cwd, projectId: stableProjectId(cwd), title, updatedAt: "", status: "idle", entries };
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
