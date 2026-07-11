import { hostId, requestId, sessionId, type HostId, type RequestId, type SessionId } from "./ids.ts";
import { boundedMap, inputObject, string } from "./guards.ts";
import { PROTOCOL_VERSION } from "./limits.ts";
import { fail } from "./errors.ts";

export interface CommandFrame {
  v: typeof PROTOCOL_VERSION;
  type: "command";
  requestId: RequestId;
  hostId: HostId;
  sessionId: SessionId;
  command: string;
  args?: Record<string, unknown>;
}
export function decodeCommand(input: unknown): CommandFrame {
  const frame = inputObject(input);
  if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
  if (frame.type !== "command") fail("INVALID_FRAME", "expected command frame", "type");
  requestId(frame.requestId); hostId(frame.hostId); sessionId(frame.sessionId); string(frame.command, "command", 128);
  if (frame.args !== undefined) boundedMap(frame.args, "args");
  return frame as unknown as CommandFrame;
}
