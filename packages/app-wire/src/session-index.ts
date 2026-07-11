import { decodeCursor, type Cursor } from "./cursor.ts";
import {
	hostId,
	projectId,
	revision,
	sessionId,
	type HostId,
	type ProjectId,
	type Revision,
	type SessionId,
} from "./ids.ts";
import { boundedArray, boundedMap, inputObject, optionalString, controlFree } from "./guards.ts";
import { PROTOCOL_VERSION } from "./limits.ts";
import { fail } from "./errors.ts";
export interface ProjectIdentity {
	projectId: ProjectId;
	canonicalCwd: string;
	name?: string;
}
export interface ContextUsage {
	used: number;
	limit: number;
}
export interface SessionRef {
	hostId: HostId;
	sessionId: SessionId;
	project: ProjectIdentity;
	revision: Revision;
	title: string;
	status: "active" | "idle" | "closed" | (string & {});
	updatedAt: string;
	liveState?: Record<string, unknown>;
	model?: string;
	thinking?: string;
	pendingApproval?: boolean;
	pendingUserInput?: boolean;
	proposedPlan?: string;
	contextUsage?: ContextUsage;
}
export interface SessionsFrame {
	v: typeof PROTOCOL_VERSION;
	type: "sessions";
	cursor: Cursor;
	sessions: SessionRef[];
}
export function decodeSessionRef(value: unknown, path: string): SessionRef {
	const session = boundedMap(value, path);
	hostId(session.hostId, `${path}.hostId`);
	sessionId(session.sessionId, `${path}.sessionId`);
	revision(session.revision, `${path}.revision`);
	const project = boundedMap(session.project, `${path}.project`);
	projectId(project.projectId, `${path}.project.projectId`);
	controlFree(project.canonicalCwd, `${path}.project.canonicalCwd`, 4096);
	if (project.name !== undefined) optionalString(project.name, `${path}.project.name`, 256);
	controlFree(session.title, `${path}.title`, 512);
	controlFree(session.status, `${path}.status`, 64);
	controlFree(session.updatedAt, `${path}.updatedAt`, 128);
	if (session.liveState !== undefined) boundedMap(session.liveState, `${path}.liveState`);
	if (session.model !== undefined) controlFree(session.model, `${path}.model`, 256);
	if (session.thinking !== undefined) controlFree(session.thinking, `${path}.thinking`, 256);
	if (session.pendingApproval !== undefined && typeof session.pendingApproval !== "boolean")
		fail("INVALID_FRAME", "pendingApproval must be boolean", `${path}.pendingApproval`);
	if (session.pendingUserInput !== undefined && typeof session.pendingUserInput !== "boolean")
		fail("INVALID_FRAME", "pendingUserInput must be boolean", `${path}.pendingUserInput`);
	if (session.proposedPlan !== undefined) optionalString(session.proposedPlan, `${path}.proposedPlan`, 4096);
	if (session.contextUsage !== undefined) {
		const usage = boundedMap(session.contextUsage, `${path}.contextUsage`);
		if (
			typeof usage.used !== "number" ||
			!Number.isSafeInteger(usage.used) ||
			usage.used < 0 ||
			typeof usage.limit !== "number" ||
			!Number.isSafeInteger(usage.limit) ||
			usage.limit < 0 ||
			usage.used > usage.limit
		)
			fail("BOUNDS", "invalid context usage", `${path}.contextUsage`);
	}
	return session as unknown as SessionRef;
}
export function decodeSessions(input: unknown): SessionsFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "sessions") fail("INVALID_FRAME", "expected sessions frame", "type");
	const cursor = decodeCursor(frame.cursor);
	const values = boundedArray(frame.sessions, "sessions");
	for (let i = 0; i < values.length; i++) decodeSessionRef(values[i], `sessions[${i}]`);
	return { ...frame, cursor } as unknown as SessionsFrame;
}
