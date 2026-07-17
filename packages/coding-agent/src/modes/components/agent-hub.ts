/**
 * Agent Hub overlay component.
 *
 * One overlay, two views:
 * - Table view: every registered agent except Main (Main IS the ambient
 *   chat), live from the global AgentRegistry — status, unread irc count,
 *   current/last task, last activity. Select with j/k, Enter opens a chat,
 *   `r` revives a parked agent, `x` aborts + releases one.
 * - Chat view: per-agent transcript (incremental session-file tail, absorbed
 *   from the old session observer overlay) plus an input line. Submitting
 *   revives a parked agent, then prompts/steers it; the message lands in the
 *   agent's persisted history via the normal prompt path.
 *
 * Replaces the old SessionObserverOverlayComponent (ctrl+s observer).
 */
import { type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Container, Ellipsis, matchesKey, type OverlayHandle, padding, type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatAge, formatDuration, formatNumber, getProjectDir, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import { formatModelStringWithRouting } from "../../config/model-resolver";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { IrcBus } from "../../irc/bus";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentStatus, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { registerPersistedSubagents } from "../../registry/persisted-agents";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { parseThinkingLevel } from "../../thinking";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { AgentTranscriptViewer } from "./agent-transcript-viewer";
import { DynamicBorder } from "./dynamic-border";
import { formatContextUsage } from "./status-line/context-thresholds";

/** Refresh cadence for the relative-time column */
const AGE_TICK_MS = 5_000;
const DATA_CHANGE_RENDER_COALESCE_MS = 100;
/** Double-tap window for the table's left-left "close hub" gesture. */
const LEFT_TAP_WINDOW_MS = 500;

/** Compute the max content width for the current terminal, accounting for chrome. */
function contentWidth(): number {
	return Math.max(TRUNCATE_LENGTHS.SHORT, (process.stdout.columns || 80) - 6);
}

/** Sanitize a line for TUI display: replace tabs, then truncate to viewport width. */
function sanitizeLine(text: string, maxWidth?: number): string {
	const singleLine = replaceTabs(sanitizeText(text)).replace(/[\r\n]+/g, " ");
	return truncateToWidth(singleLine, maxWidth ?? contentWidth());
}

function clampHubLine(line: string, width: number): string {
	return truncateToWidth(line.replace(/[\r\n]+/g, " "), Math.max(1, width - 2), Ellipsis.Omit);
}

const STATUS_ORDER: Record<AgentStatus, number> = { running: 0, idle: 1, parked: 2, aborted: 3 };
type HubTab = "active" | "archive";

interface AgentRuntimeView {
	model?: string;
	thinkingLevel?: string;
	lspEnabled?: boolean;
	advisorActive?: boolean;
	turns?: number;
	tokens?: number;
	contextTokens?: number;
	contextWindow?: number;
	toolCount?: number;
	cost?: number;
}

/** Status glyph, colored per theme status conventions. The title-line counts spell out the words. */
function statusGlyph(status: AgentStatus): string {
	switch (status) {
		case "running":
			return theme.fg("accent", theme.status.running);
		case "idle":
			return theme.fg("success", theme.status.enabled);
		case "parked":
			return theme.fg("muted", theme.status.shadowed);
		case "aborted":
			return theme.fg("error", theme.status.aborted);
	}
}

/** Model id + thinking level (`sonnet-4-6 ◒ high`), level colored per theme. */
function formatModelBadge(modelId: string, level: ThinkingLevel | undefined): string {
	const model = theme.fg("muted", replaceTabs(modelId));
	if (!level || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) return model;
	const display = theme.thinking[level as keyof typeof theme.thinking] ?? level;
	return `${model} ${theme.getThinkingBorderColor(level)(display)}`;
}

/**
 * Active model + reasoning level for a hub row: live session state when the
 * agent is attached, else the executor-reported `resolvedModel` selector
 * (`provider/id`, optionally `:<level>`). Undefined when neither is known
 * (e.g. a parked historical agent restored from disk).
 */
function modelBadge(ref: AgentRef, observed: ObservableSession | undefined): string | undefined {
	const model = ref.session?.model;
	if (model) {
		const level = model.thinking ? ref.session?.thinkingLevel : undefined;
		return formatModelBadge(model.id, level);
	}
	const resolved = observed?.progress?.resolvedModel;
	if (!resolved) return undefined;
	// Model ids may themselves contain colons (`qwen3:14b`), so only treat the
	// suffix as a thinking level when it parses as one.
	const colon = resolved.lastIndexOf(":");
	const level = colon >= 0 ? parseThinkingLevel(resolved.slice(colon + 1)) : undefined;
	const selector = level !== undefined ? resolved.slice(0, colon) : resolved;
	return formatModelBadge(selector.slice(selector.indexOf("/") + 1), level);
}

/** Result of one host-backed transcript read for the Agent Hub viewer. */
export interface AgentHubRemoteTranscript {
	text: string;
	newSize: number;
	/** Terminal read failure reported by the host; guests should surface it instead of retrying hot. */
	error?: string;
}

/** Guest-side proxy for hub actions executed on the collab host. */
export interface AgentHubRemote {
	chat(id: string, text: string): void;
	kill(id: string): void;
	revive(id: string): void;
	/** Mirrors readFileIncremental: text from fromByte (complete JSONL lines), newSize = next fromByte base; null = temporarily unavailable. */
	readTranscript(id: string, fromByte: number): Promise<AgentHubRemoteTranscript | null>;
}

export interface AgentHubDeps {
	/** Progress/status snapshot source (task lifecycle + progress channels). */
	observers: SessionObserverRegistry;
	/** Keys that toggle the hub closed from inside (app.agents.hub + app.session.observe). */
	hubKeys: KeyId[];
	onDone: () => void;
	requestRender: () => void;
	/** Injectable for tests; defaults to the process-global registry. */
	registry?: AgentRegistry;
	/** Injectable for tests; defaults to the process-global lifecycle manager. */
	lifecycle?: AgentLifecycleManager;
	/** Injectable for tests; defaults to the process-global bus. */
	irc?: IrcBus;
	/** TUI handle for transcript components; tests omit it and get a render-only stub. */
	ui?: TUI;
	/** Tool lookup for transcript renderers (labels, custom render functions). */
	getTool?: (name: string) => AgentTool | undefined;
	/** Extension message renderers for custom messages in the transcript. */
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	/** Cwd used by tool renderers for path shortening; defaults to the project dir. */
	cwd?: string;
	/** Mirrors the main transcript's thinking-block visibility. */
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	/** Keys toggling tool output expansion (app.tools.expand). */
	expandKeys?: KeyId[];
	/** Focus the main view on this agent's live session (ctx.focusAgentSession). When absent (collab guest, tests), Enter opens the in-hub chat view instead. */
	focusAgent?: (id: string) => Promise<void>;
	/** Current main session file; used to seed parked historical subagents after restart. */
	sessionFile?: string | null;
	/** Collab guest: route actions/transcripts to the host instead of local sessions. */
	remote?: AgentHubRemote;
}

export class AgentHubOverlayComponent extends Container {
	#registry: AgentRegistry;
	#observers: SessionObserverRegistry;
	#irc: IrcBus;
	#lifecycle: () => AgentLifecycleManager;
	#onDone: () => void;
	#requestRender: () => void;
	#hubKeys: KeyId[];
	#unsubscribers: Array<() => void> = [];
	#ageTimer: NodeJS.Timeout | undefined;
	#dataChangeTimer?: NodeJS.Timeout;
	#remote: AgentHubRemote | undefined;
	/** Resolves after persisted historical subagents have been registered and rows refreshed. */
	readonly persistedSubagentsReady: Promise<void>;

	// Dashboard state
	#allRows: AgentRef[] = [];
	#rows: AgentRef[] = [];
	#selectedRow = 0;
	#selectedByTab: Partial<Record<HubTab, string>> = {};
	#tab: HubTab = "active";
	#showIdle = false;
	#notice: string | undefined;
	/** Captured row order from the first refresh; keeps each status group stable while open. */
	#rowOrder: Map<string, number> | undefined;
	#liveMetricsCache:
		| {
				id: string;
				revision: number;
				metrics: Pick<
					AgentRuntimeView,
					"turns" | "tokens" | "contextTokens" | "contextWindow" | "toolCount" | "cost"
				>;
		  }
		| undefined;
	#lastLeftTap = 0;

	// Transcript-viewer launch deps (passed through to AgentTranscriptViewer).
	#ui: TUI;
	#getTool: ((name: string) => AgentTool | undefined) | undefined;
	#getMessageRenderer: ((customType: string) => MessageRenderer | undefined) | undefined;
	#cwd: string;
	#hideThinkingBlock: (() => boolean) | undefined;
	#proseOnlyThinking: (() => boolean) | undefined;
	#expandKeys: KeyId[];
	#focusAgent: ((id: string) => Promise<void>) | undefined;

	// Fullscreen transcript overlay opened by openChat(), if any.
	#transcriptOverlay: OverlayHandle | undefined;
	#transcriptViewer: AgentTranscriptViewer | undefined;

	constructor(deps: AgentHubDeps) {
		super();
		this.#registry = deps.registry ?? AgentRegistry.global();
		this.#observers = deps.observers;
		this.#irc = deps.irc ?? IrcBus.global();
		// Lazy: the lifecycle global self-constructs against the global
		// registry, so only touch it when revive/kill actually needs it.
		this.#lifecycle = () => deps.lifecycle ?? AgentLifecycleManager.global();
		this.#onDone = deps.onDone;
		this.#requestRender = deps.requestRender;
		this.#hubKeys = deps.hubKeys;
		this.#remote = deps.remote;
		this.#ui =
			deps.ui ??
			({
				requestRender: () => deps.requestRender(),
				requestComponentRender: () => deps.requestRender(),
			} as unknown as TUI);
		this.#getTool = deps.getTool;
		this.#getMessageRenderer = deps.getMessageRenderer;
		this.#cwd = deps.cwd ?? getProjectDir();
		this.#hideThinkingBlock = deps.hideThinkingBlock;
		this.#proseOnlyThinking = deps.proseOnlyThinking;
		this.#expandKeys = deps.expandKeys ?? ["ctrl+o"];
		this.#focusAgent = deps.focusAgent;

		this.#unsubscribers.push(this.#registry.onChange(() => this.#scheduleDataChange()));
		this.#unsubscribers.push(this.#observers.onChange(() => this.#scheduleDataChange()));
		this.#ageTimer = setInterval(() => this.#requestRender(), AGE_TICK_MS);
		this.#ageTimer.unref?.();

		this.persistedSubagentsReady = this.#remote
			? Promise.resolve()
			: registerPersistedSubagents(this.#registry, deps.sessionFile)
					.catch((error: unknown) => {
						logger.warn("Failed to register persisted subagents", { error });
					})
					.then(() => {
						this.#refreshRows();
					})
					.finally(() => this.#requestRender());
		this.#refreshRows();
	}

	/**
	 * Whether the current table view has no agents to show (every registered agent
	 * except Main). Persisted historical rows may arrive later; callers that need
	 * those included must wait for {@link persistedSubagentsReady} first.
	 */
	get isEmpty(): boolean {
		return this.#allRows.length === 0;
	}

	/** Tear down every subscription and timer. Called by the overlay owner on close. */
	dispose(): void {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		if (this.#ageTimer) {
			clearInterval(this.#ageTimer);
			this.#ageTimer = undefined;
		}
		if (this.#dataChangeTimer) {
			clearTimeout(this.#dataChangeTimer);
			this.#dataChangeTimer = undefined;
		}
		this.#closeTranscriptOverlay();
	}

	override render(width: number): readonly string[] {
		return this.#renderTable(width).map(line => clampHubLine(line, width));
	}

	handleInput(keyData: string): void {
		// The hub/observe keys always close the overlay (toggle semantics)
		for (const key of this.#hubKeys) {
			if (matchesKey(keyData, key)) {
				this.#onDone();
				return;
			}
		}
		this.#handleTableInput(keyData);
	}

	/**
	 * Seed the table's left-left close detector with the current time so a single
	 * subsequent `←` (within {@link LEFT_TAP_WINDOW_MS}) dismisses the hub.
	 *
	 * The editor's own double-tap detector consumes the `←←` that opens the hub,
	 * leaving this detector at its fresh `0` — without this handoff the user would
	 * have to press `←←` a second time to escape. Called by the opener when the hub
	 * was raised by that gesture.
	 */
	armCloseTap(): void {
		this.#lastLeftTap = Date.now();
	}

	/**
	 * Open the fullscreen transcript viewer for an agent id (public for table Enter
	 * and tests). Mounts {@link AgentTranscriptViewer} as a `fullscreen` overlay so it
	 * owns the alternate screen; the hub table stays mounted underneath and is
	 * restored when the viewer closes. No-op without a real TUI (render-only test stub).
	 */
	openChat(id: string): void {
		if (!this.#registry.get(id)) return;
		if (typeof this.#ui.showOverlay !== "function") return;
		this.#closeTranscriptOverlay();
		this.#notice = undefined;
		const viewer = new AgentTranscriptViewer({
			agentId: id,
			registry: this.#registry,
			remote: this.#remote,
			observers: this.#observers,
			lifecycle: this.#remote ? undefined : this.#lifecycle,
			ui: this.#ui,
			getTool: this.#getTool,
			getMessageRenderer: this.#getMessageRenderer,
			cwd: this.#cwd,
			hideThinkingBlock: this.#hideThinkingBlock,
			proseOnlyThinking: this.#proseOnlyThinking,
			expandKeys: this.#expandKeys,
			hubKeys: this.#hubKeys,
			requestRender: this.#requestRender,
			onClose: () => this.#closeTranscriptOverlay(),
			onHubClose: () => {
				this.#closeTranscriptOverlay();
				this.#onDone();
			},
		});
		this.#transcriptViewer = viewer;
		this.#transcriptOverlay = this.#ui.showOverlay(viewer, { width: "100%", margin: 0, fullscreen: true });
		this.#ui.setFocus(viewer);
		this.#requestRender();
	}

	/** Close and dispose the transcript overlay, restoring focus to the hub table. */
	#closeTranscriptOverlay(): void {
		this.#transcriptOverlay?.hide();
		this.#transcriptOverlay = undefined;
		this.#transcriptViewer?.dispose();
		this.#transcriptViewer = undefined;
		if (typeof this.#ui.setFocus === "function") this.#ui.setFocus(this);
		this.#requestRender();
	}

	// ========================================================================
	// Live data plumbing
	// ========================================================================

	#scheduleDataChange(): void {
		if (this.#dataChangeTimer) return;
		this.#dataChangeTimer = setTimeout(() => {
			this.#dataChangeTimer = undefined;
			this.#onDataChange();
		}, DATA_CHANGE_RENDER_COALESCE_MS);
		this.#dataChangeTimer.unref?.();
	}

	#onDataChange(): void {
		this.#refreshRows();
		this.#requestRender();
	}

	#refreshRows(): void {
		const selectedId = this.#selectedByTab[this.#tab] ?? this.#rows[this.#selectedRow]?.id;
		const refs = this.#registry.list().filter(ref => ref.id !== MAIN_AGENT_ID);

		if (!this.#rowOrder) {
			const initiallySorted = [...refs].sort(
				(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity,
			);
			this.#rowOrder = new Map(initiallySorted.map((ref, i) => [ref.id, i]));
		}
		for (const ref of refs) {
			if (!this.#rowOrder.has(ref.id)) this.#rowOrder.set(ref.id, this.#rowOrder.size);
		}
		this.#allRows = refs;
		this.#rows = this.#rowsForTab(this.#tab);

		const keptIndex = selectedId ? this.#rows.findIndex(ref => ref.id === selectedId) : -1;
		this.#selectedRow = keptIndex >= 0 ? keptIndex : Math.min(this.#selectedRow, Math.max(0, this.#rows.length - 1));
		const current = this.#rows[this.#selectedRow];
		if (current) this.#selectedByTab[this.#tab] = current.id;
	}

	#rowsForTab(tab: HubTab): AgentRef[] {
		const refs =
			tab === "active"
				? this.#allRows.filter(
						ref =>
							ref.kind !== "advisor" && (ref.status === "running" || (this.#showIdle && ref.status === "idle")),
					)
				: this.#allRows.filter(
						ref => ref.kind === "advisor" || ref.status === "parked" || ref.status === "aborted",
					);
		return refs.sort((a, b) => {
			const groupA = this.#rowGroup(a, tab);
			const groupB = this.#rowGroup(b, tab);
			if (groupA !== groupB) return groupA - groupB;
			return (
				(this.#rowOrder?.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
				(this.#rowOrder?.get(b.id) ?? Number.MAX_SAFE_INTEGER)
			);
		});
	}

	#rowGroup(ref: AgentRef, tab: HubTab): number {
		if (tab === "active") return ref.status === "running" ? 0 : 1;
		if (ref.kind === "advisor") return 2;
		return ref.status === "parked" ? 0 : 1;
	}

	#observableFor(id: string): ObservableSession | undefined {
		return this.#observers.getSessions().find(s => s.id === id);
	}

	// ========================================================================
	// Table view
	// ========================================================================

	#renderTable(width: number): string[] {
		const lines: string[] = [];
		const counts = this.#counts();
		lines.push(...new DynamicBorder().render(width));
		lines.push(
			` ${theme.fg("accent", `Agent Hub · ${counts.running} running · ${counts.idle} idle · ${counts.archived} archived`)}`,
		);
		lines.push(
			` ${this.#tab === "active" ? theme.bold("Active") : "Active"} (${counts.running + counts.idle})  ${this.#tab === "archive" ? theme.bold("Archive") : "Archive"} (${counts.archived})`,
		);
		lines.push(...new DynamicBorder().render(width));

		const listLines = this.#renderList(width >= 96 ? Math.floor((width - 3) * 0.44) : width);
		const inspectorLines = this.#renderInspector(this.#rows[this.#selectedRow], width >= 96 ? width : width - 2);
		if (width >= 96) {
			const leftWidth = Math.floor((width - 3) * 0.44);
			const rightWidth = width - leftWidth - 3;
			const bodyHeight = Math.max(listLines.length, inspectorLines.length);
			const separator = theme.fg("dim", ` ${theme.boxRound.vertical} `);
			for (let i = 0; i < bodyHeight; i++) {
				const left = truncateToWidth(listLines[i] ?? "", leftWidth);
				const leftPadded = left + padding(Math.max(0, leftWidth - visibleWidth(left)));
				lines.push(leftPadded + separator + truncateToWidth(inspectorLines[i] ?? "", rightWidth));
			}
		} else {
			lines.push(...listLines);
			const availableInspectorLines = Math.max(
				0,
				Math.min(9, (process.stdout.rows || 40) - lines.length - (this.#notice ? 4 : 3)),
			);
			if (availableInspectorLines > 0) lines.push(...inspectorLines.slice(0, availableInspectorLines));
		}

		if (this.#notice) {
			lines.push(` ${theme.fg("error", sanitizeLine(this.#notice, Math.max(10, width - 2)))}`);
		}
		lines.push("");
		const footer =
			this.#tab === "active"
				? "j/k:select  Enter:focus  t:transcript  i:idle  Tab:switch  Esc/←←:close"
				: "j/k:select  Enter:transcript  t:transcript  r:revive  x:kill  Tab:switch  Esc/←←:close";
		lines.push(` ${theme.fg("dim", footer)}`);
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#counts(): { running: number; idle: number; archived: number } {
		let running = 0;
		let idle = 0;
		let archived = 0;
		for (const ref of this.#allRows) {
			if (ref.kind === "advisor" || ref.status === "parked" || ref.status === "aborted") archived++;
			else if (ref.status === "running") running++;
			else if (ref.status === "idle") idle++;
		}
		return { running, idle, archived };
	}

	#renderList(width: number): string[] {
		const lines: string[] = [];
		const runningCount = this.#allRows.filter(ref => ref.status === "running" && ref.kind !== "advisor").length;
		const idleCount = this.#allRows.filter(ref => ref.status === "idle" && ref.kind !== "advisor").length;
		if (this.#tab === "active" && runningCount === 0) lines.push(` ${theme.fg("dim", "No agents running.")}`);

		const termHeight = process.stdout.rows || 40;
		const maxVisible = Math.max(3, termHeight - 10 - (this.#notice ? 1 : 0));
		let start = 0;
		if (this.#rows.length > maxVisible) {
			start = Math.min(Math.max(0, this.#selectedRow - Math.floor(maxVisible / 2)), this.#rows.length - maxVisible);
		}
		const end = Math.min(start + maxVisible, this.#rows.length);
		for (let i = start; i < end; i++) lines.push(...this.#renderEntry(this.#rows[i], i === this.#selectedRow, width));
		if (end < this.#rows.length) lines.push(` ${theme.fg("dim", `… ${this.#rows.length - end} more`)}`);
		if (this.#tab === "active" && idleCount > 0) {
			lines.push(` ${theme.fg("dim", `${this.#showIdle ? "▾" : "▸"} ${idleCount} idle agents`)}`);
		}
		if (this.#tab === "archive" && this.#rows.length === 0) lines.push(` ${theme.fg("dim", "No archived agents.")}`);
		return lines;
	}

	#runtimeView(ref: AgentRef): AgentRuntimeView {
		const progress = this.#observableFor(ref.id)?.progress;
		const view: AgentRuntimeView = {
			model: progress?.resolvedModel,
			thinkingLevel: progress?.thinkingLevel,
			lspEnabled: progress?.lspEnabled,
			advisorActive: progress?.advisorActive,
			turns: progress?.requests,
			tokens: progress?.tokens,
			contextTokens: progress?.contextTokens,
			contextWindow: progress?.contextWindow,
			toolCount: progress?.toolCount,
			cost: progress?.cost,
		};
		const session = ref.session;
		if (!session) return view;
		try {
			if (session.model) view.model = formatModelStringWithRouting(session.model);
		} catch {}
		try {
			const thinkingLevel = session.thinkingLevel;
			if (thinkingLevel !== undefined) view.thinkingLevel = thinkingLevel;
		} catch {}
		try {
			const toolNames = session.getActiveToolNames?.();
			if (toolNames !== undefined) {
				view.lspEnabled = toolNames.includes("lsp");
			}
		} catch {}
		try {
			const advisorActive = session.isAdvisorActive?.();
			if (advisorActive !== undefined) {
				view.advisorActive = advisorActive;
			}
		} catch {}

		let revision = -1;
		try {
			revision = session.contextUsageRevision;
		} catch {}
		if (this.#liveMetricsCache?.id === ref.id && this.#liveMetricsCache.revision === revision) {
			Object.assign(view, this.#liveMetricsCache.metrics);
			return view;
		}
		const metrics: AgentRuntimeView = {};
		try {
			const stats = session.getSessionStats?.();
			if (stats) {
				metrics.turns = stats.assistantMessages;
				metrics.tokens = stats.tokens.input + stats.tokens.output + stats.tokens.cacheWrite;
				metrics.toolCount = stats.toolCalls;
				metrics.cost = stats.cost;
			}
		} catch {}
		try {
			const context = session.getContextUsage?.();
			if (context) {
				metrics.contextTokens = context.tokens;
				metrics.contextWindow = context.contextWindow;
			}
		} catch {}
		this.#liveMetricsCache = { id: ref.id, revision, metrics };
		Object.assign(view, metrics);
		return view;
	}

	#renderInspector(ref: AgentRef | undefined, width: number): string[] {
		if (!ref) return [` ${theme.fg("dim", "No agent selected.")}`];
		const observed = this.#observableFor(ref.id);
		const progress = observed?.progress;
		const runtime = this.#runtimeView(ref);
		const unknown = "unknown";
		const capability = (value: boolean | undefined): string => (value === undefined ? unknown : value ? "on" : "off");
		const age = formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)));
		const parent = ref.parentId ? `${ref.kind}/of ${sanitizeLine(ref.parentId)}` : ref.kind;
		const lines = [
			` ${theme.bold(sanitizeLine(ref.id))} · ${ref.status} · ${parent} · unread ${this.#irc.unreadCount(ref.id)} · ${age}`,
		];
		const task = observed?.description ?? progress?.assignment ?? progress?.task;
		lines.push(` Task: ${task ? sanitizeLine(task, TRUNCATE_LENGTHS.TITLE) : unknown}`);
		lines.push(` Model ${sanitizeLine(runtime.model ?? unknown)} · Reasoning ${runtime.thinkingLevel ?? unknown}`);
		lines.push(` Advisor ${capability(runtime.advisorActive)} · LSP ${capability(runtime.lspEnabled)}`);
		const context =
			runtime.contextTokens === undefined
				? unknown
				: formatContextUsage(
						runtime.contextWindow && runtime.contextWindow > 0
							? (runtime.contextTokens / runtime.contextWindow) * 100
							: undefined,
						runtime.contextWindow ?? 0,
						runtime.contextTokens,
					);
		lines.push(
			` Turns ${runtime.turns === undefined ? unknown : formatNumber(runtime.turns)} · Tokens ${runtime.tokens === undefined ? unknown : formatNumber(runtime.tokens)} · Context ${context}`,
		);
		lines.push(
			` Tools ${runtime.toolCount === undefined ? unknown : formatNumber(runtime.toolCount)} · Duration ${progress ? formatDuration(progress.durationMs) : unknown} · Cost ${runtime.cost === undefined ? unknown : `$${runtime.cost.toFixed(2)}`}`,
		);
		if (!progress) {
			lines.push(` ${theme.fg("dim", "No structured progress yet.")}`);
			if (this.#tab === "archive") lines.push(` ${theme.fg("dim", "Open transcript for persisted details.")}`);
			return lines.map(line => truncateToWidth(line, Math.max(1, width)));
		}

		let activity = progress.lastIntent;
		if (progress.currentTool) {
			const elapsed = progress.currentToolStartMs
				? ` · ${formatDuration(Math.max(0, Date.now() - progress.currentToolStartMs))}`
				: "";
			activity = `${progress.currentTool}${progress.currentToolArgs ? ` ${progress.currentToolArgs}` : ""}${elapsed}`;
		}
		if (progress.retryState) {
			activity = `retry ${progress.retryState.attempt}/${progress.retryState.maxAttempts} in ${formatDuration(progress.retryState.delayMs)}: ${progress.retryState.errorMessage}`;
		} else if (progress.retryFailure) {
			activity = `retry failed at ${progress.retryFailure.attempt}: ${progress.retryFailure.errorMessage}`;
		}
		lines.push(` Activity: ${sanitizeLine(activity ?? unknown, TRUNCATE_LENGTHS.TITLE)}`);
		const recent = progress.recentTools.slice(-3).reverse();
		if (recent.length === 0) {
			lines.push(" Recent tools: none");
		} else {
			lines.push(" Recent tools:");
			for (const tool of recent) {
				const detail = `${tool.tool}${tool.args ? ` ${tool.args}` : ""} · ${formatAge(Math.max(1, Math.round((Date.now() - tool.endMs) / 1000)))}`;
				lines.push(`  ${sanitizeLine(detail, TRUNCATE_LENGTHS.TITLE)}`);
			}
		}
		return lines.map(line => truncateToWidth(line, Math.max(1, width)));
	}

	/**
	 * One agent entry, 1-2 lines:
	 * `❯ ⟳ Name  type  ↳ parent  ⧉ 2 ········ model ◒ level · age` — identity
	 * left, metadata right-aligned (inlined when the terminal is too narrow) —
	 * plus an indented dim task line when the agent's work is known.
	 */
	#renderEntry(ref: AgentRef, selected: boolean, width: number): string[] {
		const max = Math.max(1, width - 2);
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const fields: string[] = [`${cursor} ${statusGlyph(ref.status)} ${theme.bold(replaceTabs(ref.id))}`];
		if (ref.displayName && ref.displayName !== ref.id) {
			fields.push(theme.fg("dim", replaceTabs(ref.displayName)));
		}
		if (ref.parentId && ref.parentId !== MAIN_AGENT_ID) {
			fields.push(theme.fg("dim", `↳ ${replaceTabs(ref.parentId)}`));
		}
		if (ref.kind === "advisor") {
			fields.push(theme.fg("warning", "read-only"));
		}
		const unread = this.#irc.unreadCount(ref.id);
		if (unread > 0) {
			fields.push(theme.fg("warning", `⧉ ${unread}`));
		}
		const left = ` ${fields.join("  ")}`;

		const observed = this.#observableFor(ref.id);
		const meta: string[] = [];
		const badge = modelBadge(ref, observed);
		if (badge) meta.push(badge);
		meta.push(theme.fg("dim", formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)))));
		const right = meta.join(theme.sep.dot);

		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);
		const line =
			leftWidth + 2 + rightWidth <= max
				? left + padding(max - leftWidth - rightWidth) + right
				: truncateToWidth(`${left}  ${right}`.replace(/[\r\n]+/g, " "), max);
		const entry = [line];

		const task = observed?.description ?? observed?.progress?.task ?? ref.activity;
		if (task) {
			entry.push(`     ${theme.fg("muted", sanitizeLine(task, Math.max(10, max - 5)))}`);
		}
		return entry;
	}

	#handleTableInput(keyData: string): void {
		if (matchesKey(keyData, "escape")) {
			this.#onDone();
			return;
		}
		if (matchesKey(keyData, "left")) {
			const now = Date.now();
			if (now - this.#lastLeftTap < LEFT_TAP_WINDOW_MS) {
				this.#lastLeftTap = 0;
				this.#onDone();
			} else {
				this.#lastLeftTap = now;
			}
			return;
		}
		if (matchesKey(keyData, "tab") || matchesKey(keyData, "shift+tab") || keyData === "\t") {
			this.#selectedByTab[this.#tab] = this.#rows[this.#selectedRow]?.id;
			this.#tab = this.#tab === "active" ? "archive" : "active";
			this.#selectedRow = 0;
			this.#refreshRows();
			this.#notice = undefined;
			this.#requestRender();
			return;
		}
		if (this.#tab === "active" && keyData === "i") {
			this.#selectedByTab.active = this.#rows[this.#selectedRow]?.id;
			this.#showIdle = !this.#showIdle;
			this.#refreshRows();
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "j") || matchesSelectDown(keyData)) {
			if (this.#rows.length > 0) this.#selectedRow = Math.min(this.#selectedRow + 1, this.#rows.length - 1);
			this.#selectedByTab[this.#tab] = this.#rows[this.#selectedRow]?.id;
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "k") || matchesSelectUp(keyData)) {
			if (this.#rows.length > 0) this.#selectedRow = Math.max(this.#selectedRow - 1, 0);
			this.#selectedByTab[this.#tab] = this.#rows[this.#selectedRow]?.id;
			this.#requestRender();
			return;
		}
		const selected = this.#rows[this.#selectedRow];
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			if (selected) this.#activateAgent(selected);
			return;
		}
		if (keyData === "t") {
			if (selected) this.openChat(selected.id);
			return;
		}
		if (this.#tab === "archive" && keyData === "r") {
			this.#reviveSelected();
			return;
		}
		if (this.#tab === "archive" && keyData === "x") this.#killSelected();
	}

	/**
	 * Enter on a row: focus the main view on the agent's live session and close
	 * the hub. The transcript then renders through the regular session pipeline —
	 * exact parity by construction. Collab guests (no local sessions) keep the
	 * in-hub chat view.
	 */
	#activateAgent(ref: AgentRef): void {
		this.#notice = undefined;
		if (this.#tab === "archive" || this.#remote || !this.#focusAgent) {
			this.openChat(ref.id);
			return;
		}
		void (async () => {
			try {
				await this.#focusAgent!(ref.id);
				this.#onDone();
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			}
		})();
	}

	#reviveSelected(): void {
		const ref = this.#rows[this.#selectedRow];
		if (!ref) return;
		if (ref.kind === "advisor") {
			this.#notice = `"${ref.id}" is a read-only advisor transcript — nothing to revive.`;
			this.#requestRender();
			return;
		}
		if (ref.status !== "parked") {
			this.#notice = `Agent "${ref.id}" is ${ref.status} — only parked agents can be revived.`;
			this.#requestRender();
			return;
		}
		this.#notice = undefined;
		if (this.#remote) {
			this.#remote.revive(ref.id);
			this.#requestRender();
			return;
		}
		// Fire-and-forget; failures surface as an inline notice
		this.#lifecycle()
			.ensureLive(ref.id)
			.catch((error: unknown) => {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			});
		this.#requestRender();
	}

	#killSelected(): void {
		const ref = this.#rows[this.#selectedRow];
		if (!ref) return;
		if (ref.kind === "advisor") {
			this.#notice = `"${ref.id}" is a read-only advisor transcript — cannot be killed.`;
			this.#requestRender();
			return;
		}
		this.#notice = undefined;
		if (this.#remote) {
			this.#remote.kill(ref.id);
			this.#refreshRows();
			this.#requestRender();
			return;
		}
		void (async () => {
			try {
				if (ref.status === "running" && ref.session) {
					await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
				}
				await this.#lifecycle().release(ref.id);
			} catch (error) {
				logger.warn("Agent hub: kill failed", { id: ref.id, error: String(error) });
				this.#notice = error instanceof Error ? error.message : String(error);
			}
			this.#refreshRows();
			this.#requestRender();
		})();
	}
}
