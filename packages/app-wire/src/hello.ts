import { decodeCapabilities, type Capabilities } from "./capabilities.ts";
import { decodeCursor, type Cursor } from "./cursor.ts";
import { fail } from "./errors.ts";
import { inputObject, object, string } from "./guards.ts";
import { PROTOCOL_VERSION } from "./limits.ts";

export interface HelloFrame {
  v: typeof PROTOCOL_VERSION;
  type: "hello";
  client: string;
  capabilities: Capabilities;
  resume?: Cursor;
}
export interface WelcomeFrame {
  v: typeof PROTOCOL_VERSION;
  type: "welcome";
  server: string;
  epoch: number;
  capabilities: Capabilities;
  resumed: boolean;
}
function version(value: unknown): void {
  if (value !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
}
export function decodeHello(input: unknown): HelloFrame {
  const frame = inputObject(input);
  version(frame.v);
  if (frame.type !== "hello") fail("INVALID_FRAME", "expected hello frame", "type");
  string(frame.client, "client", 256);
  decodeCapabilities(frame.capabilities);
  if (frame.resume !== undefined) decodeCursor(frame.resume, "resume");
  return frame as unknown as HelloFrame;
}
export function decodeWelcome(input: unknown): WelcomeFrame {
  const frame = object(input);
  version(frame.v);
  if (frame.type !== "welcome") fail("INVALID_FRAME", "expected welcome frame", "type");
  string(frame.server, "server", 256);
  if (typeof frame.epoch !== "number" || !Number.isSafeInteger(frame.epoch) || frame.epoch < 0) fail("UNSAFE_SEQUENCE", "epoch must be safe", "epoch");
  decodeCapabilities(frame.capabilities);
  if (typeof frame.resumed !== "boolean") fail("INVALID_FRAME", "resumed must be boolean", "resumed");
  return frame as unknown as WelcomeFrame;
}
