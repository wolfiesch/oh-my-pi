import { type Cursor, decodeCursor } from "./cursor.js";
import { fail } from "./errors.js";
import {
	bool,
	boundedArray,
	boundedMap,
	boundedMetadata,
	controlFree,
	inputObject,
	isSecretLikeKey,
	optionalString,
	safeSeq,
} from "./guards.js";
import {
	type HostId,
	hostId,
	type ProjectId,
	projectId,
	type Revision,
	revision,
	type SessionId,
	sessionId,
} from "./ids.js";
import { PROTOCOL_VERSION } from "./limits.js";
export interface ProjectIdentity {
	projectId: ProjectId;
	name?: string;
}
export interface ContextUsage {
	used: number;
	limit: number;
}
export type SessionObserverLockStatus = "live" | "suspect" | "malformed";
export type SessionObserverTranscript = "live" | "snapshot";
export type ProviderTransportPolicy = "auto" | "on" | "off";
export type ProviderTransportKind = "websocket" | "sse";
export interface ProviderTransportState {
	provider: "openai-codex";
	configuredPolicy: ProviderTransportPolicy;
	websocketPreferred: boolean;
	lastTransport?: ProviderTransportKind;
	websocketDisabled: boolean;
	websocketConnected: boolean;
	fallbackCount: number;
	canAppend: boolean;
	prewarmed: boolean;
	hasSessionState: boolean;
	hasTurnState: boolean;
	fullContextRequests: number;
	deltaRequests: number;
	inputJsonBytes: number;
	lastInputJsonBytes?: number;
}
export type SessionControlState =
	| {
			mode: "observer";
			lockStatus: SessionObserverLockStatus;
			transcript: SessionObserverTranscript;
	  }
	| {
			mode: "reconciling";
			transcript: SessionObserverTranscript;
	  };
