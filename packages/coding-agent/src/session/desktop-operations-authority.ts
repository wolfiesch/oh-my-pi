import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
	type ArtifactDescriptor,
	safeRelativePath as appWireSafeRelativePath,
	decodeCatalog,
	decodeTurnReviewSnapshot,
	type TurnFileChange,
	type TurnId,
	turnId,
} from "@oh-my-pi/app-wire";
import {
	Process as NativeProcess,
	PtySession,
	type SecureDirectoryEntry,
	type SecureListDirectoryResult,
	type SecureReadFileResult,
	type SecureWriteFileResult,
	secureListDirectory,
	secureReadFile,
	secureWriteFileAtomic,
} from "@oh-my-pi/pi-natives";
import type { Settings } from "../config/settings";
import { parseApplyPatch } from "../edit/apply-patch/parser";
import { type ApplyPatchResult, applyPatch, type FileSystem, type PatchInput } from "../edit/modes/patch";
import type { SessionManager } from "./session-manager";
import { captureWorktreeTree } from "./turn-review";

const MAX_FILE_BYTES = 1024 * 1024;
type MutableTurnFileChange = Omit<TurnFileChange, "state"> & { state: TurnFileChange["state"] };
interface TurnSnapshot {
	readonly turnId: TurnId;
	readonly baseTree: string;
	readonly headTree: string;
	readonly changes: MutableTurnFileChange[];
	readonly patch?: ArtifactDescriptor;
}
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 1_000;
const MAX_COMMAND_MS = 120_000;
const SECRET_KEY = /password|passwd|secret|token|credential|api[_-]?key|private[_-]?key/i;
const ALLOWED_SHELLS = new Set(["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/fish"]);

export interface OperationContextLike {
	sessionId?: string;
	expectedRevision?: string;
	currentRevision?: string;
	abortSignal?: AbortSignal;
}
export interface SecureFsAdapter {
	secureReadFile(
		root: string,
		relativePath: string,
		maxBytes: number,
	): SecureReadFileResult | Promise<SecureReadFileResult>;
	secureListDirectory(
		root: string,
		relativePath: string | undefined | null,
		maxEntries: number,
	): SecureListDirectoryResult | Promise<SecureListDirectoryResult>;
	secureWriteFileAtomic(
		root: string,
		relativePath: string,
		data: Buffer,
		expectedRevision: string | undefined | null,
		maxBytes: number,
	): SecureWriteFileResult | Promise<SecureWriteFileResult>;
}
export interface DesktopReviewReadRequest {
	reviewId: string;
	signal?: AbortSignal;
}
export interface LegacyDesktopReviewApplyRequest {
	reviewId: string;
	expectedRevision?: string;
	signal?: AbortSignal;
}
export interface TurnDesktopReviewApplyRequest {
	turnId: string;
	path: string;
	action: "keep" | "discard";
	expectedRevision?: string;
	signal?: AbortSignal;
}
export type DesktopReviewApplyRequest = LegacyDesktopReviewApplyRequest | TurnDesktopReviewApplyRequest;
export interface ReviewStore {
	read(request: DesktopReviewReadRequest, context?: OperationContextLike): unknown | Promise<unknown>;
	apply(request: LegacyDesktopReviewApplyRequest, context?: OperationContextLike): unknown | Promise<unknown>;
}
type DesktopSessionManager = Pick<SessionManager, "getCwd" | "getSessionId"> &
	Partial<Pick<SessionManager, "appendCustomEntry" | "getBranch">>;

