import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionHeader } from "./session-entries";
import type { SessionInfo, SessionStatus } from "./session-listing";
import { loadEntriesFromFile } from "./session-loader";
import { SessionManager } from "./session-manager";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import { normalizeSessionWorkspace, type SessionWorkspace } from "./session-workspace";

export type SessionCatalogScope = "cwd" | "all";

export interface SessionCatalogEntry {
	path: string;
	id: string;
	cwd: string;
	title?: string;
	parentSessionPath?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	size: number;
	status?: SessionStatus;
}

export interface SessionCatalogQuery {
	scope?: SessionCatalogScope;
	cwd?: string;
	cursor?: string;
	limit?: number;
	search?: string;
}

export interface SessionCatalogPage {
	sessions: SessionCatalogEntry[];
	nextCursor?: string;
	total: number;
}

export interface SessionCatalogInfoPage {
	sessions: SessionInfo[];
	nextCursor?: string;
	total: number;
}

export interface SessionCatalogResolution {
	session: SessionInfo;
	entry: SessionCatalogEntry;
}

export interface SessionWorkspaceRoot {
	cwd: string;
	count: number;
	latest: string;
	exists: boolean;
}

export type SessionCatalogErrorCode =
	| "invalid_cwd"
	| "invalid_cursor"
	| "invalid_limit"
	| "session_not_found"
	| "session_ambiguous"
	| "path_not_in_catalog";

export class SessionCatalogError extends Error {
	constructor(
		message: string,
		readonly code: SessionCatalogErrorCode,
	) {
		super(message);
		this.name = "SessionCatalogError";
	}
}

function assertAbsoluteCwd(cwd: string): string {
	if (!path.isAbsolute(cwd)) throw new SessionCatalogError(`Session cwd must be absolute: ${cwd}`, "invalid_cwd");
	return path.resolve(cwd);
}

export function projectSessionCatalogEntry(session: SessionInfo): SessionCatalogEntry {
	return {
		path: path.resolve(session.path),
		id: session.id,
		cwd: session.cwd,
		...(session.title ? { title: session.title } : {}),
		...(session.parentSessionPath ? { parentSessionPath: session.parentSessionPath } : {}),
		createdAt: session.created.toISOString(),
		updatedAt: session.modified.toISOString(),
		messageCount: session.messageCount,
		size: session.size,
		...(session.status ? { status: session.status } : {}),
	};
}

function compareSessions(left: SessionInfo, right: SessionInfo): number {
	return (
		right.modified.getTime() - left.modified.getTime() ||
		path.resolve(left.path).localeCompare(path.resolve(right.path))
	);
}

interface SessionCatalogSnapshotCursor {
	sessions: SessionInfo[];
	offset: number;
	limit: number;
	expiresAt: number;
	nextCursor?: string;
}

interface SessionCatalogSnapshotGroup {
	tokens: Set<string>;
}

const SESSION_CATALOG_CURSOR_TTL_MS = 5 * 60_000;
const SESSION_CATALOG_CURSOR_MAX = 256;
const DEFAULT_SESSION_CATALOG_SNAPSHOT_ENTRY_MAX = 100_000;
let sessionCatalogSnapshotEntryMax = DEFAULT_SESSION_CATALOG_SNAPSHOT_ENTRY_MAX;
let retainedSessionCatalogSnapshotEntries = 0;
const sessionCatalogCursors = new Map<string, SessionCatalogSnapshotCursor>();
const sessionCatalogSnapshotGroups = new Map<SessionInfo[], SessionCatalogSnapshotGroup>();

function removeSnapshotGroup(sessions: SessionInfo[]): void {
	const group = sessionCatalogSnapshotGroups.get(sessions);
	if (!group) return;
	for (const token of group.tokens) sessionCatalogCursors.delete(token);
	sessionCatalogSnapshotGroups.delete(sessions);
	retainedSessionCatalogSnapshotEntries -= sessions.length;
}

function removeSnapshotCursor(token: string): void {
	const cursor = sessionCatalogCursors.get(token);
	if (!cursor) return;
	sessionCatalogCursors.delete(token);
	const group = sessionCatalogSnapshotGroups.get(cursor.sessions);
	if (!group) return;
	group.tokens.delete(token);
	if (group.tokens.size === 0) removeSnapshotGroup(cursor.sessions);
}

