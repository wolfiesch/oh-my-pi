import { createHash } from "node:crypto";
import { hostId, revision, type DurableEntry, type HostId, type SessionEvent, type SessionId, type SessionRef, type ServerFrame } from "@oh-my-pi/app-wire";
import type { Projection, SessionRecord } from "./types.ts";

function frameCursor(frame: ServerFrame): { epoch: string; seq: number } | undefined {
  if (!("cursor" in frame) || !frame.cursor || typeof frame.cursor !== "object") return undefined;
  const cursor = frame.cursor;
  if (!("epoch" in cursor) || typeof cursor.epoch !== "string" || !("seq" in cursor) || typeof cursor.seq !== "number") return undefined;
  return { epoch: cursor.epoch, seq: cursor.seq };
}
export class SessionProjection {
  readonly value: Projection;
  #byId = new Map<string, DurableEntry>();
  #ringSize: number;
  #revisionHash = createHash("sha256");
  constructor(host: HostId, record: SessionRecord, epoch: string, ringSize = 256) {
    this.#ringSize = ringSize;
    for (const entry of record.entries) this.#byId.set(entry.id, entry);
    const entries = [...this.#byId.values()];
    for (const entry of entries) this.#revisionHash.update(`${JSON.stringify(entry)}\n`);
    const currentRevision = revision(`r-${this.#revisionHash.copy().digest("hex").slice(0, 24)}`);
    this.value = { hostId: host, sessionId: record.sessionId, revision: currentRevision, cursor: { epoch, seq: 0 }, entries, ref: { hostId: host, sessionId: record.sessionId, project: { projectId: record.projectId, name: record.projectName }, revision: currentRevision, title: record.title, status: record.status, updatedAt: record.updatedAt, ...(record.model ? { model: record.model } : {}), ...(record.thinking ? { thinking: record.thinking } : {}) }, ring: [] };
  }
  setStatus(status: SessionRef["status"]): void {
    this.value.ref = { ...this.value.ref, status };
  }
  appendEntry(entry: DurableEntry): ServerFrame | undefined {
    const previous = this.#byId.get(entry.id);
    if (previous) return JSON.stringify(previous) === JSON.stringify(entry) ? undefined : this.appendEvent({ type: "entry_conflict", entryId: entry.id });
    this.#byId.set(entry.id, entry);
    this.value.entries.push(entry);
    this.#revisionHash.update(`${JSON.stringify(entry)}\n`);
    this.value.revision = revision(`r-${this.#revisionHash.copy().digest("hex").slice(0, 24)}`);
    this.value.ref = { ...this.value.ref, revision: this.value.revision, updatedAt: entry.timestamp };
    return this.appendFrame({ v: "omp-app/1", type: "entry", cursor: this.nextCursor(), revision: this.value.revision, hostId: this.value.hostId, sessionId: this.value.sessionId, entry });
  }
  appendEvent(event: SessionEvent): ServerFrame {
    return this.appendFrame({ v: "omp-app/1", type: "event", cursor: this.nextCursor(), hostId: this.value.hostId, sessionId: this.value.sessionId, event });
  }
  snapshot(): ServerFrame {
    return { v: "omp-app/1", type: "snapshot", cursor: this.value.cursor, revision: this.value.revision, hostId: this.value.hostId, sessionId: this.value.sessionId, entries: this.value.entries };
  }
  private nextCursor() { this.value.cursor = { epoch: this.value.cursor.epoch, seq: this.value.cursor.seq + 1 }; return this.value.cursor; }
  private appendFrame(frame: ServerFrame): ServerFrame { this.value.ring.push(frame); if (this.value.ring.length > this.#ringSize) this.value.ring.shift(); return frame; }
  replay(cursor: { epoch: string; seq: number }): ServerFrame[] {
    if (cursor.epoch !== this.value.cursor.epoch) return [{ v: "omp-app/1", type: "gap", hostId: this.value.hostId, sessionId: this.value.sessionId, from: { epoch: this.value.cursor.epoch, seq: 0 }, to: this.value.cursor, reason: "epoch_mismatch" }, this.snapshot()];
    const oldest = this.value.ring[0];
    const oldestSeq = oldest ? (frameCursor(oldest)?.seq ?? this.value.cursor.seq + 1) : this.value.cursor.seq + 1;
    if (cursor.seq < oldestSeq - 1) return [{ v: "omp-app/1", type: "gap", hostId: this.value.hostId, sessionId: this.value.sessionId, from: { epoch: cursor.epoch, seq: cursor.seq + 1 }, to: this.value.cursor, reason: "ring_evicted" }, this.snapshot()];
    return this.value.ring.filter(frame => (frameCursor(frame)?.seq ?? 0) > cursor.seq);
  }
}
