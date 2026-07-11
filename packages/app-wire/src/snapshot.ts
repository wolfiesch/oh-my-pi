import { decodeCursor, type Cursor } from "./cursor.ts";
import { decodeEntry, type DurableEntry } from "./entry.ts";
import { hostId, revision, sessionId, type HostId, type Revision, type SessionId } from "./ids.ts";
import { boundedArray, inputObject } from "./guards.ts";
import { PROTOCOL_VERSION } from "./limits.ts";
import { fail } from "./errors.ts";
export interface SessionSnapshotFrame {
	v: typeof PROTOCOL_VERSION;
	type: "snapshot";
	cursor: Cursor;
	revision: Revision;
	hostId: HostId;
	sessionId: SessionId;
	entries: DurableEntry[];
}
export function decodeSnapshot(input: unknown): SessionSnapshotFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "snapshot") fail("INVALID_FRAME", "expected snapshot frame", "type");
	const cursor = decodeCursor(frame.cursor);
	const currentRevision = revision(frame.revision);
	const host = hostId(frame.hostId);
	const session = sessionId(frame.sessionId);
	const entries = boundedArray(frame.entries, "entries").map((value, i) => {
		const entry = decodeEntry(value, `entries[${i}]`);
		if (entry.hostId !== host || entry.sessionId !== session)
			fail("INVALID_FRAME", "entry belongs to another session", `entries[${i}]`);
		return entry;
	});
	return { ...frame, cursor, revision: currentRevision, entries } as unknown as SessionSnapshotFrame;
}