export interface DesktopAuthorityContext {
	sessionManager: DesktopSessionManager;
	projectRootForSession: (sessionId: string) => string;
	secureFs?: SecureFsAdapter;
	reviewStore?: ReviewStore;
	agentAuthority?: { cancel(agentId: string, sessionId: string): Promise<boolean> };
	settingsAuthority?: {
		read(): Promise<Record<string, unknown>> | Record<string, unknown>;
		write(path: string, value: unknown): Promise<void> | void;
	};
	catalogAuthority?: { list(): Promise<unknown[]> | unknown[] };
	settings?: Settings;
}
export interface DesktopFileRequest {
	path: string;
	encoding?: "utf8" | "base64";
	signal?: AbortSignal;
}
export interface DesktopFileListRequest {
	path?: string;
	signal?: AbortSignal;
}
export interface DesktopWriteRequest extends DesktopFileRequest {
	content: string;
	expectedRevision?: string;
}
export interface DesktopPatchRequest extends DesktopFileRequest {
	patch: string;
	expectedRevision?: string;
}
export interface DesktopFileDiffRequest extends DesktopFileRequest {
	content?: string;
	fromRevision?: string;
}
export interface DesktopTurnDiffRequest {
	turnId: string;
	signal?: AbortSignal;
}
export type DesktopDiffRequest = DesktopFileDiffRequest | DesktopTurnDiffRequest;
export interface DesktopFileReadResult {
	path: string;
	content: string;
	encoding: "utf8" | "base64";
	revision: string;
	size: number;
}
export interface DesktopTerminalRequest {
	shell?: string;
	cwd?: string;
	cols?: number;
	rows?: number;
	timeoutMs?: number;
	env?: Record<string, string>;
	signal?: AbortSignal;
	onOutput?: (stream: "stdout" | "stderr", data: string) => void;
	onExit?: (result: { exitCode?: number; cancelled: boolean; timedOut: boolean }) => void;
}
interface ProcessResult {
	stdout: string;
	stderr: string;
	exitCode?: number;
	cancelled: boolean;
	timedOut: boolean;
	truncated: boolean;
}
interface TerminalHandle {
	owner: string;
	pty: PtySession;
	closed: boolean;
}
const DEFAULT_SECURE_FS: SecureFsAdapter = { secureReadFile, secureListDirectory, secureWriteFileAtomic };
const CATALOG_KINDS = new Set(["tool", "model", "command", "setting", "skill", "agent", "provider", "mode"]);

