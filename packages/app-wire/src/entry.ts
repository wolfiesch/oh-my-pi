import { fail } from "./errors.ts";
import { boundedArray, boundedMap, controlFree, inputObject } from "./guards.ts";
import { type EntryId, entryId, type HostId, hostId, type SessionId, sessionId } from "./ids.ts";
import { TRANSCRIPT_IMAGE_MAX_COUNT } from "./limits.ts";

export const TRANSCRIPT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type TranscriptImageMimeType = (typeof TRANSCRIPT_IMAGE_MIME_TYPES)[number];
export interface TranscriptImageMetadata {
	readonly sha256: string;
	readonly mimeType: TranscriptImageMimeType;
}

export function decodeTranscriptImageMetadata(input: unknown, path: string): TranscriptImageMetadata {
	const value = boundedMap(input, path);
	if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "sha256") || !Object.hasOwn(value, "mimeType"))
		fail("INVALID_FRAME", "transcript image metadata must contain only sha256 and mimeType", path);
	const sha256 = controlFree(value.sha256, `${path}.sha256`, 64);
	if (!/^[a-f0-9]{64}$/u.test(sha256))
		fail("INVALID_FRAME", "transcript image sha256 must be lowercase hexadecimal", `${path}.sha256`);
	const mimeType = controlFree(value.mimeType, `${path}.mimeType`, 32);
	if (!(TRANSCRIPT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType))
		fail("INVALID_FRAME", "unsupported transcript image MIME type", `${path}.mimeType`);
	return { sha256, mimeType: mimeType as TranscriptImageMimeType };
}

export function decodeTranscriptImageMetadataList(input: unknown, path: string): TranscriptImageMetadata[] {
	return boundedArray(input, path, TRANSCRIPT_IMAGE_MAX_COUNT).map((value, index) =>
		decodeTranscriptImageMetadata(value, `${path}[${index}]`),
	);
}
export interface DurableEntry {
	id: EntryId;
	parentId: EntryId | null;
	hostId: HostId;
	sessionId: SessionId;
	kind: string;
	timestamp: string;
	data: Record<string, unknown>;
}
export function decodeEntry(input: unknown, path = "entry"): DurableEntry {
	const value = path === "entry" ? inputObject(input) : boundedMap(input, path);
	entryId(value.id, `${path}.id`);
	if (value.parentId === undefined) fail("INVALID_FRAME", "parentId is required", `${path}.parentId`);
	if (value.parentId !== null) entryId(value.parentId, `${path}.parentId`);
	hostId(value.hostId, `${path}.hostId`);
	sessionId(value.sessionId, `${path}.sessionId`);
	controlFree(value.kind, `${path}.kind`, 128);
	controlFree(value.timestamp, `${path}.timestamp`, 128);
	const data = boundedMap(value.data, `${path}.data`);
	if (data.images !== undefined) decodeTranscriptImageMetadataList(data.images, `${path}.data.images`);
	return value as unknown as DurableEntry;
}
export function isDurableEntry(value: unknown): value is DurableEntry {
	try {
		decodeEntry(value);
		return true;
	} catch {
		return false;
	}
}
