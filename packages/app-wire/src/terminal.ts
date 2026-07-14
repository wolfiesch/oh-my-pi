import { fail } from "./errors";
import { boundedText, controlFree, inputObject } from "./guards";
import { type HostId, hostId, type SessionId, sessionId, type TerminalId, terminalId } from "./ids";
import { MAX_TERMINAL_OUTPUT_BYTES, PROTOCOL_VERSION } from "./limits";
export interface TerminalFrame {
	v: typeof PROTOCOL_VERSION;
	type: "terminal";
	hostId: HostId;
	sessionId: SessionId;
	terminalId: TerminalId;
	stream: "stdout" | "stderr" | "exit" | (string & {});
	data?: string;
	exitCode?: number;
}
export function decodeTerminal(input: unknown): TerminalFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "terminal") fail("INVALID_FRAME", "expected terminal frame", "type");
	hostId(frame.hostId);
	sessionId(frame.sessionId);
	terminalId(frame.terminalId);
	controlFree(frame.stream, "stream", 32);
	if (frame.data !== undefined) boundedText(frame.data, "data", MAX_TERMINAL_OUTPUT_BYTES);
	if (frame.exitCode !== undefined && (typeof frame.exitCode !== "number" || !Number.isSafeInteger(frame.exitCode)))
		fail("INVALID_FRAME", "exitCode must be safe integer", "exitCode");
	return frame as unknown as TerminalFrame;
}
