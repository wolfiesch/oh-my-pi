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
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { $env, isEnoent, isRecord, Snowflake } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
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
import type { AgentSession } from "../../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import {
	inspectPersistedSessionWorkspace,
	listSessionCatalog,
	listSessionWorkspaceRoots,
	resolveSessionCatalogReference,
	SessionCatalogError,
} from "../../session/session-catalog";
import { FileSessionStorage } from "../../session/session-storage";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import type { EventBus } from "../../utils/event-bus";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import { initializeExtensions } from "../runtime-init";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import { getRpcCapabilityManifest, validateRpcCommand } from "./rpc-command-registry";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "./rpc-frame";
import { claimRpcInput, readRpcInputFrames } from "./rpc-input";
import { pageRpcMessages, RPC_MESSAGES_PAGE_BUSY_ERROR, RpcMessagesPageError } from "./rpc-messages";
import { type RpcOperationHandle, RpcOperationManager } from "./rpc-operations";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "./rpc-subagents";
import type {
	RpcCancelOperationResult,
	RpcCommand,
	RpcDeleteSessionResult,
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
				deps.output(await deps.handleCommand(command));
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				deps.output(deps.errorResponse(command.id, command.type, message));
			}
		})();
		deps.trackBackgroundTask?.(task);
		return undefined;
	}

	return (async () => {
		deps.output(await deps.handleCommand(command));
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
): Promise<RpcSessionChangeResult> {
	switch (command.type) {
		case "new_session": {
			const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const cancelled = !(await session.newSession(options));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "new_session", data: { cancelled } };
		}

		case "switch_session": {
			const cancelled = !(await session.switchSession(command.sessionPath));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "switch_session", data: { cancelled } };
		}

		case "branch": {
			const result = await session.branch(command.entryId);
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

/** Requests host confirmation for a privileged RPC command, bound to a server-issued operation id. */
export function requestRpcPrivilegedConfirmation(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	command: "delete_session",
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
			: error(id, command, cause instanceof Error ? cause.message : String(cause));
	const operationOwnership = new RpcOperationMessageOwnership(session);
	const operationManager = new RpcOperationManager(frame => {
		if (frame.type === "operation_completed") operationOwnership.settle(frame.operationId);
		output(frame);
	});

	const extensionUserMessageTracker = new RpcExtensionUserMessageTracker();

	const pendingExtensionRequests = new RpcPendingExtensionRequests();
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	const subagentRegistry = eventBus ? new RpcSubagentRegistry(eventBus, output) : undefined;
	const sessionStorage = new FileSessionStorage();

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
	session.subscribe(event => {
		if (event.type === "message_start") operationOwnership.observeMessageStart(event.message);
		output(event);
	});

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
	await emitAvailableCommandsUpdate();

	const completeSessionTransition = async (
		id: string | undefined,
		command: RpcCommand["type"],
		data: { cancelled: boolean } & object,
	): Promise<RpcResponse> => {
		if (!data.cancelled) {
			operationManager.cancelAll("session_transition", "session_changed");
			await emitAvailableCommandsUpdate();
		}
		return success(id, command, data);
	};

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
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				operationManager.cancelAll("user", "cancelled_by_client");
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return success(id, "abort");
			}

			case "abort_and_prompt": {
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

			case "new_session":
			case "switch_session":
			case "branch": {
				const result = await handleRpcSessionChange(session, command, subagentRegistry);
				return completeSessionTransition(id, result.type, result.data);
			}

			// =================================================================
			// State
			// =================================================================
			case "get_operations": {
				return success(id, "get_operations", operationManager.snapshot());
			}

			case "get_state": {
				const state: RpcSessionState = {
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
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
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
					const forked = await session.fork();
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
						const started = await session.newSession();
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
			// Login
			// =================================================================

			case "get_login_providers": {
				const providers = getOAuthProviders().map(provider => ({
					id: provider.id,
					name: provider.name,
					available: provider.available,
					authenticated: session.modelRegistry.authStorage.hasAuth(provider.id),
				}));
				return success(id, "get_login_providers", { providers });
			}

			case "login": {
				const knownProvider = getOAuthProviders().find(p => p.id === command.providerId);
				if (!knownProvider) {
					return error(id, "login", `Unknown OAuth provider: ${command.providerId}`);
				}
				const uiCtx = new RpcExtensionUIContext(pendingExtensionRequests, output);
				// Track whether onAuth has fired. Providers that require interactive
				// input before a browser URL cannot be satisfied headlessly; after
				// onAuth, prompt input is the pasted OAuth code/redirect URL path.
				let authEmitted = false;
				try {
					await session.modelRegistry.authStorage.login(command.providerId, {
						onAuth: info => {
							authEmitted = true;
							output({
								type: "extension_ui_request",
								id: Snowflake.next() as string,
								method: "open_url",
								url: info.url,
								launchUrl: info.launchUrl,
								instructions: info.instructions,
							} as RpcExtensionUIRequest);
						},
						onProgress: message => {
							uiCtx.notify(message, "info");
						},
						onPrompt: async prompt => {
							if (!authEmitted) {
								// onPrompt called before any auth URL — provider requires
								// interactive input that cannot be satisfied headlessly.
								return Promise.reject(
									new Error(
										`Provider '${command.providerId}' requires interactive prompts ` +
											"which are not supported in RPC mode. Use the terminal UI to log in.",
									),
								);
							}
							return (await uiCtx.input(prompt.message, prompt.placeholder, { timeout: 600_000 })) ?? "";
						},
					});
					// Provider-scoped online refresh so the just-persisted credential
					// re-runs discovery instead of reusing a fresh authoritative cache
					// row (#5780).
					await session.modelRegistry.refreshProvider(command.providerId, "online");
					return success(id, "login", { providerId: command.providerId });
				} catch (err: unknown) {
					return error(id, "login", err instanceof Error ? err.message : String(err));
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
		afterSerialCommand: () => shutdownCoordinator.checkShutdownRequested(),
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
	pendingExtensionRequests.rejectAll("RPC client disconnected before extension UI response completed");
	hostToolBridge.close("RPC client disconnected before host tool execution completed");
	hostUriBridge.clear("RPC client disconnected before host URI request completed");
	await inputDispatcher.drain();
	await shutdownCoordinator.drain();
	operationManager.cancelAll("client_disconnected", "client_disconnected");
	subagentRegistry?.dispose();
	// Dispose the main session before exiting so the browser reaper and other
	// bounded teardown run on the stdin-EOF path too (#5643). Idempotent: a
	// prior pi.shutdown() through the coordinator makes this await settle
	// immediately.
	await session.dispose();
	process.exit(0);
}
