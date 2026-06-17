import * as fs from "node:fs";
import * as path from "node:path";
import type { MechFileEntry } from "./entries";
import { type AgentFileSource, MAIN_AGENT_ID } from "./normalize";
import { findActiveMainSession, getSubagentDir } from "./sources";

const JSONL_SUFFIX = ".jsonl";
const ACTIVE_SESSION_POLL_MS = 2_000;
const SUBAGENT_SCAN_MS = 1_000;
const STALE_SWITCH_MS = 30_000;

export type TailerRecord =
	| { t: "reset"; mainFile: string }
	| { t: "agent"; source: AgentFileSource }
	| { t: "entry"; source: AgentFileSource; entry: MechFileEntry; rawLine: string; observedAt: number };

export type TailerRecordListener = (record: TailerRecord) => void;

export interface SessionTailerOptions {
	mainSessionFile?: string;
	activeSessionPollMs?: number;
	subagentScanMs?: number;
}

interface WatchedFile {
	source: AgentFileSource;
	offset: number;
	pendingText: string;
	decoder: TextDecoder;
	watcher: fs.FSWatcher | null;
	readPromise: Promise<void> | null;
	readAgain: boolean;
}

interface WatchedDirectory {
	dirPath: string;
	parentId: string;
	depth: number;
	watcher: fs.FSWatcher;
}

interface UnknownObject {
	[key: string]: unknown;
}

function isObject(value: unknown): value is UnknownObject {
	return typeof value === "object" && value !== null;
}

function isKnownEntry(value: unknown): value is MechFileEntry {
	if (!isObject(value) || typeof value.type !== "string") return false;
	switch (value.type) {
		case "session":
			return typeof value.id === "string";
		case "message":
			return typeof value.id === "string" && isObject(value.message);
		case "model_change":
			return typeof value.id === "string" && typeof value.model === "string";
		case "custom_message":
			return typeof value.id === "string" && typeof value.customType === "string";
		case "session_init":
			return typeof value.id === "string";
		default:
			return false;
	}
}

export function parseMechFileEntryLine(line: string): MechFileEntry | null {
	try {
		const value = JSON.parse(line) as unknown;
		return isKnownEntry(value) ? value : null;
	} catch {
		return null;
	}
}

function agentIdForSubagentFile(filePath: string): string {
	return path.basename(filePath, JSONL_SUFFIX);
}

export class SessionTailer {
	#listeners = new Set<TailerRecordListener>();
	#files = new Map<string, WatchedFile>();
	#directories = new Map<string, WatchedDirectory>();
	#mainSessionFile: string | null = null;
	#mainSessionFilePinned: string | undefined;
	#activeSessionPollMs: number;
	#subagentScanMs: number;
	#activeSessionTimer: NodeJS.Timeout | null = null;
	#subagentScanTimer: NodeJS.Timeout | null = null;
	#started = false;
	#switchingSessions = false;

	constructor(options: SessionTailerOptions = {}) {
		this.#mainSessionFilePinned = options.mainSessionFile;
		this.#activeSessionPollMs = options.activeSessionPollMs ?? ACTIVE_SESSION_POLL_MS;
		this.#subagentScanMs = options.subagentScanMs ?? SUBAGENT_SCAN_MS;
	}

