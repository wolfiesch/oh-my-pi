import { agentId, hostId, sessionId, type AgentId, type HostId, type SessionId } from "./ids.ts";
import { boundedMap, inputObject, controlFree } from "./guards.ts";
import { PROTOCOL_VERSION } from "./limits.ts";
import { fail } from "./errors.ts";
export type AgentState = "started" | "running" | "completed" | "failed" | "cancelled" | (string & {});
export interface AgentFrame {
	v: typeof PROTOCOL_VERSION;
	type: "agent";
	hostId: HostId;
	sessionId: SessionId;
	agentId: AgentId;
	state: AgentState;
	progress?: number;
	detail?: Record<string, unknown>;
}
export function decodeAgent(input: unknown): AgentFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "agent") fail("INVALID_FRAME", "expected agent frame", "type");
	hostId(frame.hostId);
	sessionId(frame.sessionId);
	agentId(frame.agentId);
	controlFree(frame.state, "state", 64);
	if (
		frame.progress !== undefined &&
		(typeof frame.progress !== "number" ||
			!Number.isFinite(frame.progress) ||
			frame.progress < 0 ||
			frame.progress > 1)
	)
		fail("BOUNDS", "progress must be between zero and one", "progress");
	if (frame.detail !== undefined) boundedMap(frame.detail, "detail");
	return frame as unknown as AgentFrame;
}
