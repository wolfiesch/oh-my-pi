/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
import { once } from "node:events";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { serviceTierFamily } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { $env, isEnoent, isRecord, Snowflake } from "@oh-my-pi/pi-utils";
import { JobProjectionService } from "../../async";
import { reset as resetCapabilities } from "../../capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import type { EvalToolDetails } from "../../eval/types";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import { buildSkillPromptMessage, parseSkillInvocation } from "../../extensibility/skills";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { type Theme, theme } from "../../modes/theme/theme";
import { AgentControlService } from "../../registry/agent-control";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { type PythonExecutionMessage, SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import {
	inspectPersistedSessionWorkspace,
	listSessionCatalog,
	listSessionWorkspaceRoots,
	resolveSessionCatalogReference,
	SessionCatalogError,
} from "../../session/session-catalog";
import { SessionQueueEntryNotFoundError, SessionQueueInvalidPositionError } from "../../session/session-queue-service";
import { FileSessionStorage } from "../../session/session-storage";
import { ToolInventoryUnavailableError } from "../../session/session-tools";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { EvalTool } from "../../tools/eval";
import type { EventBus } from "../../utils/event-bus";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import {
	ProviderAuthController,
	ProviderAuthError,
	ProviderAuthService,
	type ProviderAuthUpdate,
} from "../controllers/provider-auth-controller";
import { initializeExtensions } from "../runtime-init";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import {
	getRpcCapabilityManifest,
	RPC_APPLICATION_API_VERSION,
	RpcToolActivationValidationError,
	validateRpcCommand,
	validateRpcToolActivationBatch,
} from "./rpc-command-registry";
import { RpcEvalOutputStream } from "./rpc-eval";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "./rpc-frame";
import { handleGetSettings } from "./rpc-get-settings";
import { claimRpcInput, readRpcInputFrames } from "./rpc-input";
import { pageRpcMessages, RPC_MESSAGES_PAGE_BUSY_ERROR, RpcMessagesPageError } from "./rpc-messages";
import { type RpcOperationHandle, RpcOperationManager } from "./rpc-operations";
import { handleSetSettings } from "./rpc-set-settings";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "./rpc-subagents";
import type {
	RpcCancelOperationResult,
	RpcCommand,
	RpcDeleteSessionResult,
	RpcEvalHistoryEntry,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcForkSessionResult,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcRenameSessionResult,
	RpcResponse,
	RpcResumeSessionResult,
	RpcSessionInfoResult,
	RpcSessionState,
	RpcSubagentSubscriptionLevel,
	RpcToolActivationResult,
} from "./rpc-types";

// Re-export types for consumers
export type * from "./rpc-types";

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

/** Pending extension UI request map that can fail closed when the RPC client disconnects. */
export class RpcPendingExtensionRequests extends Map<string, PendingExtensionRequest> {
	#closedError: Error | undefined;

	override set(id: string, request: PendingExtensionRequest): this {
		if (this.#closedError) {
			request.reject(this.#closedError);
			return this;
		}
		return super.set(id, request);
	}

	/** Reject every active and future extension UI request. */
	rejectAll(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const requests = Array.from(this.values());
		this.clear();
		for (const request of requests) {
			request.reject(this.#closedError);
		}
	}
}

type RpcOutput = (
	obj:
		| RpcResponse
		| RpcExtensionUIRequest
		| RpcHostToolCallRequest
		| RpcHostToolCancelRequest
		| RpcHostUriRequest
		| RpcHostUriCancelRequest
		| object,
) => void;

export type RpcSessionChangeCommand = Extract<
	RpcCommand,
	{ type: "new_session" } | { type: "switch_session" } | { type: "branch" }
>;

export type RpcSessionChangeResult =
	| { type: "new_session"; data: { cancelled: boolean } }
	| { type: "switch_session"; data: { cancelled: boolean } }
	| { type: "branch"; data: { text: string; cancelled: boolean } };

export type RpcSessionChangeSession = Pick<AgentSession, "newSession" | "switchSession" | "branch">;

export type RpcSkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;
export type RpcSkillCommandResult = { agentInvoked: true };

export async function tryRunRpcSkillCommand(
	session: RpcSkillCommandSession,
	text: string,
	streamingBehavior: "steer" | "followUp" = "steer",
	messageTag?: string,
): Promise<RpcSkillCommandResult | false> {
	if (!session.skillsSettings?.enableSkillCommands) return false;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return false;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return false;
	const built = await buildSkillPromptMessage(skill, parsed.args, "user");
	await session.promptCustomMessage(
		{
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: built.message,
			display: true,
			details: built.details,
			attribution: "user",
		},
		{ streamingBehavior, messageTag },
	);
	return { agentInvoked: true };
}

export function reportLocalOnlyPromptResult(input: {
	id: string | undefined;
	prompt: Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	hasExtensionAgentMessageTask?: () => boolean;
	waitForExtensionAgentMessageTasks?: () => Promise<void>;
	operation?: {
		handle: RpcOperationHandle;
		manager: RpcOperationManager;
		waitForAgentCompletion?: () => Promise<void>;
	};
}): void {
	void input.prompt
		.then(async agentInvoked => {
			await input.waitForExtensionAgentMessageTasks?.();
			const resolvedAgentInvoked = agentInvoked || Boolean(input.hasExtensionAgentMessageTask?.());
			if (resolvedAgentInvoked) {
				await input.operation?.waitForAgentCompletion?.();
			}
			const operation = input.operation;
			if (operation) {
				setImmediate(() => {
					if (!resolvedAgentInvoked) {
						input.output({
							type: "prompt_result",
							id: input.id,
							operationId: operation.handle.operationId,
							agentInvoked: false,
						});
					}
					operation.manager.complete(operation.handle, resolvedAgentInvoked);
				});
			} else if (!resolvedAgentInvoked) {
				input.output({
					type: "prompt_result",
					id: input.id,
					agentInvoked: false,
				});
			}
		})
		.catch(error => {
			const promptError = error instanceof Error ? error : new Error(String(error));
			const operation = input.operation;
			if (operation) {
				setImmediate(() => operation.manager.fail(operation.handle, promptError, "prompt_scheduling_failed"));
			}
			input.onError(promptError);
		});
}

type RpcExtensionUserMessageScope = {
	agentMessageTasks: Promise<unknown>[];
};

/**
 * Tracks extension-originated messages while an RPC prompt is executing.
 * A slash command can resolve the outer prompt as local-only while also
 * scheduling agent work through pi.sendUserMessage() or pi.sendMessage()
 * with triggerTurn; that prompt must not report agentInvoked:false to the host.
 */
export class RpcExtensionUserMessageTracker {
	#activePromptScopes = new Set<RpcExtensionUserMessageScope>();

	markAgentMessageTask(): void {
		for (const scope of this.#activePromptScopes) {
			scope.agentMessageTasks.push(Promise.resolve());
		}
	}

	trackAgentMessageTask(task: Promise<unknown>): void {
		for (const scope of this.#activePromptScopes) {
			scope.agentMessageTasks.push(task);
		}
	}

	async #waitForAgentMessageTasks(scope: RpcExtensionUserMessageScope): Promise<void> {
		let observedCount = 0;
		while (observedCount < scope.agentMessageTasks.length) {
			const tasks = scope.agentMessageTasks.slice(observedCount);
			observedCount = scope.agentMessageTasks.length;
			await Promise.all(tasks);
		}
	}

	watchPrompt<T>(startPrompt: () => Promise<T>): {
		prompt: Promise<T>;
		hasAgentMessageTask: () => boolean;
		waitForAgentMessageTasks: () => Promise<void>;
	} {
		const scope: RpcExtensionUserMessageScope = {
			agentMessageTasks: [],
		};
		this.#activePromptScopes.add(scope);
		let prompt: Promise<T>;
		try {
			prompt = startPrompt();
		} catch (error) {
			this.#activePromptScopes.delete(scope);
			throw error;
		}
		return {
			prompt: prompt.finally(() => {
				this.#activePromptScopes.delete(scope);
			}),
			hasAgentMessageTask: () => scope.agentMessageTasks.length > 0,
			waitForAgentMessageTasks: () => this.#waitForAgentMessageTasks(scope),
		};
	}
}

export function watchAndReportLocalOnlyPromptResult(input: {
	id: string | undefined;
	startPrompt: () => Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
	operation?: {
		handle: RpcOperationHandle;
		manager: RpcOperationManager;
		waitForAgentCompletion?: () => Promise<void>;
	};
}): void {
	const trackedPrompt = input.extensionUserMessageTracker.watchPrompt(input.startPrompt);
	reportLocalOnlyPromptResult({
		id: input.id,
		prompt: trackedPrompt.prompt,
		output: input.output,
		onError: input.onError,
		hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
		operation: input.operation,
	});
}

async function waitForQueuedRpcPrompt(
	session: Pick<AgentSession, "isStreaming" | "queuedMessageCount" | "waitForIdle">,
) {
	while (true) {
		await session.waitForIdle();
		const nextTurn = Promise.withResolvers<void>();
		setImmediate(nextTurn.resolve);
		await nextTurn.promise;
		if (!session.isStreaming && session.queuedMessageCount === 0) return;
	}
}
type RpcOperationMessageSession = Pick<AgentSession, "abort" | "getMessageTag" | "removeQueuedMessagesByTag">;

/** Correlates accepted operations with the exact AgentSession message that owns the active turn. */
export class RpcOperationMessageOwnership {
	#activeOperationId: string | undefined;

	constructor(readonly session: RpcOperationMessageSession) {}

	observeMessageStart(message: AgentMessage): void {
		this.#activeOperationId = this.session.getMessageTag(message);
	}

	settle(operationId: string): void {
		if (this.#activeOperationId === operationId) this.#activeOperationId = undefined;
	}

	async cancel(manager: RpcOperationManager, operationId: string): Promise<RpcCancelOperationResult> {
		const ownsActiveMessage = this.#activeOperationId === operationId;
		const cancellation = manager.cancel(operationId);
		if (!cancellation.wasStarted) return cancellation.result;
		if (ownsActiveMessage) {
			await this.session.abort({ reason: USER_INTERRUPT_LABEL });
		} else {
			this.session.removeQueuedMessagesByTag(operationId);
		}
		return cancellation.result;
	}
}

/**
 * Dependencies for {@link dispatchRpcInputFrame}. Provided by the RPC mode
 * entrypoint; broken out so tests can drive the input loop with stubs.
 */
export interface RpcInputFrameDeps {
	handleCommand: (command: RpcCommand) => Promise<RpcResponse>;
	output: RpcOutput;
	errorResponse: (id: string | undefined, command: string, message: string, code?: string) => RpcResponse;
	trackBackgroundTask?: (task: Promise<void>) => void;
	pendingExtensionRequests: Map<string, PendingExtensionRequest>;
	onHostToolResult: (frame: RpcHostToolResult) => void;
	onHostToolUpdate: (frame: RpcHostToolUpdate) => void;
	onHostUriResult: (frame: RpcHostUriResult) => void;
}

/**
 * Structural guard for a well-formed extension UI response frame. Mirrors the
 * shape declared in {@link RpcExtensionUIResponse} — a truthy record with
 * `type === "extension_ui_response"` and a string `id`. Payload variants (value,
 * confirmed, cancelled) are validated at the read site.
 */
function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_response" && typeof value.id === "string";
}

/** Dispatch side-channel frames that must overtake the serialized command queue. */
export function dispatchRpcControlFrame(parsed: unknown, deps: RpcInputFrameDeps): boolean {
	if (isRpcExtensionUIResponse(parsed)) {
		const pending = deps.pendingExtensionRequests.get(parsed.id);
		if (pending) pending.resolve(parsed);
		return true;
	}

	if (isRpcHostToolResult(parsed)) {
		deps.onHostToolResult(parsed);
		return true;
	}

	if (isRpcHostToolUpdate(parsed)) {
		deps.onHostToolUpdate(parsed);
		return true;
	}

	if (isRpcHostUriResult(parsed)) {
		deps.onHostUriResult(parsed);
		return true;
	}

	return false;
}

/**
 * Dispatch a single parsed frame from the RPC input stream.
 *
 * Concurrent and control commands are dispatched in the background so the
 * caller can keep reading while a long-running serial command is in flight.
 * This lets abort, steering, and cancellation commands preempt queued work.
 * Response correlation is preserved via each command's `id`; ordering across
 * concurrent commands is not guaranteed and clients MUST match on `id`.
 *
 * @returns `undefined` when the frame was routed to a side-channel handler
 *   (extension UI response, host tool/URI frames) or dispatched in the
 *   background (`concurrent` or `control`). Otherwise a promise that resolves once the response
 *   for the command has been emitted via `output`. Errors from `handleCommand`
 *   on serial commands propagate; the caller is expected to wrap them.
 */
export function dispatchRpcInputFrame(parsed: unknown, deps: RpcInputFrameDeps): Promise<void> | undefined {
	if (dispatchRpcControlFrame(parsed, deps)) return undefined;
	const validation = validateRpcCommand(parsed);
	if (!validation.ok) {
		deps.output(deps.errorResponse(validation.id, validation.command, validation.error, validation.code));
		return undefined;
	}
	const command = validation.command;

	if (validation.scheduling !== "serial") {
		const task = (async () => {
			try {
				const response = await deps.handleCommand(command);
				deps.output(response);
				if (response.success && response.command === "set_settings") deps.output({ type: "settings_update" });
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				deps.output(deps.errorResponse(command.id, command.type, message));
			}
		})();
		deps.trackBackgroundTask?.(task);
		return undefined;
	}

	return (async () => {
		const response = await deps.handleCommand(command);
		deps.output(response);
		if (response.success && response.command === "set_settings") deps.output({ type: "settings_update" });
	})();
}

/** Serializes ordinary RPC commands while allowing control frames to dispatch immediately. */
export class RpcInputDispatcher {
	#tail: Promise<void> = Promise.resolve();
	#tasks = new Set<Promise<void>>();
	readonly #deps: RpcInputFrameDeps;
	readonly #afterSerialCommand: (() => Promise<void>) | undefined;

	constructor(options: { deps: RpcInputFrameDeps; afterSerialCommand?: () => Promise<void> }) {
		this.#deps = options.deps;
		this.#afterSerialCommand = options.afterSerialCommand;
	}

	/** Accept a parsed input frame without blocking the stdin reader. */
	dispatch(parsed: unknown): void {
		try {
			if (dispatchRpcControlFrame(parsed, this.#deps)) return;

			const validation = validateRpcCommand(parsed);
			if (!validation.ok) {
				this.#deps.output(
					this.#deps.errorResponse(validation.id, validation.command, validation.error, validation.code),
				);
				return;
			}
			if (validation.scheduling !== "serial") {
				dispatchRpcInputFrame(validation.command, this.#deps);
				return;
			}

			const task = this.#tail.then(
				() => this.#dispatchSerialCommand(validation.command),
				() => this.#dispatchSerialCommand(validation.command),
			);
			this.#tail = task.catch(() => {});
			this.#tasks.add(task);
			void task.finally(() => {
				this.#tasks.delete(task);
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			const id = isRecord(parsed) && typeof parsed.id === "string" ? parsed.id : undefined;
			this.#deps.output(this.#deps.errorResponse(id, "parse", `Failed to parse command: ${message}`));
		}
	}

	/** Await every accepted serial command, including commands queued before EOF. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	async #dispatchSerialCommand(command: RpcCommand): Promise<void> {
		try {
			const awaited = dispatchRpcInputFrame(command, this.#deps);
			if (awaited) await awaited;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(command.id, command.type, message));
		} finally {
			await this.#afterSerialCommand?.();
		}
	}
}

/**
 * Coordinates deferred shutdown with in-flight background input tasks.
 *
 * `pi.shutdown()` from an extension only *requests* shutdown; the process must
 * not exit while a background-dispatched command (see
 * {@link dispatchRpcInputFrame}) still owes the client a response frame. The
 * coordinator tracks those tasks, re-checks the shutdown request whenever one
 * settles (covering a shutdown requested mid-bash with no follow-up client
 * frame), and drains every tracked task before invoking `performShutdown`.
 * The shutdown sequence is latched so concurrent triggers (input loop and
 * settling tasks) run it exactly once.
 */
export class RpcShutdownCoordinator {
	#tasks = new Set<Promise<void>>();
	#shutdown: Promise<void> | undefined;
	readonly #isShutdownRequested: () => boolean;
	readonly #performShutdown: () => Promise<void>;

	constructor(options: { isShutdownRequested: () => boolean; performShutdown: () => Promise<void> }) {
		this.#isShutdownRequested = options.isShutdownRequested;
		this.#performShutdown = options.performShutdown;
	}

	/**
	 * Track a background input task. When it settles it is untracked and the
	 * shutdown request is re-checked, so a deferred shutdown fires even when
	 * no further client frames arrive.
	 */
	track(task: Promise<void>): void {
		this.#tasks.add(task);
		void task.finally(() => {
			this.#tasks.delete(task);
			// Fire-and-forget: performShutdown ends the process. Rejections are
			// not expected — hook errors are caught inside extensionRunner.emit,
			// and background tasks catch their own dispatch errors.
			void this.checkShutdownRequested();
		});
	}

	/** Await every tracked task, including tasks tracked while draining. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	/**
	 * If shutdown was requested, drain background tasks (so every owed
	 * response frame is written) before running the shutdown sequence.
	 */
	checkShutdownRequested(): Promise<void> {
		if (!this.#shutdown) {
			if (!this.#isShutdownRequested()) return Promise.resolve();
			this.#shutdown = this.drain().then(() => this.#performShutdown());
		}
		return this.#shutdown;
	}
}

export type RpcSubagentResetRegistry = Pick<RpcSubagentRegistry, "clear">;

export async function handleRpcSessionChange(
	session: RpcSessionChangeSession,
	command: RpcSessionChangeCommand,
	subagentRegistry?: RpcSubagentResetRegistry,
	beforeCommit?: () => void | Promise<void>,
): Promise<RpcSessionChangeResult> {
	switch (command.type) {
		case "new_session": {
			const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const cancelled = !(await session.newSession(options, beforeCommit));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "new_session", data: { cancelled } };
		}

		case "switch_session": {
			const cancelled = !(await session.switchSession(command.sessionPath, beforeCommit));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "switch_session", data: { cancelled } };
		}

		case "branch": {
			const result = await session.branch(command.entryId, beforeCommit);
			if (!result.cancelled) subagentRegistry?.clear();
			return { type: "branch", data: { text: result.selectedText, cancelled: result.cancelled } };
		}
	}
	throw new Error("Unsupported RPC session change command");
}

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
			loadMode: defaultLoadModeForToolName(name, tool.loadMode),
		};
	});
}

function parseValueDialogResponse(
	response: RpcExtensionUIResponse,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isSubagentSubscriptionLevel(value: unknown): value is RpcSubagentSubscriptionLevel {
	return value === "off" || value === "progress" || value === "events";
}

export function requestRpcEditor(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
	let settled = false;

	const cleanup = () => {
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: string | undefined) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		finish(undefined);
	};

	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
	pendingRequests.set(id, {
		resolve: response => {
			if ("cancelled" in response && response.cancelled) {
				finish(undefined);
			} else if ("value" in response) {
				finish(response.value);
			} else {
				finish(undefined);
			}
		},
		reject: fail,
	});
	output({
		type: "extension_ui_request",
		id,
		method: "editor",
		title,
		prefill,
		promptStyle: editorOptions?.promptStyle,
	} as RpcExtensionUIRequest);
	return promise;
}

/** Sends an RPC extension dialog and cancels the remote presentation when its signal aborts. */
export function requestRpcDialog<T>(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	opts: ExtensionUIDialogOptions | undefined,
	defaultValue: T,
	request: Record<string, unknown>,
	parseResponse: (response: RpcExtensionUIResponse) => T,
): Promise<T> {
	if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let timeoutId: NodeJS.Timeout | undefined;

	const cleanup = () => {
		clearTimeout(timeoutId);
		opts?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		cleanup();
		resolve(defaultValue);
	};
	opts?.signal?.addEventListener("abort", onAbort, { once: true });

	if (opts?.timeout !== undefined) {
		timeoutId = setTimeout(() => {
			opts.onTimeout?.();
			cleanup();
			resolve(defaultValue);
		}, opts.timeout);
	}

	pendingRequests.set(id, {
		resolve: response => {
			cleanup();
			resolve(parseResponse(response));
		},
		reject,
	});
	output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
	return promise;
}

export function requestRpcAgentMutationConfirmation(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	command: "cancel_agent" | "release_agent",
	agentId: string,
	tombstone = false,
	timeout = 30_000,
): Promise<boolean> {
	const operationId = Snowflake.next() as string;
	return requestRpcDialog(
		pendingRequests,
		output,
		{ timeout },
		false,
		{
			method: "confirm",
			title: command === "cancel_agent" ? "Cancel agent" : "Release agent",
			message:
				command === "cancel_agent"
					? `Cancel agent ${agentId}?`
					: `Release agent ${agentId} (tombstone: ${tombstone})?`,
			timeout,
			operationId,
			command,
		},
		response => "confirmed" in response && response.confirmed === true && response.operationId === operationId,
	);
}

export function requestRpcPrivilegedConfirmation(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	command: "eval_execute" | "bash" | "cancel_job" | "delete_session" | "remove_provider_auth",
	title: string,
	message: string,
	options: { operationId?: string; signal?: AbortSignal; timeout?: number } = {},
): Promise<boolean> {
	const operationId = options.operationId ?? (Snowflake.next() as string);
	const timeout = options.timeout ?? 30_000;
	return requestRpcDialog(
		pendingRequests,
		output,
		{ signal: options.signal, timeout },
		false,
		{ method: "confirm", title, message, timeout, operationId, command },
		response => "confirmed" in response && response.confirmed === true && response.operationId === operationId,
	);
}
export type RpcToolActivationSession = Pick<
	AgentSession,
	| "activityPhase"
	| "getActiveToolNames"
	| "getAllToolNames"
	| "getEnabledToolNames"
	| "getMountedXdevToolNames"
	| "getToolInventory"
	| "isCompacting"
	| "isStreaming"
	| "setActiveToolsByName"
>;

export class RpcToolActivationBusyError extends Error {
	constructor() {
		super("Session is busy; tool activation cannot change during active work");
		this.name = "RpcToolActivationBusyError";
	}
}

class RpcSessionTransitionBusyError extends Error {
	constructor() {
		super("Session transition is unavailable while an authentication, mode, or plan operation is committing");
		this.name = "RpcSessionTransitionBusyError";
	}
}

/** Validate and atomically reconcile one session's enabled tool set. */
export async function applyRpcToolActivation(
	session: RpcToolActivationSession,
	command: Extract<RpcCommand, { type: "set_tool_activation" }>,
	hasActiveOperation = false,
): Promise<RpcToolActivationResult> {
	const { activate, deactivate } = validateRpcToolActivationBatch(command, session.getAllToolNames());
	if (hasActiveOperation || session.activityPhase !== "idle" || session.isStreaming || session.isCompacting) {
		throw new RpcToolActivationBusyError();
	}
	const previousEnabled = [...new Set(session.getEnabledToolNames())];
	const deactivateSet = new Set(deactivate);
	const next = previousEnabled.filter(name => !deactivateSet.has(name));
	const nextSet = new Set(next);
	for (const name of activate) {
		if (!nextSet.has(name)) {
			next.push(name);
			nextSet.add(name);
		}
	}

	await session.setActiveToolsByName(next, false);

	const enabledToolNames = [...new Set(session.getEnabledToolNames())];
	const activeToolNames = [...new Set(session.getActiveToolNames())];
	const mountedToolNames = [...new Set(session.getMountedXdevToolNames())];
	const previousSet = new Set(previousEnabled);
	const achievedSet = new Set(enabledToolNames);
	const activated = enabledToolNames.filter(name => !previousSet.has(name));
	const deactivated = previousEnabled.filter(name => !achievedSet.has(name));
	try {
		return {
			enabledToolNames,
			activeToolNames,
			mountedToolNames,
			activated,
			deactivated,
			inventoryAvailable: true,
			inventory: session.getToolInventory(RPC_APPLICATION_API_VERSION),
		};
	} catch (cause) {
		if (!(cause instanceof ToolInventoryUnavailableError)) throw cause;
		return {
			enabledToolNames,
			activeToolNames,
			mountedToolNames,
			activated,
			deactivated,
			inventoryAvailable: false,
		};
	}
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	eventBus?: EventBus,
	input: ReadableStream<Uint8Array> = claimRpcInput(),
): Promise<never> {
	// Signal to RPC clients that the server is ready to accept commands
	// Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
	// process.stdout with no newline, which the reader merges with the next JSON line and
	// breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
	// may write there.
	process.env.PI_NOTIFICATIONS = "off";

	const frameEncoder = new RpcFrameEncoder();
	const getCapabilityManifest = () => {
		const features = new Set<string>();
		if (eventBus) features.add("subagent-event-bus");
		features.add("agent-control");
		if (session.asyncJobManager && session.getAgentId()) features.add("job-control");
		if (session.model && serviceTierFamily(session.model)) features.add("model.fast-mode");
		return getRpcCapabilityManifest({ features });
	};
	const capabilityManifest = getCapabilityManifest();
	// Ordered stdout writer honoring backpressure: chunked v2 frames are produced
	// lazily by the encoder and written one physical line at a time, so a near-limit
	// logical frame never materializes its full base64 transport in memory.
	let stdoutQueue: Promise<void> = Promise.resolve();
	const writeFrames = (frames: Iterable<string>) => {
		stdoutQueue = stdoutQueue
			.then(async () => {
				for (const line of frames) {
					if (!process.stdout.write(line)) await once(process.stdout, "drain");
				}
			})
			// stdout gone (host exited) — nothing left to deliver; keep the queue alive.
			.catch(() => {});
	};
	writeFrames(
		frameEncoder.encodeFrames({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
			capabilities: capabilityManifest,
		}),
	);
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeFrames(frameEncoder.encodeFrames(obj));
		if (isRecord(obj) && obj.type === "response" && obj.command === "negotiate_protocol" && obj.success === true)
			frameEncoder.setProtocolVersion(2);
	};
	const emitRpcTitles = shouldEmitRpcTitles();

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string, code?: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message, ...(code ? { code } : {}) };
	};
	const catalogError = (id: string | undefined, command: string, cause: unknown): RpcResponse =>
		cause instanceof SessionCatalogError
			? error(id, command, cause.message, cause.code)
			: cause instanceof RpcSessionTransitionBusyError
				? error(id, command, cause.message, "session_busy")
				: error(id, command, cause instanceof Error ? cause.message : String(cause));
	const operationOwnership = new RpcOperationMessageOwnership(session);
	const rpcEvalOperationIds = new Set<string>();
	const rpcEvalConfirmationControllers = new Map<string, AbortController>();
	const rpcEvalTasks = new Set<Promise<void>>();
	const pendingRpcBashConfirmations = new Set<AbortController>();
	const rpcBashExecutions = new Set<Promise<unknown>>();
	const operationManager = new RpcOperationManager(frame => {
		if (frame.type === "operation_completed") operationOwnership.settle(frame.operationId);
		if (frame.type !== "operation_started") {
			rpcEvalOperationIds.delete(frame.operationId);
			rpcEvalConfirmationControllers.get(frame.operationId)?.abort();
			rpcEvalConfirmationControllers.delete(frame.operationId);
		}
		output(frame);
	});
	const planApprovalOperations = new Map<string, string>();

	const extensionUserMessageTracker = new RpcExtensionUserMessageTracker();

	const pendingExtensionRequests = new RpcPendingExtensionRequests();
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	const subagentRegistry = eventBus ? new RpcSubagentRegistry(eventBus, output) : undefined;
	const sessionStorage = new FileSessionStorage();
	const providerAuthService = new ProviderAuthService(session.modelRegistry, session.sessionId);
	let rpcTaskTracker: (task: Promise<void>) => void = task => {
		void task;
	};
	const providerAuthController = new ProviderAuthController(
		providerAuthService,
		operationManager,
		frame => output(frame),
		task => rpcTaskTracker(task),
		request =>
			requestRpcDialog(
				pendingExtensionRequests,
				output,
				{ signal: request.signal },
				undefined,
				{
					method: "input",
					title: request.prompt,
					placeholder: request.placeholder,
					sensitive: true,
					operationId: request.operationId,
					purpose: "provider_auth",
					providerId: request.providerId,
				},
				response => ("value" in response ? response.value : undefined),
			),
	);
	const agentSenderId = session.getAgentId?.() ?? MAIN_AGENT_ID;
	const agentRegistry = AgentRegistry.global();
	const agentLifecycle = AgentLifecycleManager.global();
	const agentControl = new AgentControlService({
		session: { agentRegistry, agentLifecycle: () => agentLifecycle },
		registry: agentRegistry,
		lifecycle: agentLifecycle,
		senderId: agentSenderId,
		settings: session.settings,
		projectResult: agentId => {
			const job = session.asyncJobManager?.getJob(agentId);
			if (!job || (job.ownerId !== undefined && job.ownerId !== agentSenderId)) return undefined;
			return {
				status: job.status,
				resultText: job.resultText,
				errorText: job.errorText,
			};
		},
	});
	const unsubscribeAgentRegistry = agentControl.onRegistryUpdate(update => {
		output({ type: "agent_registry_update", ...update });
	});
	const rpcJobOwnerId = session.getAgentId();
	const jobProjection =
		session.asyncJobManager && rpcJobOwnerId
			? new JobProjectionService({
					manager: session.asyncJobManager,
					ownerId: rpcJobOwnerId,
					registry: AgentRegistry.global(),
					lifecycle: AgentLifecycleManager.global(),
				})
			: undefined;

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		constructor(
			private pendingRequests: Map<string, PendingExtensionRequest>,
			private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
		) {}

		select(
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				undefined,
				{
					method: "select",
					title,
					options: options.map(getExtensionUISelectOptionLabel),
					timeout: dialogOptions?.timeout,
				},
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				false,
				{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
				response => {
					if ("cancelled" in response && response.cancelled) {
						if (response.timedOut) dialogOptions?.onTimeout?.();
						return false;
					}
					if ("confirmed" in response) return response.confirmed;
					return false;
				},
			);
		}

		input(
			title: string,
			placeholder?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				undefined,
				{ method: "input", title, placeholder, timeout: dialogOptions?.timeout },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		}

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		}

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		}

		setWorkingMessage(_message?: string): void {
			// Not supported in RPC mode
		}

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				this.output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		}

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		}

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		}

		setTitle(title: string): void {
			// Title updates are low-value noise for most RPC hosts; opt in via PI_RPC_EMIT_TITLE=1.
			if (!emitRpcTitles) return;
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		}

		async custom(): Promise<never> {
			// Custom UI not supported in RPC mode
			return undefined as never;
		}

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		}

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		}

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		}

		async editor(
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
			editorOptions?: { promptStyle?: boolean },
		): Promise<string | undefined> {
			return requestRpcEditor(this.pendingRequests, this.output, title, prefill, dialogOptions, editorOptions);
		}

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		}

		get theme(): Theme {
			return theme;
		}

		getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
			return Promise.resolve([]);
		}

		getTheme(_name: string): Promise<Theme | undefined> {
			return Promise.resolve(undefined);
		}

		setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
			// Theme switching not supported in RPC mode
			return Promise.resolve({ success: false, error: "Theme switching not supported in RPC mode" });
		}

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		}

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		}

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		}
	}

	// Wire up UI context for tool execution (ask tool, etc.) and extensions.
	// A single shared instance routes all responses received on stdin to the
	// correct waiting promise regardless of which code path created the request.
	const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, output);
	setToolUIContext?.(rpcUiContext, true);

	// Set up extensions with RPC-based UI context
	await initializeExtensions(session, {
		mode: "rpc",
		reportSendError: (action, err) => {
			output(error(undefined, action, err.message));
		},
		reportRuntimeError: err => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		},
		onShutdown: () => {
			shutdownState.requested = true;
		},
		trackAgentInvokingMessage: task => {
			extensionUserMessageTracker.trackAgentMessageTask(task);
		},
		uiContext: rpcUiContext,
	});

	// Output all agent events as JSON
	let lastQueueFrame = "";
	const emitQueueUpdate = () => {
		const queue = session.getQueueSnapshot();
		const serialized = JSON.stringify(queue);
		if (serialized === lastQueueFrame) return;
		lastQueueFrame = serialized;
		output({ type: "queue_update", queue });
	};
	session.subscribe(event => {
		if (event.type === "message_start") operationOwnership.observeMessageStart(event.message);
		output(event);
		emitQueueUpdate();
	});
	session.planMode.onStateChange(state => {
		output({ type: "plan_state_update", state });
	});
	session.planMode.onApprovalRequest(approval => {
		output({
			type: "plan_approval_request",
			approvalId: approval.approvalId,
			planFilePath: approval.planFilePath,
			title: approval.title,
			planContent: approval.planContent,
		});
	});
	session.planMode.onApprovalSettled(result => {
		output({ type: "plan_approval_settled", approvalId: result.approvalId, result });
	});
	const emitJobUpdate = () => {
		const snapshot = jobProjection?.list();
		if (snapshot) output({ type: "job_update", ...snapshot });
	};
	const unsubscribeJobUpdates = jobProjection?.subscribe(emitJobUpdate);

	const getAvailableCommands = async () => buildAvailableSlashCommands(session);
	const getAdvisorState = () => session.getAdvisorStateOverview();
	const emitConfigUpdate = () => {
		output({
			type: "config_update",
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			advisor: getAdvisorState(),
		});
	};
	const reloadPluginState = async () => {
		const cwd = session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		resetCapabilities();
		await session.refreshSkills();
		session.setSlashCommands(await loadSlashCommands({ cwd }));
		await emitAvailableCommandsUpdate();
	};
	const emitAvailableCommandsUpdate = async () => {
		output({ type: "available_commands_update", commands: await getAvailableCommands() });
	};
	session.subscribeCommandMetadataChanged(() => {
		void emitAvailableCommandsUpdate();
	});
	session.subscribeToolInventoryChanged(() => {
		output({ type: "tool_inventory_update" });
	});
	await emitAvailableCommandsUpdate();
	emitQueueUpdate();
	emitJobUpdate();

	const protectedCommitOperationIds = (): Set<string> => {
		const protectedOperations = new Set(providerAuthController.protectedOperationIds());
		for (const operation of operationManager.snapshot().active) {
			if (
				operation.status === "started" &&
				(operation.command === "set_mode" || operation.command === "resolve_plan_approval")
			) {
				protectedOperations.add(operation.operationId);
			}
		}
		return protectedOperations;
	};
	let sessionTransitionInFlight = false;
	let sessionGeneration = 0;
	const prepareSessionTransition = async (): Promise<void> => {
		if (providerAuthController.hasMutationInFlight()) throw new RpcSessionTransitionBusyError();
		const protectedOperations = protectedCommitOperationIds();
		if (protectedOperations.size > 0) throw new RpcSessionTransitionBusyError();
		const providerProtected = providerAuthController.cancelAll("session_transition", "session_changed");
		if (providerProtected.size > 0) throw new RpcSessionTransitionBusyError();
		sessionTransitionInFlight = true;
		sessionGeneration++;
		try {
			const evalOperationIds = Array.from(rpcEvalOperationIds);
			operationManager.cancelAll("session_transition", "session_changed");
			for (const controller of pendingRpcBashConfirmations) controller.abort();
			session.abortBash();
			for (const operationId of evalOperationIds) session.abortEvalExecution(operationId);
			await Promise.allSettled([...rpcEvalTasks, ...rpcBashExecutions]);
			if (session.isStreaming) {
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				await session.waitForIdle();
			}
		} catch (cause) {
			sessionTransitionInFlight = false;
			throw cause;
		}
	};
	const completeSessionTransition = async (
		id: string | undefined,
		command: RpcCommand["type"],
		data: { cancelled: boolean } & object,
	): Promise<RpcResponse> => {
		if (!data.cancelled) await emitAvailableCommandsUpdate();
		return success(id, command, data);
	};
	let toolActivationInFlight = false;
	const confirmAgentMutation = (
		command: "cancel_agent" | "release_agent",
		agentId: string,
		tombstone = false,
	): Promise<boolean> =>
		requestRpcAgentMutationConfirmation(pendingExtensionRequests, output, command, agentId, tombstone);

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;

		switch (command.type) {
			case "negotiate_protocol": {
				if (command.protocolVersion !== 2)
					return error(id, "negotiate_protocol", `Unsupported RPC protocol version: ${command.protocolVersion}`);
				return success(id, "negotiate_protocol", { protocolVersion: 2 });
			}

			case "get_capabilities":
				return success(id, "get_capabilities", getCapabilityManifest());

			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				if (sessionTransitionInFlight) {
					return error(id, "prompt", "Session transition is in progress", "session_busy");
				}
				const operation = operationManager.start(id, "prompt");
				setImmediate(() => {
					if (!operationManager.begin(operation)) return;
					void (async () => {
						const skillResult = await tryRunRpcSkillCommand(
							session,
							command.message,
							command.streamingBehavior,
							operation.operationId,
						);
						if (!operationManager.isActive(operation)) return;
						if (skillResult) {
							reportLocalOnlyPromptResult({
								id,
								prompt: Promise.resolve(true),
								output,
								onError: () => {},
								operation: {
									handle: operation,
									manager: operationManager,
									waitForAgentCompletion: () => waitForQueuedRpcPrompt(session),
								},
							});
							return;
						}
						const builtinResult = await executeAcpBuiltinSlashCommand(command.message, {
							session,
							sessionManager: session.sessionManager,
							settings: session.settings,
							cwd: session.sessionManager.getCwd(),
							output: text => output({ type: "command_output", text }),
							refreshCommands: emitAvailableCommandsUpdate,
							reloadPlugins: reloadPluginState,
							notifyTitleChanged: async () => {
								output({
									type: "session_info_update",
									title: session.sessionName,
									sessionId: session.sessionId,
									mode: session.planMode.mode,
								});
							},
							notifyConfigChanged: async () => {
								emitConfigUpdate();
							},
						});
						if (!operationManager.isActive(operation)) return;
						if (builtinResult !== false) {
							if ("prompt" in builtinResult) {
								watchAndReportLocalOnlyPromptResult({
									id,
									startPrompt: () =>
										session.prompt(builtinResult.prompt, {
											images: command.images,
											messageTag: operation.operationId,
										}),
									output,
									onError: () => {},
									extensionUserMessageTracker,
									operation: {
										handle: operation,
										manager: operationManager,
										waitForAgentCompletion: () => waitForQueuedRpcPrompt(session),
									},
								});
								return;
							}
							output({ type: "prompt_result", id, operationId: operation.operationId, agentInvoked: false });
							operationManager.complete(operation, false);
							return;
						}

						watchAndReportLocalOnlyPromptResult({
							id,
							startPrompt: () =>
								session.prompt(command.message, {
									images: command.images,
									streamingBehavior: command.streamingBehavior,
									messageTag: operation.operationId,
								}),
							output,
							onError: () => {},
							extensionUserMessageTracker,
							operation: {
								handle: operation,
								manager: operationManager,
								waitForAgentCompletion: () => waitForQueuedRpcPrompt(session),
							},
						});
					})().catch(promptError => {
						operationManager.fail(
							operation,
							promptError instanceof Error ? promptError : new Error(String(promptError)),
							"prompt_scheduling_failed",
						);
					});
				});
				return success(id, "prompt", { operationId: operation.operationId, accepted: true });
			}

			case "steer": {
				if (sessionTransitionInFlight) {
					return error(id, "steer", "Session transition is in progress", "session_busy");
				}
				if (toolActivationInFlight) {
					return error(id, "steer", "Session tool activation is in progress", "session_busy");
				}
				await session.steer(command.message, command.images);
				emitQueueUpdate();
				return success(id, "steer");
			}

			case "follow_up": {
				if (sessionTransitionInFlight) {
					return error(id, "follow_up", "Session transition is in progress", "session_busy");
				}
				if (toolActivationInFlight) {
					return error(id, "follow_up", "Session tool activation is in progress", "session_busy");
				}
				await session.followUp(command.message, command.images);
				emitQueueUpdate();
				return success(id, "follow_up");
			}

			case "abort": {
				const protectedOperations = protectedCommitOperationIds();
				for (const operationId of providerAuthController.cancelAll("user", "cancelled_by_client")) {
					protectedOperations.add(operationId);
				}
				operationManager.cancelAll("user", "cancelled_by_client", protectedOperations);
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				emitQueueUpdate();
				return success(id, "abort");
			}

			case "abort_and_prompt": {
				if (sessionTransitionInFlight) {
					return error(id, "abort_and_prompt", "Session transition is in progress", "session_busy");
				}
				if (toolActivationInFlight) {
					return error(id, "abort_and_prompt", "Session tool activation is in progress", "session_busy");
				}
				const protectedOperations = protectedCommitOperationIds();
				if (protectedOperations.size > 0) {
					return error(id, "abort_and_prompt", "Session state commit is in progress", "session_busy");
				}
				const providerProtected = providerAuthController.cancelAll("replaced", "replaced_by_prompt");
				if (providerProtected.size > 0) {
					return error(id, "abort_and_prompt", "Session state commit is in progress", "session_busy");
				}
				operationManager.cancelAll("replaced", "replaced_by_prompt");
				const operation = operationManager.start(id, "abort_and_prompt");
				setImmediate(() => {
					if (!operationManager.begin(operation)) return;
					void (async () => {
						await session.abort({ reason: USER_INTERRUPT_LABEL });
						if (!operationManager.isActive(operation)) return;
						watchAndReportLocalOnlyPromptResult({
							id,
							startPrompt: () =>
								session.prompt(command.message, {
									images: command.images,
									messageTag: operation.operationId,
								}),
							output,
							onError: () => {},
							extensionUserMessageTracker,
							operation: {
								handle: operation,
								manager: operationManager,
								waitForAgentCompletion: () => waitForQueuedRpcPrompt(session),
							},
						});
					})().catch(promptError => {
						operationManager.fail(
							operation,
							promptError instanceof Error ? promptError : new Error(String(promptError)),
							"prompt_scheduling_failed",
						);
					});
				});
				return success(id, "abort_and_prompt", { operationId: operation.operationId, accepted: true });
			}

			case "cancel_operation": {
				const activeOperation = operationManager
					.snapshot()
					.active.find(operation => operation.operationId === command.operationId);
				if (
					activeOperation?.status === "started" &&
					(activeOperation.command === "set_mode" || activeOperation.command === "resolve_plan_approval")
				) {
					return error(
						id,
						"cancel_operation",
						"Mode and plan operations cannot be cancelled after their commit phase starts",
						"operation_commit_in_progress",
					);
				}
				const approvalId = planApprovalOperations.get(command.operationId);
				if (approvalId) {
					planApprovalOperations.delete(command.operationId);
					const pending = session.planMode.pendingApproval;
					if (pending?.approvalId === approvalId) await session.planMode.abandonPendingApproval();
				}
				const providerCancellation = providerAuthController.cancel(command.operationId);
				if (providerCancellation === "cancelled") {
					return success(id, "cancel_operation", operationManager.cancel(command.operationId).result);
				}
				if (providerCancellation === "protected") {
					return error(
						id,
						"cancel_operation",
						"Provider authentication credentials are already being committed",
						"provider_auth_commit_in_progress",
					);
				}
				const isRpcEval = rpcEvalOperationIds.has(command.operationId);
				if (isRpcEval) {
					const cancellation = operationManager.cancel(command.operationId);
					rpcEvalConfirmationControllers.get(command.operationId)?.abort();
					if (cancellation.wasStarted) session.abortEvalExecution(command.operationId);
					return success(id, "cancel_operation", cancellation.result);
				}
				const cancellation = await operationOwnership.cancel(operationManager, command.operationId);
				return success(id, "cancel_operation", cancellation);
			}

			case "resume_session": {
				if (session.isStreaming || session.isCompacting)
					return error(
						id,
						"resume_session",
						"Session mutation is unavailable while the session is busy",
						"session_busy",
					);
				try {
					const previousCwd = session.sessionManager.getCwd();
					const resolved = await resolveSessionCatalogReference(
						command.session,
						{ scope: command.scope ?? (command.cwd ? "cwd" : "all"), cwd: command.cwd },
						sessionStorage,
					);
					const switched = await handleRpcSessionChange(
						session,
						{ type: "switch_session", sessionPath: resolved.entry.path },
						subagentRegistry,
						prepareSessionTransition,
					);
					const cwd = session.sessionManager.getCwd();
					const sessionFile = session.sessionManager.getSessionFile();
					const data: RpcResumeSessionResult = {
						cancelled: switched.data.cancelled,
						...(sessionFile ? { sessionFile } : {}),
						cwd,
						cwdChanged: !switched.data.cancelled && path.resolve(cwd) !== path.resolve(previousCwd),
					};
					return completeSessionTransition(id, "resume_session", data);
				} catch (cause) {
					return catalogError(id, "resume_session", cause);
				}
			}

			case "eval_execute": {
				if (sessionTransitionInFlight) {
					return error(
						id,
						"eval_execute",
						"Eval execution is unavailable while a session transition is in progress",
						"session_busy",
					);
				}
				if (toolActivationInFlight) {
					return error(
						id,
						"eval_execute",
						"Eval execution is unavailable while tool activation is in progress",
						"session_busy",
					);
				}
				const operationGeneration = sessionGeneration;
				const operation = operationManager.start(id, "eval_execute");
				rpcEvalOperationIds.add(operation.operationId);
				const confirmationController = new AbortController();
				rpcEvalConfirmationControllers.set(operation.operationId, confirmationController);
				const { promise: task, resolve: resolveTask } = Promise.withResolvers<void>();
				rpcEvalTasks.add(task);
				void task.finally(() => rpcEvalTasks.delete(task));
				setImmediate(() => {
					if (!operationManager.begin(operation)) {
						resolveTask();
						return;
					}
					void (async () => {
						const confirmed = await requestRpcPrivilegedConfirmation(
							pendingExtensionRequests,
							output,
							"eval_execute",
							"Run eval code?",
							`Language: ${command.language}\n\n${command.code}`,
							{ operationId: operation.operationId, signal: confirmationController.signal },
						);
						if (!operationManager.isActive(operation)) return;
						if (!confirmed) {
							operationManager.fail(
								operation,
								new Error("Eval execution was not confirmed"),
								"confirmation_denied",
							);
							return;
						}
						if (sessionTransitionInFlight || operationGeneration !== sessionGeneration) {
							operationManager.fail(
								operation,
								new Error("Session changed before eval execution"),
								"session_changed",
							);
							return;
						}

						const evalOutput = new RpcEvalOutputStream(
							operation.operationId,
							() => operationManager.isActive(operation),
							output,
						);
						const registeredEvalTool = session.getEvalToolForHost();
						if (!(registeredEvalTool instanceof EvalTool)) throw new Error("Eval tool is unavailable");
						const evalTool = registeredEvalTool;
						const result = await evalTool.withExecutionId(operation.operationId).execute(
							operation.operationId,
							{
								language: command.language,
								code: command.code,
								title: command.title,
								timeout: command.timeout,
								reset: command.reset,
							},
							undefined,
							update => {
								const text =
									update.details?.cells
										.map((cell: NonNullable<EvalToolDetails["cells"]>[number]) => cell.output.trim())
										.filter(Boolean)
										.join("\n\n") ?? "";
								evalOutput.push(text);
							},
						);
						if (!operationManager.isActive(operation)) return;
						const outputText = result.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("");
						evalOutput.complete(outputText);
						if (!operationManager.isActive(operation)) return;
						const firstCell = result.details?.cells?.[0];
						const boundedOutput = outputText.length > 262_144 ? outputText.slice(-262_144) : outputText;
						const entry: RpcEvalHistoryEntry = {
							language: command.language,
							code: command.code,
							output: boundedOutput,
							exitCode: firstCell?.exitCode,
							cancelled: firstCell?.cancelled === true,
							truncated:
								evalOutput.truncated ||
								outputText.length > boundedOutput.length ||
								result.details?.meta?.truncation !== undefined,
							timestamp: Date.now(),
							excludeFromContext: command.excludeFromContext,
						};
						session.recordEvalResult(entry);
						output({ type: "eval_complete", operationId: operation.operationId, result: entry });
						operationManager.complete(operation, false);
					})()
						.catch(cause => {
							const evalError = cause instanceof Error ? cause : new Error(String(cause));
							operationManager.fail(operation, evalError, "eval_execution_failed");
						})
						.finally(resolveTask);
				});
				rpcTaskTracker(task);
				return success(id, "eval_execute", { operationId: operation.operationId, accepted: true });
			}

			case "get_eval_history": {
				const limit = command.limit ?? 50;
				const entries = [...session.messages, ...session.getPendingEvalMessages()]
					.filter((message): message is PythonExecutionMessage => message.role === "pythonExecution")
					.slice(-limit)
					.map(
						(message): RpcEvalHistoryEntry => ({
							language: message.language ?? "py",
							code: message.code.slice(0, 262_144),
							output: message.output.length > 262_144 ? message.output.slice(-262_144) : message.output,
							exitCode: message.exitCode,
							cancelled: message.cancelled,
							truncated: message.truncated || message.output.length > 262_144,
							timestamp: message.timestamp,
							excludeFromContext: message.excludeFromContext,
						}),
					);
				return success(id, "get_eval_history", { entries });
			}

			case "new_session":
			case "switch_session":
			case "branch": {
				try {
					const result = await handleRpcSessionChange(
						session,
						command,
						subagentRegistry,
						prepareSessionTransition,
					);
					return completeSessionTransition(id, result.type, result.data);
				} catch (cause) {
					if (cause instanceof RpcSessionTransitionBusyError) {
						return error(id, command.type, cause.message, "session_busy");
					}
					throw cause;
				}
			}

			case "set_mode": {
				if (command.mode !== "plan" && (command.planFilePath !== undefined || command.workflow !== undefined)) {
					return error(
						id,
						"set_mode",
						"planFilePath and workflow are valid only for plan mode.",
						"invalid_request",
					);
				}
				if (command.mode !== "none" && !session.settings.get("plan.enabled")) {
					return error(id, "set_mode", "Plan mode is disabled.", "plan_disabled");
				}
				if (session.isStreaming && command.when !== "next_idle") {
					return error(id, "set_mode", "Session is busy.", "busy");
				}
				if (command.mode === "plan" && (session.getGoalModeState() || session.getVibeModeState())) {
					return error(id, "set_mode", "Another exclusive mode is active.", "mode_conflict");
				}
				if (command.mode === "plan" && session.planMode.active) {
					const current = session.getPlanModeState();
					if (
						(command.planFilePath !== undefined && current?.planFilePath !== command.planFilePath) ||
						(command.workflow !== undefined && current?.workflow !== command.workflow)
					) {
						return error(
							id,
							"set_mode",
							"Plan mode is already active with a different plan file or workflow.",
							"mode_conflict",
						);
					}
				}
				if (operationManager.hasActiveCommand("set_mode")) {
					return error(id, "set_mode", "Another mode change is already pending.", "busy");
				}
				const operation = operationManager.start(id, "set_mode");
				const apply = async () => {
					if (command.mode === "none") await session.planMode.disable();
					else if (command.mode === "plan_paused") {
						if (!session.planMode.active && !session.planMode.paused) {
							await session.planMode.enter({
								planFilePath: "local://PLAN.md",
								workflow: "parallel",
							});
						}
						if (session.planMode.active) await session.planMode.pause();
					} else {
						await session.planMode.enter({
							planFilePath: command.planFilePath ?? "local://PLAN.md",
							workflow: command.workflow ?? "parallel",
						});
					}
				};
				const deferred = session.isStreaming && command.when === "next_idle";
				const task = new Promise<void>(resolve => {
					setImmediate(() => {
						void (async () => {
							try {
								if (deferred) await session.waitForIdle();
								if (!operationManager.begin(operation)) return;
								await apply();
								operationManager.complete(operation, false);
							} catch (cause) {
								operationManager.fail(operation, cause instanceof Error ? cause : new Error(String(cause)));
							}
						})().finally(resolve);
					});
				});
				rpcTaskTracker(task);
				return success(id, "set_mode", {
					operationId: operation.operationId,
					accepted: true,
					deferred,
				});
			}

			case "get_plan":
				return success(
					id,
					"get_plan",
					await session.planMode.project({ includeContent: true, includeAvailableFiles: true }),
				);

			case "resolve_plan_approval": {
				const pending = session.planMode.pendingApproval;
				if (!pending || pending.approvalId !== command.approvalId) {
					return error(id, "resolve_plan_approval", "Unknown plan approval.", "unknown_approval");
				}
				if (operationManager.hasActiveCommand("resolve_plan_approval")) {
					return error(id, "resolve_plan_approval", "The plan approval is already being resolved.", "busy");
				}
				const operation = operationManager.start(id, "resolve_plan_approval");
				planApprovalOperations.set(operation.operationId, command.approvalId);
				const task = new Promise<void>(resolve => {
					setImmediate(() => {
						if (!operationManager.begin(operation)) {
							planApprovalOperations.delete(operation.operationId);
							resolve();
							return;
						}
						void session.planMode
							.resolveApproval(
								command.approvalId,
								command.decision === "approve"
									? {
											kind: "approve",
											preserveContext: command.preserveContext === true,
											compactBeforeExecute: command.compactBeforeExecute === true,
											executionModelRole: command.executionModelRole,
											editedContent: command.editedContent,
										}
									: { kind: command.decision, feedback: command.feedback },
							)
							.then(result => operationManager.complete(operation, result.executionDispatched))
							.catch(cause =>
								operationManager.fail(operation, cause instanceof Error ? cause : new Error(String(cause))),
							)
							.finally(() => {
								planApprovalOperations.delete(operation.operationId);
								resolve();
							});
					});
				});
				rpcTaskTracker(task);
				return success(id, "resolve_plan_approval", { operationId: operation.operationId, accepted: true });
			}

			// =================================================================
			// State
			// =================================================================
			case "get_operations": {
				return success(id, "get_operations", operationManager.snapshot());
			}
			case "get_tool_inventory": {
				try {
					const response = success(
						id,
						"get_tool_inventory",
						session.getToolInventory(RPC_APPLICATION_API_VERSION),
					);
					if (Buffer.byteLength(`${JSON.stringify(response)}\n`, "utf8") > MAX_RPC_FRAME_BYTES) {
						return error(
							id,
							"get_tool_inventory",
							"Authoritative tool inventory does not fit the protocol frame",
							"tool_inventory_unavailable",
						);
					}
					return response;
				} catch (cause) {
					if (cause instanceof ToolInventoryUnavailableError) {
						return error(id, "get_tool_inventory", cause.message, "tool_inventory_unavailable");
					}
					throw cause;
				}
			}
			case "set_tool_activation": {
				toolActivationInFlight = true;
				try {
					return success(
						id,
						"set_tool_activation",
						await applyRpcToolActivation(session, command, operationManager.snapshot().active.length > 0),
					);
				} catch (cause) {
					if (cause instanceof RpcToolActivationValidationError) {
						return error(id, "set_tool_activation", cause.message, "invalid_request");
					}
					if (cause instanceof RpcToolActivationBusyError) {
						return error(id, "set_tool_activation", cause.message, "session_busy");
					}
					throw cause;
				} finally {
					toolActivationInFlight = false;
				}
			}

			case "get_state": {
				const state: RpcSessionState = {
					mode: session.planMode.mode,
					plan: await session.planMode.project(),
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					activityPhase: session.activityPhase,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					interruptMode: session.interruptMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					queuedMessageCount: session.queuedMessageCount,
					todoPhases: session.getTodoPhases(),
					fastModeEnabled: session.isFastModeEnabled(),
					tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
					fastModeActive: session.isFastModeActive(),
					messageCount: session.messages.length,
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: toolWireSchema(tool),
						examples: tool.examples,
					})),
					contextUsage: session.getContextUsage(),
					advisor: getAdvisorState(),
				};
				return success(id, "get_state", state);
			}

			case "get_advisor_state":
				return success(id, "get_advisor_state", getAdvisorState());

			case "set_advisor_enabled": {
				session.setAdvisorEnabled(command.enabled);
				const advisor = getAdvisorState();
				emitConfigUpdate();
				return success(id, "set_advisor_enabled", advisor);
			}

			case "set_fast_mode": {
				const supported = session.setFastMode(command.enabled);
				if (command.enabled && !supported) {
					return error(id, "set_fast_mode", "Fast mode is unavailable for the current model.");
				}
				return success(id, "set_fast_mode", {
					enabled: session.isFastModeEnabled(),
					active: session.isFastModeActive(),
				});
			}

			case "get_available_commands": {
				return success(id, "get_available_commands", { commands: await getAvailableCommands() });
			}

			case "set_todos": {
				session.setTodoPhases(command.phases);
				return success(id, "set_todos", { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const rpcTools = hostToolBridge.setTools(tools);
				await session.refreshRpcHostTools(rpcTools);
				return success(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
			}

			case "set_host_uri_schemes": {
				try {
					const schemes = hostUriBridge.setSchemes(command.schemes);
					return success(id, "set_host_uri_schemes", { schemes });
				} catch (err) {
					return error(id, "set_host_uri_schemes", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_subagent_subscription": {
				if (!subagentRegistry) {
					return error(id, "set_subagent_subscription", "Subagent event bus is unavailable");
				}
				if (!isSubagentSubscriptionLevel(command.level)) {
					return error(
						id,
						"set_subagent_subscription",
						`Invalid subagent subscription level: ${String(command.level)}`,
					);
				}
				subagentRegistry.setSubscriptionLevel(command.level);
				return success(id, "set_subagent_subscription", { level: subagentRegistry.getSubscriptionLevel() });
			}

			case "get_subagents": {
				if (!subagentRegistry) {
					return error(id, "get_subagents", "Subagent event bus is unavailable");
				}
				return success(id, "get_subagents", { subagents: subagentRegistry.getSubagents() });
			}

			case "get_subagent_messages": {
				if (!subagentRegistry) {
					return error(id, "get_subagent_messages", "Subagent event bus is unavailable");
				}
				try {
					if (command.fromByte !== undefined && !Number.isFinite(command.fromByte)) {
						return error(id, "get_subagent_messages", "fromByte must be a finite number");
					}
					const sessionFile = subagentRegistry.resolveSessionFile(command);
					const transcript = await readRpcSubagentTranscript(sessionFile, command.fromByte);
					return success(id, "get_subagent_messages", transcript);
				} catch (err) {
					return error(id, "get_subagent_messages", err instanceof Error ? err.message : String(err));
				}
			}
			case "get_queue":
				return success(id, "get_queue", session.getQueueSnapshot());

			case "remove_queued_message": {
				try {
					const result = session.queueService.remove(command.entryId);
					emitQueueUpdate();
					return success(id, "remove_queued_message", { removed: result.removed, queue: result.snapshot });
				} catch (cause) {
					if (cause instanceof SessionQueueEntryNotFoundError) {
						return error(id, "remove_queued_message", cause.message, "stale_queue_entry");
					}
					throw cause;
				}
			}

			case "reorder_queued_message": {
				try {
					const queue = session.queueService.reorder(command.entryId, command.toIndex);
					emitQueueUpdate();
					return success(id, "reorder_queued_message", queue);
				} catch (cause) {
					if (cause instanceof SessionQueueEntryNotFoundError) {
						return error(id, "reorder_queued_message", cause.message, "stale_queue_entry");
					}
					if (cause instanceof SessionQueueInvalidPositionError) {
						return error(id, "reorder_queued_message", cause.message, "invalid_queue_position");
					}
					throw cause;
				}
			}

			case "clear_queue": {
				const result = session.clearQueue({ lane: command.lane });
				emitQueueUpdate();
				return success(id, "clear_queue", result);
			}

			case "list_jobs": {
				if (!jobProjection) return error(id, "list_jobs", "Background job manager is unavailable", "unavailable");
				return success(id, "list_jobs", jobProjection.list());
			}

			case "get_job": {
				if (!jobProjection) return error(id, "get_job", "Background job manager is unavailable", "unavailable");
				return success(id, "get_job", { job: jobProjection.get(command.jobId) ?? null });
			}

			case "cancel_job": {
				if (!jobProjection) return error(id, "cancel_job", "Background job manager is unavailable", "unavailable");
				const resolvedTargets = jobProjection.resolveCancellationTargets(command.jobIds);
				let confirmed = false;
				try {
					confirmed = await requestRpcPrivilegedConfirmation(
						pendingExtensionRequests,
						output,
						"cancel_job",
						"Cancel background jobs?",
						`Cancel ${command.jobIds.length} background job${command.jobIds.length === 1 ? "" : "s"}: ${command.jobIds.join(", ")}`,
						{ timeout: 15_000 },
					);
				} catch {
					return error(id, "cancel_job", "Cancellation confirmation was not completed", "confirmation_required");
				}
				if (!confirmed) {
					return error(id, "cancel_job", "Cancellation was not confirmed", "confirmation_required");
				}
				const outcomes = await jobProjection.cancelResolved(resolvedTargets);
				emitJobUpdate();
				return success(id, "cancel_job", { outcomes });
			}

			case "list_agents":
				return success(id, "list_agents", {
					agents: agentControl.list({ includeAdvisors: command.includeAdvisors }),
				});

			case "get_agent":
				try {
					return success(id, "get_agent", { agent: agentControl.get(command.agentId) });
				} catch (cause) {
					return error(id, "get_agent", cause instanceof Error ? cause.message : String(cause), "not_found");
				}

			case "get_agent_result":
				try {
					return success(id, "get_agent_result", agentControl.getResult(command.agentId));
				} catch (cause) {
					return error(
						id,
						"get_agent_result",
						cause instanceof Error ? cause.message : String(cause),
						"not_found",
					);
				}

			case "send_agent_message":
			case "park_agent":
			case "resume_agent":
				try {
					if (command.type === "send_agent_message") {
						return success(
							id,
							command.type,
							await agentControl.send(command.agentId, command.message, command.replyTo),
						);
					}
					const agent =
						command.type === "park_agent"
							? await agentControl.park(command.agentId)
							: await agentControl.resume(command.agentId);
					return success(id, command.type, { agent });
				} catch (cause) {
					return error(
						id,
						command.type,
						cause instanceof Error ? cause.message : String(cause),
						"agent_control_failed",
					);
				}

			case "cancel_agent":
			case "release_agent":
				try {
					const expected = agentControl.captureMutationTarget(command.agentId);
					const tombstone = command.type === "release_agent" && command.tombstone === true;
					if (!(await confirmAgentMutation(command.type, command.agentId, tombstone))) {
						return error(id, command.type, "Agent mutation was not confirmed.", "confirmation_required");
					}
					return command.type === "cancel_agent"
						? success(id, command.type, await agentControl.cancel(command.agentId, expected))
						: success(id, command.type, await agentControl.release(command.agentId, { tombstone }, expected));
				} catch (cause) {
					return error(
						id,
						command.type,
						cause instanceof Error ? cause.message : String(cause),
						"agent_control_failed",
					);
				}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				let models = session.getAvailableModels();
				let model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					// Model not in the current catalog. Wait for in-flight
					// background discovery before declaring it missing: on cold
					// start, discovery-backed providers (proxy / ollama / etc.)
					// populate seconds after session ready. Models already in
					// the bundled catalog skip this await entirely so the RPC
					// queue is not stalled behind unrelated discovery.
					await session.modelRegistry.awaitBackgroundRefresh();
					models = session.getAvailableModels();
					model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				}
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				await session.modelRegistry.awaitBackgroundRefresh();
				const models = session.getAvailableModels();
				return success(id, "get_available_models", { models });
			}

			case "get_settings":
				return handleGetSettings(session.settings, id, command.tab);

			case "set_settings":
				return handleSetSettings(session.settings, id, command.changes);

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				session.setInterruptMode(command.mode);
				return success(id, "set_interrupt_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================
			case "bash": {
				if (sessionTransitionInFlight) {
					return error(
						id,
						"bash",
						"Shell command execution is unavailable while a session transition is in progress",
						"session_busy",
					);
				}
				const operationGeneration = sessionGeneration;
				const confirmationController = new AbortController();
				pendingRpcBashConfirmations.add(confirmationController);
				let confirmed = false;
				try {
					confirmed = await requestRpcPrivilegedConfirmation(
						pendingExtensionRequests,
						output,
						"bash",
						"Run shell command?",
						command.command,
						{ signal: confirmationController.signal },
					);
				} catch {
					return error(id, "bash", "Shell command confirmation was not completed", "confirmation_required");
				} finally {
					pendingRpcBashConfirmations.delete(confirmationController);
				}
				if (!confirmed) {
					return error(id, "bash", "Shell command execution was not confirmed", "confirmation_required");
				}
				if (sessionTransitionInFlight || operationGeneration !== sessionGeneration) {
					return error(id, "bash", "Session changed before shell command execution", "session_changed");
				}
				const execution = session.executeBash(command.command);
				rpcBashExecutions.add(execution);
				try {
					return success(id, "bash", await execution);
				} finally {
					rpcBashExecutions.delete(execution);
				}
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "list_sessions": {
				try {
					await session.sessionManager.flush();
					return success(
						id,
						"list_sessions",
						await listSessionCatalog(
							{
								scope: command.scope ?? "cwd",
								cwd: command.cwd ?? session.sessionManager.getCwd(),
								cursor: command.cursor,
								limit: command.limit,
								search: command.search,
							},
							sessionStorage,
						),
					);
				} catch (cause) {
					return catalogError(id, "list_sessions", cause);
				}
			}

			case "get_session_info": {
				try {
					await session.sessionManager.flush();
					const resolved = await resolveSessionCatalogReference(
						command.session,
						{ scope: command.scope ?? (command.cwd ? "cwd" : "all"), cwd: command.cwd },
						sessionStorage,
					);
					const activePath = session.sessionManager.getSessionFile();
					const active = activePath !== undefined && path.resolve(activePath) === resolved.entry.path;
					const workspace = active
						? {
								cwd: session.sessionManager.getCwd(),
								directories: [
									session.sessionManager.getCwd(),
									...session.sessionManager.getAdditionalDirectories(),
								],
							}
						: await inspectPersistedSessionWorkspace(resolved.entry.path, resolved.entry.cwd, sessionStorage);
					const data: RpcSessionInfoResult = { session: resolved.entry, workspace, active };
					return success(id, "get_session_info", data);
				} catch (cause) {
					return catalogError(id, "get_session_info", cause);
				}
			}

			case "list_workspace_roots": {
				try {
					await session.sessionManager.flush();
					return success(id, "list_workspace_roots", { roots: await listSessionWorkspaceRoots(sessionStorage) });
				} catch (cause) {
					return catalogError(id, "list_workspace_roots", cause);
				}
			}

			case "fork_session": {
				if (session.isStreaming || session.isCompacting)
					return error(
						id,
						"fork_session",
						"Session mutation is unavailable while the session is busy",
						"session_busy",
					);
				if (!session.sessionManager.getSessionFile())
					return error(id, "fork_session", "The active session has not been persisted", "session_not_persisted");
				try {
					const forked = await session.fork(prepareSessionTransition);
					const data: RpcForkSessionResult = {
						cancelled: !forked,
						...(forked && session.sessionManager.getSessionFile()
							? { sessionFile: session.sessionManager.getSessionFile() }
							: {}),
					};
					if (forked) subagentRegistry?.clear();
					return completeSessionTransition(id, "fork_session", data);
				} catch (cause) {
					return catalogError(id, "fork_session", cause);
				}
			}

			case "rename_session": {
				if (session.isStreaming || session.isCompacting)
					return error(
						id,
						"rename_session",
						"Session mutation is unavailable while the session is busy",
						"session_busy",
					);
				const name = command.name
					.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
					.replace(/ +/g, " ")
					.trim();
				if (!name) return error(id, "rename_session", "Session name cannot be empty");
				try {
					const resolved = await resolveSessionCatalogReference(
						command.session,
						{ scope: command.scope ?? (command.cwd ? "cwd" : "all"), cwd: command.cwd },
						sessionStorage,
					);
					const activePath = session.sessionManager.getSessionFile();
					const active = activePath !== undefined && path.resolve(activePath) === resolved.entry.path;
					if (active) {
						const renamed = await session.setSessionName(name, "user");
						const data: RpcRenameSessionResult = { renamed, active: true };
						return success(id, "rename_session", data);
					}
					await sessionStorage.updateSessionTitle(resolved.entry.path, {
						title: name,
						source: "user",
						updatedAt: new Date().toISOString(),
					});
					const data: RpcRenameSessionResult = { renamed: true, active: false };
					return success(id, "rename_session", data);
				} catch (cause) {
					return catalogError(id, "rename_session", cause);
				}
			}

			case "delete_session": {
				if (session.isStreaming || session.isCompacting)
					return error(
						id,
						"delete_session",
						"Session mutation is unavailable while the session is busy",
						"session_busy",
					);
				try {
					const resolved = await resolveSessionCatalogReference(
						command.session,
						{ scope: command.scope ?? (command.cwd ? "cwd" : "all"), cwd: command.cwd },
						sessionStorage,
					);
					const confirmed = await requestRpcPrivilegedConfirmation(
						pendingExtensionRequests,
						output,
						"delete_session",
						"Delete session?",
						`Permanently delete session "${resolved.entry.title ?? resolved.entry.id}" and its artifacts?`,
					);
					if (!confirmed) {
						return error(id, "delete_session", "Session deletion was not confirmed", "confirmation_required");
					}
					const activePath = session.sessionManager.getSessionFile();
					const wasActive = activePath !== undefined && path.resolve(activePath) === resolved.entry.path;
					if (wasActive) {
						const started = await session.newSession(undefined, prepareSessionTransition);
						if (!started) {
							const cancelled: RpcDeleteSessionResult = {
								deleted: false,
								cancelled: true,
								wasActive: true,
								newSessionStarted: false,
							};
							return success(id, "delete_session", cancelled);
						}
						subagentRegistry?.clear();
						try {
							await session.sessionManager.dropSession(resolved.entry.path);
						} catch (cause) {
							const failed: RpcDeleteSessionResult = {
								deleted: false,
								cancelled: false,
								wasActive: true,
								newSessionStarted: true,
								deleteError: {
									code: "delete_failed",
									message: cause instanceof Error ? cause.message : String(cause),
								},
							};
							return completeSessionTransition(id, "delete_session", failed);
						}
						const deleted: RpcDeleteSessionResult = {
							deleted: true,
							cancelled: false,
							wasActive: true,
							newSessionStarted: true,
						};
						return completeSessionTransition(id, "delete_session", deleted);
					}
					try {
						await sessionStorage.deleteSessionWithArtifacts(resolved.entry.path);
					} catch (cause) {
						if (!isEnoent(cause))
							return error(
								id,
								"delete_session",
								cause instanceof Error ? cause.message : String(cause),
								"delete_failed",
							);
					}
					const deleted: RpcDeleteSessionResult = {
						deleted: true,
						cancelled: false,
						wasActive: false,
						newSessionStarted: false,
					};
					return success(id, "delete_session", deleted);
				} catch (cause) {
					return catalogError(id, "delete_session", cause);
				}
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return success(id, "get_branch_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				return success(id, "set_session_name");
			}

			case "handoff": {
				// Resetting the agent mid-stream lets the live turn keep emitting into a
				// session that handoff has already torn down. Refuse while a prompt is in
				// flight (mirrors the TUI /handoff guard).
				if (session.isStreaming) {
					return error(id, "handoff", "Cannot hand off while a response is in progress");
				}
				const result = await session.handoff(command.customInstructions);
				return success(id, "handoff", result ? { savedPath: result.savedPath } : null);
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			case "get_messages_page": {
				if (session.isStreaming || session.isCompacting)
					return error(id, "get_messages_page", RPC_MESSAGES_PAGE_BUSY_ERROR, "session_busy");
				const messages = session.messages;
				try {
					return success(
						id,
						"get_messages_page",
						pageRpcMessages(
							messages,
							{
								sessionId: session.sessionId,
								leafId: session.sessionManager.getLeafId(),
								messageCount: messages.length,
							},
							{ cursor: command.cursor, limit: command.limit },
						),
					);
				} catch (pageError) {
					return error(
						id,
						"get_messages_page",
						pageError instanceof Error ? pageError.message : String(pageError),
						pageError instanceof RpcMessagesPageError ? pageError.code : undefined,
					);
				}
			}

			// =================================================================
			// Provider authentication
			// =================================================================

			case "list_provider_auth": {
				return success(id, "list_provider_auth", { providers: providerAuthService.list() });
			}

			case "begin_provider_auth": {
				try {
					const handle = providerAuthController.begin(id, command.providerId, command.method);
					return success(id, "begin_provider_auth", { operationId: handle.operationId, accepted: true });
				} catch (authError) {
					const known = authError instanceof ProviderAuthError ? authError : undefined;
					return error(
						id,
						"begin_provider_auth",
						known?.message ?? "Provider authentication could not be started",
						known?.code ?? "provider_auth_failed",
					);
				}
			}

			case "cancel_provider_auth": {
				const providerCancellation = providerAuthController.cancel(command.operationId);
				if (providerCancellation === "not_found") {
					return error(
						id,
						"cancel_provider_auth",
						"Provider authentication operation was not found",
						"provider_auth_operation_not_found",
					);
				}
				if (providerCancellation === "protected") {
					return error(
						id,
						"cancel_provider_auth",
						"Provider authentication credentials are already being committed",
						"provider_auth_commit_in_progress",
					);
				}
				return success(id, "cancel_provider_auth", operationManager.cancel(command.operationId).result);
			}

			case "remove_provider_auth": {
				let releaseReservation: () => void;
				try {
					releaseReservation = providerAuthController.reserveMutation();
				} catch (authError) {
					const known = authError instanceof ProviderAuthError ? authError : undefined;
					return error(
						id,
						"remove_provider_auth",
						known?.message ?? "Provider authentication could not be removed",
						known?.code ?? "provider_auth_remove_failed",
					);
				}
				try {
					const target = providerAuthService.credentialTarget(command.providerId);
					let confirmed = false;
					try {
						confirmed = await requestRpcPrivilegedConfirmation(
							pendingExtensionRequests,
							output,
							"remove_provider_auth",
							"Remove provider authentication?",
							`Remove credentials stored as "${target.storageProvider}" for providers: ${target.affectedProviderIds.join(", ")}?`,
						);
					} catch {
						return error(
							id,
							"remove_provider_auth",
							"Credential removal confirmation was not completed",
							"confirmation_required",
						);
					}
					if (!confirmed) {
						return error(
							id,
							"remove_provider_auth",
							"Credential removal was not confirmed",
							"confirmation_required",
						);
					}
					const result = await providerAuthService.remove(command.providerId);
					for (const state of result.states) {
						output({ type: "provider_auth_update", state } satisfies ProviderAuthUpdate);
					}
					return success(id, "remove_provider_auth", { state: result.state });
				} catch (authError) {
					const known = authError instanceof ProviderAuthError ? authError : undefined;
					return error(
						id,
						"remove_provider_auth",
						known?.message ?? "Provider authentication could not be removed",
						known?.code ?? "provider_auth_remove_failed",
					);
				} finally {
					releaseReservation();
				}
			}

			default: {
				const exhaustiveCommand: never = command;
				return exhaustiveCommand;
			}
		}
	};

	// Deferred shutdown (pi.shutdown() from an extension) must not kill the
	// process while a background-dispatched command still owes the client its
	// response frame. The coordinator drains tracked tasks before exiting and
	// re-checks the request as each task settles.
	const shutdownCoordinator = new RpcShutdownCoordinator({
		isShutdownRequested: () => shutdownState.requested,
		performShutdown: async () => {
			// Route through the idempotent session.dispose() so the browser
			// reaper (releaseTabsForOwner) and other bounded teardown run before
			// the process exits. dispose() also emits `session_shutdown`, so we
			// must NOT emit it separately here or the event fires twice. Skipping
			// dispose left OMP-owned Chromium alive after RPC shutdown (#5643).
			await session.dispose();
			process.exit(0);
		},
	});
	rpcTaskTracker = task => shutdownCoordinator.track(task);

	const dispatchFrameDeps: RpcInputFrameDeps = {
		handleCommand,
		output,
		errorResponse: error,
		trackBackgroundTask: task => shutdownCoordinator.track(task),
		pendingExtensionRequests,
		onHostToolResult: frame => hostToolBridge.handleResult(frame),
		onHostToolUpdate: frame => hostToolBridge.handleUpdate(frame),
		onHostUriResult: frame => hostUriBridge.handleResult(frame),
	};

	const inputDispatcher = new RpcInputDispatcher({
		deps: dispatchFrameDeps,
		afterSerialCommand: async () => {
			sessionTransitionInFlight = false;
			shutdownCoordinator.checkShutdownRequested();
		},
	});

	// Keep the stdin reader moving: side-channel frames dispatch immediately,
	// ordinary commands serialize through inputDispatcher, while concurrent
	// and control commands can overtake them. Frames are read line-by-line by
	// readRpcInputFrames so a single malformed line is reported as an error frame
	// and the loop keeps running instead of killing the process (issue #5194).
	await readRpcInputFrames(
		input ?? Bun.stdin.stream(),
		parsed => inputDispatcher.dispatch(parsed),
		message => output(error(undefined, "parse", message)),
	);

	// stdin closed — stop accepting side-channel work, drain every command that
	// already owes a response, then settle any operation still running.
	const protectedOperations = new Set(providerAuthController.close());
	pendingExtensionRequests.rejectAll("RPC client disconnected before extension UI response completed");
	session.abortBash();
	await inputDispatcher.drain();
	for (const operationId of protectedCommitOperationIds()) protectedOperations.add(operationId);
	const rpcEvalsToAbort = Array.from(rpcEvalOperationIds);
	operationManager.cancelAll("client_disconnected", "client_disconnected", protectedOperations);
	for (const operationId of rpcEvalsToAbort) session.abortEvalExecution(operationId);
	hostToolBridge.close("RPC client disconnected before host tool execution completed");
	hostUriBridge.clear("RPC client disconnected before host URI request completed");
	await shutdownCoordinator.drain();
	await session.planMode.abandonPendingApproval();
	unsubscribeAgentRegistry();
	unsubscribeJobUpdates?.();
	subagentRegistry?.dispose();
	// Jobs are process-scoped rather than transport-scoped: keep the host alive
	// until this owner's accepted jobs settle, then tear down without cancelling
	// or evicting their retained outcomes.
	if (session.asyncJobManager && rpcJobOwnerId) {
		await session.asyncJobManager.waitForOwnerJobs(rpcJobOwnerId);
	}
	await session.dispose({ preserveAsyncJobs: true });
	process.exit(0);
}
