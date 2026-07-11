import { decodeCatalog } from "@oh-my-pi/app-wire";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, opendir, realpath, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";
import type { AgentSession } from "./agent-session";
import type { SessionManager } from "./session-manager";
import type { Settings } from "../config/settings";

const MAX_FILE_BYTES = 768 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 1_000;
const MAX_COMMAND_MS = 120_000;
const SECRET_KEY = /password|passwd|secret|token|credential|api[_-]?key|private[_-]?key/i;
const ALLOWED_SHELLS = new Set(["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/fish"]);

export interface DesktopAuthorityContext {
	sessionManager: Pick<SessionManager, "getCwd" | "getSessionId">;
	/** A caller-owned child/subagent authority. Parent-session abort is never used as a fallback. */
	agentAuthority?: { cancel(agentId: string, sessionId: string): Promise<boolean> };
	/** A caller-owned typed settings authority. Raw Settings is intentionally not guessed at. */
	settingsAuthority?: {
		read(): Promise<Record<string, unknown>> | Record<string, unknown>;
		write(path: string, value: unknown): Promise<void> | void;
	};
	/** A caller-owned registry snapshot. Values must already be serializable metadata. */
	catalogAuthority?: { list(): Promise<unknown[]> | unknown[] };
	/** Optional Settings instance is retained only for explicit unsupported diagnostics. */
	settings?: Settings;
}

interface ProcessResult { stdout: string; stderr: string; exitCode?: number; cancelled: boolean; timedOut: boolean; truncated: boolean }
export interface DesktopFileRequest { path: string; signal?: AbortSignal }
export interface DesktopWriteRequest extends DesktopFileRequest { content: string; expectedRevision?: string }
export interface DesktopPatchRequest extends DesktopFileRequest { patch: string; expectedRevision?: string }
export interface DesktopReviewApplyRequest { reviewId: string; expectedRevision?: string }
export interface DesktopTerminalRequest {
	shell?: string; cwd?: string; cols?: number; rows?: number; timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal;
	onOutput?: (stream: "stdout" | "stderr", data: string) => void;
	onExit?: (result: { exitCode?: number; cancelled: boolean; timedOut: boolean }) => void;
}
interface Review { path: string; patch: string; revision: string }
interface TerminalHandle { owner: string; pty: PtySession; closed: boolean }

const CATALOG_KINDS = new Set(["tool", "model", "command", "setting", "skill", "agent", "provider", "mode"]);

function catalogItem(value: unknown, index: number): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`catalog item ${index} must be an object`);
	const item = value as Record<string, unknown>;
	if (typeof item.id !== "string" || !item.id || typeof item.kind !== "string" || !CATALOG_KINDS.has(item.kind) || typeof item.name !== "string" || !item.name) throw new Error(`catalog item ${index} is missing required fields`);
	const result: Record<string, unknown> = { id: boundedText(item.id, 256), kind: item.kind, name: boundedText(item.name, 256) };
	if (item.description !== undefined) { if (typeof item.description !== "string") throw new Error(`catalog item ${index} has invalid description`); result.description = boundedText(item.description, 4096); }
	if (item.capabilities !== undefined) { if (!Array.isArray(item.capabilities) || item.capabilities.length > 128 || item.capabilities.some(capability => typeof capability !== "string")) throw new Error(`catalog item ${index} has invalid capabilities`); result.capabilities = item.capabilities.map(capability => boundedText(capability as string, 128)); }
	if (item.supported !== undefined) { if (typeof item.supported !== "boolean") throw new Error(`catalog item ${index} has invalid supported flag`); result.supported = item.supported; }
	if (item.reason !== undefined) { if (typeof item.reason !== "string") throw new Error(`catalog item ${index} has invalid reason`); result.reason = boundedText(item.reason, 2048); }
	if (item.metadata !== undefined) result.metadata = item.metadata;
	return result;
}

