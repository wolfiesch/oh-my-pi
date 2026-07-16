import { createHash } from "node:crypto";
import {
	type DurableEntry,
	decodeTranscriptImageMetadataList,
	type EntryId,
	type HostId,
	revision,
	type ServerFrame,
	type SessionEvent,
	type SessionRef,
	type SessionStateResult,
	type TranscriptImageMetadata,
} from "@oh-my-pi/app-wire";
import { boundSnapshotEntries } from "./snapshot-limits.ts";
import type { Projection, SessionRecord } from "./types.ts";

const MAX_REPLAY_BYTES = 512 * 1024;
const encoder = new TextEncoder();

export interface PendingPromptProjection {
	entryId: string;
	text: string;
	attachmentCount: number;
	at: string;
}

function replayBytes(frames: readonly ServerFrame[]): number {
	return frames.reduce((bytes, frame) => bytes + encoder.encode(JSON.stringify(frame)).byteLength, 0);
}

function frameCursor(frame: ServerFrame): { epoch: string; seq: number } | undefined {
	if (!("cursor" in frame) || !frame.cursor || typeof frame.cursor !== "object") return undefined;
	const cursor = frame.cursor;
	if (!("epoch" in cursor) || typeof cursor.epoch !== "string" || !("seq" in cursor) || typeof cursor.seq !== "number")
		return undefined;
	return { epoch: cursor.epoch, seq: cursor.seq };
}

function placeholderTitle(title: string): boolean {
	return title === "Session" || title === "Untitled" || title.trim() === "";
}

function settledRuntimeRef(current: SessionRef, status: SessionRef["status"]): SessionRef {
	const next: SessionRef = { ...current, status };
	delete next.pendingApproval;
	delete next.pendingUserInput;
	if (current.liveState) {
		const liveState: Record<string, unknown> = {
			...current.liveState,
			isStreaming: false,
			isCompacting: false,
			queuedMessageCount: 0,
		};
		delete liveState.pendingPrompt;
		delete liveState.pendingPrompts;
		delete liveState.queuedMessages;
		delete liveState.pendingApproval;
		delete liveState.pendingUserInput;
		delete liveState.runtimeCrashed;
		next.liveState = liveState;
	}
	return next;
}

