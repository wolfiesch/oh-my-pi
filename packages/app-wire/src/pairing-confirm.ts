import { hostId, pairingId, requestId, sessionId, type HostId, type PairingId, type RequestId, type SessionId } from "./ids.ts";
import { inputObject, string } from "./guards.ts";
import { PROTOCOL_VERSION } from "./limits.ts";
import { fail } from "./errors.ts";

export interface PairingFrame {
  v: typeof PROTOCOL_VERSION; type: "pairing"; pairingId: PairingId; hostId: HostId; code: string; expiresAt: string;
}
export interface ConfirmFrame {
  v: typeof PROTOCOL_VERSION; type: "confirm"; requestId: RequestId; pairingId: PairingId; hostId: HostId; sessionId?: SessionId; approved: boolean;
}
export function decodePairing(input: unknown): PairingFrame {
  const frame = inputObject(input);
  if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
  if (frame.type !== "pairing") fail("INVALID_FRAME", "expected pairing frame", "type");
  pairingId(frame.pairingId); hostId(frame.hostId); string(frame.code, "code", 64); string(frame.expiresAt, "expiresAt", 128);
  return frame as unknown as PairingFrame;
}
export function decodeConfirm(input: unknown): ConfirmFrame {
  const frame = inputObject(input);
  if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
  if (frame.type !== "confirm") fail("INVALID_FRAME", "expected confirm frame", "type");
  requestId(frame.requestId); pairingId(frame.pairingId); hostId(frame.hostId);
  if (frame.sessionId !== undefined) sessionId(frame.sessionId);
  if (typeof frame.approved !== "boolean") fail("INVALID_FRAME", "approved must be boolean", "approved");
  return frame as unknown as ConfirmFrame;
}
