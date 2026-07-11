import { decodeCursor, type Cursor } from "./cursor.ts";
import { hostId, sessionId, type HostId, type SessionId } from "./ids.ts";
import { boundedArray, inputObject, optionalString, string } from "./guards.ts";
import { PROTOCOL_VERSION } from "./limits.ts";
import { fail } from "./errors.ts";

export interface SessionRef {
  hostId: HostId;
  sessionId: SessionId;
  title?: string;
  status: "active" | "idle" | "closed" | (string & {});
  updatedAt: string;
}
export interface SessionsFrame {
  v: typeof PROTOCOL_VERSION;
  type: "sessions";
  cursor: Cursor;
  sessions: SessionRef[];
}
function decodeSession(value: unknown, path: string): SessionRef {
  const session = value as Record<string, unknown>;
  if (session === null || typeof session !== "object" || Array.isArray(session)) fail("INVALID_FRAME", "session must be object", path);
  hostId(session.hostId, `${path}.hostId`); sessionId(session.sessionId, `${path}.sessionId`);
  if (session.title !== undefined) optionalString(session.title, `${path}.title`, 512);
  string(session.status, `${path}.status`, 64); string(session.updatedAt, `${path}.updatedAt`, 128);
  return session as unknown as SessionRef;
}
export function decodeSessions(input: unknown): SessionsFrame {
  const frame = inputObject(input);
  if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
  if (frame.type !== "sessions") fail("INVALID_FRAME", "expected sessions frame", "type");
  decodeCursor(frame.cursor);
  const values = boundedArray(frame.sessions, "sessions");
  for (let i = 0; i < values.length; i++) decodeSession(values[i], `sessions[${i}]`);
  return frame as unknown as SessionsFrame;
}
