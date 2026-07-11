import { hostId, requestId, sessionId, type HostId, type RequestId, type SessionId } from "./ids.ts";
import { boundedMap, inputObject, string } from "./guards.ts";
import { PROTOCOL_VERSION } from "./limits.ts";
import { fail } from "./errors.ts";

export interface ResultFrame {
  v: typeof PROTOCOL_VERSION;
  type: "response";
  requestId: RequestId;
  hostId: HostId;
  sessionId: SessionId;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; [key: string]: unknown };
}
export function decodeResult(input: unknown): ResultFrame {
  const frame = inputObject(input);
  if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
  if (frame.type !== "response") fail("INVALID_FRAME", "expected response frame", "type");
  requestId(frame.requestId); hostId(frame.hostId); sessionId(frame.sessionId);
  if (typeof frame.ok !== "boolean") fail("INVALID_FRAME", "ok must be boolean", "ok");
  if (frame.ok) {
    if (frame.error !== undefined) fail("INVALID_FRAME", "successful response cannot have error", "error");
  } else {
    const error = boundedMap(frame.error, "error");
    string(error.code, "error.code", 128); string(error.message, "error.message", 1024);
  }
  return frame as unknown as ResultFrame;
}
