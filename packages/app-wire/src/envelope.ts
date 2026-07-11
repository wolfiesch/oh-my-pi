import { decodeAgent, type AgentFrame } from "./agents.ts";
import { decodeAudit, type AuditFrame } from "./audit.ts";
import { decodeCommand, type CommandFrame } from "./command.ts";
import { decodeConfirm, type ConfirmFrame } from "./pairing-confirm.ts";
import { decodeEvent, type LiveEventFrame } from "./event.ts";
import { fail } from "./errors.ts";
import { inputObject, string } from "./guards.ts";
import { decodeGap, type GapFrame } from "./gap.ts";
import { decodeFiles, decodeReview, type FileFrame, type ReviewFrame } from "./files-review.ts";
import { decodeHello, decodeWelcome, type HelloFrame, type WelcomeFrame } from "./hello.ts";
import { PROTOCOL_VERSION } from "./limits.ts";
import { decodePairing, type ConfirmFrame as PairingConfirmFrame, type PairingFrame } from "./pairing-confirm.ts";
import { decodeResult, type ResultFrame } from "./result.ts";
import { decodeSessions, type SessionsFrame } from "./session-index.ts";
import { decodeSnapshot, type SessionSnapshotFrame } from "./snapshot.ts";
import { decodeTerminal, type TerminalFrame } from "./terminal.ts";

export interface ErrorFrame { v: typeof PROTOCOL_VERSION; type: "error"; code: string; message: string; requestId?: string }
export type ClientFrame = HelloFrame | CommandFrame | ConfirmFrame;
export type ServerFrame = WelcomeFrame | SessionsFrame | SessionSnapshotFrame | LiveEventFrame | AgentFrame | TerminalFrame | FileFrame | ReviewFrame | AuditFrame | PairingFrame | PairingConfirmFrame | ResultFrame | GapFrame | ErrorFrame;
export type AppFrame = ClientFrame | ServerFrame;

function decodeError(input: unknown): ErrorFrame {
  const frame = inputObject(input);
  if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
  if (frame.type !== "error") fail("INVALID_FRAME", "expected error frame", "type");
  string(frame.code, "code", 128); string(frame.message, "message", 2048);
  if (frame.requestId !== undefined) string(frame.requestId, "requestId", 256);
  return frame as unknown as ErrorFrame;
}
export function decodeClientFrame(input: unknown): ClientFrame {
  const frame = inputObject(input);
  switch (frame.type) {
    case "hello": return decodeHello(frame);
    case "command": return decodeCommand(frame);
    case "confirm": return decodeConfirm(frame);
    default: fail("UNKNOWN_FRAME", "unknown client frame family", "type");
  }
}
export function decodeServerFrame(input: unknown): ServerFrame {
  const frame = inputObject(input);
  switch (frame.type) {
    case "welcome": return decodeWelcome(frame);
    case "sessions": return decodeSessions(frame);
    case "snapshot": return decodeSnapshot(frame);
    case "event": return decodeEvent(frame);
    case "agent": return decodeAgent(frame);
    case "terminal": return decodeTerminal(frame);
    case "files": return decodeFiles(frame);
    case "review": return decodeReview(frame);
    case "audit": return decodeAudit(frame);
    case "pairing": return decodePairing(frame);
    case "response": return decodeResult(frame);
    case "gap": return decodeGap(frame);
    case "error": return decodeError(frame);
    default: fail("UNKNOWN_FRAME", "unknown server frame family", "type");
  }
}
export function isClientFrame(value: unknown): value is ClientFrame {
  try { decodeClientFrame(value); return true; } catch { return false; }
}
export function isServerFrame(value: unknown): value is ServerFrame {
  try { decodeServerFrame(value); return true; } catch { return false; }
}