function protocolError(code: string): Error {
	const messages: Record<string, string> = {
		FORBIDDEN: "operation is not permitted",
		NOT_FOUND: "resource was not found",
		STALE_REVISION: "file revision is stale",
		UNSUPPORTED: "operation is unsupported",
		BOUNDS: "resource exceeds protocol bounds",
		ABORTED: "operation was cancelled",
		OPERATION_FAILED: "operation failed",
		stale_turn: "turn targets are stale",
	};
	return Object.assign(new Error(messages[code] ?? "operation failed"), { code });
}
function nativeCode(error: unknown): string | undefined {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
		return error.code.toUpperCase();
	return String(error).match(/\b(UNSAFE_PATH|NOT_FOUND|BOUNDS|CONFLICT|STALE_REVISION|ABORTED|UNSUPPORTED)\b/)?.[1];
}
function mapNative(error: unknown): never {
	const code = nativeCode(error);
	if (code === "UNSAFE_PATH") throw protocolError("FORBIDDEN");
	if (code === "NOT_FOUND") throw protocolError("NOT_FOUND");
	if (code === "BOUNDS") throw protocolError("BOUNDS");
	if (code === "CONFLICT" || code === "STALE_REVISION") throw protocolError("STALE_REVISION");
	if (code === "ABORTED") throw protocolError("ABORTED");
	throw protocolError("OPERATION_FAILED");
}
function boundedText(value: string, max = MAX_FILE_BYTES): string {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > max) throw protocolError("BOUNDS");
	return value;
}
function safeRelativePath(value: string): string {
	if (
		typeof value !== "string" ||
		!value ||
		isAbsolute(value) ||
		/^[A-Za-z]:/.test(value) ||
		value.includes("\\") ||
		value.includes("\0")
	)
		throw protocolError("FORBIDDEN");
	const parts = value.split("/");
	if (parts.some(part => part === "." || part === "..")) throw protocolError("FORBIDDEN");
	const result = parts.filter(Boolean).join("/");
	if (!result) throw protocolError("FORBIDDEN");
	return result;
}
interface ProtocolSafeDirectoryEntry {
	path: string;
	kind: "file" | "directory" | "symlink";
	size?: number;
}
function protocolSafeDirectoryEntry(entry: SecureDirectoryEntry): ProtocolSafeDirectoryEntry | undefined {
	const kind =
		entry.kind === "file" || entry.kind === "directory" || entry.kind === "symlink" ? entry.kind : undefined;
	if (
		!kind ||
		!entry.name ||
		entry.name.includes("/") ||
		entry.name.includes("\\") ||
		/[\u0000-\u001f\u007f]/.test(entry.name)
	)
		return undefined;
	try {
		const path = appWireSafeRelativePath(entry.path);
		return { path, kind, ...(entry.size === undefined ? {} : { size: entry.size }) };
	} catch {
		return undefined;
	}
}
function freeze<T>(value: T): T {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
	return Object.freeze(value);
}
function decodeContent(value: string, encoding: "utf8" | "base64" = "utf8"): Buffer {
	if (encoding === "utf8") return Buffer.from(boundedText(value), "utf8");
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || value.length % 4 !== 0)
		throw protocolError("OPERATION_FAILED");
	const data = Buffer.from(value, "base64");
	if (data.toString("base64") !== value) throw protocolError("OPERATION_FAILED");
	if (data.byteLength > MAX_FILE_BYTES) throw protocolError("BOUNDS");
	return data;
}
function decodeUtf8(data: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(data);
	} catch {
		throw protocolError("OPERATION_FAILED");
	}
}
function catalogItem(value: unknown, index: number): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`catalog item ${index} must be an object`);
	const item = value as Record<string, unknown>;
	if (
		typeof item.id !== "string" ||
		!item.id ||
		typeof item.kind !== "string" ||
		!CATALOG_KINDS.has(item.kind) ||
		typeof item.name !== "string" ||
		!item.name
	)
		throw new Error(`catalog item ${index} is missing required fields`);
	return {
		id: boundedText(item.id, 256),
		kind: item.kind,
		name: boundedText(item.name, 256),
		...(typeof item.description === "string" ? { description: boundedText(item.description, 4096) } : {}),
	};
}
function diffText(path: string, before: string, after: string): string {
	if (before === after) return "";
	const oldLines = before.split("\n"),
		newLines = after.split("\n");
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
	)
		suffix++;
	const removed = oldLines.slice(prefix, oldLines.length - suffix),
		added = newLines.slice(prefix, newLines.length - suffix);
	return boundedText(
		`--- ${path}\n+++ ${path}\n@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@\n${[...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)].join("\n")}\n`,
	);
}
function safeEnv(input: Record<string, string> | undefined): Record<string, string> {
	const result: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: process.env.HOME ?? "/",
		TERM: process.env.TERM ?? "dumb",
	};
	for (const [key, value] of Object.entries(input ?? {}))
		if (!SECRET_KEY.test(key)) result[key] = boundedText(value, 4096);
	return result;
}
async function readStreamBounded(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
	const reader = stream.getReader(),
		chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > max) throw new Error("output exceeds limit");
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}
async function runArgv(
	argv: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutMs = MAX_COMMAND_MS,
	env?: Record<string, string>,
): Promise<ProcessResult> {
	if (signal?.aborted)
		return { stdout: "", stderr: "", exitCode: undefined, cancelled: true, timedOut: false, truncated: false };
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeout must be positive");
	const proc = Bun.spawn(argv, {
		cwd,
		env: env ?? safeEnv(undefined),
		stdout: "pipe",
		stderr: "pipe",
		detached: process.platform !== "win32",
	});
	let cancelled = false,
		timedOut = false,
		truncated = false,
		killed = false,
		hardKillTimer: NodeJS.Timeout | undefined;
	const kill = () => {
		if (killed) return;
		killed = true;
		const pid = proc.pid;
		try {
			if (process.platform !== "win32" && typeof pid === "number") process.kill(-pid, "SIGTERM");
			else if (typeof pid === "number") NativeProcess.fromPid(pid)?.killTree(15);
		} catch {}
		hardKillTimer = setTimeout(() => {
			try {
				if (process.platform !== "win32" && typeof pid === "number") process.kill(-pid, "SIGKILL");
				else if (typeof pid === "number") NativeProcess.fromPid(pid)?.killTree(9);
			} catch {}
		}, 100);
		hardKillTimer.unref?.();
	};
	const onAbort = () => {
		cancelled = true;
		kill();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		kill();
	}, timeoutMs);
	try {
		let stdout: Uint8Array<ArrayBufferLike> = new Uint8Array(),
			stderr: Uint8Array<ArrayBufferLike> = new Uint8Array(),
			exitCode: number | undefined;
		try {
			[stdout, stderr, exitCode] = await Promise.all([
				readStreamBounded(proc.stdout, MAX_OUTPUT_BYTES),
				readStreamBounded(proc.stderr, MAX_OUTPUT_BYTES),
				proc.exited,
			]);
		} catch {
			truncated = true;
			kill();
			await proc.exited.catch(() => undefined);
		}
		return {
			stdout: new TextDecoder().decode(stdout),
			stderr: new TextDecoder().decode(stderr).replaceAll(cwd, "<session-root>"),
			exitCode,
			cancelled,
			timedOut,
			truncated,
		};
	} finally {
		clearTimeout(timer);
		clearTimeout(hardKillTimer);
		signal?.removeEventListener("abort", onAbort);
	}
}

