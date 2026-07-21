import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CompactionCancelledError, type CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import {
	getEnvApiKey,
	getProviderDetails,
	type ProviderDetails,
	resolveUsedFraction,
	type UsageLimit,
	type UsageReport,
} from "@oh-my-pi/pi-ai";
import { Loader, Markdown, padding, Spacer, Text, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, Snowflake, sanitizeText } from "@oh-my-pi/pi-utils";
import { shouldEnableAppendOnlyContext } from "../../config/append-only-context-mode";
import { type BashResult, isPersistentShellCdCommand } from "../../exec/bash-executor";
import { type LoadedCustomShare, loadCustomShare } from "../../export/custom-share";
import { shareSession } from "../../export/share";
import type { CompactOptions } from "../../extensibility/extensions/types";
import {
	diffMentalModelContent,
	type HindsightApi,
	type HindsightSessionState,
	loadHindsightConfig,
	reloadMentalModelsForSession,
	resolveSeedsForScope,
	seedAlreadyExists,
	summarizeMentalModel,
} from "../../hindsight";
import { resolveMemoryBackend } from "../../memory-backend";
import { BashExecutionComponent } from "../../modes/components/bash-execution";
import { BorderedLoader } from "../../modes/components/bordered-loader";
import { DynamicBorder } from "../../modes/components/dynamic-border";
import { EvalExecutionComponent } from "../../modes/components/eval-execution";
import { MoveOverlay, type MoveOverlayResult } from "../../modes/components/move-overlay";
import { TranscriptBlock } from "../../modes/components/transcript-container";
import { getMarkdownTheme, getSymbolTheme, theme } from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import { computeContextBreakdown, renderContextUsage } from "../../modes/utils/context-usage";
import { buildHotkeysMarkdown } from "../../modes/utils/hotkeys-markdown";
import { buildToolsMarkdown } from "../../modes/utils/tools-markdown";
import type { AsyncJobSnapshotItem } from "../../session/agent-session";
import type { AuthStorage, OAuthAccountIdentity } from "../../session/auth-storage";
import type { CompactMode } from "../../session/compact-modes";
import type { NewSessionOptions } from "../../session/session-entries";
import { formatShakeSummary, type ShakeMode, type ShakeResult } from "../../session/shake-types";
import {
	formatActiveAccountLabel,
	limitMatchesActiveAccount,
	reportMatchesActiveAccount,
} from "../../slash-commands/helpers/active-oauth-account";
import { outputMeta } from "../../tools/output-meta";
import { resolveToCwd, stripOuterDoubleQuotes } from "../../tools/path-utils";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import {
	getChangelogPath,
	parseChangelog,
	RECENT_CHANGELOG_ENTRY_LIMIT,
	renderChangelogEntries,
} from "../../utils/changelog";
import { copyToClipboard } from "../../utils/clipboard";
import { openPath } from "../../utils/open";
import { setSessionTerminalTitle } from "../../utils/title-generator";

function showMarkdownPanel(ctx: InteractiveModeContext, title: string, markdown: string): void {
	const block = new TranscriptBlock();
	block.addChild(new DynamicBorder());
	block.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
	block.addChild(new Spacer(1));
	block.addChild(new Markdown(markdown.trim(), 1, 1, getMarkdownTheme()));
	block.addChild(new DynamicBorder());
	ctx.presentCommandOutput(block);
}

