import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import wakeupDescription from "../prompts/tools/wakeup.md" with { type: "text" };
import wakeupFiredTemplate from "../prompts/tools/wakeup-fired.md" with { type: "text" };
import wakeupScheduledTemplate from "../prompts/tools/wakeup-scheduled.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { previewLine, TRUNCATE_LENGTHS } from "./render-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const MIN_DELAY_SECONDS = 1;
const MAX_DELAY_SECONDS = 86_400;

const wakeupSchema = type({
	delaySeconds: type("number.integer").describe("delay before waking, from 1 to 86400 seconds"),
	prompt: type("string").describe("instruction to resume with when the delay elapses"),
});

export type WakeupParams = typeof wakeupSchema.infer;

export interface WakeupDetails {
	jobId: string;
	delaySeconds: number;
	scheduledAt: string;
	prompt: string;
	meta?: OutputMeta;
}

async function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer: NodeJS.Timeout = setTimeout(resolve, delayMs);
	const abort = (): void => {
		clearTimeout(timer);
		reject(new ToolAbortError());
	};

	if (signal.aborted) {
		abort();
	} else {
		signal.addEventListener("abort", abort, { once: true });
	}

	try {
		await promise;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}

/** Session-owned, one-shot delayed wakeup delivered through AsyncJobManager. */
export class WakeupTool implements AgentTool<typeof wakeupSchema, WakeupDetails> {
	readonly name = "wakeup";
	readonly approval = "exec" as const;
	readonly label = "Wakeup";
	readonly summary = "Schedule a one-shot future wakeup for this agent";
	readonly description = prompt.render(wakeupDescription);
	readonly parameters = wakeupSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly intent = (args: Partial<WakeupParams>) =>
		typeof args.delaySeconds === "number" ? `waking in ${args.delaySeconds}s` : "scheduling wakeup";
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<WakeupParams>;
		const lines = [`Delay: ${params.delaySeconds ?? "(missing)"} seconds`];
		if (typeof params.prompt === "string") {
			lines.push(`Prompt: ${previewLine(params.prompt, TRUNCATE_LENGTHS.CONTENT)}`);
		}
		return lines;
	};

	readonly examples: readonly ToolExample<WakeupParams>[] = [
		{
			caption: "Retry a check in ten minutes",
			call: { delaySeconds: 600, prompt: "Check CI again and report any remaining failures." },
		},
		{
			caption: "Continue a self-paced polling loop",
			call: {
				delaySeconds: 300,
				prompt:
					"Check the deployment. If it is still pending, schedule another wakeup; otherwise report the result.",
			},
		},
	];

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): WakeupTool | null {
		return session.asyncJobManager ? new WakeupTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: WakeupParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<WakeupDetails>> {
		throwIfAborted(signal);
		if (params.delaySeconds < MIN_DELAY_SECONDS || params.delaySeconds > MAX_DELAY_SECONDS) {
			throw new ToolError(`delaySeconds must be between ${MIN_DELAY_SECONDS} and ${MAX_DELAY_SECONDS}, inclusive.`);
		}
		if (params.prompt.trim().length === 0) {
			throw new ToolError("prompt must not be empty.");
		}

		const manager = this.session.asyncJobManager;
		if (!manager) throw new ToolError("Wakeups are unavailable in this session.");

		const scheduledAt = new Date(Date.now() + params.delaySeconds * 1_000).toISOString();
		const jobId = manager.register(
			"wakeup",
			`Wakeup at ${scheduledAt}`,
			async ({ signal: jobSignal }) => {
				await waitForDelay(params.delaySeconds * 1_000, jobSignal);
				return prompt.render(wakeupFiredTemplate, {
					instruction: params.prompt,
					scheduledAt,
				});
			},
			{
				ownerId: this.session.getAgentId?.() ?? undefined,
				onComplete: this.session.deliverAsyncResult,
				passive: true,
			},
		);

		const details: WakeupDetails = {
			jobId,
			delaySeconds: params.delaySeconds,
			scheduledAt,
			prompt: params.prompt,
		};
		return toolResult<WakeupDetails>(details)
			.text(
				prompt.render(wakeupScheduledTemplate, {
					delaySeconds: params.delaySeconds,
					jobId,
					scheduledAt,
				}),
			)
			.done();
	}
}
