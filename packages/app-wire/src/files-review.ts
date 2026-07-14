import { fail } from "./errors";
import { boundedArray, boundedMap, boundedText, controlFree, inputObject, safeRelativePath } from "./guards";
import { type HostId, hostId, type SessionId, sessionId } from "./ids";
import { MAX_FILE_BYTES, PROTOCOL_VERSION } from "./limits";
export interface FileFrame {
	v: typeof PROTOCOL_VERSION;
	type: "files";
	hostId: HostId;
	sessionId: SessionId;
	path: string;
	content?: string;
	truncated?: boolean;
}
export interface ReviewFrame {
	v: typeof PROTOCOL_VERSION;
	type: "review";
	hostId: HostId;
	sessionId: SessionId;
	reviewId: string;
	status: string;
	path?: string;
	findings: Record<string, unknown>[];
}
export function decodeFiles(input: unknown): FileFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "files") fail("INVALID_FRAME", "expected files frame", "type");
	hostId(frame.hostId);
	sessionId(frame.sessionId);
	const path = safeRelativePath(frame.path);
	if (frame.content !== undefined) boundedText(frame.content, "content", MAX_FILE_BYTES);
	if (frame.truncated !== undefined && typeof frame.truncated !== "boolean")
		fail("INVALID_FRAME", "truncated must be boolean", "truncated");
	return { ...frame, path } as unknown as FileFrame;
}
export function decodeReview(input: unknown): ReviewFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "review") fail("INVALID_FRAME", "expected review frame", "type");
	hostId(frame.hostId);
	sessionId(frame.sessionId);
	controlFree(frame.reviewId, "reviewId", 256);
	controlFree(frame.status, "status", 64);
	if (frame.path !== undefined) safeRelativePath(frame.path, "path");
	const findings = boundedArray(frame.findings, "findings");
	for (let i = 0; i < findings.length; i++) boundedMap(findings[i], `findings[${i}]`);
	return frame as unknown as ReviewFrame;
}
