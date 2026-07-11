import { decodeCursor, type Cursor } from "./cursor.ts";
import { decodeEntry, type DurableEntry } from "./entry.ts";
import { hostId, sessionId, type HostId, type SessionId } from "./ids.ts";
import { boundedArray, inputObject, string } from "./guards.ts";
import { PROTOCOL_VERSION } from "./limits.ts";
import { fail } from "./errors.ts";

export interface SessionSnapshotFrame {
  v: typeof PROTOCOL_VERSION;
  type: "snapshot";
  cursor: Cursor;
  hostId: HostId;
  sessionId: SessionId;
  entries: DurableEntry[];
}
export function decodeSnapshot(input: unknown): SessionSnapshotFrame {
  const frame = inputObject(input);
  if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
  if (frame.type !== "snapshot") fail("INVALID_FRAME", "expected snapshot frame", "type");
  decodeCursor(frame.cursor); hostId(frame.hostId); sessionId(frame.sessionId);
  const entries = boundedArray(frame.entries, "entries");
  for (let i = 0; i < entries.length; i++) {
    const entry = decodeEntry(entries[i], `entries[${i}]`);
    if (entry.hostId !== frame.hostId || entry.sessionId !== frame.sessionId) fail("INVALID_FRAME", "entry belongs to another session", `entries[${i}]`);
  }
  return frame as unknown as SessionSnapshotFrame;
}