function enforceSnapshotBounds(): void {
	while (
		retainedSessionCatalogSnapshotEntries > sessionCatalogSnapshotEntryMax ||
		(sessionCatalogCursors.size > SESSION_CATALOG_CURSOR_MAX && sessionCatalogSnapshotGroups.size > 1)
	) {
		const oldest = sessionCatalogSnapshotGroups.keys().next().value;
		if (oldest === undefined) break;
		removeSnapshotGroup(oldest);
	}
}

function storeSnapshotCursor(cursor: SessionCatalogSnapshotCursor): string {
	if (cursor.sessions.length > sessionCatalogSnapshotEntryMax)
		throw new SessionCatalogError("Session catalog is too large for a stable pagination snapshot", "invalid_cursor");
	const token = crypto.randomUUID();
	sessionCatalogCursors.set(token, cursor);
	let group = sessionCatalogSnapshotGroups.get(cursor.sessions);
	if (!group) {
		group = { tokens: new Set() };
		sessionCatalogSnapshotGroups.set(cursor.sessions, group);
		retainedSessionCatalogSnapshotEntries += cursor.sessions.length;
	}
	group.tokens.add(token);
	enforceSnapshotBounds();
	return token;
}

function pageSnapshot(snapshot: SessionCatalogSnapshotCursor, token?: string): SessionCatalogInfoPage {
	if (snapshot.expiresAt <= Date.now()) {
		if (token) removeSnapshotCursor(token);
		throw new SessionCatalogError("Session catalog cursor has expired", "invalid_cursor");
	}
	const sessions = snapshot.sessions.slice(snapshot.offset, snapshot.offset + snapshot.limit);
	const nextOffset = snapshot.offset + sessions.length;
	if (nextOffset < snapshot.sessions.length && !snapshot.nextCursor) {
		snapshot.nextCursor = storeSnapshotCursor({
			sessions: snapshot.sessions,
			offset: nextOffset,
			limit: snapshot.limit,
			expiresAt: snapshot.expiresAt,
		});
	}
	return {
		sessions,
		total: snapshot.sessions.length,
		...(snapshot.nextCursor ? { nextCursor: snapshot.nextCursor } : {}),
	};
}

/** Test seam for deterministic snapshot-retention coverage. Restores and clears cursor state on cleanup. */
export function setSessionCatalogSnapshotEntryLimitForTesting(limit: number): () => void {
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Snapshot entry limit must be a positive integer");
	sessionCatalogSnapshotEntryMax = limit;
	enforceSnapshotBounds();
	return () => {
		for (const sessions of [...sessionCatalogSnapshotGroups.keys()]) removeSnapshotGroup(sessions);
		sessionCatalogSnapshotEntryMax = DEFAULT_SESSION_CATALOG_SNAPSHOT_ENTRY_MAX;
	};
}

export async function listCatalogSessionInfo(
	query: Pick<SessionCatalogQuery, "scope" | "cwd"> = {},
	storage: SessionStorage = new FileSessionStorage(),
): Promise<SessionInfo[]> {
	const scope = query.scope ?? (query.cwd ? "cwd" : "all");
	const cwd = query.cwd === undefined ? undefined : assertAbsoluteCwd(query.cwd);
	if (scope === "cwd" && !cwd) throw new SessionCatalogError("cwd scope requires an absolute cwd", "invalid_cwd");
	const sessions =
		scope === "all" ? await SessionManager.listAll(storage) : await SessionManager.list(cwd!, undefined, storage);
	return sessions.sort(compareSessions);
}

