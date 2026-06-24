import type {
	AgentIdentity,
	AgentTelemetryConfig,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import { escapeXmlText } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import adviseDescription from "../prompts/advisor/advise-tool.md" with { type: "text" };

const adviseSchema = type({
	note: type("string").describe(
		"One concrete piece of advice for the agent you are watching. Terse, specific, actionable.",
	),
	"severity?": type("'nit' | 'concern' | 'blocker'").describe("How strongly to weigh this. Omit for a plain nit."),
});

export type AdviseParams = typeof adviseSchema.infer;

export type AdvisorSeverity = "nit" | "concern" | "blocker";

export interface AdviseDetails {
	note: string;
	severity?: AdvisorSeverity;
}

/** One queued advice note. */
export interface AdvisorNote {
	note: string;
	severity?: AdvisorSeverity;
}

/** Details payload on the batched `advisor` custom message rendered in the transcript. */
export interface AdvisorMessageDetails {
	notes: AdvisorNote[];
}

/**
 * Behavioral framing for the watched agent — advice, not orders. Carried as a
 * tag attribute (rather than a prose header) so the rendered agent-facing output
 * stays a clean `<advisory>` block. The primary agent's system prompt never
 * mentions advisories, so this is its only cue for how to treat them.
 */
const ADVISOR_GUIDANCE = "weigh, don't blindly obey";

/**
 * Render a batch of advisor notes as the agent-facing message body: one
 * `<advisory>` element per note, severity as an attribute. Shared by the
 * non-interrupting YieldQueue dispatcher and the interrupting steer path so both
 * build byte-identical content.
 */
export function formatAdvisorBatchContent(notes: readonly AdvisorNote[]): string {
	return notes
		.map(n => {
			const severity = n.severity ? ` severity="${n.severity}"` : "";
			return `<advisory${severity} guidance="${ADVISOR_GUIDANCE}">\n${escapeXmlText(n.note)}\n</advisory>`;
		})
		.join("\n");
}

/**
 * Whether advice at this severity should interrupt the running agent (delivered
 * via the steering channel, aborting in-flight tools) rather than ride the
 * non-interrupting aside queue that lands at the next step boundary. `concern`
 * and `blocker` interrupt; a plain `nit` queues.
 */
export function isInterruptingSeverity(severity: AdvisorSeverity | undefined): boolean {
	return severity === "concern" || severity === "blocker";
}

/** How an advisor note is routed to the primary. */
export type AdvisorDeliveryChannel = "aside" | "steer" | "preserve";
/** Half-open turn-count fence for the post-interrupt cooldown. */
export function isAdvisorInterruptImmuneTurnActive(opts: {
	completedTurns: number;
	immuneTurnStart: number | undefined;
	immuneTurns: number;
}): boolean {
	if (opts.immuneTurnStart === undefined || opts.immuneTurns <= 0) return false;
	return opts.completedTurns < opts.immuneTurnStart + opts.immuneTurns;
}

/**
 * Decide how one advisor note reaches the primary agent.
 *
 * - A non-interrupting `nit` always rides the non-interrupting aside queue.
 * - An interrupting `concern`/`blocker` is normally steered into the agent: into
 *   the live turn while one is streaming, or (when idle) a triggered turn so the
 *   advice is acted on immediately.
 * - After a deliberate user interrupt (`autoResumeSuppressed`) the advisor must
 *   not auto-resume the stopped run. While the agent is idle — or still tearing
 *   the interrupted turn down (`aborting`) — the note is preserved as a visible
 *   card instead of restarting the run. But once a turn is actively streaming
 *   again (a resume the user already drove), steering the note in does NOT
 *   auto-resume anything, so it is delivered live. Parking it during an active
 *   run instead strands it (it never reaches the running agent) and the withheld
 *   notes dump as one burst at the next user prompt — the bug this guards.
 * - During the post-interrupt immune-turn window, further `concern`/`blocker`
 *   notes are downgraded to asides; suppression preservation still wins.
 */
export function resolveAdvisorDeliveryChannel(opts: {
	severity: AdvisorSeverity | undefined;
	autoResumeSuppressed: boolean;
	streaming: boolean;
	aborting: boolean;
	interruptImmuneTurnActive?: boolean;
}): AdvisorDeliveryChannel {
	if (!isInterruptingSeverity(opts.severity)) return "aside";
	if (opts.autoResumeSuppressed && (opts.aborting || !opts.streaming)) return "preserve";
	if (opts.interruptImmuneTurnActive) return "aside";
	return "steer";
}

/**
 * Derive the advisor loop's telemetry from the primary session's config so the
 * advisor model's GenAI spans and usage/cost hooks (onChatUsage, onCostDelta,
 * costEstimator) fire under the same pipeline as every other model call —
 * stamped with the advisor's own agent identity. `conversationId` is cleared so
 * the advisor loop falls back to its own `-advisor` session id for
 * `gen_ai.conversation.id` instead of inheriting the primary's conversation.
 *
 * Returns undefined when the primary has no telemetry (instrumentation off), so
 * the advisor `Agent` stays a zero-overhead no-op as well.
 */
export function deriveAdvisorTelemetry(
	primaryTelemetry: AgentTelemetryConfig | undefined,
	identity: AgentIdentity,
): AgentTelemetryConfig | undefined {
	if (!primaryTelemetry) return undefined;
	return { ...primaryTelemetry, agent: identity, conversationId: undefined };
}

/**
 * Investigation tools handed to the advisor agent so it can inspect the
 * workspace before weighing in. Names match the primary session's tool
 * instances, which the advisor reuses against a distinct `-advisor` ToolSession.
 *
 * Selection is an EXPLICIT allowlist, never derived from approval tier: some
 * `read`-tier tools (e.g. `checkpoint`/`rewind`) still mutate git/session state
 * and are not advisor-safe. `read`/`search`/`find` are wholly read-only; `lsp`
 * is only PARTLY read-only, so {@link wrapAdvisorReadOnlyTool} rejects any of its
 * write-tier actions (rename, code-action apply, reload, raw request) at call
 * time. The wrapper is applied uniformly as defense-in-depth.
 */
export const ADVISOR_READONLY_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "search", "find", "lsp"]);