function hash(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }
function boundedText(value: string, max = MAX_FILE_BYTES): string { if (Buffer.byteLength(value, "utf8") > max) throw new Error("content exceeds protocol limit"); return value; }
function relativePath(value: string): string {
	if (typeof value !== "string" || !value || isAbsolute(value)) throw new Error("path must be relative");
	const normalized = value.replaceAll("\\", "/");
	if (normalized.split("/").some(part => part === "..")) throw new Error("path traversal is not allowed");
	const result = normalized.split("/").filter(Boolean).join("/");
	if (!result || result === ".") throw new Error("path must name a file or directory");
	return result;
}
function contained(root: string, target: string): boolean { const rel = relative(root, target); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
function safeEnv(input: Record<string, string> | undefined): Record<string, string> {
	const result: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", TERM: process.env.TERM ?? "dumb" };
	for (const [key, value] of Object.entries(input ?? {})) { if (SECRET_KEY.test(key)) continue; result[key] = boundedText(value, 4096); }
	return result;
}

async function readFileBounded(path: string): Promise<Buffer> {
	if (fsConstants.O_NOFOLLOW === undefined) throw new Error("safe file operations unavailable on this platform");
	const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (info.size > MAX_FILE_BYTES) throw new Error("file exceeds protocol limit");
		const output = Buffer.alloc(info.size);
		let offset = 0;
		while (offset < output.length) {
			const result = await handle.read(output, offset, output.length - offset, offset);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		return offset === output.length ? output : output.subarray(0, offset);
	} finally { await handle.close(); }
}

async function readStreamBounded(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
	const reader = stream.getReader(); const chunks: Uint8Array[] = []; let total = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > max) throw new Error("command output exceeds protocol limit");
			chunks.push(next.value);
		}
	} finally { reader.releaseLock(); }
	const result = new Uint8Array(total); let offset = 0;
	for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
	return result;
}

