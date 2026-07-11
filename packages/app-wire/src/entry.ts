import { entryId, hostId, sessionId, type EntryId, type HostId, type SessionId } from "./ids.ts";
import { boundedMap, inputObject, string } from "./guards.ts";

export interface DurableEntry {
  id: EntryId;
  hostId: HostId;
  sessionId: SessionId;
  kind: string;
  timestamp: string;
  data: Record<string, unknown>;
}
export function decodeEntry(input: unknown, path = "entry"): DurableEntry {
  const value = path === "entry" ? inputObject(input) : boundedMap(input, path);
  entryId(value.id, `${path}.id`);
  hostId(value.hostId, `${path}.hostId`);
  sessionId(value.sessionId, `${path}.sessionId`);
  string(value.kind, `${path}.kind`, 128);
  string(value.timestamp, `${path}.timestamp`, 128);
  boundedMap(value.data, `${path}.data`);
  return value as unknown as DurableEntry;
}
export function isDurableEntry(value: unknown): value is DurableEntry {
  try { decodeEntry(value); return true; } catch { return false; }
}