/**
 * Workspace-wide LSP diagnostics (`lsp` with `action:"diagnostics"`, `file:"*"`)
 * shell out to the project's build/typecheck command (`cargo check`, `tsc`,
 * `go build`, `pyright`). `LspTool` classifies that as `read` tier because it
 * does not mutate LSP state, but for the PASSIVE advisor it means spawning a
 * build the user never asked for (and that may run build scripts or write
 * caches). Reject this specific shape regardless of tier; single-file
 * diagnostics (a concrete `file` path) stay allowed.
 */
function isAdvisorBlockedLspCall(tool: AgentTool, args: unknown): boolean {
	if (tool.name !== "lsp") return false;
	if (typeof args !== "object" || args === null) return false;
	const { action, file } = args as { action?: unknown; file?: unknown };
	return action === "diagnostics" && file === "*";
}

/**
 * Wrap an advisor investigation tool so any call whose resolved capability tier
 * exceeds `read` is rejected before {@link AgentTool.execute} runs. The advisor
 * is a passive reviewer: it must never mutate the workspace or session, even if
 * an allowlisted tool (e.g. `lsp`) also exposes write-tier actions. A few
 * read-tier shapes with external side effects (workspace diagnostics) are also
 * rejected explicitly. Returns an error tool-result instead of throwing so the
 * advisor model gets a clear, self-correcting signal rather than a failed turn.
 */
export function wrapAdvisorReadOnlyTool<T extends AgentTool>(
	tool: T,
	resolveTier: (tool: AgentTool, args: unknown) => "read" | "write" | "exec",
): T {
	const originalExecute = tool.execute.bind(tool);
	tool.execute = async function (this: T, toolCallId, args, signal, onUpdate, context) {
		if (isAdvisorBlockedLspCall(tool, args)) {
			return {
				content: [
					{
						type: "text",
						text: `The advisor cannot run workspace diagnostics (it spawns the project build/typecheck command). Pass a concrete file to "${tool.name}" instead of "*".`,
					},
				],
				isError: true,
			} as AgentToolResult;
		}
		if (resolveTier(tool, args) !== "read") {
			return {
				content: [
					{
						type: "text",
						text: `The advisor toolset is read-only; the "${tool.name}" call was rejected because it is not a read-only action.`,
					},
				],
				isError: true,
			} as AgentToolResult;
		}
		return originalExecute(toolCallId, args, signal, onUpdate, context);
	} as T["execute"];
	return tool;
}

export class AdviseTool implements AgentTool<typeof adviseSchema, AdviseDetails> {
	readonly name = "advise";
	readonly label = "Advise";
	readonly description = adviseDescription;
	readonly parameters = adviseSchema;
	readonly intent = "omit" as const;

	constructor(private readonly onAdvice: (note: string, severity?: AdviseDetails["severity"]) => void) {}

	async execute(
		_toolCallId: string,
		args: AdviseParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AdviseDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AdviseDetails>> {
		this.onAdvice(args.note, args.severity);
		return {
			content: [{ type: "text", text: "Recorded." }],
			details: { note: args.note, severity: args.severity },
			useless: true,
		};
	}
}