export async function listCatalogSessionInfoPage(
	query: SessionCatalogQuery = {},
	storage: SessionStorage = new FileSessionStorage(),
): Promise<SessionCatalogInfoPage> {
	const limit = query.limit ?? 50;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
		throw new SessionCatalogError("Session list limit must be an integer from 1 to 200", "invalid_limit");
	if (query.cursor !== undefined) {
		const snapshot = sessionCatalogCursors.get(query.cursor);
		if (!snapshot) throw new SessionCatalogError("Invalid or expired session catalog cursor", "invalid_cursor");
		return pageSnapshot(snapshot, query.cursor);
	}
	let sessions = await listCatalogSessionInfo(query, storage);
	const search = query.search?.trim().toLocaleLowerCase();
	if (search) {
		sessions = sessions.filter(session =>
			[session.title, session.id].some(value => value?.toLocaleLowerCase().includes(search)),
		);
	}
	sessions = sessions.map(session => ({ ...session, firstMessage: "", allMessagesText: "" }));
	return pageSnapshot({
		sessions,
		offset: 0,
		limit,
		expiresAt: Date.now() + SESSION_CATALOG_CURSOR_TTL_MS,
	});
}

export async function listSessionCatalog(
	query: SessionCatalogQuery = {},
	storage: SessionStorage = new FileSessionStorage(),
): Promise<SessionCatalogPage> {
	const page = await listCatalogSessionInfoPage(query, storage);
	return {
		sessions: page.sessions.map(projectSessionCatalogEntry),
		total: page.total,
		...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
	};
}

export async function resolveSessionCatalogReference(
	reference: string,
	query: Pick<SessionCatalogQuery, "scope" | "cwd"> = {},
	storage: SessionStorage = new FileSessionStorage(),
): Promise<SessionCatalogResolution> {
	const sessions = await listCatalogSessionInfo(query, storage);
	if (path.isAbsolute(reference)) {
		const resolved = path.resolve(reference);
		const match = sessions.find(session => path.resolve(session.path) === resolved);
		if (!match)
			throw new SessionCatalogError(
				`Session path is not present in the catalog: ${reference}`,
				"path_not_in_catalog",
			);
		return { session: match, entry: projectSessionCatalogEntry(match) };
	}
	const normalized = reference.toLocaleLowerCase();
	const exact = sessions.filter(session => session.id.toLocaleLowerCase() === normalized);
	const matches =
		exact.length > 0 ? exact : sessions.filter(session => session.id.toLocaleLowerCase().startsWith(normalized));
	if (matches.length === 0) throw new SessionCatalogError(`Session not found: ${reference}`, "session_not_found");
	if (matches.length > 1)
		throw new SessionCatalogError(`Session reference is ambiguous: ${reference}`, "session_ambiguous");
	const match = matches[0]!;
	return { session: match, entry: projectSessionCatalogEntry(match) };
}

export async function inspectPersistedSessionWorkspace(
	sessionPath: string,
	fallbackCwd: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<SessionWorkspace> {
	const entries = await loadEntriesFromFile(sessionPath, storage);
	const header = entries.find(entry => entry.type === "session") as SessionHeader | undefined;
	return normalizeSessionWorkspace({
		cwd: header?.cwd || fallbackCwd,
		directories: header?.additionalDirectories,
	});
}

export async function listSessionWorkspaceRoots(
	storage: SessionStorage = new FileSessionStorage(),
): Promise<SessionWorkspaceRoot[]> {
	const sessions = await listCatalogSessionInfo({ scope: "all" }, storage);
	const grouped = new Map<string, { count: number; latest: Date }>();
	for (const session of sessions) {
		if (!session.cwd || !path.isAbsolute(session.cwd)) continue;
		const cwd = path.resolve(session.cwd);
		const current = grouped.get(cwd);
		if (current) {
			current.count += 1;
			if (session.modified > current.latest) current.latest = session.modified;
		} else {
			grouped.set(cwd, { count: 1, latest: session.modified });
		}
	}
	const roots = await Promise.all(
		Array.from(grouped, async ([cwd, value]): Promise<SessionWorkspaceRoot> => {
			let exists = false;
			try {
				exists = (await fs.stat(cwd)).isDirectory();
			} catch {
				// Missing and inaccessible persisted roots remain visible.
			}
			return { cwd, count: value.count, latest: value.latest.toISOString(), exists };
		}),
	);
	return roots.sort((left, right) => right.latest.localeCompare(left.latest) || left.cwd.localeCompare(right.cwd));
}
