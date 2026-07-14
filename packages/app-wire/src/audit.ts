import { fail } from "./errors";
import { boundedMap, controlFree, inputObject } from "./guards";
import { type HostId, hostId, type SessionId, sessionId } from "./ids";
import { PROTOCOL_VERSION } from "./limits";
export interface AuditFrame {
	v: typeof PROTOCOL_VERSION;
	type: "audit";
	hostId: HostId;
	sessionId?: SessionId;
	action: string;
	actor: string;
	timestamp: string;
	detail?: Record<string, unknown>;
}
export function decodeAudit(input: unknown): AuditFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "audit") fail("INVALID_FRAME", "expected audit frame", "type");
	hostId(frame.hostId);
	if (frame.sessionId !== undefined) sessionId(frame.sessionId);
	controlFree(frame.action, "action", 128);
	controlFree(frame.actor, "actor", 256);
	controlFree(frame.timestamp, "timestamp", 128);
	if (frame.detail !== undefined) boundedMap(frame.detail, "detail");
	return frame as unknown as AuditFrame;
}