export class CommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	openInBrowser(urlOrPath: string): void {
		openPath(urlOrPath);
	}

	async handleExportCommand(text: string): Promise<void> {
		const parts = text.split(/\s+/);
		const arg = parts.length > 1 ? parts[1] : undefined;

		if (arg === "--copy" || arg === "clipboard" || arg === "copy") {
			this.ctx.showWarning("Use /dump to copy the session to clipboard.");
			return;
		}

		try {
			const filePath = await this.ctx.session.exportToHtml(arg);
			this.ctx.showStatus(`Session exported to: ${filePath}`);
			this.openInBrowser(filePath);
		} catch (error: unknown) {
			this.ctx.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	async handleDumpCommand(): Promise<void> {
		try {
			const formatted = this.ctx.session.formatSessionAsText();
			if (!formatted) {
				this.ctx.showError("No messages to dump yet.");
				return;
			}
			// Build the LLM request JSON sidecar first so its path (and a
			// raw-context warning) can be appended to the copied transcript.
			let sidecarPath: string | undefined;
			let sidecarError: string | undefined;
			try {
				sidecarPath = await this.ctx.session.dumpLlmRequestToTmpDir();
			} catch (error: unknown) {
				sidecarError = error instanceof Error ? error.message : "Unknown error";
			}
			const doc = sidecarPath
				? `${formatted}\n\n---\nLLM request JSON: ${sidecarPath}\nThis file persists on disk and may contain raw context/secrets — treat accordingly.`
				: formatted;
			await copyToClipboard(doc);
			const statusParts = ["Session copied to clipboard"];
			if (sidecarPath) statusParts.push(`LLM request JSON: ${sidecarPath}`);
			if (sidecarError) statusParts.push(`LLM request JSON unavailable: ${sidecarError}`);
			this.ctx.showStatus(statusParts.join("\n"));
		} catch (error: unknown) {
			this.ctx.showError(`Failed to copy session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	handleAdvisorDumpCommand(isRaw = false) {
		try {
			const advisorHistory = this.ctx.session.formatAdvisorHistoryAsText({ compact: !isRaw });
			if (advisorHistory === null) {
				this.ctx.showError("Advisor is not active for this session.");
				return;
			}
			if (!advisorHistory) {
				this.ctx.showError("Advisor has no history yet.");
				return;
			}
			copyToClipboard(advisorHistory);
			this.ctx.showStatus("Advisor history copied to clipboard");
		} catch (error: unknown) {
			this.ctx.showError(
				`Failed to copy advisor history: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async handleDebugTranscriptCommand(): Promise<void> {
		try {
			const width = Math.max(1, this.ctx.ui.terminal.columns);
			const renderedLines = this.ctx.chatContainer.render(width).map(line => replaceTabs(Bun.stripANSI(line)));
			const rendered = renderedLines.join("\n").trimEnd();
			if (!rendered) {
				this.ctx.showError("No messages to dump yet.");
				return;
			}
			const tmpPath = path.join(os.tmpdir(), `${Snowflake.next()}-tmp.txt`);
			await Bun.write(tmpPath, `${rendered}\n`);
			this.ctx.showStatus(`Debug transcript written to:\n${tmpPath}`);
		} catch (error: unknown) {
			this.ctx.showError(
				`Failed to write debug transcript: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async handleShareCommand(): Promise<void> {
		let customShare: LoadedCustomShare | null;
		try {
			customShare = await loadCustomShare();
		} catch (err) {
			this.ctx.showError(err instanceof Error ? err.message : String(err));
			return;
		}

		const loader = new BorderedLoader(this.ctx.ui, theme, "Sharing session...");
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(loader);
		this.ctx.ui.setFocus(loader);
		this.ctx.ui.requestRender();

		const restoreEditor = () => {
			loader.dispose();
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};
		loader.onAbort = () => {
			restoreEditor();
			this.ctx.showStatus("Share cancelled");
		};

		// Custom share scripts keep their legacy contract: they receive a path
		// to a standalone HTML export. No fallback to the default flow on error.
		if (customShare) {
			const tmpFile = path.join(os.tmpdir(), `${Snowflake.next()}.html`);
			try {
				await this.ctx.session.exportToHtml(tmpFile);
				const result = await customShare.fn(tmpFile);
				if (loader.signal.aborted) return;
				restoreEditor();

				if (typeof result === "string") {
					this.ctx.showStatus(`Share URL: ${result}`);
					this.openInBrowser(result);
				} else if (result) {
					const parts: string[] = [];
					if (result.url) parts.push(`Share URL: ${result.url}`);
					if (result.message) parts.push(result.message);
					if (parts.length > 0) this.ctx.showStatus(parts.join("\n"));
					if (result.url) this.openInBrowser(result.url);
				} else {
					this.ctx.showStatus("Session shared");
				}
			} catch (err) {
				if (!loader.signal.aborted) {
					restoreEditor();
					this.ctx.showError(`Custom share failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			} finally {
				await fs.rm(tmpFile, { force: true }).catch(() => {});
			}
			return;
		}

		// Default: encrypted snapshot to a secret gist (preferred) or the share
		// server; the key rides in the link fragment and never leaves the client.
		try {
			const result = await shareSession(this.ctx.session.sessionManager, {
				serverUrl: this.ctx.settings.get("share.serverUrl"),
				store: this.ctx.settings.get("share.store"),
				state: this.ctx.session.state,
				obfuscator: this.ctx.settings.get("share.redactSecrets") ? this.ctx.session.obfuscator : undefined,
			});
			if (loader.signal.aborted) return;
			restoreEditor();

			const lines = [`Share URL: ${result.url}`];
			if (result.gistUrl) lines.push(`Gist: ${result.gistUrl}`);
			if (result.truncated) lines.push("Note: large content was trimmed to fit the share size limit.");
			this.ctx.showStatus(lines.join("\n"));
			this.openInBrowser(result.url);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.ctx.showError(`Failed to share session: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}
	}

	async handleSessionCommand(): Promise<void> {
		const stats = this.ctx.session.getSessionStats();
		const premiumRequests =
			"premiumRequests" in stats && typeof stats.premiumRequests === "number"
				? stats.premiumRequests
				: this.ctx.session.sessionManager.getUsageStatistics().premiumRequests;
		const normalizedPremiumRequests = Math.round((premiumRequests + Number.EPSILON) * 100) / 100;

		let info = `${theme.bold("Session Info")}\n\n`;
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `\n${theme.bold("Provider")}\n`;
		const model = this.ctx.session.model;
		if (!model) {
			info += `${theme.fg("dim", "No model selected")}\n`;
		} else {
			const authMode = resolveProviderAuthMode(this.ctx.session.modelRegistry.authStorage, model.provider);
			const openaiWebsocketSetting = this.ctx.settings.get("providers.openaiWebsockets") ?? "auto";
			const preferOpenAICodexWebsockets =
				openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
			const credentialSource = this.ctx.session.modelRegistry.authStorage.describeCredentialSource(
				model.provider,
				stats.sessionId,
			);
			const providerDetails = getProviderDetails({
				model,
				sessionId: stats.sessionId,
				authMode,
				credentialSource,
				preferWebsockets: preferOpenAICodexWebsockets,
				providerSessionState: this.ctx.session.providerSessionState,
			});
			info += renderProviderSection(providerDetails, theme);
		}
		info += `\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		// Append-only context
		{
			const setting = this.ctx.settings.get("provider.appendOnlyContext") ?? "auto";
			const model = this.ctx.session.model;
			const mode = shouldEnableAppendOnlyContext(setting, model);
			const activeLabel = mode ? theme.fg("success", "active") : theme.fg("dim", "inactive");
			const settingLabel = setting === "auto" ? `${setting} (${model?.provider ?? "?"})` : setting;
			info += `${theme.fg("dim", "Append-Only:")} ${activeLabel} (setting: ${settingLabel})\n`;
		}
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0 || normalizedPremiumRequests > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			if (stats.cost > 0) {
				info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}\n`;
			}
			if (normalizedPremiumRequests > 0) {
				info += `${theme.fg("dim", "Premium Requests:")} ${normalizedPremiumRequests.toLocaleString()}\n`;
			}
		}

		if (this.ctx.lspServers && this.ctx.lspServers.length > 0) {
			info += `\n${theme.bold("LSP Servers")}\n`;
			for (const server of this.ctx.lspServers) {
				const statusColor =
					server.status === "ready"
						? "success"
						: server.status === "available"
							? "dim"
							: server.status === "connecting"
								? "warning"
								: "error";
				const statusText =
					server.status === "error" && server.error ? `${server.status}: ${server.error}` : server.status;
				info += `${theme.fg("dim", `${server.name}:`)} ${theme.fg(statusColor, statusText)} ${theme.fg("dim", `(${server.fileTypes.join(", ")})`)}\n`;
			}
		}

		if (this.ctx.mcpManager) {
			const mcpServers = this.ctx.mcpManager.getConnectedServers();
			info += `\n${theme.bold("MCP Servers")}\n`;
			if (mcpServers.length === 0) {
				info += `${theme.fg("dim", "None connected")}\n`;
			} else {
				for (const name of mcpServers) {
					const conn = this.ctx.mcpManager.getConnection(name);
					const toolCount = conn?.tools?.length ?? 0;
					info += `${theme.fg("dim", `${name}:`)} ${theme.fg("success", "connected")} ${theme.fg("dim", `(${toolCount} tools)`)}\n`;
				}
			}
		}

		this.ctx.present([new Spacer(1), new Text(info, 1, 0)]);
	}

	static readonly #advisorStatusGlyph: Record<string, string> = {
		running: "●",
		paused: "○",
		no_model: "○",
		quota_exhausted: "✕",
		error: "✕",
	};

	static readonly #advisorStatusLabel: Record<string, string> = {
		running: "running",
		paused: "off",
		no_model: "no model",
		quota_exhausted: "quota exhausted",
		error: "error",
	};

	async handleAdvisorStatusCommand(): Promise<void> {
		const stats = this.ctx.session.getAdvisorStats();
		if (!stats.configured) {
			this.ctx.present([new Spacer(1), new Text("Advisor is disabled.", 1, 0)]);
			return;
		}
		// Fetch live quota data (cached 5 min by the auth-gateway) so we can show
		// real usage windows/reset timers per advisor provider. Non-fatal when absent.
		const usageProvider = this.ctx.session as { fetchUsageReports?: () => Promise<UsageReport[] | null> };
		let usageReports: UsageReport[] | null = null;
		if (usageProvider.fetchUsageReports) {
			try {
				usageReports = await usageProvider.fetchUsageReports();
			} catch {
				// Network/auth failure is non-fatal — just skip the quota line.
			}
		}
		// Resolve the active OAuth identity for each advisor's provider so quota
		// filtering matches the credential actually in use (not sibling accounts).
		const resolveActiveAdvisorAccount = (provider: string, sessionId?: string): OAuthAccountIdentity | undefined =>
			this.ctx.session.modelRegistry.authStorage.getOAuthAccountIdentity(
				provider,
				sessionId ?? this.ctx.session.sessionId,
			);
		const nowMs = Date.now();
		// Roster view: show every configured advisor with its status, even when
		// none are live (all paused/no-model). The old code returned a generic
		// message that hid the per-advisor state the user needs to act on.
		if (stats.advisors.length > 1 || (stats.configured && !stats.active)) {
			let info = `${theme.bold("Advisor Status")} (${stats.advisors.length} advisors)\n`;
			for (const a of stats.advisors) {
				const glyph = CommandController.#advisorStatusGlyph[a.status] ?? "?";
				const label = CommandController.#advisorStatusLabel[a.status] ?? a.status;
				const color =
					a.status === "running"
						? "success"
						: a.status === "quota_exhausted" || a.status === "error"
							? "error"
							: "dim";
				info += `\n${theme.fg(color, glyph)} ${theme.bold(a.name)} ${theme.fg("dim", `[${label}]`)}\n`;
				if (a.model) {
					info += `${theme.fg("dim", "Model:")} ${a.model.provider}/${a.model.id}\n`;
				}
				if (a.model && usageReports) {
					const quota = formatCompactQuota(
						a.model.provider,
						usageReports,
						nowMs,
						resolveActiveAdvisorAccount(a.model.provider, a.sessionId),
					);
					if (quota) info += `${theme.fg("dim", quota)}\n`;
				}
				if (a.status === "running" || a.status === "quota_exhausted") {
					const ctx =
						a.contextWindow > 0
							? `${a.contextTokens.toLocaleString()} / ${a.contextWindow.toLocaleString()} (${Math.round((a.contextTokens / a.contextWindow) * 100)}%)`
							: `${a.contextTokens.toLocaleString()}`;
					info += `${theme.fg("dim", "Context:")} ${ctx}\n`;
					info += `${theme.fg("dim", "Messages:")} ${a.messages.total.toLocaleString()}\n`;
					info += `${theme.fg("dim", "Spend:")} ${a.tokens.input.toLocaleString()} in / ${a.tokens.output.toLocaleString()} out`;
					if (a.cost > 0) info += `, $${a.cost.toFixed(4)}`;
					info += "\n";
				}
			}
			if (stats.active) {
				info += `\n${theme.bold("Totals")}\n`;
				info += `${theme.fg("dim", "Tokens:")} ${stats.tokens.total.toLocaleString()}\n`;
				if (stats.cost > 0) info += `${theme.fg("dim", "Cost:")} $${stats.cost.toFixed(4)}\n`;
			}
			this.ctx.present([new Spacer(1), new Text(info, 1, 0)]);
			return;
		}
		// Single active advisor — detailed view.
		const model = stats.model;
		let info = `${theme.bold("Advisor Status")}\n\n`;
		if (stats.advisors.length === 1) {
			const a = stats.advisors[0];
			const glyph = CommandController.#advisorStatusGlyph[a.status] ?? "?";
			const label = CommandController.#advisorStatusLabel[a.status] ?? a.status;
			info += `${theme.fg(a.status === "running" ? "success" : "error", glyph)} ${a.name} ${theme.fg("dim", `[${label}]`)}\n\n`;
		}
		if (model) {
			info += `${theme.bold("Provider")}\n`;
			info += `${theme.fg("dim", "Model:")} ${model.provider}/${model.id}\n`;
		}
		if (model && usageReports) {
			const quota = formatCompactQuota(
				model.provider,
				usageReports,
				nowMs,
				resolveActiveAdvisorAccount(model.provider, stats.advisors[0]?.sessionId),
			);
			if (quota) {
				info += `\n${theme.bold("Quota")}\n`;
				info += `${theme.fg("dim", quota)}\n`;
			}
		}
		info += `\n${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.messages.user.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.messages.assistant.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.messages.total.toLocaleString()}\n`;
		info += `\n${theme.bold("Context")}\n`;
		if (stats.contextWindow > 0) {
			const percent = Math.round((stats.contextTokens / stats.contextWindow) * 100);
			info += `${theme.fg("dim", "Tokens:")} ${stats.contextTokens.toLocaleString()} / ${stats.contextWindow.toLocaleString()} (${percent}%)\n`;
		} else {
			info += `${theme.fg("dim", "Tokens:")} ${stats.contextTokens.toLocaleString()}\n`;
		}
		info += `\n${theme.bold("Spend")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.cost > 0) info += `${theme.fg("dim", "Cost:")} $${stats.cost.toFixed(4)}\n`;
		this.ctx.present([new Spacer(1), new Text(info, 1, 0)]);
	}

	async handleJobsCommand(): Promise<void> {
		const snapshot = this.ctx.session.getAsyncJobSnapshot({ recentLimit: 5 });
		if (!snapshot) {
			this.ctx.showWarning("Async background jobs are unavailable in this session.");
			return;
		}

		const now = Date.now();
		const lineWidth = Math.max(24, (this.ctx.ui.terminal.columns ?? 100) - 24);
		let info = `${theme.bold("Background Jobs")}\n\n`;
		info += `${theme.fg("dim", "Running:")} ${snapshot.running.length}\n`;

		if (snapshot.running.length === 0 && snapshot.recent.length === 0) {
			info += `\n${theme.fg("dim", "No async jobs yet.")}\n`;
			this.ctx.present([new Spacer(1), new Text(info, 1, 0)]);
			return;
		}

		if (snapshot.running.length > 0) {
			info += `\n${theme.bold("Running Jobs")}\n`;
			for (const job of snapshot.running) {
				info += `${renderJobLine(job, now)}\n`;
				info += `  ${theme.fg("dim", truncateJobLabel(job.label, lineWidth))}\n`;
			}
		}

		if (snapshot.recent.length > 0) {
			info += `\n${theme.bold("Recent Jobs")}\n`;
			for (const job of snapshot.recent) {
				info += `${renderJobLine(job, now)}\n`;
				info += `  ${theme.fg("dim", truncateJobLabel(job.label, lineWidth))}\n`;
			}
		}

		this.ctx.present([new Spacer(1), new Text(info.trimEnd(), 1, 0)]);
	}

	async handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		let usageReports = reports ?? null;
		if (!usageReports) {
			const provider = this.ctx.session as { fetchUsageReports?: () => Promise<UsageReport[] | null> };
			if (!provider.fetchUsageReports) {
				this.ctx.showWarning("Usage reporting is not configured for this session.");
				return;
			}
			try {
				usageReports = await provider.fetchUsageReports();
			} catch (error) {
				this.ctx.showError(`Failed to fetch usage data: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
		}

		if (!usageReports || usageReports.length === 0) {
			this.ctx.showWarning("No usage data available.");
			return;
		}

		const availableWidth = Math.max(40, (this.ctx.ui.terminal.columns ?? 100) - 2);
		const currentProvider = this.ctx.session.model?.provider;
		const activeAccount = currentProvider
			? this.ctx.session.modelRegistry.authStorage.getOAuthAccountIdentity(
					currentProvider,
					this.ctx.session.sessionId,
				)
			: undefined;
		const output = renderUsageReports(usageReports, theme, Date.now(), availableWidth, provider =>
			provider === currentProvider ? activeAccount : undefined,
		);
		this.ctx.present([new Spacer(1), new Text(output, 1, 0)]);
	}

	async handleChangelogCommand(showFull = false): Promise<void> {
		const changelogPath = getChangelogPath();
		const allEntries = await parseChangelog(changelogPath);
		const entriesToShow = showFull ? allEntries : allEntries.slice(0, RECENT_CHANGELOG_ENTRY_LIMIT);
		const changelogMarkdown =
			entriesToShow.length > 0 ? renderChangelogEntries(entriesToShow).markdown : "No changelog entries found.";
		const title = showFull ? "Full Changelog" : "Recent Changes";
		const hint = showFull
			? ""
			: `\n\n${theme.fg("dim", "Use")} ${theme.bold("/changelog full")} ${theme.fg("dim", "to view the complete changelog.")}`;

		const block = new TranscriptBlock();
		block.addChild(new DynamicBorder());
		block.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
		block.addChild(new Spacer(1));
		block.addChild(new Markdown(changelogMarkdown + hint, 1, 1, getMarkdownTheme()));
		block.addChild(new DynamicBorder());
		this.ctx.present(block);
	}

	handleHotkeysCommand(): void {
		const hotkeys = buildHotkeysMarkdown({ keybindings: this.ctx.keybindings });
		showMarkdownPanel(this.ctx, "Keyboard Shortcuts", hotkeys);
	}

	handleToolsCommand(): void {
		const tools = buildToolsMarkdown({
			tools: this.ctx.session.agent.state.tools,
			xdevTools: this.ctx.session.getXdevToolEntries(),
		});
		showMarkdownPanel(this.ctx, "Available Tools", tools);
	}

	handleContextCommand(): void {
		const breakdown = computeContextBreakdown(this.ctx.session, { snapcompactSavings: true });
		if (breakdown.contextWindow <= 0) {
			this.ctx.showWarning("Context usage is unavailable: no model is selected for this session.");
			return;
		}
		const output = renderContextUsage(breakdown, theme);
		const block = new TranscriptBlock();
		block.addChild(new DynamicBorder());
		block.addChild(new Text(theme.bold(theme.fg("accent", "Context Usage")), 1, 0));
		block.addChild(new Spacer(1));
		block.addChild(new Text(output, 1, 0));
		block.addChild(new DynamicBorder());
		this.ctx.present(block);
	}

	async handleMemoryCommand(text: string): Promise<void> {
		const argumentText = text.slice(7).trim();
		const action = argumentText.split(/\s+/, 1)[0]?.toLowerCase() || "view";
		const agentDir = this.ctx.settings.getAgentDir();
		const backend = await resolveMemoryBackend(this.ctx.settings);

		if (action === "view") {
			const payload = await backend.buildDeveloperInstructions(agentDir, this.ctx.settings, this.ctx.session);
			if (!payload) {
				this.ctx.showWarning("Memory payload is empty (memory backend off, disabled, or no memory available).");
				return;
			}
			const block = new TranscriptBlock();
			block.addChild(new DynamicBorder());
			block.addChild(new Text(theme.bold(theme.fg("accent", "Memory Injection Payload")), 1, 0));
			block.addChild(new Spacer(1));
			block.addChild(new Markdown(payload, 1, 1, getMarkdownTheme()));
			block.addChild(new DynamicBorder());
			this.ctx.present(block);
			return;
		}

		if (action === "reset" || action === "clear") {
			try {
				await backend.clear(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				await this.ctx.session.refreshBaseSystemPrompt();
				this.ctx.showStatus("Memory data cleared and system prompt refreshed.");
			} catch (error) {
				this.ctx.showError(`Memory clear failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (action === "enqueue" || action === "rebuild") {
			try {
				await backend.enqueue(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				this.ctx.showStatus("Memory consolidation enqueued.");
			} catch (error) {
				this.ctx.showError(`Memory enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (action === "stats" || action === "diagnose") {
			const hook = action === "stats" ? backend.stats : backend.diagnose;
			try {
				const payload = await hook?.(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				if (!payload) {
					this.ctx.showWarning(`Memory ${action} is not available for the ${backend.id} backend.`);
					return;
				}
				showMarkdownPanel(this.ctx, `Memory ${action === "stats" ? "Stats" : "Diagnostics"}`, payload);
			} catch (error) {
				this.ctx.showError(`Memory ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (action === "mm") {
			await this.#handleMentalModelsSubcommand(argumentText);
			return;
		}

		this.ctx.showError("Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild|mm ...>");
	}

	async #handleMentalModelsSubcommand(argumentText: string): Promise<void> {
		// Parse: "mm <verb> [arg]"
		const parts = argumentText.split(/\s+/).slice(1);
		const verb = parts[0]?.toLowerCase() ?? "list";
		const arg = parts[1];

		const state = this.ctx.session.getHindsightSessionState();
		const primary = state && !state.aliasOf ? state : undefined;
		if (!primary) {
			this.ctx.showError("Hindsight backend is not active for this session.");
			return;
		}
		if (!primary.config.mentalModelsEnabled) {
			this.ctx.showError("Mental models are disabled (hindsight.mentalModelsEnabled = false).");
			return;
		}

		switch (verb) {
			case "list":
				await this.#mmList(primary);
				return;
			case "show":
				if (!arg) return this.ctx.showError("Usage: /memory mm show <id>");
				await this.#mmShow(primary, arg);
				return;
			case "refresh":
				await this.#mmRefresh(primary, arg);
				return;
			case "history":
				if (!arg) return this.ctx.showError("Usage: /memory mm history <id>");
				await this.#mmHistory(primary, arg);
				return;
			case "seed":
				await this.#mmSeed(primary);
				return;
			case "reload":
				await this.#mmReload(primary);
				return;
			case "delete":
			case "remove":
				if (!arg) return this.ctx.showError("Usage: /memory mm delete <id>");
				await this.#mmDelete(primary, arg);
				return;
			default:
				this.ctx.showError("Usage: /memory mm <list|show|refresh|history|seed|reload|delete>");
		}
	}

	async #mmList(state: HindsightSessionState): Promise<void> {
		const client: HindsightApi = state.client;
		try {
			const response = await client.listMentalModels(state.bankId, { detail: "metadata" });
			const items = response.items ?? [];
			if (items.length === 0) {
				this.ctx.showStatus(`No mental models on bank ${state.bankId}.`);
				return;
			}
			const lines = items
				.slice()
				.sort((a, b) => a.id.localeCompare(b.id))
				.map(summarizeMentalModel);
			showMarkdownPanel(this.ctx, `Mental Models — ${state.bankId}`, lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`mm list failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmShow(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const model = await state.client.getMentalModel(state.bankId, id, { detail: "content" });
			if (!model) {
				this.ctx.showError(`Mental model not found: ${id}`);
				return;
			}
			const tags = model.tags && model.tags.length > 0 ? `\n_tags: ${model.tags.join(", ")}_` : "";
			const refreshed = model.last_refreshed_at ? `\n_last refreshed: ${model.last_refreshed_at}_` : "";
			const sourceQuery = model.source_query ? `\n\n**Source query:** ${model.source_query}` : "";
			const content = (model.content ?? "_(empty — background reflect may still be running)_").trim();
			showMarkdownPanel(
				this.ctx,
				model.name,
				`**id:** \`${model.id}\`${tags}${refreshed}${sourceQuery}\n\n${content}`,
			);
		} catch (error) {
			this.ctx.showError(`mm show failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmRefresh(state: HindsightSessionState, id: string | undefined): Promise<void> {
		try {
			if (id) {
				// Single-model refresh is explicit operator intent: bypass the
				// auto-refresh filter so curated/manual models can still be
				// refreshed on demand.
				await state.client.refreshMentalModel(state.bankId, id);
				this.ctx.showStatus(`Refresh queued for mental model ${id}.`);
			} else {
				// Bulk refresh: only touch models that opted into automatic
				// refresh via `trigger.refresh_after_consolidation`. Curated
				// models are reviewed before publishing and must not be
				// silently regenerated by a bank-wide refresh sweep. Reading
				// `detail: "content"` here is required because the trigger
				// field is excluded from `detail: "metadata"`.
				const list = await state.client.listMentalModels(state.bankId, { detail: "content" });
				const items = list.items ?? [];
				if (items.length === 0) {
					this.ctx.showStatus(`No mental models on bank ${state.bankId}.`);
					return;
				}
				const targets = items.filter(m => m.trigger?.refresh_after_consolidation === true);
				const skipped = items.length - targets.length;
				if (targets.length === 0) {
					this.ctx.showStatus(
						`No mental models opted into auto-refresh; ${skipped} curated model(s) left untouched. Pass an explicit id to refresh one of them.`,
					);
					return;
				}
				let queued = 0;
				for (const item of targets) {
					try {
						await state.client.refreshMentalModel(state.bankId, item.id);
						queued++;
					} catch (error) {
						this.ctx.showWarning(
							`Refresh failed for ${item.id}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
				const skippedSuffix = skipped > 0 ? `; skipped ${skipped} curated model(s)` : "";
				this.ctx.showStatus(
					`Refresh queued for ${queued}/${targets.length} auto-refresh model(s)${skippedSuffix}.`,
				);
			}
			// Reload the cache after a brief grace so the new content (if the refresh
			// completes synchronously on the server) flows into the system prompt.
			await Bun.sleep(500);
			await reloadMentalModelsForSession(state.session);
		} catch (error) {
			this.ctx.showError(`mm refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmHistory(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const [model, history] = await Promise.all([
				state.client.getMentalModel(state.bankId, id, { detail: "content" }),
				state.client.getMentalModelHistory(state.bankId, id),
			]);
			if (!model) {
				this.ctx.showError(`Mental model not found: ${id}`);
				return;
			}
			if (history.length === 0) {
				this.ctx.showStatus(`No history recorded for ${id}.`);
				return;
			}
			// History is most-recent first. Each entry stores the content BEFORE that
			// change. To diff "what changed at entry N", compare entry N's
			// previous_content (= state before that change) with entry N-1's
			// previous_content (= state after that change, which was state before
			// the next change). For the most recent change, compare against the
			// model's CURRENT content.
			const sections: string[] = [];
			for (let i = 0; i < history.length; i++) {
				const before = history[i].previous_content ?? "";
				const after = i === 0 ? (model.content ?? "") : (history[i - 1].previous_content ?? "");
				const diff = diffMentalModelContent(before, after);
				sections.push(`### ${history[i].changed_at}\n\n\`\`\`diff\n${diff}\n\`\`\``);
			}
			showMarkdownPanel(this.ctx, `History — ${model.name}`, sections.join("\n\n"));
		} catch (error) {
			this.ctx.showError(`mm history failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmSeed(state: HindsightSessionState): Promise<void> {
		try {
			const config = loadHindsightConfig(this.ctx.settings);
			const seeds = resolveSeedsForScope(
				{
					bankId: state.bankId,
					retainTags: state.retainTags,
					recallTags: state.recallTags,
					recallTagsMatch: state.recallTagsMatch,
				},
				config.scoping,
			);
			if (seeds.length === 0) {
				this.ctx.showStatus(`No built-in seeds apply to scoping=${config.scoping}.`);
				return;
			}
			const list = await state.client.listMentalModels(state.bankId, { detail: "metadata" });
			const existing = list.items ?? [];
			let created = 0;
			let skipped = 0;
			for (const seed of seeds) {
				if (seedAlreadyExists(seed, existing)) {
					skipped++;
					continue;
				}
				try {
					await state.client.createMentalModel(state.bankId, seed.name, seed.sourceQuery, {
						id: seed.id,
						tags: seed.tags.length > 0 ? seed.tags : undefined,
						maxTokens: seed.maxTokens,
						trigger: seed.trigger,
					});
					created++;
				} catch (error) {
					this.ctx.showWarning(
						`Seed failed for ${seed.id}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			this.ctx.showStatus(`Seeded ${created} new mental model(s); ${skipped} already present.`);
		} catch (error) {
			this.ctx.showError(`mm seed failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmReload(state: HindsightSessionState): Promise<void> {
		const ok = await reloadMentalModelsForSession(state.session);
		if (ok) {
			this.ctx.showStatus("Mental-model cache reloaded.");
		} else {
			this.ctx.showError("Reload failed (Hindsight backend not active or mental models disabled).");
		}
	}

	async #mmDelete(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const removed = await state.client.deleteMentalModel(state.bankId, id);
			if (!removed) {
				this.ctx.showError(`Mental model not found: ${id}`);
				return;
			}
			// Drop the cached snippet so the closing tag does not silently keep
			// stale content in the system prompt until the next agent_end TTL.
			await reloadMentalModelsForSession(state.session);
			this.ctx.showStatus(`Deleted mental model ${id} from bank ${state.bankId}.`);
		} catch (error) {
			this.ctx.showError(`mm delete failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #runNewSessionFlow(options?: NewSessionOptions, label: string = "New session started"): Promise<void> {
		this.ctx.clearTransientSessionUi();

		if (this.ctx.session.isCompacting) {
			this.ctx.session.abortCompaction();
			while (this.ctx.session.isCompacting) {
				await Bun.sleep(10);
			}
		}
		if (!(await this.ctx.session.newSession(options))) return;
		this.ctx.resetObserverRegistry();
		setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());

		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.updateEditorBorderColor();
		this.ctx.clearTransientSessionUi();
		this.ctx.resetTranscript();

		this.ctx.present([new Spacer(1), new Text(`${theme.fg("accent", `${theme.status.success} ${label}`)}`, 1, 1)]);
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
	}

	async handleClearCommand(): Promise<void> {
		await this.#runNewSessionFlow();
	}

	async handleFreshCommand(): Promise<void> {
		const result = this.ctx.session.freshSession();
		if (!result) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before refreshing provider state.");
			return;
		}
		const stateLabel = result.closedProviderSessions === 1 ? "provider state" : "provider states";
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();
		this.ctx.showStatus(`Fresh provider session started (${result.closedProviderSessions} ${stateLabel} pruned).`);
	}

	async handleDropCommand(): Promise<void> {
		if (!this.ctx.sessionManager.getSessionFile()) {
			this.ctx.showError("Nothing to drop (in-memory session)");
			return;
		}
		await this.#runNewSessionFlow({ drop: true }, "Session dropped");
	}

	async handleForkCommand(): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before forking.");
			return;
		}
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.disposeChildren();

		const success = await this.ctx.session.fork();
		if (!success) {
			this.ctx.showError("Fork failed (session not persisted or cancelled)");
			return;
		}

		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();

		const sessionFile = this.ctx.session.sessionFile;
		const shortPath = sessionFile ? sessionFile.split("/").pop() : "new session";
		this.ctx.present([
			new Spacer(1),
			new Text(`${theme.fg("accent", `${theme.status.success} Session forked to ${shortPath}`)}`, 1, 1),
		]);
	}

	/**
	 * `/move` — relocate the current session to a different directory.
	 *
	 * With no `targetPath` (TUI only), opens an autocomplete overlay so the user
	 * can pick or type a directory. With a `targetPath`, resolves it directly.
	 * If the target directory does not exist, the user is asked whether to create
	 * it. The active session file and artifacts are moved into the target
	 * directory's session bucket so `/resume` from that directory can find it.
	 */
	async handleMoveCommand(targetPath?: string): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before moving.");
			return;
		}

		let input: string | undefined = targetPath?.trim() || undefined;

		// No argument in TUI mode: open the path autocomplete overlay.
		if (!input) {
			const result = await this.ctx.showHookCustom<MoveOverlayResult | undefined>(
				(_tui, _theme, _keybindings, done) => new MoveOverlay(this.ctx.sessionManager.getCwd(), done),
				{ overlay: true },
			);
			if (!result) return; // cancelled
			input = result.directory;
		}

		const unquoted = stripOuterDoubleQuotes(input);
		if (!unquoted) {
			this.ctx.showError("Usage: /move <path>");
			return;
		}

		const cwd = this.ctx.sessionManager.getCwd();
		const resolvedPath = resolveToCwd(unquoted, cwd);

		// If the directory doesn't exist, offer to create it.
		let isDirectory: boolean;
		try {
			isDirectory = (await fs.stat(resolvedPath)).isDirectory();
		} catch {
			isDirectory = false;
		}

		if (!isDirectory) {
			const parentDir = path.dirname(resolvedPath);
			let parentExists = false;
			try {
				parentExists = (await fs.stat(parentDir)).isDirectory();
			} catch {
				parentExists = false;
			}
			if (!parentExists) {
				this.ctx.showError(`Cannot create "${path.basename(resolvedPath)}": parent directory does not exist`);
				return;
			}
			const confirmed = await this.ctx.showHookConfirm(
				"Create directory?",
				`"${path.basename(resolvedPath)}" does not exist. Create it?`,
			);
			if (!confirmed) return;
			try {
				await fs.mkdir(resolvedPath, { recursive: true });
			} catch (err) {
				this.ctx.showError(`Failed to create directory: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
		}
		try {
			await this.ctx.settings.flush();
		} catch (err) {
			this.ctx.showError(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		try {
			await this.ctx.sessionManager.moveTo(resolvedPath);
		} catch (err) {
			this.ctx.showError(`Move failed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		await this.ctx.applyCwdChange(resolvedPath);

		this.ctx.updateEditorBorderColor();
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender();

		this.ctx.present([
			new Spacer(1),
			new Text(`${theme.fg("accent", `${theme.status.success} Moved to ${resolvedPath}`)}`, 1, 1),
		]);
	}

	async handleRenameCommand(title: string): Promise<void> {
		try {
			const stored = await this.ctx.sessionManager.setSessionName(title, "user");
			if (!stored) {
				this.ctx.showError("Session name cannot be empty.");
				return;
			}
			const name = this.ctx.sessionManager.getSessionName()!;
			this.ctx.showStatus(`Session renamed to "${name}".`);
		} catch (err) {
			this.ctx.showError(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const isDeferred = this.ctx.session.isStreaming;
		const shouldPersistCwd = isPersistentShellCdCommand(command);
		if (isDeferred && shouldPersistCwd) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before changing directories.");
			return;
		}

		this.ctx.bashComponent = new BashExecutionComponent(command, this.ctx.ui, excludeFromContext);

		if (isDeferred) {
			this.ctx.pendingMessagesContainer.addChild(this.ctx.bashComponent);
			this.ctx.pendingBashComponents.push(this.ctx.bashComponent);
		} else {
			this.ctx.present(this.ctx.bashComponent);
		}
		this.ctx.ui.requestRender();

		try {
			const result = await this.ctx.session.executeBash(
				command,
				chunk => {
					if (this.ctx.bashComponent) {
						this.ctx.bashComponent.appendOutput(chunk);
					}
				},
				{ excludeFromContext, useUserShell: true },
			);
			if (this.ctx.bashComponent) {
				const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
				this.ctx.bashComponent.setComplete(result.exitCode, result.cancelled, {
					output: result.output,
					truncation: meta?.truncation,
				});
			}
			try {
				if (shouldPersistCwd) await this.#applyBashResultCwd(result);
			} catch (error) {
				this.ctx.showError(
					`Bash command completed, but OMP failed to update its working directory: ${
						error instanceof Error ? error.message : "Unknown error"
					}`,
				);
			}
		} catch (error) {
			if (this.ctx.bashComponent) {
				this.ctx.bashComponent.setComplete(undefined, false);
			}
			this.ctx.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.ctx.bashComponent = undefined;
		this.ctx.ui.requestRender();
	}

	async #moveInteractiveCwd(resolvedPath: string): Promise<void> {
		await this.ctx.sessionManager.moveTo(resolvedPath);
		await this.ctx.applyCwdChange(resolvedPath);
		this.ctx.updateEditorBorderColor();
		await this.ctx.reloadTodos();
	}

	async #applyBashResultCwd(result: BashResult): Promise<void> {
		if (result.cancelled || result.exitCode !== 0 || !result.workingDir) return;
		if (!path.isAbsolute(result.workingDir)) return;

		const resolvedPath = path.resolve(result.workingDir);
		if (resolvedPath === path.resolve(this.ctx.sessionManager.getCwd())) return;

		let isDirectory = false;
		try {
			isDirectory = (await fs.stat(resolvedPath)).isDirectory();
		} catch {
			isDirectory = false;
		}
		if (!isDirectory) return;

		await this.#moveInteractiveCwd(resolvedPath);
	}

	async handlePythonCommand(code: string, excludeFromContext = false): Promise<void> {
		const isDeferred = this.ctx.session.isStreaming;
		this.ctx.pythonComponent = new EvalExecutionComponent(code, this.ctx.ui, excludeFromContext);

		if (isDeferred) {
			this.ctx.pendingMessagesContainer.addChild(this.ctx.pythonComponent);
			this.ctx.pendingPythonComponents.push(this.ctx.pythonComponent);
		} else {
			this.ctx.present(this.ctx.pythonComponent);
		}
		this.ctx.ui.requestRender();

		try {
			const result = await this.ctx.session.executePython(
				code,
				chunk => {
					if (this.ctx.pythonComponent) {
						this.ctx.pythonComponent.appendOutput(chunk);
					}
				},
				{ excludeFromContext },
			);

			if (this.ctx.pythonComponent) {
				const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
				this.ctx.pythonComponent.setComplete(result.exitCode, result.cancelled, {
					output: result.output,
					truncation: meta?.truncation,
				});
			}
		} catch (error) {
			if (this.ctx.pythonComponent) {
				this.ctx.pythonComponent.setComplete(undefined, false);
			}
			this.ctx.showError(`Python execution failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.ctx.pythonComponent = undefined;
		this.ctx.ui.requestRender();
	}

	async handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		internalGuidance?: string,
	): Promise<CompactionOutcome> {
		const entries = this.ctx.sessionManager.getEntries();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			this.ctx.showWarning("Nothing to compact (no messages yet)");
			return "ok";
		}

		// `internalGuidance` is a private summarizer directive (plan-mode
		// "Approve and compact context") that MUST stay off the public
		// `customInstructions` channel of the `session_before_compact` extension
		// hook — extensions treat that field as user focus and would otherwise
		// bias the summary toward the plan boilerplate (issue #4359). Ride it
		// through as a CompactOptions field instead.
		if (internalGuidance) {
			return this.executeCompaction({ internalGuidance, ...(mode ? { mode } : {}) }, false, beforeFlush, mode);
		}
		return this.executeCompaction(customInstructions, false, beforeFlush, mode);
	}

	/**
	 * TUI handler for `/shake`. `elide` drops heavy structural content and
	 * `images` strips image blocks. Rebuilds the chat and reports counts.
	 */
	async handleShakeCommand(mode: ShakeMode): Promise<void> {
		let result: ShakeResult;
		try {
			result = await this.ctx.session.shake(mode);
		} catch (error) {
			this.ctx.showError(`Shake failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		const dropped = result.toolResultsDropped + result.blocksDropped + (result.imagesDropped ?? 0);
		if (dropped === 0) {
			this.ctx.showStatus("Nothing to shake.");
			return;
		}
		this.ctx.rebuildChatFromMessages();
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();
		this.ctx.showStatus(formatShakeSummary(result));
	}

	async executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto = false,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		mode?: CompactMode,
	): Promise<CompactionOutcome> {
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.disposeChildren();

		const label = isAuto ? "Auto-compacting context... (esc to cancel)" : "Compacting context... (esc to cancel)";
		const compactingLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			label,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(compactingLoader);
		this.ctx.ui.requestRender();

		let outcome: CompactionOutcome = "ok";
		try {
			const instructions = typeof customInstructionsOrOptions === "string" ? customInstructionsOrOptions : undefined;
			const baseOptions =
				customInstructionsOrOptions && typeof customInstructionsOrOptions === "object"
					? customInstructionsOrOptions
					: undefined;
			// The slash path passes `mode` positionally; the extension path carries
			// it inside the options object. Either source wins over no mode.
			const effectiveMode = mode ?? baseOptions?.mode;
			const options =
				baseOptions || effectiveMode
					? { ...baseOptions, ...(effectiveMode ? { mode: effectiveMode } : {}) }
					: undefined;
			await this.ctx.session.compact(instructions, options);

			compactingLoader.stop();
			this.ctx.statusContainer.disposeChildren();
			this.ctx.rebuildChatFromMessages();

			this.ctx.statusLine.invalidate();
			// Same as the auto-compaction rebuild: a collapsed transcript is an
			// intentional replacement, so drop the stale pre-compaction scrollback
			// instead of repainting the shrunken frame below it. With collapse
			// disabled the full history stays inline and scrollback is kept.
			if (this.ctx.settings.get("display.collapseCompacted")) {
				this.ctx.ui.requestRender(true, { clearScrollback: true });
			} else {
				this.ctx.ui.requestRender();
			}
		} catch (error) {
			if (error instanceof CompactionCancelledError) {
				outcome = "cancelled";
				this.ctx.showError("Compaction cancelled");
			} else {
				outcome = "failed";
				const message = error instanceof Error ? error.message : String(error);
				this.ctx.showError(`Compaction failed: ${message}`);
			}
		} finally {
			compactingLoader.stop();
			this.ctx.statusContainer.disposeChildren();
		}
		// Run the caller's pre-flush hook (e.g. the plan-approval model transition)
		// before queued user input is dispatched, so any turn queued during
		// compaction executes on the post-compaction model rather than the model
		// compaction itself ran on.
		if (beforeFlush) await beforeFlush(outcome);
		await this.ctx.flushCompactionQueue({ willRetry: false });
		return outcome;
	}

	async handleHandoffCommand(customInstructions?: string): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before handing off.");
			return;
		}

		const entries = this.ctx.sessionManager.getEntries();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			this.ctx.showWarning("Nothing to hand off (no messages yet)");
			return;
		}

		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.disposeChildren();

		const handoffLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			"Generating handoff… (esc to cancel)",
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(handoffLoader);
		this.ctx.ui.requestRender();

		try {
			// Handoff generation runs as a oneshot request; the new session is shown after it completes.
			const result = await this.ctx.session.handoff(customInstructions);

			if (!result) {
				this.ctx.showError("Handoff cancelled");
				return;
			}

			// Rebuild chat from the new session (which now contains the handoff document).
			this.ctx.clearTransientSessionUi();
			this.ctx.renderInitialMessages();
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			await this.ctx.reloadTodos();

			this.ctx.present([
				new Spacer(1),
				new Text(`${theme.fg("accent", `${theme.status.success} New session started with handoff context`)}`, 1, 1),
			]);
			if (result.savedPath) {
				this.ctx.showStatus(`Handoff document saved to: ${result.savedPath}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === "Handoff cancelled" || (error instanceof Error && error.name === "AbortError")) {
				this.ctx.showError("Handoff cancelled");
			} else {
				this.ctx.showError(`Handoff failed: ${message}`);
			}
		} finally {
			handoffLoader.stop();
			this.ctx.statusContainer.disposeChildren();
		}
		this.ctx.ui.requestRender(true, { clearScrollback: true });
	}
}

const BAR_WIDTH_MAX = 24;
const COLUMN_WIDTH_MIN = 4;

function renderJobLine(job: AsyncJobSnapshotItem, now: number): string {
	const duration = formatDuration(Math.max(0, now - job.startTime));
	const status = formatJobStatus(job.status);
	return `${theme.fg("dim", job.id)} ${theme.fg("dim", `[${job.type}]`)} ${status} ${theme.fg("dim", `(${duration})`)}`;
}

function formatJobStatus(status: AsyncJobSnapshotItem["status"]): string {
	if (status === "running") return theme.fg("warning", "running");
	if (status === "completed") return theme.fg("success", "completed");
	if (status === "cancelled") return theme.fg("dim", "cancelled");
	return theme.fg("error", "failed");
}

function truncateJobLabel(label: string, maxWidth: number): string {
	if (visibleWidth(label) <= maxWidth) return label;
	if (maxWidth <= 1) return "…";

	let out = "";
	for (const char of label) {
		const next = `${out}${char}`;
		if (visibleWidth(`${next}…`) > maxWidth) break;
		out = next;
	}

	return `${out}…`;
}

function formatProviderName(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map(part => (part ? part[0].toUpperCase() + part.slice(1) : ""))
		.join(" ");
}

function resolveProviderAuthMode(authStorage: AuthStorage, provider: string): string {
	if (authStorage.hasOAuth(provider)) {
		return "oauth";
	}
	if (authStorage.has(provider)) {
		return "api key";
	}
	if (getEnvApiKey(provider)) {
		return "env api key";
	}
	if (authStorage.hasAuth(provider)) {
		return "runtime/fallback";
	}
	return "unknown";
}

export function renderProviderSection(details: ProviderDetails, uiTheme: Pick<typeof theme, "fg">): string {
	const lines: string[] = [];
	lines.push(`${uiTheme.fg("dim", "Name:")} ${details.provider}`);
	for (const field of details.fields) {
		lines.push(`${uiTheme.fg("dim", `${field.label}:`)} ${field.value}`);
	}
	return `${lines.join("\n")}\n`;
}

function resolveProviderUsageTotal(reports: UsageReport[]): number {
	return reports
		.flatMap(report => report.limits)
		.map(limit => resolveUsedFraction(limit) ?? 0)
		.reduce((sum, value) => sum + value, 0);
}

function formatLimitTitle(limit: UsageLimit): string {
	const tier = limit.scope.tier;
	if (tier && !limit.label.toLowerCase().includes(tier.toLowerCase())) {
		return `${limit.label} (${tier})`;
	}
	return limit.label;
}

function formatWindowSuffix(label: string, windowLabel: string, uiTheme: typeof theme): string {
	const normalizedLabel = label.toLowerCase();
	const normalizedWindow = windowLabel.toLowerCase();
	if (normalizedWindow === "quota window") return "";
	if (normalizedLabel.includes(normalizedWindow)) return "";
	return uiTheme.fg("dim", `(${windowLabel})`);
}

/** ` (org)` suffix when the report is org-attributed — two subscriptions can share one email. */
function orgSuffix(report: UsageReport): string {
	const orgName = report.metadata?.orgName;
	const orgId = report.metadata?.orgId;
	const org = typeof orgName === "string" && orgName ? orgName : typeof orgId === "string" ? orgId : undefined;
	return org ? ` (${org})` : "";
}

function formatUnlimitedReportLabel(report: UsageReport, index: number): string {
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return `${email}${orgSuffix(report)}`;
	const accountId = report.metadata?.accountId;
	if (typeof accountId === "string" && accountId) return `${accountId}${orgSuffix(report)}`;
	const projectId = report.metadata?.projectId;
	if (typeof projectId === "string" && projectId) return projectId;
	return `account ${index + 1}`;
}

function resolveReportProjectId(report: UsageReport): string | undefined {
	const projectId = report.metadata?.projectId;
	if (typeof projectId === "string" && projectId) return projectId;
	for (const limit of report.limits) {
		const scopedProjectId = limit.scope.projectId;
		if (typeof scopedProjectId === "string" && scopedProjectId) return scopedProjectId;
	}
	return undefined;
}

function resolveReportOrganizationId(report: UsageReport): string | undefined {
	const metadataOrgId = report.metadata?.orgId;
	if (typeof metadataOrgId === "string" && metadataOrgId) return metadataOrgId;
	const metadataOrgName = report.metadata?.orgName;
	if (typeof metadataOrgName === "string" && metadataOrgName) return metadataOrgName;
	for (const limit of report.limits) {
		const scopedOrgId = limit.scope.orgId;
		if (typeof scopedOrgId === "string" && scopedOrgId) return scopedOrgId;
	}
	return undefined;
}

function resolveReportAccountId(report: UsageReport): string | undefined {
	const metadataAccountId = report.metadata?.accountId;
	if (typeof metadataAccountId === "string" && metadataAccountId) return metadataAccountId;
	const metadataAccountIdAlias = report.metadata?.account_id;
	if (typeof metadataAccountIdAlias === "string" && metadataAccountIdAlias) return metadataAccountIdAlias;
	for (const limit of report.limits) {
		const scopedAccountId = limit.scope.accountId;
		if (typeof scopedAccountId === "string" && scopedAccountId) return scopedAccountId;
	}
	return undefined;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function toGraphemes(text: string): string[] {
	const clusters: string[] = [];
	for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) clusters.push(segment);
	return clusters;
}

/**
 * Shortest stable fragments (min 4 grapheme clusters, prefix or tail —
 * whichever distinguishes sooner) that tell every account id in a collision
 * group apart. Ids are first grouped into NFC equivalence classes so
 * composed-vs-decomposed sequences that render identically share one
 * canonical identity (never "distinguished" from each other, and never
 * blocking distinctness for a genuinely different sibling). Slicing works on
 * grapheme clusters, so astral pairs are never split into lone surrogates.
 */
function shortestUniqueIdFragments(ids: readonly string[]): Map<string, string> {
	const rawsByCanonical = new Map<string, string[]>();
	for (const id of new Set(ids)) {
		const canonical = id.normalize("NFC");
		const raws = rawsByCanonical.get(canonical);
		if (raws) raws.push(id);
		else rawsByCanonical.set(canonical, [id]);
	}
	const canonicals = [...rawsByCanonical.keys()];
	const fragments = new Map<string, string>();
	if (canonicals.length === 1) {
		// Every id renders identically — nothing can visually distinguish
		// them, so keep the full canonical identity.
		for (const raw of rawsByCanonical.get(canonicals[0])!) {
			fragments.set(raw, canonicals[0]);
		}
		return fragments;
	}
	const clustersByCanonical = new Map(canonicals.map(canonical => [canonical, toGraphemes(canonical)]));
	const maxLength = Math.max(...canonicals.map(canonical => clustersByCanonical.get(canonical)!.length));
	const distinctLength = (slice: (clusters: string[], length: number) => string): number => {
		for (let length = Math.min(4, maxLength); length <= maxLength; length++) {
			const seen = new Set(canonicals.map(canonical => slice(clustersByCanonical.get(canonical)!, length)));
			if (seen.size === canonicals.length) return length;
		}
		return maxLength;
	};
	const prefixLength = distinctLength((clusters, length) => clusters.slice(0, length).join(""));
	const tailLength = distinctLength((clusters, length) => clusters.slice(-length).join(""));
	// Ties prefer the tail: unequal-length ids (one a prefix of another) pass
	// the prefix distinctness check on length alone, which a tight cell's
	// front-anchored trim then destroys; tail trims keep the distinguishing
	// edge instead.
	const keepEnd = tailLength <= prefixLength;
	const length = keepEnd ? tailLength : prefixLength;
	for (const [canonical, raws] of rawsByCanonical) {
		const clusters = clustersByCanonical.get(canonical)!;
		const text =
			clusters.length <= length
				? canonical
				: keepEnd
					? `…${clusters.slice(-length).join("")}`
					: `${clusters.slice(0, length).join("")}…`;
		for (const raw of raws) fragments.set(raw, text);
	}
	return fragments;
}

/** Keep as many whole clusters as fit `maxWidth`, anchored at the kept edge. */
function fitClustersToWidth(clusters: readonly string[], maxWidth: number, keepEnd: boolean): string {
	let out = "";
	if (keepEnd) {
		for (let i = clusters.length - 1; i >= 0; i--) {
			const next = `${clusters[i]}${out}`;
			if (visibleWidth(next) > maxWidth) break;
			out = next;
		}
	} else {
		for (const cluster of clusters) {
			const next = `${out}${cluster}`;
			if (visibleWidth(next) > maxWidth) break;
			out = next;
		}
	}
	return out || clusters[keepEnd ? clusters.length - 1 : 0] || "";
}

/**
 * Bare-tier texts for a collision group: every id's rendered cell fitted to
 * the group's shared budget. Instead of one prefix/tail edge for the whole
 * group, each NFC identity class gets its own edge: classes (≤2 candidate
 * texts each, tail preferred) are matched injectively onto texts via
 * deterministic augmenting paths (Kuhn's bipartite matching, O(classes ×
 * candidates) per augmentation), so a collision-free combination is found
 * whenever one exists. Unmatched classes fall back to their tail fit.
 * NFC-equivalent raw ids always share one class and therefore one text.
 */
function planBareFragmentTexts(ids: readonly string[], maxWidth: number): Map<string, string> {
	const rawsByCanonical = new Map<string, string[]>();
	for (const id of new Set(ids)) {
		const canonical = id.normalize("NFC");
		const raws = rawsByCanonical.get(canonical);
		if (raws) raws.push(id);
		else rawsByCanonical.set(canonical, [id]);
	}
	const canonicals = [...rawsByCanonical.keys()].sort();
	const candidates = canonicals.map(canonical => {
		const clusters = toGraphemes(canonical);
		// Tail first: account ids usually differ at the end.
		return [
			...new Set([fitClustersToWidth(clusters, maxWidth, true), fitClustersToWidth(clusters, maxWidth, false)]),
		];
	});
	const chosen: (string | undefined)[] = new Array(canonicals.length);
	const textOwner = new Map<string, number>();
	const augment = (index: number, visited: Set<string>): boolean => {
		for (const text of candidates[index]) {
			if (visited.has(text)) continue;
			visited.add(text);
			const owner = textOwner.get(text);
			if (owner === undefined || augment(owner, visited)) {
				textOwner.set(text, index);
				chosen[index] = text;
				return true;
			}
		}
		return false;
	};
	for (let index = 0; index < canonicals.length; index++) augment(index, new Set());
	// No perfect matching exists for these classes: best-effort tails.
	for (let index = 0; index < canonicals.length; index++) chosen[index] ??= candidates[index][0];
	const texts = new Map<string, string>();
	for (const [index, canonical] of canonicals.entries()) {
		for (const raw of rawsByCanonical.get(canonical)!) texts.set(raw, chosen[index]!);
	}
	return texts;
}

/** Header label for a report column, derived from report metadata or limit scope. */
function formatReportAccountLabel(report: UsageReport, index: number): string {
	const projectId = resolveReportProjectId(report);
	const email = report.metadata?.email;
	if (typeof email === "string" && email) {
		const label = projectId && email !== projectId ? `${email} (${projectId})` : email;
		return `${label}${orgSuffix(report)}`;
	}
	const accountId = report.metadata?.accountId;
	if (typeof accountId === "string" && accountId) {
		const label = projectId && accountId !== projectId ? `${accountId} (${projectId})` : accountId;
		return `${label}${orgSuffix(report)}`;
	}
	if (projectId) return `${projectId}${orgSuffix(report)}`;
	for (const limit of report.limits) {
		const scopedAccountId = limit.scope.accountId;
		if (typeof scopedAccountId === "string" && scopedAccountId) {
			const label =
				projectId && scopedAccountId !== projectId ? `${scopedAccountId} (${projectId})` : scopedAccountId;
			return `${label}${orgSuffix(report)}`;
		}
	}
	return `account ${index + 1}`;
}

function formatReportAccountKey(report: UsageReport, index: number): string {
	const projectId = resolveReportProjectId(report);
	const organizationId = resolveReportOrganizationId(report);
	const email = report.metadata?.email;
	const accountId = report.metadata?.accountId;
	const emailKey = typeof email === "string" && email ? `email:${email}` : undefined;
	const metadataAccountKey = typeof accountId === "string" && accountId ? `account:${accountId}` : undefined;
	let scopedAccountKey: string | undefined;
	for (const limit of report.limits) {
		const scopedAccountId = limit.scope.accountId;
		if (typeof scopedAccountId === "string" && scopedAccountId) {
			scopedAccountKey = `account:${scopedAccountId}`;
			break;
		}
	}
	const accountKey = metadataAccountKey ?? scopedAccountKey;
	const keys = [
		organizationId ? `org:${organizationId}` : undefined,
		projectId ? `project:${projectId}` : undefined,
		emailKey,
		accountKey,
	].filter((key): key is string => key !== undefined);
	return keys.length > 0 ? keys.join("|") : `index:${index}`;
}

/** Sort reports so the active account is first and the rest are deterministic. */
function stableAccountOrder(
	reports: UsageReport[],
	activeAccount: OAuthAccountIdentity | undefined,
	fallbackIndices: ReadonlyMap<UsageReport, number>,
): UsageReport[] {
	return [...reports].sort((a, b) => {
		const aActive = reportMatchesActiveAccount(a, activeAccount);
		const bActive = reportMatchesActiveAccount(b, activeAccount);
		if (aActive && !bActive) return -1;
		if (!aActive && bActive) return 1;
		const aIndex = fallbackIndices.get(a) ?? 0;
		const bIndex = fallbackIndices.get(b) ?? 0;
		const labelOrder = formatReportAccountLabel(a, aIndex).localeCompare(formatReportAccountLabel(b, bIndex));
		if (labelOrder !== 0) return labelOrder;
		const keyOrder = formatReportAccountKey(a, aIndex).localeCompare(formatReportAccountKey(b, bIndex));
		if (keyOrder !== 0) return keyOrder;
		return aIndex - bIndex;
	});
}

function formatResetShort(limit: UsageLimit, nowMs: number): string | undefined {
	const resetsAt = limit.window?.resetsAt;
	if (resetsAt === undefined) return undefined;
	// Codex returns the prior window's reset_at until a new request opens a fresh window —
	// rendering a negative delta is meaningless, so drop the suffix in that case.
	if (resetsAt <= nowMs) return undefined;
	return formatDuration(resetsAt - nowMs);
}

function padColumn(text: string, width: number): string {
	const visible = visibleWidth(text);
	if (visible >= width) return text;
	return `${text}${padding(width - visible)}`;
}

function resolveAggregateStatus(limits: UsageLimit[]): UsageLimit["status"] {
	const hasOk = limits.some(limit => limit.status === "ok");
	const hasWarning = limits.some(limit => limit.status === "warning");
	const hasExhausted = limits.some(limit => limit.status === "exhausted");
	if (!hasOk && !hasWarning && !hasExhausted) return "unknown";
	if (hasOk) {
		return hasWarning || hasExhausted ? "warning" : "ok";
	}
	if (hasWarning) return "warning";
	return "exhausted";
}

function resolveResetRange(limits: UsageLimit[], nowMs: number): string | null {
	const absolute = limits
		.map(limit => limit.window?.resetsAt)
		.filter((value): value is number => value !== undefined && Number.isFinite(value) && value > nowMs);
	if (absolute.length === 0) return null;
	const offsets = absolute.map(value => value - nowMs);
	const minReset = Math.min(...offsets);
	const maxReset = Math.max(...offsets);
	if (maxReset - minReset > 60_000) {
		return `resets in ${formatDuration(minReset)}–${formatDuration(maxReset)}`;
	}
	return `resets in ${formatDuration(minReset)}`;
}
/**
 * Compact one-line quota summary for a single advisor's provider.
 * Returns `null` when the provider has no usage data.
 * When `activeAccount` is provided, only limits matching that credential
 * are shown (mirrors `renderUsageReports`'s account-stickiness filtering).
 * Example output: `Quota: 7d window · 67% used · resets in 3.2d`
 */
export function formatCompactQuota(
	provider: string,
	reports: UsageReport[],
	nowMs: number,
	activeAccount?: OAuthAccountIdentity,
): string | null {
	const providerReports = reports.filter(r => r.provider === provider);
	if (providerReports.length === 0) return null;
	// Group limits by window id so we show BOTH the 5-hour and 7-day windows
	// (or any other distinct windows the provider exposes). Within each window,
	// pick the highest used fraction across accounts — that's the most pressing.
	const byWindow = new Map<string, { limit: UsageLimit; fraction: number }>();
	for (const report of providerReports) {
		for (const limit of report.limits) {
			// Skip limits that belong to a different credential than the one
			// the advisor is actually using, so we don't alarm the user with
			// an exhausted account that isn't theirs.
			if (activeAccount && !limitMatchesActiveAccount(report, limit, activeAccount)) continue;
			const fraction = resolveUsedFraction(limit);
			if (fraction === undefined) continue;
			const key = limit.window?.id ?? limit.scope.windowId ?? "—";
			const existing = byWindow.get(key);
			if (!existing || fraction > existing.fraction) byWindow.set(key, { limit, fraction });
		}
	}
	if (byWindow.size === 0) return null;
	// Sort windows by urgency (highest fraction first) so the most pressing
	// quota is always the first thing the user sees.
	const entries = [...byWindow.values()].sort((a, b) => b.fraction - a.fraction);
	const lines: string[] = [];
	for (const { limit, fraction } of entries) {
		const pct = Math.round(fraction * 100);
		const windowLabel = limit.window?.label ?? limit.scope.windowId ?? "—";
		// Include the limit label (account/tier) when it carries identity beyond
		// the window name, so the user can tell which credential's quota is shown.
		const identity = limit.label.trim();
		const header = identity && identity !== windowLabel ? `${windowLabel} (${identity})` : windowLabel;
		const parts = [`${header}: ${pct}% used`];
		const reset = resolveResetRange([limit], nowMs);
		if (reset) parts.push(reset);
		lines.push(parts.join(" · "));
	}
	return `Quota: ${lines.join(" │ ")}`;
}
function resolveStatusIcon(status: UsageLimit["status"], uiTheme: typeof theme): string {
	if (status === "exhausted") return uiTheme.fg("error", uiTheme.status.error);
	if (status === "warning") return uiTheme.fg("warning", uiTheme.status.warning);
	if (status === "ok") return uiTheme.fg("success", uiTheme.status.success);
	return uiTheme.fg("dim", uiTheme.status.pending);
}

function resolveStatusColor(status: UsageLimit["status"]): "success" | "warning" | "error" | "dim" {
	if (status === "exhausted") return "error";
	if (status === "warning") return "warning";
	if (status === "ok") return "success";
	return "dim";
}

function renderUsageBar(limit: UsageLimit | undefined, uiTheme: typeof theme, barWidth: number): string {
	if (limit === undefined) {
		return uiTheme.fg("dim", "·".repeat(barWidth));
	}
	const fraction = resolveUsedFraction(limit);
	if (fraction === undefined) {
		return uiTheme.fg("dim", "·".repeat(barWidth));
	}
	const clamped = Math.min(Math.max(fraction, 0), 1);
	const exact = clamped * barWidth;
	const fullCells = Math.floor(exact);
	const remainder = exact - fullCells;
	let partial = "";
	if (remainder >= 2 / 3) partial = "▓";
	else if (remainder >= 1 / 3) partial = "▒";
	const leading = "█".repeat(fullCells) + partial;
	const empty = "░".repeat(Math.max(0, barWidth - fullCells - (partial ? 1 : 0)));
	const color = resolveStatusColor(limit.status);
	return `${uiTheme.fg(color, leading)}${uiTheme.fg("dim", empty)}`;
}

/** Exact percentage and reset time for a single meter cell. */
function formatMeterDetails(limit: UsageLimit | undefined, nowMs: number): string {
	if (limit === undefined) return "—";
	const fraction = resolveUsedFraction(limit);
	const parts: string[] = [];
	if (fraction !== undefined) {
		parts.push(`${(fraction * 100).toFixed(1)}% used`);
	} else if (limit.amount.remainingFraction !== undefined) {
		parts.push(`${(limit.amount.remainingFraction * 100).toFixed(1)}% left`);
	} else {
		parts.push("no data");
	}
	const reset = formatResetShort(limit, nowMs);
	if (reset) parts.push(reset);
	return parts.join(" · ");
}

function renderAccountHeaderCell(
	report: UsageReport,
	label: string,
	columnWidth: number,
	uiTheme: typeof theme,
	activeAccount?: OAuthAccountIdentity,
): string {
	const active = reportMatchesActiveAccount(report, activeAccount);
	const cell = truncateJobLabel(active ? `● ${label}` : label, columnWidth);
	return padColumn(active ? uiTheme.fg("accent", cell) : cell, columnWidth);
}

/**
 * Pick a per-account column width so the columns and trailing amount fit in `available`.
 * Falls back to the minimum when the terminal is too narrow rather than wrapping.
 */
function resolveColumnWidth(count: number, available: number, trailing: number): number {
	if (count <= 0) return BAR_WIDTH_MAX;
	const indent = 2;
	const gaps = count - 1;
	const spaceForBars = available - indent - gaps - (trailing > 0 ? trailing + 1 : 0);
	const ideal = Math.floor(spaceForBars / count);
	if (ideal < COLUMN_WIDTH_MIN) return COLUMN_WIDTH_MIN;
	return ideal;
}

export function renderUsageReports(
	reports: UsageReport[],
	uiTheme: typeof theme,
	nowMs: number,
	availableWidth: number,
	resolveActiveAccount?: (provider: string) => OAuthAccountIdentity | undefined,
): string {
	const lines: string[] = [];
	const latestFetchedAt = Math.max(...reports.map(report => report.fetchedAt ?? 0));
	const headerSuffix = latestFetchedAt ? ` (${formatDuration(nowMs - latestFetchedAt)} ago)` : "";
	lines.push(uiTheme.bold(uiTheme.fg("accent", `Usage${headerSuffix}`)));
	const grouped = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const list = grouped.get(report.provider) ?? [];
		list.push(report);
		grouped.set(report.provider, list);
	}
	const providerEntries = Array.from(grouped.entries())
		.map(([provider, providerReports]) => ({
			provider,
			providerReports,
			totalUsage: resolveProviderUsageTotal(providerReports),
		}))
		.sort((a, b) => {
			if (a.totalUsage !== b.totalUsage) return a.totalUsage - b.totalUsage;
			return a.provider.localeCompare(b.provider);
		});

	for (const { provider, providerReports } of providerEntries) {
		lines.push("");
		const providerName = formatProviderName(provider);
		const activeAccount = resolveActiveAccount?.(provider);

		const reportFallbackIndices = new Map<UsageReport, number>();
		for (const [index, report] of providerReports.entries()) {
			reportFallbackIndices.set(report, index);
		}
		const reportAccountKeys = new Map<UsageReport, string>();
		const usedReportKeys = new Set<string>();
		for (const report of providerReports) {
			const fallbackIndex = reportFallbackIndices.get(report) ?? 0;
			const baseKey = formatReportAccountKey(report, fallbackIndex);
			let key = baseKey;
			let collision = 0;
			while (usedReportKeys.has(key)) {
				collision += 1;
				key = `${baseKey}|index:${fallbackIndex}-${collision}`;
			}
			usedReportKeys.add(key);
			reportAccountKeys.set(report, key);
		}

		const limitGroups = new Map<
			string,
			{ label: string; windowLabel: string; limitsByAccountKey: Map<string, UsageLimit> }
		>();
		for (const report of providerReports) {
			const accountKey =
				reportAccountKeys.get(report) ?? formatReportAccountKey(report, reportFallbackIndices.get(report) ?? 0);
			for (const limit of report.limits) {
				const windowId = limit.window?.id ?? limit.scope.windowId ?? "default";
				const key = `${formatLimitTitle(limit)}|${windowId}`;
				const windowLabel = limit.window?.label ?? windowId;
				const entry = limitGroups.get(key) ?? {
					label: formatLimitTitle(limit),
					windowLabel,
					limitsByAccountKey: new Map<string, UsageLimit>(),
				};
				entry.limitsByAccountKey.set(accountKey, limit);
				limitGroups.set(key, entry);
			}
		}

		lines.push(uiTheme.bold(uiTheme.fg("accent", providerName)));
		const activeAccountLabel = formatActiveAccountLabel(activeAccount);
		if (activeAccountLabel) {
			lines.push(`  ${uiTheme.fg("accent", "in use by this session:")} ${activeAccountLabel}`);
		}

		// Provider-wide disclaimers (e.g. "OMP-observed spend only") render once
		// above the per-account sections instead of duplicating onto every limit.
		const providerNotes = [...new Set(providerReports.flatMap(report => report.notes ?? []))];
		if (providerNotes.length > 0) {
			lines.push(
				`  ${uiTheme.fg("dim", replaceTabs(truncateToWidth(sanitizeText(providerNotes.map(n => n.replace(/[\r\n]+/g, " ")).join(" • ")), 110)))}`.trimEnd(),
			);
		}

		const resetAccountLines: string[] = [];
		for (const report of providerReports) {
			const count = report.resetCredits?.availableCount ?? 0;
			if (count <= 0) continue;
			const label =
				typeof report.metadata?.email === "string" && report.metadata.email
					? report.metadata.email
					: typeof report.metadata?.accountId === "string" && report.metadata.accountId
						? report.metadata.accountId
						: "account";
			// Same matching rules as the account columns (alias/scope ids,
			// normalization, decisive account-id, org gate). Reset-only rows have
			// no limits, so they match on report metadata alone.
			const isActive =
				report.limits.length > 0
					? reportMatchesActiveAccount(report, activeAccount)
					: limitMatchesActiveAccount(report, undefined, activeAccount);
			resetAccountLines.push(
				`    • ${label}: ${count} saved reset${count === 1 ? "" : "s"}${isActive ? " (active)" : ""}`,
			);
			const credits = report.resetCredits?.credits;
			if (credits) {
				for (const credit of credits) {
					if (credit.expiresAt) {
						const expiryMs = Date.parse(credit.expiresAt);
						if (!Number.isNaN(expiryMs)) {
							const remaining = expiryMs - nowMs;
							const expiryDate = credit.expiresAt.slice(0, 10);
							if (remaining > 0) {
								resetAccountLines.push(`        expires in ${formatDuration(remaining)} (${expiryDate})`);
							} else {
								resetAccountLines.push(`        expired (${expiryDate})`);
							}
						}
					}
				}
			}
		}
		if (resetAccountLines.length > 0) {
			lines.push(
				`  ${uiTheme.fg("accent", "Saved rate-limit resets")} ${uiTheme.fg("dim", "(/usage reset to spend)")}`,
			);
			for (const line of resetAccountLines) lines.push(uiTheme.fg("dim", line));
		}

		const providerAccounts = stableAccountOrder(
			providerReports.filter(report => report.limits.length > 0),
			activeAccount,
			reportFallbackIndices,
		);

		const renderableGroups = Array.from(limitGroups.values()).map(group => {
			const columns = providerAccounts.map(account => {
				const accountKey =
					reportAccountKeys.get(account) ??
					formatReportAccountKey(account, reportFallbackIndices.get(account) ?? 0);
				return group.limitsByAccountKey.get(accountKey);
			});
			return { group, columns };
		});
		renderableGroups.sort((left, right) => {
			const labelOrder = left.group.label.localeCompare(right.group.label);
			if (labelOrder !== 0) return labelOrder;
			return left.group.windowLabel.localeCompare(right.group.windowLabel);
		});

		const accountCount = providerAccounts.length;
		const sectionColumnWidth = resolveColumnWidth(accountCount, availableWidth, 0);
		const meterWidth = Math.min(BAR_WIDTH_MAX, sectionColumnWidth);

		// One provider-wide account header so columns stay aligned across limit groups.
		if (accountCount > 0) {
			const baseLabels = providerAccounts.map((report, index) =>
				formatReportAccountLabel(report, reportFallbackIndices.get(report) ?? index),
			);
			const labelCounts = new Map<string, number>();
			for (const label of baseLabels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
			const activeFlags = providerAccounts.map(report => reportMatchesActiveAccount(report, activeAccount));
			// Per colliding label group: shortest-unique id fragments plus a
			// group-wide suffix tier chosen against the tightest marker-adjusted
			// cell, so sibling columns always disambiguate the same way.
			const collisionPlans = new Map<
				string,
				{
					fragments: Map<string, string>;
					tier: "full" | "fragment" | "bare";
					bareTexts: Map<string, string> | undefined;
				}
			>();
			for (const [label, count] of labelCounts) {
				if (count <= 1) continue;
				const memberIds: string[] = [];
				let minBudget = Number.POSITIVE_INFINITY;
				for (const [index, report] of providerAccounts.entries()) {
					if (baseLabels[index] !== label) continue;
					const id = resolveReportAccountId(report);
					if (id) memberIds.push(id);
					minBudget = Math.min(minBudget, sectionColumnWidth - (activeFlags[index] ? 2 : 0));
				}
				if (memberIds.length === 0) continue;
				const fragments = shortestUniqueIdFragments(memberIds);
				const maxFullSuffix = Math.max(...memberIds.map(id => visibleWidth(` (${id})`)));
				const maxFragmentSuffix = Math.max(...[...fragments.values()].map(f => visibleWidth(` (${f})`)));
				const tier =
					minBudget - maxFullSuffix >= 2 ? "full" : minBudget - maxFragmentSuffix >= 2 ? "fragment" : "bare";
				collisionPlans.set(label, {
					fragments,
					tier,
					// Bare texts fit to the GROUP's tightest budget so
					// NFC-equivalent siblings render the same text whether or
					// not they carry the active marker, and each identity class
					// gets its own collision-free prefix/tail edge.
					bareTexts: tier === "bare" ? planBareFragmentTexts(memberIds, minBudget) : undefined,
				});
			}
			const headerCells = providerAccounts.map((report, index) => {
				let label = baseLabels[index];
				// Same rendered label on two columns (e.g. one email across
				// workspaces): disambiguate with the stable account id. The id
				// (or its shortest-unique fragment) is the only part telling
				// colliding columns apart, so end-truncation must never eat it:
				// the base is truncated separately, and in the tightest tier the
				// base and decorations are dropped so the complete fragment
				// renders directly. Unique labels render unchanged.
				const plan = collisionPlans.get(label);
				const accountId = plan ? resolveReportAccountId(report) : undefined;
				if (plan && accountId) {
					const budget = sectionColumnWidth - (activeFlags[index] ? 2 : 0);
					if (plan.tier === "full") {
						const suffix = ` (${accountId})`;
						label = `${truncateJobLabel(label, budget - visibleWidth(suffix))}${suffix}`;
					} else if (plan.tier === "fragment") {
						const fragment = plan.fragments.get(accountId) ?? accountId;
						const suffix = ` (${fragment})`;
						label = `${truncateJobLabel(label, budget - visibleWidth(suffix))}${suffix}`;
					} else {
						label = plan.bareTexts?.get(accountId) ?? accountId;
					}
				}
				return renderAccountHeaderCell(report, label, sectionColumnWidth, uiTheme, activeAccount);
			});

			lines.push(`  ${headerCells.join(" ")}`.trimEnd());
		}

		for (const { group, columns } of renderableGroups) {
			const status = resolveAggregateStatus(columns.filter((limit): limit is UsageLimit => limit !== undefined));
			const statusIcon = resolveStatusIcon(status, uiTheme);

			const windowSuffix = formatWindowSuffix(group.label, group.windowLabel, uiTheme);
			lines.push(`${statusIcon} ${uiTheme.bold(group.label)} ${windowSuffix}`.trim());
			const bars = columns.map(limit => padColumn(renderUsageBar(limit, uiTheme, meterWidth), sectionColumnWidth));
			lines.push(`  ${bars.join(" ")}`.trimEnd());
			const details = columns.map(limit => {
				const text = replaceTabs(sanitizeText(formatMeterDetails(limit, nowMs)));
				return padColumn(uiTheme.fg("dim", truncateJobLabel(text, sectionColumnWidth)), sectionColumnWidth);
			});
			lines.push(`  ${details.join(" ")}`.trimEnd());
			const notes = [...new Set(columns.flatMap(limit => limit?.notes ?? []))];
			if (notes.length > 0) {
				lines.push(
					`  ${uiTheme.fg("dim", replaceTabs(truncateToWidth(sanitizeText(notes.map(n => n.replace(/[\r\n]+/g, " ")).join(" • ")), 110)))}`.trimEnd(),
				);
			}
		}

		// Render accounts with no rate limits (e.g. business/enterprise plans).
		const unlimitedReports = providerReports.filter(report => report.limits.length === 0);
		for (const report of unlimitedReports) {
			const label = formatUnlimitedReportLabel(report, reportFallbackIndices.get(report) ?? 0);
			const tier = report.metadata?.planType;
			const tierSuffix = typeof tier === "string" && tier ? ` ${uiTheme.fg("dim", `(${tier})`)}` : "";
			lines.push(
				`${uiTheme.fg("success", uiTheme.status.success)} ${label}${tierSuffix} ${uiTheme.fg("dim", "-- no limits")}`,
			);
		}
		// No per-provider footer; global header shows last check.
	}

	return lines.join("\n");
}
