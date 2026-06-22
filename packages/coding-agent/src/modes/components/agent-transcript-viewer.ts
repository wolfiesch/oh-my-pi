/**
 * Fullscreen transcript viewer.
 *
 * `AgentHubOverlayComponent.openChat` mounts this as a `fullscreen` overlay
 * (`ui.showOverlay(..., { fullscreen: true })`), so it borrows the terminal's
 * alternate screen buffer (the vim/less idiom) and paints the whole screen — no
 * compositing into the live transcript's scrollback. It renders a parked
 * subagent / advisor / collab-guest transcript that has no live in-view session.
 *
 * The viewer tails append-only JSONL when possible and falls back to a full
 * compaction-aware rebuild when file identity changes, content is replaced, or a
 * structural session entry arrives. Scroll is owned end-to-end by a single
 * {@link ScrollView}; the viewer follows the tail until the reader scrolls up.
 *
 * Local agents read only newly appended bytes for normal writes while preserving
 * an incomplete trailing JSONL line across polls. Collab guests keep the
 * incremental byte cursor the host's capped `readTranscript` requires and clear
 * stale rows when the host reports rotation.
 */
import * as fs from "node:fs";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Component, Editor, matchesKey, parseSgrMouse, ScrollView, type TUI } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber, logger } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import type { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import type { AgentRegistry, AgentStatus } from "../../registry/agent-registry";
import { buildSessionContext } from "../../session/session-context";
import type { FileEntry, SessionEntry } from "../../session/session-entries";
import { parseSessionEntries } from "../../session/session-loader";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { getEditorTheme, theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import type { AgentHubRemote } from "./agent-hub";
import { ChatTranscriptBuilder } from "./chat-transcript-builder";
import { DynamicBorder } from "./dynamic-border";
import { formatContextUsage } from "./status-line/context-thresholds";

export interface AgentTranscriptViewerDeps {
	agentId: string;
	registry: AgentRegistry;
	/** Collab guest: read transcript from the host instead of a local file. */
	remote?: AgentHubRemote;
	/** Progress/cost snapshot source for the stats line. */
	observers?: SessionObserverRegistry;
	/** Revive+prompt path for messageable local agents. Lazy to avoid touching the global. */
	lifecycle?: () => AgentLifecycleManager;
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandKeys: KeyId[];
	/** Keys that toggle the whole hub closed (app.agents.hub + app.session.observe). */
	hubKeys: KeyId[];
	requestRender: () => void;
	/** Close just this viewer (Esc), returning to the hub table. */
	onClose: () => void;
	/** Close this viewer AND the hub (hub-toggle keys). */
	onHubClose: () => void;
}

/** How often to re-stat a file-backed transcript for growth (advisor/live tail). */
const POLL_MS = 250;

type LocalTailState = {
	path: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	offset: number;
	pending: string;
};

function splitCompleteJsonl(text: string): { complete: string; pending: string } {
	const lastNewline = text.lastIndexOf("\n");
	if (lastNewline < 0) return { complete: "", pending: text };
	return { complete: text.slice(0, lastNewline + 1), pending: text.slice(lastNewline + 1) };
}

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
	return entry.type !== "session";
}

function statusBadge(status: AgentStatus): string {
	switch (status) {
		case "running":
			return theme.fg("success", "running");
		case "idle":
			return theme.fg("accent", "idle");
		case "parked":
			return theme.fg("muted", "parked");
		case "aborted":
			return theme.fg("error", "aborted");
	}
}

export class AgentTranscriptViewer implements Component {
	#builder: ChatTranscriptBuilder;
	#scrollView: ScrollView;
	#followBottom = true;
	#editor: Editor | undefined;
	#notice: string | undefined;
	#expanded = false;

	// Local file transcript state: append-tail same-inode growth; rebuild on replacement.
	#localState: LocalTailState | undefined;
	#localEmptyReason: "none" | "missing" | undefined;
	// Remote transcript state (incremental; the host caps each read).
	#remoteEntries: FileEntry[] = [];
	#remotePending = "";
	#remoteBytes = 0;
	#remoteFetchInFlight = false;
	#remoteToken = 0;
	#remoteUnavailable = false;
	#hasRemoteData = false;

	#model: string | undefined;
	#pollTimer: NodeJS.Timeout | undefined;
	#disposed = false;

	constructor(private readonly deps: AgentTranscriptViewerDeps) {
		this.#builder = new ChatTranscriptBuilder({
			ui: deps.ui,
			getTool: deps.getTool,
			getMessageRenderer: deps.getMessageRenderer,
			cwd: deps.cwd,
			hideThinkingBlock: deps.hideThinkingBlock,
			proseOnlyThinking: deps.proseOnlyThinking,
			requestRender: deps.requestRender,
		});
		this.#scrollView = new ScrollView([], {
			height: 10,
			scrollbar: "auto",
			theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
		});
		if (this.#sendable) {
			this.#editor = new Editor(getEditorTheme());
			this.#editor.setMaxHeight(4);
			this.#editor.onSubmit = text => this.#submit(text);
		}
		this.#refresh();
		this.#pollTimer = setInterval(() => this.#refresh(), POLL_MS);
		this.#pollTimer.unref?.();
	}

	/** Advisor transcripts are read-only; everything else may be messaged. */
	get #sendable(): boolean {
		const ref = this.deps.registry.get(this.deps.agentId);
		if (!ref || ref.kind === "advisor") return false;
		return Boolean(this.deps.remote || this.deps.lifecycle);
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#pollTimer) {
			clearInterval(this.#pollTimer);
			this.#pollTimer = undefined;
		}
		this.#remoteToken++;
		this.#builder.dispose();
	}

	// ========================================================================
	// Transcript loading
	// ========================================================================

	/** Tail the transcript and rebuild components only when necessary. */
	#refresh(): void {
		if (this.#disposed) return;
		if (this.deps.remote) {
			this.#fetchRemote();
			return;
		}
		const sessionFile = this.deps.registry.get(this.deps.agentId)?.sessionFile;
		if (!sessionFile) {
			if (this.#localEmptyReason !== "none") {
				this.#localState = undefined;
				this.#localEmptyReason = "none";
				this.#model = undefined;
				this.#rebuildMessages([]);
			}
			return;
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(sessionFile);
		} catch {
			if (this.#localEmptyReason !== "missing") {
				this.#localState = undefined;
				this.#localEmptyReason = "missing";
				this.#model = undefined;
				this.#rebuildMessages([]);
			}
			return;
		}
		this.#localEmptyReason = undefined;
		const state = this.#localState;
		const identityChanged = !state || state.path !== sessionFile || state.dev !== stat.dev || state.ino !== stat.ino;
		const contentReplaced =
			state &&
			state.path === sessionFile &&
			state.dev === stat.dev &&
			state.ino === stat.ino &&
			stat.size === state.size &&
			(stat.mtimeMs !== state.mtimeMs || stat.ctimeMs !== state.ctimeMs);
		if (identityChanged || stat.size < (state?.offset ?? 0) || contentReplaced) {
			this.#loadLocalFull(sessionFile, stat);
			return;
		}
		if (!state || stat.size === state.offset) return;
		let fd: number | undefined;
		try {
			fd = fs.openSync(sessionFile, "r");
			const length = stat.size - state.offset;
			const buffer = Buffer.allocUnsafe(length);
			fs.readSync(fd, buffer, 0, length, state.offset);
			const { complete, pending } = splitCompleteJsonl(state.pending + buffer.toString("utf-8"));
			const entries = complete ? parseSessionEntries(complete) : [];
			this.#localState = {
				...state,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				ctimeMs: stat.ctimeMs,
				offset: stat.size,
				pending,
			};
			const incremental = this.#incrementalMessages(entries);
			if (incremental) {
				this.#appendMessages(incremental);
			} else {
				this.#loadLocalFull(sessionFile, stat);
			}
		} catch (err) {
			logger.debug("transcript viewer: append read failed", { err: String(err) });
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}

	#loadLocalFull(sessionFile: string, stat: fs.Stats): void {
		let data: Buffer;
		try {
			data = fs.readFileSync(sessionFile);
		} catch (err) {
			logger.debug("transcript viewer: read failed", { err: String(err) });
			return;
		}
		const { complete, pending } = splitCompleteJsonl(data.toString("utf-8"));
		const entries = complete ? parseSessionEntries(complete) : [];
		this.#model = undefined;
		this.#scanModel(entries);
		this.#rebuildMessages(this.#messagesFromEntries(entries));
		let nextStat = stat;
		try {
			nextStat = fs.statSync(sessionFile);
		} catch {
			nextStat = stat;
		}
		this.#localState = {
			path: sessionFile,
			dev: nextStat.dev,
			ino: nextStat.ino,
			size: data.byteLength,
			mtimeMs: nextStat.mtimeMs,
			ctimeMs: nextStat.ctimeMs,
			offset: data.byteLength,
			pending,
		};
	}

	#fetchRemote(): void {
		const remote = this.deps.remote;
		if (!remote || this.#remoteFetchInFlight) return;
		const id = this.deps.agentId;
		const fromByte = this.#remoteBytes;
		this.#remoteFetchInFlight = true;
		const token = ++this.#remoteToken;
		void remote
			.readTranscript(id, fromByte)
			.then(result => {
				if (token !== this.#remoteToken || this.#disposed) return;
				this.#remoteFetchInFlight = false;
				if (!result) {
					if (!this.#hasRemoteData && !this.#remoteUnavailable) {
						this.#remoteUnavailable = true;
						this.deps.requestRender();
					}
					return;
				}
				if (result.newSize < fromByte) {
					// Host transcript rotated/truncated — clear stale rows and restart from 0.
					this.#remoteBytes = 0;
					this.#remotePending = "";
					this.#remoteEntries = [];
					this.#hasRemoteData = false;
					this.#rebuildMessages([]);
					this.#fetchRemote();
					return;
				}
				this.#remoteUnavailable = false;
				const firstData = !this.#hasRemoteData;
				this.#hasRemoteData = true;
				const { complete, pending } = splitCompleteJsonl(this.#remotePending + result.text);
				const parsed = complete ? parseSessionEntries(complete) : [];
				this.#remotePending = pending;
				this.#remoteBytes = result.newSize;
				if (parsed.length > 0) {
					this.#remoteEntries.push(...parsed);
					const incremental = this.#incrementalMessages(parsed);
					if (incremental) {
						if (incremental.length > 0) {
							this.#appendMessages(incremental);
						} else if (firstData) {
							this.deps.requestRender();
						}
					} else {
						this.#model = undefined;
						this.#scanModel(this.#remoteEntries);
						this.#rebuildMessages(this.#messagesFromEntries(this.#remoteEntries));
					}
					return;
				}
				// First completed fetch (even empty/header-only) clears the "Loading…" placeholder.
				if (firstData) this.deps.requestRender();
			})
			.catch((error: unknown) => {
				if (token === this.#remoteToken) this.#remoteFetchInFlight = false;
				logger.warn("transcript viewer: remote fetch failed", { id, error: String(error) });
			});
	}

	#messagesFromEntries(entries: readonly FileEntry[]): AgentMessage[] {
		const sessionEntries = entries.filter(isSessionEntry);
		return buildSessionContext(sessionEntries, undefined, undefined, {
			transcript: true,
			collapseCompactedHistory: true,
		}).messages;
	}

	/** Return appendable messages, or undefined when a structural entry requires rebuild. */
	#incrementalMessages(entries: readonly FileEntry[]): AgentMessage[] | undefined {
		const messages: AgentMessage[] = [];
		for (const entry of entries) {
			if (entry.type === "session") continue;
			if (entry.type === "message") {
				messages.push(entry.message);
				if (!this.#model && entry.message.role === "assistant") this.#model = entry.message.model;
			} else if (entry.type === "model_change") {
				this.#model = entry.model;
			} else {
				return undefined;
			}
		}
		return messages;
	}

	#scanModel(entries: readonly FileEntry[]): void {
		for (const entry of entries) {
			if (entry.type === "message" && !this.#model && entry.message.role === "assistant") {
				this.#model = entry.message.model;
			} else if (entry.type === "model_change") {
				this.#model = entry.model;
			}
		}
	}

	#rebuildMessages(messages: readonly AgentMessage[]): void {
		this.#builder.rebuildMessages(messages);
		this.deps.requestRender();
	}

	#appendMessages(messages: readonly AgentMessage[]): void {
		if (messages.length === 0) return;
		this.#builder.appendMessages(messages);
		this.deps.requestRender();
	}

	// ========================================================================
	// Input
	// ========================================================================

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (event?.wheel != null) {
				this.#scrollView.scroll(event.wheel * 3);
				this.#syncFollow();
				this.deps.requestRender();
			}
			return;
		}

		// The hub/observe toggle keys close the whole hub (matches the table view's
		// toggle semantics), not just this viewer.
		for (const key of this.deps.hubKeys) {
			if (matchesKey(data, key)) {
				this.deps.onHubClose();
				return;
			}
		}

		if (matchesKey(data, "escape")) {
			if (this.#editor && this.#editor.getText().trim() !== "") {
				this.#editor.setText("");
				this.deps.requestRender();
				return;
			}
			this.deps.onClose();
			return;
		}

		for (const key of this.deps.expandKeys) {
			if (matchesKey(data, key)) {
				this.#expanded = !this.#expanded;
				this.#builder.setExpanded(this.#expanded);
				this.deps.requestRender();
				return;
			}
		}

		// Once the reader starts typing a message, the editor owns every key.
		const editorEmpty = !this.#editor || this.#editor.getText().trim() === "";
		if (editorEmpty && this.#handleScroll(data)) return;

		if (this.#editor) {
			this.#editor.handleInput(data);
			this.deps.requestRender();
		}
	}

	/** Returns true when the key was a scroll command. ScrollView owns the offset. */
	#handleScroll(data: string): boolean {
		if (this.#scrollView.handleScrollKey(data)) {
			this.#syncFollow();
			this.deps.requestRender();
			return true;
		}
		if (data === "j" || matchesSelectDown(data)) {
			this.#scrollView.scroll(1);
		} else if (data === "k" || matchesSelectUp(data)) {
			this.#scrollView.scroll(-1);
		} else if (data === "g") {
			this.#scrollView.scrollToTop();
		} else if (data === "G") {
			this.#scrollView.scrollToBottom();
		} else {
			return false;
		}
		this.#syncFollow();
		this.deps.requestRender();
		return true;
	}

	#syncFollow(): void {
		this.#followBottom = this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset();
	}

	#submit(text: string): void {
		const trimmed = text.trim();
		this.#editor?.setText("");
		if (!trimmed) return;
		this.#notice = undefined;
		const id = this.deps.agentId;
		if (this.deps.remote) {
			this.deps.remote.chat(id, trimmed);
			this.deps.requestRender();
			return;
		}
		const lifecycle = this.deps.lifecycle;
		if (!lifecycle) return;
		void (async () => {
			try {
				// Revives a parked agent; returns the live session for running/idle.
				const session = await lifecycle().ensureLive(id);
				// Steers a mid-turn agent; sends a normal prompt to an idle one.
				await session.prompt(trimmed, { streamingBehavior: "steer" });
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
			}
			this.deps.requestRender();
		})();
		this.deps.requestRender();
	}

	// ========================================================================
	// Render
	// ========================================================================

	render(width: number): readonly string[] {
		const termHeight = process.stdout.rows || 40;
		// `innerWidth` widths the editor/notice chrome (gutter-prefixed below).
		// `contentWidth` widths the transcript: ScrollView reserves the last column
		// for the scrollbar, and the transcript components carry their own 1-col left
		// gutter — so body rows are emitted WITHOUT an extra outer space, sharing that
		// gutter with the header/footer (which add one). Stacking both shifted the body
		// one column right of the title.
		const innerWidth = Math.max(20, width - 2);
		const contentWidth = Math.max(1, width - 1);
		const ref = this.deps.registry.get(this.deps.agentId);

		const headerLines = this.#headerLines(ref?.status, ref?.kind, ref?.parentId);
		const footerLines = this.#footerLines();
		const noticeLine = this.#notice ? ` ${theme.fg("error", this.#notice)}` : undefined;
		const editorLines = this.#editor ? this.#editor.render(innerWidth) : [];

		// Chrome: top border + header rows + divider border + (notice) + editor + footer + bottom border.
		const chrome = headerLines.length + 2 + editorLines.length + footerLines.length + (noticeLine ? 1 : 0) + 1;
		const viewportHeight = Math.max(3, termHeight - chrome);

		const contentLines = this.#builder.isEmpty
			? [` ${theme.fg("dim", this.#placeholder())}`]
			: this.#builder.container.render(contentWidth);
		this.#scrollView.setLines(contentLines);
		this.#scrollView.setHeight(viewportHeight);
		if (this.#followBottom) this.#scrollView.scrollToBottom();

		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		for (const headerLine of headerLines) lines.push(` ${headerLine}`);
		lines.push(...new DynamicBorder().render(width));
		for (const row of this.#scrollView.render(width)) lines.push(row);
		if (noticeLine) lines.push(noticeLine);
		for (const editorLine of editorLines) lines.push(` ${editorLine}`);
		lines.push(...footerLines);
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#headerLines(status: AgentStatus | undefined, kind: string | undefined, parentId: string | undefined): string[] {
		const lines = [theme.fg("accent", `Agent Hub ${theme.sep.dot} ${this.deps.agentId}`)];
		if (status && kind) {
			const kindTag = theme.fg("dim", ` ${parentId ? `${kind} ${theme.sep.dot} of ${parentId}` : kind}`);
			const modelLabel = this.#model ? theme.fg("muted", `${theme.sep.dot}${this.#model}`) : "";
			lines.push(`${theme.bold(this.deps.agentId)} ${statusBadge(status)}${kindTag}${modelLabel}`);
		}
		return lines;
	}

	#footerLines(): string[] {
		const lines: string[] = [];
		const statsLine = this.#statsLine();
		if (statsLine) lines.push(` ${statsLine}`);
		const hint = this.#editor
			? `Enter:send  Esc:close  ${this.deps.expandKeys[0] ?? "ctrl+o"}:expand  empty input → j/k:scroll  g/G:top/bottom`
			: `Esc:close  ${this.deps.expandKeys[0] ?? "ctrl+o"}:expand  j/k:scroll  g/G:top/bottom`;
		lines.push(` ${theme.fg("dim", hint)}`);
		return lines;
	}

	#statsLine(): string {
		const observed: ObservableSession | undefined = this.deps.observers
			?.getSessions()
			.find(s => s.id === this.deps.agentId);
		const progress = observed?.progress;
		if (!progress) return "";
		const stats: string[] = [];
		if (progress.contextTokens && progress.contextTokens > 0) {
			stats.push(
				progress.contextWindow && progress.contextWindow > 0
					? formatContextUsage((progress.contextTokens / progress.contextWindow) * 100, progress.contextWindow)
					: formatNumber(progress.contextTokens),
			);
		}
		if (progress.durationMs > 0) stats.push(formatDuration(progress.durationMs));
		const parts: string[] = [];
		if (stats.length > 0 || progress.toolCount > 0) {
			const toolStat =
				progress.toolCount > 0 ? `${formatNumber(progress.toolCount)} ${theme.icon.extensionTool}` : "";
			parts.push(theme.fg("dim", [toolStat, ...stats].filter(Boolean).join(theme.sep.dot)));
		}
		if (progress.cost > 0) parts.push(theme.fg("statusLineCost", `$${progress.cost.toFixed(2)}`));
		return parts.join(theme.sep.dot);
	}

	#placeholder(): string {
		if (this.deps.remote && this.#remoteUnavailable) return "Transcript lives on the host — not available.";
		if (this.deps.remote && !this.#hasRemoteData) return "Loading transcript from host…";
		if (this.deps.remote) return "No messages yet.";
		if (!this.deps.registry.get(this.deps.agentId)?.sessionFile) return "No session file available yet.";
		return "No messages yet.";
	}
}
