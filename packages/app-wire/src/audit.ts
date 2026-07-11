import { hostId, sessionId, type HostId, type SessionId } from "./ids.ts";
import { boundedMap, inputObject, string } from "./guards.ts";
import { PROTOCOL_VERSION } from "./limits.ts";
import { fail } from "./errors.ts";

export interface AuditFrame {
  v: typeof PROTOCOL_VERSION; type: "audit"; hostId: HostId; sessionId: SessionId;
  action: string; actor: string; timestamp: string; detail?: Record<string, unknown>;
}
export function decodeAudit(input: unknown): AuditFrame {
  const frame = inputObject(input);
  if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
  if (frame.type !== "audit") fail("INVALID_FRAME", "expected audit frame", "type");
  hostId(frame.hostId); sessionId(frame.sessionId); string(frame.action, "action", 128); string(frame.actor, "actor", 256); string(frame.timestamp, "timestamp", 128);
  if (frame.detail !== undefined) boundedMap(frame.detail, "detail");
  return frame as unknown as AuditFrame;
}