function normalizedSecureFs(adapter: SecureFsAdapter): SecureFsAdapter {
	return {
		secureReadFile: async (root, path, max) => {
			try {
				return await adapter.secureReadFile(root, path, max);
			} catch (error) {
				throw new Error(String(error));
			}
		},
		secureListDirectory: async (root, path, max) => {
			try {
				return await adapter.secureListDirectory(root, path, max);
			} catch (error) {
				throw new Error(String(error));
			}
		},
		secureWriteFileAtomic: async (root, path, data, revision, max) => {
			try {
				return await adapter.secureWriteFileAtomic(root, path, data, revision, max);
			} catch (error) {
				throw new Error(String(error));
			}
		},
	};
}
export class CodingAgentDesktopAuthority {
	readonly #context: DesktopAuthorityContext;
	readonly #secureFs: SecureFsAdapter;
	readonly #terminals = new Map<string, TerminalHandle>();
	readonly #owner: string;
	constructor(context: DesktopAuthorityContext, owner = "desktop") {
		this.#context = context;
		this.#secureFs = normalizedSecureFs(context.secureFs ?? DEFAULT_SECURE_FS);
		this.#owner = owner;
	}
	#getRoot(sessionId = this.#context.sessionManager.getSessionId()): string {
		try {
			const root = this.#context.projectRootForSession(sessionId);
			if (!isAbsolute(root)) throw protocolError("FORBIDDEN");
			return root;
		} catch {
			throw protocolError("FORBIDDEN");
		}
	}
	#session(context?: OperationContextLike): string {
		return context?.sessionId ?? this.#context.sessionManager.getSessionId();
	}
	#signal(request: { signal?: AbortSignal }, context?: OperationContextLike): AbortSignal | undefined {
		if (request.signal?.aborted || context?.abortSignal?.aborted) throw protocolError("ABORTED");
		return context?.abortSignal ?? request.signal;
	}
	#expected(
		request: { expectedRevision?: string },
		context: OperationContextLike | undefined,
		required: boolean,
	): string | undefined {
		const revision = context?.expectedRevision ?? request.expectedRevision;
		if (required && revision === undefined) throw protocolError("STALE_REVISION");
		return revision;
	}
	#turnSnapshot(rawTurnId: string): TurnSnapshot {
		const requested = turnId(rawTurnId, "turnId");
		let result: TurnSnapshot | undefined;
		const getBranch = this.#context.sessionManager.getBranch;
		if (!getBranch) throw protocolError("UNSUPPORTED");
		const entries = getBranch.call(this.#context.sessionManager);
		for (const entry of entries) {
			const data = entry.type === "custom" && entry.customType === "turn-review" ? entry.data : undefined;
			if (
				!data ||
				typeof data !== "object" ||
				!("turnId" in data) ||
				data.turnId !== requested ||
				!("baseTree" in data) ||
				!("headTree" in data) ||
				!("changes" in data)
			)
				continue;
			try {
				const snapshot = decodeTurnReviewSnapshot(
					{
						turnId: data.turnId,
						baseTree: data.baseTree,
						headTree: data.headTree,
						changes: data.changes,
						...("patch" in data ? { patch: data.patch } : {}),
					},
					"turn-review",
				);
				result = {
					...snapshot,
					changes: snapshot.changes.map(change => ({ ...change })),
					...(snapshot.patch === undefined ? {} : { patch: snapshot.patch }),
				};
			} catch {}
		}
		if (!result) throw protocolError("NOT_FOUND");
		for (const entry of entries) {
			const action = entry.type === "custom" && entry.customType === "turn-review-action" ? entry.data : undefined;
			if (
				!action ||
				typeof action !== "object" ||
				!("turnId" in action) ||
				!("action" in action) ||
				action.turnId !== requested ||
				(action.action !== "keep" && action.action !== "discard") ||
				!("path" in action)
			)
				continue;
			try {
				const path = appWireSafeRelativePath(action.path, "turn-review-action.path");
				for (const change of result.changes)
					if (change.path === path) change.state = action.action === "keep" ? "applied" : "discarded";
			} catch {}
		}
		return result;
	}
	async filesRead(request: DesktopFileRequest, context?: OperationContextLike): Promise<DesktopFileReadResult> {
		const signal = this.#signal(request, context),
			path = safeRelativePath(request.path),
			sessionId = this.#session(context);
		try {
			const result = await this.#secureFs.secureReadFile(this.#getRoot(sessionId), path, MAX_FILE_BYTES);
			if (signal?.aborted) throw protocolError("ABORTED");
			const encoding = request.encoding ?? "utf8";
			const content = encoding === "base64" ? Buffer.from(result.data).toString("base64") : decodeUtf8(result.data);
			return freeze({ path, content, encoding, revision: result.revisionSha256, size: result.size });
		} catch (error) {
			if (error && typeof error === "object" && "code" in error) throw error;
			return mapNative(error);
		}
	}
	async filesList(
		request: DesktopFileListRequest = {},
		context?: OperationContextLike,
	): Promise<Record<string, unknown>> {
		const signal = this.#signal(request, context),
			path = request.path === undefined ? undefined : safeRelativePath(request.path),
			sessionId = this.#session(context);
		try {
			const result = await this.#secureFs.secureListDirectory(this.#getRoot(sessionId), path, MAX_LIST_ENTRIES);
			if (signal?.aborted) throw protocolError("ABORTED");
			const entries = result.entries
				.slice()
				.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
				.map(protocolSafeDirectoryEntry)
				.filter((entry): entry is ProtocolSafeDirectoryEntry => entry !== undefined)
				.map(entry => freeze(entry));
			return freeze({ entries });
		} catch (error) {
			if (error && typeof error === "object" && "code" in error) throw error;
			return mapNative(error);
		}
	}
	async filesWrite(request: DesktopWriteRequest, context?: OperationContextLike): Promise<Record<string, unknown>> {
		const signal = this.#signal(request, context),
			path = safeRelativePath(request.path),
			sessionId = this.#session(context),
			expectedRevision = this.#expected(request, context, context !== undefined),
			data = decodeContent(request.content, request.encoding);
		try {
			const result = await this.#secureFs.secureWriteFileAtomic(
				this.#getRoot(sessionId),
				path,
				data,
				expectedRevision,
				MAX_FILE_BYTES,
			);
			if (signal?.aborted) throw protocolError("ABORTED");
			return freeze({ path, revision: result.revisionSha256, size: result.size });
		} catch (error) {
			if (error && typeof error === "object" && "code" in error) throw error;
			return mapNative(error);
		}
	}
	async filesDiff(request: DesktopDiffRequest, context?: OperationContextLike): Promise<Record<string, unknown>> {
		const signal = this.#signal(request, context);
		if ("turnId" in request) {
			const sessionId = this.#session(context);
			if (sessionId !== this.#context.sessionManager.getSessionId()) throw protocolError("FORBIDDEN");
			if (signal?.aborted) throw protocolError("ABORTED");
			const snapshot = this.#turnSnapshot(request.turnId);
			return freeze({
				turnId: snapshot.turnId,
				baseTree: snapshot.baseTree,
				headTree: snapshot.headTree,
				changes: snapshot.changes,
				...(snapshot.patch === undefined ? {} : { patch: snapshot.patch }),
			});
		}
		const path = safeRelativePath(request.path),
			basis = request.fromRevision ?? context?.expectedRevision;
		if (
			request.fromRevision !== undefined &&
			context?.expectedRevision !== undefined &&
			request.fromRevision !== context.expectedRevision
		)
			throw protocolError("OPERATION_FAILED");
		if (request.content === undefined || basis === undefined) throw protocolError("UNSUPPORTED");
		try {
			const current = await this.filesRead({ path, encoding: "utf8", signal }, context),
				requested = decodeUtf8(decodeContent(request.content, request.encoding));
			if (current.revision !== basis) throw protocolError("STALE_REVISION");
			if (signal?.aborted) throw protocolError("ABORTED");
			return freeze({ path, diff: diffText(path, current.content, requested), fromRevision: current.revision });
		} catch (error) {
			if (error && typeof error === "object" && "code" in error) throw error;
			return mapNative(error);
		}
	}
	async filesPatch(request: DesktopPatchRequest, context?: OperationContextLike): Promise<Record<string, unknown>> {
		const signal = this.#signal(request, context),
			path = safeRelativePath(request.path),
			sessionId = this.#session(context),
			expectedRevision = this.#expected(request, context, true);
		if (!expectedRevision) throw protocolError("STALE_REVISION");
		let current: DesktopFileReadResult;
		try {
			current = await this.filesRead({ path, encoding: "utf8", signal }, context);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error) throw error;
			return mapNative(error);
		}
		if (current.revision !== expectedRevision) throw protocolError("STALE_REVISION");
		let parsed: PatchInput[];
		try {
			parsed = parseApplyPatch(boundedText(request.patch));
		} catch {
			throw protocolError("OPERATION_FAILED");
		}
		if (parsed.length !== 1 || parsed[0].op !== "update" || parsed[0].path !== path || parsed[0].rename !== undefined)
			throw protocolError("UNSUPPORTED");
		const root = this.#getRoot(sessionId),
			absolute = resolve(root, path);
		const fs: FileSystem = {
			exists: async target => target === absolute,
			read: async target => {
				if (target !== absolute) throw protocolError("FORBIDDEN");
				return current.content;
			},
			readBinary: async target => {
				if (target !== absolute) throw protocolError("FORBIDDEN");
				return Buffer.from(current.content, "utf8");
			},
			write: async () => {
				throw protocolError("OPERATION_FAILED");
			},
			delete: async () => {
				throw protocolError("OPERATION_FAILED");
			},
			mkdir: async () => {
				throw protocolError("OPERATION_FAILED");
			},
		};
		let applied: ApplyPatchResult;
		try {
			applied = await applyPatch(parsed[0], { cwd: root, dryRun: true, allowFuzzy: false, fuzzyThreshold: 0, fs });
		} catch {
			throw protocolError("OPERATION_FAILED");
		}
		const next = applied.change.newContent;
		if (typeof next !== "string") throw protocolError("OPERATION_FAILED");
		if (signal?.aborted) throw protocolError("ABORTED");
		try {
			const result = await this.#secureFs.secureWriteFileAtomic(
				root,
				path,
				Buffer.from(next, "utf8"),
				expectedRevision,
				MAX_FILE_BYTES,
			);
			return freeze({ path, revision: result.revisionSha256, size: result.size });
		} catch (error) {
			if (error && typeof error === "object" && "code" in error) throw error;
			return mapNative(error);
		}
	}
	async reviewRead(
		request: DesktopReviewReadRequest,
		context?: OperationContextLike,
	): Promise<Record<string, unknown>> {
		this.#signal(request, context);
		this.#session(context);
		if (!this.#context.reviewStore) throw protocolError("UNSUPPORTED");
		try {
			const value = await this.#context.reviewStore.read({ reviewId: boundedText(request.reviewId, 256) }, context);
			return freeze(this.#metadata(value) as Record<string, unknown>);
		} catch (error) {
			return mapNative(error);
		}
	}
	async reviewApply(
		request: DesktopReviewApplyRequest,
		context?: OperationContextLike,
	): Promise<Record<string, unknown>> {
		const signal = this.#signal(request, context);
		const sessionId = this.#session(context);
		if ("turnId" in request) {
			if (sessionId !== this.#context.sessionManager.getSessionId()) throw protocolError("FORBIDDEN");
			const snapshot = this.#turnSnapshot(request.turnId);
			const path = appWireSafeRelativePath(request.path, "path");
			const change = snapshot.changes.find(candidate => candidate.path === path);
			if (!change) throw protocolError("NOT_FOUND");
			const expectedState = request.action === "keep" ? "applied" : "discarded";
			if (change.state !== "pending") {
				if (change.state !== expectedState) throw protocolError("stale_turn");
				const resultingRevision = await captureWorktreeTree(this.#getRoot(sessionId));
				if (!resultingRevision) throw protocolError("OPERATION_FAILED");
				return freeze({
					turnId: snapshot.turnId,
					path,
					action: request.action,
					state: expectedState,
					resultingRevision,
				});
			}
			const appendCustomEntry = this.#context.sessionManager.appendCustomEntry;
			if (!appendCustomEntry) throw protocolError("UNSUPPORTED");
			const root = this.#getRoot(sessionId);
			const before = await captureWorktreeTree(root);
			if (!before) throw protocolError("OPERATION_FAILED");
			const targets = [change.path, ...(change.previousPath === undefined ? [] : [change.previousPath])];
			const targetCheck = await runArgv(
				["git", "diff", "--quiet", snapshot.headTree, before, "--", ...targets],
				root,
				signal,
			);
			if (targetCheck.cancelled) throw protocolError("ABORTED");
			if (targetCheck.exitCode !== 0 || targetCheck.timedOut || targetCheck.truncated)
				throw protocolError("stale_turn");
			if (signal?.aborted) throw protocolError("ABORTED");
			if (request.action === "discard") {
				const restore =
					change.status === "untracked"
						? await runArgv(["git", "clean", "-f", "--", change.path], root, signal)
						: await runArgv(
								["git", "restore", "--staged", "--worktree", `--source=${snapshot.baseTree}`, "--", ...targets],
								root,
								signal,
							);
				if (restore.cancelled) throw protocolError("ABORTED");
				if (restore.exitCode !== 0 || restore.timedOut || restore.truncated)
					throw protocolError("OPERATION_FAILED");
			}
			const resultingRevision = await captureWorktreeTree(root);
			if (!resultingRevision) throw protocolError("OPERATION_FAILED");
			try {
				appendCustomEntry.call(this.#context.sessionManager, "turn-review-action", {
					turnId: snapshot.turnId,
					path,
					action: request.action,
				});
			} catch {
				if (request.action === "discard") {
					await runArgv(
						["git", "restore", "--staged", "--worktree", `--source=${snapshot.headTree}`, "--", ...targets],
						root,
						undefined,
					);
				}
				throw protocolError("OPERATION_FAILED");
			}
			return freeze({
				turnId: snapshot.turnId,
				path,
				action: request.action,
				state: expectedState,
				resultingRevision,
			});
		}
		const expectedRevision = this.#expected(request, context, true);
		if (!this.#context.reviewStore) throw protocolError("UNSUPPORTED");
		try {
			const value = await this.#context.reviewStore.apply(
				{ reviewId: boundedText(request.reviewId, 256), expectedRevision, signal: request.signal },
				context,
			);
			return freeze(this.#metadata(value) as Record<string, unknown>);
		} catch (error) {
			return mapNative(error);
		}
	}
	async cancelAgent(agentId: string, context?: OperationContextLike): Promise<{ cancelled: boolean }> {
		if (!this.#context.agentAuthority) throw new Error("agent cancellation authority unavailable");
		return {
			cancelled: await this.#context.agentAuthority.cancel(
				agentId,
				context?.sessionId ?? this.#context.sessionManager.getSessionId(),
			),
		};
	}
	async runBash(
		request: { command: string; timeout?: number; signal?: AbortSignal; env?: Record<string, string> },
		context?: OperationContextLike,
	): Promise<ProcessResult & { output: string }> {
		const result = await runArgv(
			["/bin/sh", "-c", boundedText(request.command)],
			this.#getRoot(context?.sessionId),
			this.#signal(request, context),
			request.timeout ?? MAX_COMMAND_MS,
			safeEnv(request.env),
		);
		return { ...result, output: result.stdout };
	}
	async #terminalCwd(root: string, raw: string | undefined): Promise<string> {
		if (raw === undefined) return root;
		try {
			const candidate = resolve(root, safeRelativePath(raw));
			const canonical = await realpath(candidate);
			const escaped = relative(root, canonical);
			if (escaped.startsWith("..") || isAbsolute(escaped)) throw protocolError("FORBIDDEN");
			return canonical;
		} catch {
			throw protocolError("FORBIDDEN");
		}
	}
	async openTerminal(
		request: DesktopTerminalRequest = {},
		context?: OperationContextLike,
	): Promise<{ terminalId: string }> {
		const shell = request.shell ?? process.env.SHELL ?? "/bin/sh";
		if (!ALLOWED_SHELLS.has(shell)) throw new Error("shell is not allowed");
		await access(shell, fsConstants.X_OK);
		if (
			request.cols !== undefined &&
			(!Number.isSafeInteger(request.cols) || request.cols < 1 || request.cols > 1_000)
		)
			throw new Error("invalid terminal columns");
		if (request.rows !== undefined && (!Number.isSafeInteger(request.rows) || request.rows < 1 || request.rows > 500))
			throw new Error("invalid terminal rows");
		if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0))
			throw new Error("invalid terminal timeout");
		const signal = this.#signal(request, context);
		const root = this.#getRoot(context?.sessionId),
			cwd = await this.#terminalCwd(root, request.cwd),
			terminalId = randomUUID(),
			pty = new PtySession(),
			handle: TerminalHandle = { owner: this.#owner, pty, closed: false };
		this.#terminals.set(terminalId, handle);
		let outputBytes = 0;
		void pty
			.start(
				{
					shell,
					command: shell,
					cwd,
					cols: request.cols ?? 80,
					rows: request.rows ?? 24,
					timeoutMs: request.timeoutMs,
					env: safeEnv(request.env),
					signal,
				},
				(error, chunk) => {
					if (handle.closed || error || !chunk || outputBytes >= MAX_OUTPUT_BYTES) return;
					const bytes = Buffer.byteLength(chunk, "utf8"),
						remaining = MAX_OUTPUT_BYTES - outputBytes,
						emitted = bytes <= remaining ? chunk : Buffer.from(chunk).subarray(0, remaining).toString("utf8");
					outputBytes += Buffer.byteLength(emitted, "utf8");
					request.onOutput?.("stdout", emitted);
				},
			)
			.then(result => {
				if (!handle.closed) request.onExit?.(result);
			})
			.finally(() => {
				handle.closed = true;
				this.#terminals.delete(terminalId);
			});
		return { terminalId };
	}
	#terminal(id: string): TerminalHandle {
		const handle = this.#terminals.get(id);
		if (!handle || handle.owner !== this.#owner || handle.closed)
			throw new Error("terminal is not owned by this connection");
		return handle;
	}
	inputTerminal(id: string, data: string): void {
		this.#terminal(id).pty.write(boundedText(data, MAX_OUTPUT_BYTES));
	}
	resizeTerminal(id: string, cols: number, rows: number): void {
		if (
			!Number.isSafeInteger(cols) ||
			cols < 1 ||
			cols > 1_000 ||
			!Number.isSafeInteger(rows) ||
			rows < 1 ||
			rows > 500
		)
			throw new Error("invalid terminal dimensions");
		this.#terminal(id).pty.resize(cols, rows);
	}
	closeTerminal(id: string): void {
		const handle = this.#terminal(id);
		handle.closed = true;
		handle.pty.kill();
		this.#terminals.delete(id);
	}
	input(id: string, data: string): void {
		this.inputTerminal(id, data);
	}
	resize(id: string, cols: number, rows: number): void {
		this.resizeTerminal(id, cols, rows);
	}
	close(id: string): void {
		this.closeTerminal(id);
	}
	disconnect(): void {
		for (const handle of this.#terminals.values()) {
			handle.closed = true;
			handle.pty.kill();
		}
		this.#terminals.clear();
	}
	async catalogGet(): Promise<{ items: unknown[] }> {
		if (!this.#context.catalogAuthority) throw new Error("catalog authority unavailable");
		const values = await this.#context.catalogAuthority.list();
		if (values.length > MAX_LIST_ENTRIES) throw new Error("catalog exceeds protocol limit");
		const frame = decodeCatalog({
			v: "omp-app/1",
			type: "catalog",
			hostId: "desktop",
			revision: "catalog",
			items: values.map((value, index) => this.#metadata(catalogItem(value, index))),
		});
		if (frame.type !== "catalog") throw new Error("catalog authority returned invalid frame");
		return { items: frame.items };
	}
	async settingsRead(): Promise<{ settings: Record<string, unknown> }> {
		if (!this.#context.settingsAuthority) throw new Error("settings authority unavailable");
		return { settings: this.#metadata(await this.#context.settingsAuthority.read()) as Record<string, unknown> };
	}
	async settingsWrite(path: string, value: unknown): Promise<void> {
		if (!this.#context.settingsAuthority || !path || SECRET_KEY.test(path))
			throw new Error("settings authority unavailable");
		return this.#context.settingsAuthority.write(path, this.#metadata(value));
	}
	#metadata(value: unknown, depth = 0, state = { nodes: 0 }): unknown {
		if (++state.nodes > 5_000 || depth > 8) throw new Error("metadata exceeds bounds");
		if (typeof value === "string") {
			if (value.length > 8_192) throw new Error("metadata string exceeds bounds");
			return isAbsolute(value) ? "<redacted-path>" : value;
		}
		if (typeof value === "function" || typeof value === "bigint") throw new Error("metadata is not serializable");
		if (Array.isArray(value)) {
			if (value.length > MAX_LIST_ENTRIES) throw new Error("metadata array exceeds bounds");
			return value.map(item => this.#metadata(item, depth + 1, state));
		}
		if (!value || typeof value !== "object") return value;
		const result: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			if (Object.keys(result).length >= 256 || SECRET_KEY.test(key) || isAbsolute(key)) continue;
			result[key] = this.#metadata(child, depth + 1, state);
		}
		return result;
	}
}
export type DesktopOperationsAuthority = CodingAgentDesktopAuthority;