async function runArgv(argv: string[], cwd: string, signal: AbortSignal | undefined, timeoutMs = MAX_COMMAND_MS, env?: Record<string, string>): Promise<ProcessResult> {
	if (signal?.aborted) return { stdout: "", stderr: "", exitCode: undefined, cancelled: true, timedOut: false, truncated: false };
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeout must be positive");
	const proc = Bun.spawn(argv, { cwd, env: env ?? safeEnv(undefined), stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32" });
	let timedOut = false; let cancelled = false; let truncated = false; let killed = false;
	const kill = () => { if (killed) return; killed = true; const pid = proc.pid; try { if (process.platform !== "win32" && typeof pid === "number") process.kill(-pid, "SIGTERM"); else proc.kill("SIGTERM"); } catch { try { proc.kill("SIGTERM"); } catch {} } setTimeout(() => { try { if (process.platform !== "win32" && typeof pid === "number") process.kill(-pid, "SIGKILL"); else proc.kill("SIGKILL"); } catch {} }, 100).unref?.(); };
	const onAbort = () => { cancelled = true; kill(); };
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
	let stdout: Uint8Array<ArrayBufferLike> = new Uint8Array(); let stderr: Uint8Array<ArrayBufferLike> = new Uint8Array(); let code: number | undefined;
	try {
		try { [stdout, stderr, code] = await Promise.all([readStreamBounded(proc.stdout, MAX_OUTPUT_BYTES), readStreamBounded(proc.stderr, MAX_OUTPUT_BYTES), proc.exited]); }
		catch { truncated = true; kill(); await proc.exited.catch(() => undefined); }
		return { stdout: new TextDecoder().decode(stdout), stderr: new TextDecoder().decode(stderr).replaceAll(cwd, "<session-root>"), exitCode: code, cancelled, timedOut, truncated };
	} finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
}

export class CodingAgentDesktopAuthority {
	readonly #context: DesktopAuthorityContext; readonly #reviews = new Map<string, Review>(); readonly #terminals = new Map<string, TerminalHandle>(); readonly #owner: string;
	constructor(context: DesktopAuthorityContext, owner = "desktop") { this.#context = context; this.#owner = owner; }
	#getRoot(): string { return resolve(this.#context.sessionManager.getCwd()); }

	async #resolvePath(raw: string, allowMissing = false): Promise<{ relativePath: string; absolutePath: string; root: string }> {
		const path = relativePath(raw); const root = await realpath(this.#getRoot()); const absolutePath = resolve(root, path); if (!contained(root, absolutePath)) throw new Error("path escapes session root");
		try { const canonical = await realpath(absolutePath); if (!contained(root, canonical)) throw new Error("path escapes session root"); return { relativePath: path, absolutePath: canonical, root }; }
		catch (error) {
			if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			let parentPath = dirname(absolutePath);
			while (true) { try { const parent = await realpath(parentPath); if (!contained(root, parent)) throw new Error("path escapes session root"); return { relativePath: path, absolutePath, root }; } catch (parentError) { if ((parentError as NodeJS.ErrnoException).code !== "ENOENT" || parentPath === root) throw parentError; parentPath = dirname(parentPath); } }
		}
	}

	async filesRead(_request: DesktopFileRequest): Promise<never> { throw new Error("files.read unavailable: secure openat authority is not installed"); }
	async filesList(_request: { path?: string; signal?: AbortSignal } = {}): Promise<never> { throw new Error("files.list unavailable: secure openat authority is not installed"); }

	async filesWrite(_request: DesktopWriteRequest): Promise<never> {
		throw new Error("files.write unavailable: stable directory-handle mutation authority is not installed");
	}
	async filesDiff(_request: DesktopFileRequest): Promise<never> { throw new Error("files.diff unavailable: secure openat authority is not installed"); }
	async filesPatch(_request: DesktopPatchRequest): Promise<never> { throw new Error("files.patch unavailable: atomic patch authority is not installed"); }

	async reviewRead(_request: DesktopFileRequest): Promise<never> { throw new Error("review.read unavailable: secure openat authority is not installed"); }
	async reviewApply(_request: DesktopReviewApplyRequest): Promise<never> { throw new Error("review.apply unavailable: atomic patch authority is not installed"); }
	async cancelAgent(agentId: string): Promise<{ cancelled: boolean }> { if (!this.#context.agentAuthority) throw new Error("agent cancellation authority unavailable"); return { cancelled: await this.#context.agentAuthority.cancel(agentId, this.#context.sessionManager.getSessionId()) }; }
	async runBash(request: { command: string; timeout?: number; signal?: AbortSignal; env?: Record<string, string> }): Promise<ProcessResult & { output: string }> {
		const result = await runArgv(["/bin/sh", "-c", boundedText(request.command)], this.#getRoot(), request.signal, request.timeout ?? MAX_COMMAND_MS, safeEnv(request.env));
		return { ...result, output: result.stdout };
	}

	async openTerminal(request: DesktopTerminalRequest = {}): Promise<{ terminalId: string }> {
		const shell = request.shell ?? process.env.SHELL ?? "/bin/sh"; if (!ALLOWED_SHELLS.has(shell)) throw new Error("shell is not allowed"); await access(shell, fsConstants.X_OK);
		if (request.cols !== undefined && (!Number.isSafeInteger(request.cols) || request.cols < 1 || request.cols > 1_000)) throw new Error("invalid terminal columns"); if (request.rows !== undefined && (!Number.isSafeInteger(request.rows) || request.rows < 1 || request.rows > 500)) throw new Error("invalid terminal rows");
		if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) throw new Error("invalid terminal timeout");
		const root = await realpath(this.#getRoot()); const cwd = request.cwd === undefined ? root : (await this.#resolvePath(request.cwd)).absolutePath; const terminalId = randomUUID(); const pty = new PtySession(); const handle: TerminalHandle = { owner: this.#owner, pty, closed: false }; this.#terminals.set(terminalId, handle);
		let outputBytes = 0;
		void pty.start({ shell, command: shell, cwd, cols: request.cols ?? 80, rows: request.rows ?? 24, timeoutMs: request.timeoutMs, env: safeEnv(request.env), signal: request.signal }, (error, chunk) => { if (handle.closed || error || !chunk || outputBytes >= MAX_OUTPUT_BYTES) return; const bytes = Buffer.byteLength(chunk, "utf8"); const remaining = MAX_OUTPUT_BYTES - outputBytes; const emitted = bytes <= remaining ? chunk : Buffer.from(chunk).subarray(0, remaining).toString("utf8"); outputBytes += Buffer.byteLength(emitted, "utf8"); request.onOutput?.("stdout", emitted); }).then(result => { if (!handle.closed) request.onExit?.(result); }).finally(() => { handle.closed = true; this.#terminals.delete(terminalId); });
		return { terminalId };
	}
	#terminal(id: string): TerminalHandle { const handle = this.#terminals.get(id); if (!handle || handle.owner !== this.#owner || handle.closed) throw new Error("terminal is not owned by this connection"); return handle; }
	inputTerminal(id: string, data: string): void { this.#terminal(id).pty.write(boundedText(data, MAX_OUTPUT_BYTES)); }
	resizeTerminal(id: string, cols: number, rows: number): void { if (!Number.isSafeInteger(cols) || cols < 1 || cols > 1_000 || !Number.isSafeInteger(rows) || rows < 1 || rows > 500) throw new Error("invalid terminal dimensions"); this.#terminal(id).pty.resize(cols, rows); }
	closeTerminal(id: string): void { const handle = this.#terminal(id); handle.closed = true; handle.pty.kill(); this.#terminals.delete(id); }
	input(id: string, data: string): void { this.inputTerminal(id, data); }
	resize(id: string, cols: number, rows: number): void { this.resizeTerminal(id, cols, rows); }
	close(id: string): void { this.closeTerminal(id); }
	disconnect(): void { for (const handle of this.#terminals.values()) { handle.closed = true; handle.pty.kill(); } this.#terminals.clear(); }

	async catalogGet(): Promise<{ items: unknown[] }> {
		if (!this.#context.catalogAuthority) throw new Error("catalog authority unavailable");
		const values = await this.#context.catalogAuthority.list();
		if (values.length > MAX_LIST_ENTRIES) throw new Error("catalog exceeds protocol limit");
		const frame = decodeCatalog({ v: "omp-app/1", type: "catalog", hostId: "desktop", revision: "catalog", items: values.map((value, index) => this.#metadata(catalogItem(value, index))) });
		if (frame.type !== "catalog") throw new Error("catalog authority returned invalid frame");
		return { items: frame.items };
	}
	async settingsRead(): Promise<{ settings: Record<string, unknown> }> { if (!this.#context.settingsAuthority) throw new Error("settings authority unavailable"); return { settings: this.#metadata(await this.#context.settingsAuthority.read()) as Record<string, unknown> }; }
	async settingsWrite(path: string, value: unknown): Promise<void> { if (!this.#context.settingsAuthority || !path || SECRET_KEY.test(path)) throw new Error("settings authority unavailable"); return this.#context.settingsAuthority.write(path, this.#metadata(value)); }
	#metadata(value: unknown, depth = 0, state = { nodes: 0 }): unknown { if (++state.nodes > 5_000 || depth > 8) throw new Error("metadata exceeds bounds"); if (typeof value === "string") { if (value.length > 8_192) throw new Error("metadata string exceeds bounds"); return isAbsolute(value) ? "<redacted-path>" : value; } if (typeof value === "function" || typeof value === "bigint") throw new Error("metadata is not serializable"); if (Array.isArray(value)) { if (value.length > MAX_LIST_ENTRIES) throw new Error("metadata array exceeds bounds"); return value.map(item => this.#metadata(item, depth + 1, state)); } if (!value || typeof value !== "object") return value; const result: Record<string, unknown> = {}; for (const [key, child] of Object.entries(value)) { if (Object.keys(result).length >= 256) throw new Error("metadata object exceeds bounds"); if (SECRET_KEY.test(key) || isAbsolute(key)) continue; result[key] = this.#metadata(child, depth + 1, state); } return result; }
}
export type DesktopOperationsAuthority = CodingAgentDesktopAuthority;