export interface SessionLiveState {
	sessionControl?: SessionControlState;
	providerTransport?: ProviderTransportState;
	[key: string]: unknown;
}
export interface SessionRef {
	hostId: HostId;
	sessionId: SessionId;
	project: ProjectIdentity;
	revision: Revision;
	title: string;
	status: "active" | "idle" | "closed" | (string & {});
	updatedAt: string;
	archivedAt?: string;
	liveState?: SessionLiveState;
	model?: string;
	thinking?: string;
	pendingApproval?: boolean;
	pendingUserInput?: boolean;
	proposedPlan?: string;
	contextUsage?: ContextUsage;
}
export interface SessionListResult {
	cursor: Cursor;
	sessions: SessionRef[];
	totalCount: number;
	truncated: boolean;
}
export interface SessionsFrame {
	v: typeof PROTOCOL_VERSION;
	type: "sessions";
	hostId?: HostId;
	cursor: Cursor;
	sessions: SessionRef[];
	totalCount?: number;
	truncated?: boolean;
}
function decodeSessionControl(value: unknown, path: string): SessionControlState {
	const control = boundedMap(value, path);
	if (control.mode === "observer") {
		if (control.lockStatus !== "live" && control.lockStatus !== "suspect" && control.lockStatus !== "malformed")
			fail("INVALID_FRAME", "invalid observer lock status", `${path}.lockStatus`);
		if (control.transcript !== "live" && control.transcript !== "snapshot")
			fail("INVALID_FRAME", "invalid observer transcript state", `${path}.transcript`);
		if (Object.keys(control).some(key => !["mode", "lockStatus", "transcript"].includes(key)))
			fail("INVALID_FRAME", "unknown observer session control field", path);
		return control as unknown as SessionControlState;
	}
	if (control.mode === "reconciling") {
		if (control.transcript !== "live" && control.transcript !== "snapshot")
			fail("INVALID_FRAME", "invalid reconciling transcript state", `${path}.transcript`);
		if (Object.keys(control).some(key => !["mode", "transcript"].includes(key)))
			fail("INVALID_FRAME", "unknown reconciling session control field", path);
		return control as unknown as SessionControlState;
	}
	fail("INVALID_FRAME", "invalid session control mode", `${path}.mode`);
}
const PROVIDER_TRANSPORT_KEYS = new Set([
	"provider",
	"configuredPolicy",
	"websocketPreferred",
	"lastTransport",
	"websocketDisabled",
	"websocketConnected",
	"fallbackCount",
	"canAppend",
	"prewarmed",
	"hasSessionState",
	"hasTurnState",
	"fullContextRequests",
	"deltaRequests",
	"inputJsonBytes",
	"lastInputJsonBytes",
]);
export function decodeProviderTransportState(value: unknown, path: string): ProviderTransportState {
	const raw = boundedMap(value, path);
	for (const key of Object.keys(raw))
		if (!PROVIDER_TRANSPORT_KEYS.has(key))
			fail("INVALID_FRAME", "unknown provider transport field", `${path}.${key}`);
	if (raw.provider !== "openai-codex")
		fail("INVALID_FRAME", "invalid provider transport provider", `${path}.provider`);
	if (raw.configuredPolicy !== "auto" && raw.configuredPolicy !== "on" && raw.configuredPolicy !== "off")
		fail("INVALID_FRAME", "invalid provider transport policy", `${path}.configuredPolicy`);
	if (raw.lastTransport !== undefined && raw.lastTransport !== "websocket" && raw.lastTransport !== "sse")
		fail("INVALID_FRAME", "invalid provider transport kind", `${path}.lastTransport`);
	return {
		provider: raw.provider,
		configuredPolicy: raw.configuredPolicy,
		websocketPreferred: bool(raw.websocketPreferred, `${path}.websocketPreferred`),
		...(raw.lastTransport === undefined ? {} : { lastTransport: raw.lastTransport }),
		websocketDisabled: bool(raw.websocketDisabled, `${path}.websocketDisabled`),
		websocketConnected: bool(raw.websocketConnected, `${path}.websocketConnected`),
		fallbackCount: safeSeq(raw.fallbackCount, `${path}.fallbackCount`),
		canAppend: bool(raw.canAppend, `${path}.canAppend`),
		prewarmed: bool(raw.prewarmed, `${path}.prewarmed`),
		hasSessionState: bool(raw.hasSessionState, `${path}.hasSessionState`),
		hasTurnState: bool(raw.hasTurnState, `${path}.hasTurnState`),
		fullContextRequests: safeSeq(raw.fullContextRequests, `${path}.fullContextRequests`),
		deltaRequests: safeSeq(raw.deltaRequests, `${path}.deltaRequests`),
		inputJsonBytes: safeSeq(raw.inputJsonBytes, `${path}.inputJsonBytes`),
		...(raw.lastInputJsonBytes === undefined
			? {}
			: { lastInputJsonBytes: safeSeq(raw.lastInputJsonBytes, `${path}.lastInputJsonBytes`) }),
	};
}
function decodeListMetadata(
	value: Record<string, unknown>,
	path: string,
	sessionCount: number,
): { totalCount: number; truncated: boolean } {
	const totalCount = value.totalCount === undefined ? sessionCount : safeSeq(value.totalCount, `${path}.totalCount`);
	const truncated = value.truncated === undefined ? totalCount > sessionCount : value.truncated;
	if (typeof truncated !== "boolean") fail("INVALID_FRAME", "truncated must be boolean", `${path}.truncated`);
	if (totalCount < sessionCount)
		fail("INVALID_FRAME", "totalCount cannot be less than sessions length", `${path}.totalCount`);
	if (truncated !== totalCount > sessionCount) fail("INVALID_FRAME", "truncated does not match totalCount", path);
	return { totalCount, truncated };
}
export function decodeSessionRef(value: unknown, path: string): SessionRef {
	const session = boundedMap(value, path);
	hostId(session.hostId, `${path}.hostId`);
	sessionId(session.sessionId, `${path}.sessionId`);
	revision(session.revision, `${path}.revision`);
	const project = boundedMap(session.project, `${path}.project`);
	projectId(project.projectId, `${path}.project.projectId`);
	if (project.name !== undefined) optionalString(project.name, `${path}.project.name`, 256);
	controlFree(session.title, `${path}.title`, 512);
	controlFree(session.status, `${path}.status`, 64);
	controlFree(session.updatedAt, `${path}.updatedAt`, 128);
	if (session.archivedAt !== undefined) {
		const archivedAt = controlFree(session.archivedAt, `${path}.archivedAt`, 128);
		const timestamp = Date.parse(archivedAt);
		if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== archivedAt)
			fail("INVALID_FRAME", "archivedAt must be a canonical ISO timestamp", `${path}.archivedAt`);
	}
	if (session.liveState !== undefined) {
		boundedMetadata(session.liveState, `${path}.liveState`, isSecretLikeKey);
		const liveState = session.liveState as Record<string, unknown>;
		if (liveState.sessionControl !== undefined)
			decodeSessionControl(liveState.sessionControl, `${path}.liveState.sessionControl`);
		if (liveState.providerTransport !== undefined)
			decodeProviderTransportState(liveState.providerTransport, `${path}.liveState.providerTransport`);
	}
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
export function decodeSessionListResult(value: unknown): SessionListResult {
	const result = boundedMap(value, "result");
	const cursor = decodeCursor(result.cursor, "result.cursor");
	const values = boundedArray(result.sessions, "result.sessions");
	const sessions = values.map((entry, index) => decodeSessionRef(entry, `result.sessions[${index}]`));
	return {
		...result,
		cursor,
		sessions,
		...decodeListMetadata(result, "result", sessions.length),
	} as SessionListResult;
}
export function decodeSessions(input: unknown): SessionsFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "sessions") fail("INVALID_FRAME", "expected sessions frame", "type");
	const decodedHostId = frame.hostId === undefined ? undefined : hostId(frame.hostId, "hostId");
	const cursor = decodeCursor(frame.cursor);
	const values = boundedArray(frame.sessions, "sessions");
	const sessions = values.map((entry, index) => decodeSessionRef(entry, `sessions[${index}]`));
	const metadata = decodeListMetadata(frame, "frame", sessions.length);
	return {
		...frame,
		...(decodedHostId ? { hostId: decodedHostId } : {}),
		cursor,
		sessions,
		...metadata,
	} as unknown as SessionsFrame;
}