	onRecord(listener: TailerRecordListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		await this.refreshActiveSession();
		if (!this.#mainSessionFilePinned) {
			this.#activeSessionTimer = setInterval(() => {
				void this.refreshActiveSession();
			}, this.#activeSessionPollMs);
			this.#activeSessionTimer.unref?.();
		}
		this.#subagentScanTimer = setInterval(() => {
			void this.scanSubagents();
		}, this.#subagentScanMs);
		this.#subagentScanTimer.unref?.();
	}

	stop(): void {
		if (this.#activeSessionTimer) {
			clearInterval(this.#activeSessionTimer);
			this.#activeSessionTimer = null;
		}
		if (this.#subagentScanTimer) {
			clearInterval(this.#subagentScanTimer);
			this.#subagentScanTimer = null;
		}
		this.#clearSessionWatches();
		this.#mainSessionFile = null;
		this.#listeners.clear();
		this.#started = false;
	}

	async flush(): Promise<void> {
		await this.scanSubagents();
		const watchedFiles = Array.from(this.#files.values());
		for (const watchedFile of watchedFiles) {
			await this.#readFileUpdates(watchedFile);
		}
	}

	async scanSubagents(): Promise<void> {
		if (!this.#mainSessionFile) return;
		const subagentDir = getSubagentDir(this.#mainSessionFile);
		await this.#watchSubagentDirectory(subagentDir, MAIN_AGENT_ID, 1);
	}

	/** Re-evaluate which session is active. Public as a deterministic test seam (no timer wait). */
	async refreshActiveSession(): Promise<void> {
		if (this.#switchingSessions) return;
		this.#switchingSessions = true;
		try {
			const nextSession = this.#mainSessionFilePinned ?? (await findActiveMainSession());
			if (!nextSession) return;
			const resolved = path.resolve(nextSession);
			if (resolved === this.#mainSessionFile) return;
			// Stay attached to the current session until it goes quiet, so a momentary
			// mtime lead from a second live session cannot wipe and re-snapshot the roster.
			if (this.#mainSessionFile !== null && !(await this.#currentSessionStale())) return;
			await this.#activateMainSession(resolved);
		} finally {
			this.#switchingSessions = false;
		}
	}

	async #currentSessionStale(): Promise<boolean> {
		if (this.#mainSessionFile === null) return true;
		try {
			const stat = await fs.promises.stat(this.#mainSessionFile);
			return Date.now() - stat.mtimeMs > STALE_SWITCH_MS;
		} catch {
			return true;
		}
	}

	async #activateMainSession(mainSessionFile: string): Promise<void> {
		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(mainSessionFile);
		} catch {
			return;
		}
		this.#clearSessionWatches();
		this.#mainSessionFile = mainSessionFile;
		this.#emit({ t: "reset", mainFile: mainSessionFile });
		await this.#watchFile({
			filePath: mainSessionFile,
			agentId: MAIN_AGENT_ID,
			parentId: null,
			depth: 0,
			isMain: true,
			mtimeMs: stat.mtimeMs,
		});
		await this.scanSubagents();
	}

	#clearSessionWatches(): void {
		for (const watchedFile of this.#files.values()) {
			watchedFile.watcher?.close();
		}
		for (const watchedDirectory of this.#directories.values()) {
			watchedDirectory.watcher.close();
		}
		this.#files.clear();
		this.#directories.clear();
	}

	async #watchSubagentDirectory(dirPath: string, parentId: string, depth: number): Promise<void> {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
		} catch {
			return;
		}

		const resolvedDir = path.resolve(dirPath);
		if (!this.#directories.has(resolvedDir)) {
			const watcher = fs.watch(resolvedDir, (_eventType, fileName) => {
				void this.#handleDirectoryChange(resolvedDir, parentId, depth, fileName?.toString());
			});
			this.#directories.set(resolvedDir, { dirPath: resolvedDir, parentId, depth, watcher });
		}

		for (const entry of entries) {
			const fullPath = path.join(resolvedDir, entry.name);
			if (entry.isFile() && entry.name.endsWith(JSONL_SUFFIX) && !entry.name.endsWith(".bak")) {
				await this.#watchFile({
					filePath: fullPath,
					agentId: agentIdForSubagentFile(fullPath),
					parentId,
					depth,
					isMain: false,
				});
			} else if (entry.isDirectory()) {
				await this.#watchSubagentDirectory(fullPath, entry.name, depth + 1);
			}
		}
	}

	async #handleDirectoryChange(
		dirPath: string,
		parentId: string,
		depth: number,
		fileName: string | undefined,
	): Promise<void> {
		if (!fileName) {
			await this.#watchSubagentDirectory(dirPath, parentId, depth);
			return;
		}
		const fullPath = path.join(dirPath, fileName);
		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(fullPath);
		} catch {
			return;
		}
		if (stat.isFile() && fileName.endsWith(JSONL_SUFFIX) && !fileName.endsWith(".bak")) {
			await this.#watchFile({
				filePath: fullPath,
				agentId: agentIdForSubagentFile(fullPath),
				parentId,
				depth,
				isMain: false,
				mtimeMs: stat.mtimeMs,
			});
		} else if (stat.isDirectory()) {
			await this.#watchSubagentDirectory(fullPath, fileName, depth + 1);
		}
	}

	async #watchFile(source: AgentFileSource): Promise<void> {
		const resolvedFile = path.resolve(source.filePath);
		const existing = this.#files.get(resolvedFile);
		if (existing) {
			existing.source = { ...existing.source, ...source, filePath: resolvedFile };
			await this.#readFileUpdates(existing);
			return;
		}

		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(resolvedFile);
		} catch {
			return;
		}
		if (!stat.isFile()) return;

		const watchedFile: WatchedFile = {
			source: { ...source, filePath: resolvedFile, mtimeMs: source.mtimeMs ?? stat.mtimeMs },
			offset: 0,
			pendingText: "",
			decoder: new TextDecoder(),
			watcher: null,
			readPromise: null,
			readAgain: false,
		};
		this.#files.set(resolvedFile, watchedFile);
		this.#emit({ t: "agent", source: watchedFile.source });
		watchedFile.watcher = fs.watch(resolvedFile, () => {
			this.#scheduleRead(resolvedFile);
		});
		await this.#readFileUpdates(watchedFile);
	}

	#scheduleRead(filePath: string): void {
		const watchedFile = this.#files.get(path.resolve(filePath));
		if (!watchedFile) return;
		watchedFile.readAgain = true;
		void this.#readFileUpdates(watchedFile);
	}

	async #readFileUpdates(watchedFile: WatchedFile): Promise<void> {
		if (watchedFile.readPromise) return watchedFile.readPromise;
		watchedFile.readPromise = (async () => {
			try {
				do {
					watchedFile.readAgain = false;
					await this.#readFileOnce(watchedFile);
				} while (watchedFile.readAgain);
			} finally {
				watchedFile.readPromise = null;
			}
		})();
		return watchedFile.readPromise;
	}

	async #readFileOnce(watchedFile: WatchedFile): Promise<void> {
		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(watchedFile.source.filePath);
		} catch {
			return;
		}
		if (stat.size < watchedFile.offset) {
			watchedFile.offset = 0;
			watchedFile.pendingText = "";
			watchedFile.decoder = new TextDecoder();
		}
		const bytesToRead = stat.size - watchedFile.offset;
		if (bytesToRead <= 0) return;

		let handle: fs.promises.FileHandle | null = null;
		try {
			handle = await fs.promises.open(watchedFile.source.filePath, "r");
			const buffer = Buffer.alloc(bytesToRead);
			const { bytesRead } = await handle.read(buffer, 0, bytesToRead, watchedFile.offset);
			watchedFile.offset += bytesRead;
			watchedFile.source.mtimeMs = stat.mtimeMs;
			this.#processChunk(watchedFile, buffer.subarray(0, bytesRead), stat.mtimeMs);
		} catch {
			return;
		} finally {
			await handle?.close();
		}
	}

	#processChunk(watchedFile: WatchedFile, chunk: Buffer, observedAt: number): void {
		const decoded = watchedFile.decoder.decode(chunk, { stream: true });
		const combined = watchedFile.pendingText + decoded;
		const lines = combined.split("\n");
		watchedFile.pendingText = lines.pop() ?? "";

		for (const rawLine of lines) {
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			if (!line) continue;
			const entry = parseMechFileEntryLine(line);
			if (!entry) continue;
			this.#emit({ t: "entry", source: watchedFile.source, entry, rawLine: line, observedAt });
		}
	}

	#emit(record: TailerRecord): void {
		for (const listener of Array.from(this.#listeners)) listener(record);
	}
}