export class SessionProjection {
	readonly value: Projection;
	#byId = new Map<string, DurableEntry>();
	#ringSize: number;
	#revisionHash = createHash("sha256");
	constructor(host: HostId, record: SessionRecord, epoch: string, ringSize = 256) {
		this.#ringSize = ringSize;
		for (const entry of record.entries) {
			const rebound = { ...entry, hostId: host, sessionId: record.sessionId };
			this.#byId.set(rebound.id, rebound);
		}
		const entries = [...this.#byId.values()];
		for (const entry of entries) this.#revisionHash.update(`${JSON.stringify(entry)}\n`);
		const currentRevision = revision(`r-${this.#revisionHash.copy().digest("hex").slice(0, 24)}`);
		this.value = {
			hostId: host,
			sessionId: record.sessionId,
			revision: currentRevision,
			cursor: { epoch, seq: 0 },
			entries,
			ref: {
				hostId: host,
				sessionId: record.sessionId,
				project: { projectId: record.projectId, name: record.projectName },
				revision: currentRevision,
				title: record.title,
				status: record.status,
				updatedAt: record.updatedAt,
				...(record.archivedAt ? { archivedAt: record.archivedAt } : {}),
				...(record.model ? { model: record.model } : {}),
				...(record.thinking ? { thinking: record.thinking } : {}),
			},
			indexCursor: { epoch, seq: 0 },
			ring: [],
		};
	}
	transcriptImage(entryId: EntryId, sha256: string): TranscriptImageMetadata | undefined {
		const entry = this.#byId.get(entryId);
		if (!entry || entry.data.images === undefined) return undefined;
		try {
			return decodeTranscriptImageMetadataList(entry.data.images, "entry.data.images").find(
				image => image.sha256 === sha256,
			);
		} catch {
			return undefined;
		}
	}
	updateStatus(status: SessionRef["status"]): ServerFrame | undefined {
		const current = this.value.ref;
		const next: SessionRef = status === "closed" ? settledRuntimeRef(current, status) : { ...current, status };
		if (status === "idle" && current.liveState?.isStreaming === true) {
			next.liveState = { ...current.liveState, isStreaming: false };
		} else if (status === "active" && current.liveState?.runtimeCrashed === true) {
			const liveState = { ...current.liveState };
			delete liveState.runtimeCrashed;
			next.liveState = liveState;
		}
		if (JSON.stringify(next) === JSON.stringify(current)) return undefined;
		return this.updateRef(next, `status:${status}`);
	}
	markRuntimeCrashed(): ServerFrame | undefined {
		const current = this.value.ref;
		const next = settledRuntimeRef(current, "closed");
		next.liveState = { ...(next.liveState ?? {}), runtimeCrashed: true };
		if (JSON.stringify(next) === JSON.stringify(current)) return undefined;
		return this.updateRef(next, "runtime:crashed");
	}
	markRuntimeRestartable(): ServerFrame | undefined {
		const current = this.value.ref;
		if (current.liveState?.runtimeCrashed !== true) return undefined;
		const next: SessionRef = { ...current, status: "idle" };
		if (JSON.stringify(next) === JSON.stringify(current)) return undefined;
		return this.updateRef(next, "runtime:restartable");
	}
	updateTitle(title: string): ServerFrame | undefined {
		if (!title || this.value.ref.title === title) return undefined;
		return this.updateRef({ ...this.value.ref, title }, `title:${title}`);
	}
	reconcileRecord(record: SessionRecord): ServerFrame | undefined {
		const current = this.value.ref;
		const sameProject = current.project.projectId === record.projectId;
		const projectName =
			sameProject && !current.project.name && record.projectName ? record.projectName : current.project.name;
		const project =
			sameProject && projectName !== current.project.name
				? { projectId: current.project.projectId, ...(projectName ? { name: projectName } : {}) }
				: current.project;
		const title = placeholderTitle(current.title) && !placeholderTitle(record.title) ? record.title : current.title;
		const archivedAt = record.archivedAt;
		if (project === current.project && title === current.title && archivedAt === current.archivedAt) return undefined;
		const next = { ...current, project, title };
		if (archivedAt) next.archivedAt = archivedAt;
		else delete next.archivedAt;
		return this.updateRef(next, `record:${record.updatedAt}:${archivedAt ?? "restored"}`);
	}
	updateArchivedAt(archivedAt?: string): ServerFrame | undefined {
		if (this.value.ref.archivedAt === archivedAt) return undefined;
		const next = { ...this.value.ref };
		if (archivedAt) next.archivedAt = archivedAt;
		else delete next.archivedAt;
		return this.updateRef(next, `archived:${archivedAt ?? "restored"}`);
	}
	indexUpsert(): ServerFrame {
		return {
			v: "omp-app/1",
			type: "session.delta",
			cursor: this.nextIndexCursor(),
			revision: this.value.revision,
			hostId: this.value.hostId,
			sessionId: this.value.sessionId,
			upsert: this.value.ref,
		};
	}
	remove(): ServerFrame {
		this.#revisionHash.update("deleted\n");
		const nextRevision = revision(`r-${this.#revisionHash.copy().digest("hex").slice(0, 24)}`);
		this.value.revision = nextRevision;
		return {
			v: "omp-app/1",
			type: "session.delta",
			cursor: this.nextIndexCursor(),
			revision: nextRevision,
			hostId: this.value.hostId,
			sessionId: this.value.sessionId,
			remove: this.value.sessionId,
		};
	}
	appendEntry(entry: DurableEntry): ServerFrame | undefined {
		const previous = this.#byId.get(entry.id);
		if (previous)
			return JSON.stringify(previous) === JSON.stringify(entry)
				? undefined
				: this.appendEvent({ type: "entry_conflict", entryId: entry.id });
		this.#byId.set(entry.id, entry);
		this.value.entries.push(entry);
		this.#revisionHash.update(`${JSON.stringify(entry)}\n`);
		this.value.revision = revision(`r-${this.#revisionHash.copy().digest("hex").slice(0, 24)}`);
		this.value.ref = { ...this.value.ref, revision: this.value.revision, updatedAt: entry.timestamp };
		return this.appendFrame({
			v: "omp-app/1",
			type: "entry",
			cursor: this.nextCursor(),
			revision: this.value.revision,
			hostId: this.value.hostId,
			sessionId: this.value.sessionId,
			entry,
		});
	}
	updateState(
		state: SessionStateResult,
		statusOverride?: SessionRef["status"],
		recoverClosedStatus = false,
	): ServerFrame | undefined {
		const next: SessionRef = { ...this.value.ref };
		const liveState = { ...(next.liveState ?? {}) };
		delete liveState.modelId;
		delete liveState.modelProvider;
		delete liveState.modelDisplayName;
		delete liveState.runtimeCrashed;
		if (state.queuedMessages) liveState.queuedMessages = state.queuedMessages;
		else delete liveState.queuedMessages;
		if (state.sessionName !== undefined) next.title = state.sessionName;
		if (state.model !== undefined) {
			next.model = `${state.model.provider}/${state.model.id}`;
			liveState.modelId = state.model.id;
			liveState.modelProvider = state.model.provider;
			if (state.model.displayName) liveState.modelDisplayName = state.model.displayName;
		} else delete next.model;
		if (state.thinking !== undefined) next.thinking = state.thinking;
		else delete next.thinking;
		if (state.contextUsage !== undefined) next.contextUsage = state.contextUsage;
		else delete next.contextUsage;
		if (next.status !== "closed" || recoverClosedStatus)
			next.status = statusOverride ?? (state.isStreaming ? "active" : "idle");
		next.liveState = {
			...liveState,
			isStreaming: state.isStreaming,
			isCompacting: state.isCompacting,
			isPaused: state.isPaused,
			messageCount: state.messageCount,
			queuedMessageCount: state.queuedMessageCount,
			steeringMode: state.steeringMode,
			followUpMode: state.followUpMode,
			interruptMode: state.interruptMode,
		};
		if (JSON.stringify(next) === JSON.stringify(this.value.ref)) return undefined;
		this.#revisionHash.update(`state:${JSON.stringify(next)}\n`);
		const nextRevision = revision(`r-${this.#revisionHash.copy().digest("hex").slice(0, 24)}`);
		next.revision = nextRevision;
		this.value.revision = nextRevision;
		this.value.ref = next;
		return {
			v: "omp-app/1",
			type: "session.delta",
			cursor: this.nextIndexCursor(),
			revision: nextRevision,
			hostId: this.value.hostId,
			sessionId: this.value.sessionId,
			upsert: next,
		};
	}
	updatePendingPrompts(pendingPrompts: readonly PendingPromptProjection[]): ServerFrame | undefined {
		const current = this.value.ref;
		const liveState = { ...(current.liveState ?? {}) };
		delete liveState.pendingPrompt;
		if (pendingPrompts.length > 0) liveState.pendingPrompts = [...pendingPrompts];
		else delete liveState.pendingPrompts;
		const next: SessionRef = { ...current };
		if (Object.keys(liveState).length > 0) next.liveState = liveState;
		else delete next.liveState;
		if (JSON.stringify(next) === JSON.stringify(current)) return undefined;
		return this.updateRef(next, `pending-prompts:${pendingPrompts.map(pending => pending.entryId).join(",")}`);
	}
	addPendingPrompt(pending: PendingPromptProjection): ServerFrame | undefined {
		const current = this.pendingPrompts();
		if (current.some(candidate => candidate.entryId === pending.entryId)) return undefined;
		return this.updatePendingPrompts([...current, pending]);
	}
	clearPendingPrompt(entryId: string): ServerFrame | undefined {
		const current = this.pendingPrompts();
		const next = current.filter(pending => pending.entryId !== entryId);
		if (next.length === current.length) return undefined;
		return this.updatePendingPrompts(next);
	}
	private pendingPrompts(): PendingPromptProjection[] {
		const value = this.value.ref.liveState?.pendingPrompts;
		if (!Array.isArray(value)) return [];
		return value.filter((pending): pending is PendingPromptProjection => {
			if (!pending || typeof pending !== "object" || Array.isArray(pending)) return false;
			const candidate = pending as Record<string, unknown>;
			return (
				typeof candidate.entryId === "string" &&
				typeof candidate.text === "string" &&
				typeof candidate.attachmentCount === "number" &&
				typeof candidate.at === "string"
			);
		});
	}
	appendEvent(event: SessionEvent): ServerFrame {
		return this.appendFrame({
			v: "omp-app/1",
			type: "event",
			cursor: this.nextCursor(),
			hostId: this.value.hostId,
			sessionId: this.value.sessionId,
			event,
		});
	}
	private updateRef(next: SessionRef, marker: string): ServerFrame {
		this.#revisionHash.update(`${marker}:${JSON.stringify(next)}\n`);
		const nextRevision = revision(`r-${this.#revisionHash.copy().digest("hex").slice(0, 24)}`);
		next.revision = nextRevision;
		this.value.revision = nextRevision;
		this.value.ref = next;
		return {
			v: "omp-app/1",
			type: "session.delta",
			cursor: this.nextIndexCursor(),
			revision: nextRevision,
			hostId: this.value.hostId,
			sessionId: this.value.sessionId,
			upsert: next,
		};
	}
	snapshot(): ServerFrame {
		return {
			v: "omp-app/1",
			type: "snapshot",
			cursor: this.value.cursor,
			revision: this.value.revision,
			hostId: this.value.hostId,
			sessionId: this.value.sessionId,
			entries: boundSnapshotEntries(
				this.value.entries,
				this.value.hostId,
				this.value.sessionId,
				this.value.ref.updatedAt,
			),
		};
	}
	private nextCursor() {
		this.value.cursor = { epoch: this.value.cursor.epoch, seq: this.value.cursor.seq + 1 };
		return this.value.cursor;
	}
	private nextIndexCursor() {
		this.value.indexCursor = { epoch: this.value.indexCursor.epoch, seq: this.value.indexCursor.seq + 1 };
		return this.value.indexCursor;
	}
	private appendFrame(frame: ServerFrame): ServerFrame {
		this.value.ring.push(frame);
		if (this.value.ring.length > this.#ringSize) this.value.ring.shift();
		return frame;
	}
	replay(cursor: { epoch: string; seq: number }): ServerFrame[] {
		if (cursor.epoch !== this.value.cursor.epoch)
			return [
				{
					v: "omp-app/1",
					type: "gap",
					hostId: this.value.hostId,
					sessionId: this.value.sessionId,
					from: { epoch: this.value.cursor.epoch, seq: 0 },
					to: this.value.cursor,
					reason: "epoch_mismatch",
				},
				this.snapshot(),
			];
		const oldest = this.value.ring[0];
		const oldestSeq = oldest ? (frameCursor(oldest)?.seq ?? this.value.cursor.seq + 1) : this.value.cursor.seq + 1;
		if (cursor.seq < oldestSeq - 1)
			return [
				{
					v: "omp-app/1",
					type: "gap",
					hostId: this.value.hostId,
					sessionId: this.value.sessionId,
					from: { epoch: cursor.epoch, seq: cursor.seq + 1 },
					to: this.value.cursor,
					reason: "ring_evicted",
				},
				this.snapshot(),
			];
		const frames = this.value.ring.filter(frame => (frameCursor(frame)?.seq ?? 0) > cursor.seq);
		if (replayBytes(frames) <= MAX_REPLAY_BYTES) return frames;
		return [
			{
				v: "omp-app/1",
				type: "gap",
				hostId: this.value.hostId,
				sessionId: this.value.sessionId,
				from: { epoch: cursor.epoch, seq: cursor.seq + 1 },
				to: this.value.cursor,
				reason: "replay_budget_exceeded",
			},
			this.snapshot(),
		];
	}
}
