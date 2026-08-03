import type { Agent } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { disposeJuliaKernelSessionsByOwner } from "../eval/jl/executor";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { namespaceSessionId as namespacePythonSessionId } from "../eval/py";
import {
	disposeKernelSessionsByOwner,
	executePython as executePythonCommand,
	type PythonResult,
} from "../eval/py/executor";
import { disposeRubyKernelSessionsByOwner } from "../eval/rb/executor";
import { defaultEvalSessionId } from "../eval/session-id";
import type { ExtensionRunner } from "../extensibility/extensions";
import { outputMeta } from "../tools/output-meta";
import type { PythonExecutionMessage } from "./messages";
import type { SessionManager } from "./session-manager";

/** Capabilities the eval runner borrows from its owning session. */
export interface EvalRunnerHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	extensionRunner(): ExtensionRunner | undefined;
	isStreaming(): boolean;
	appendSessionMessage(message: PythonExecutionMessage): void;
}

/** Owns user-initiated Python execution and retained eval-kernel lifecycle. */
export class EvalRunner {
	readonly #host: EvalRunnerHost;
	readonly #kernelOwnerId: string;
	readonly #parentSessionId: string | undefined;
	#executions = new Map<string, { controller: AbortController; execution: Promise<unknown> }>();
	#nextExecutionId = 0;
	#pendingMessages: PythonExecutionMessage[] = [];
	#disposing = false;

	constructor(host: EvalRunnerHost, options: { kernelOwnerId: string; parentSessionId: string | undefined }) {
		this.#host = host;
		this.#kernelOwnerId = options.kernelOwnerId;
		this.#parentSessionId = options.parentSessionId;
	}

	/** Executes Python in the session's shared kernel. */
	async executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<PythonResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.#host.sessionManager.getCwd();
		this.assertExecutionAllowed();
		const abortController = new AbortController();
		const executionId = this.#allocateExecutionId();
		const execution = (async (): Promise<PythonResult> => {
			const extensionRunner = this.#host.extensionRunner();
			if (extensionRunner?.hasHandlers("user_python")) {
				const hookResult = await extensionRunner.emitUserPython({
					type: "user_python",
					code,
					excludeFromContext,
					cwd,
				});
				this.assertExecutionAllowed();
				if (hookResult?.result) {
					this.recordPythonResult(code, hookResult.result, options);
					return hookResult.result;
				}
			}
			const sessionId =
				this.getSessionId() ??
				defaultEvalSessionId({
					cwd,
					getSessionFile: () => this.#host.sessionManager.getSessionFile() ?? null,
				});
			const result = await executePythonCommand(code, {
				cwd,
				sessionId: namespacePythonSessionId(sessionId),
				kernelOwnerId: this.#kernelOwnerId,
				kernelMode: this.#host.settings.get("python.kernelMode"),
				interpreter: this.#host.settings.get("python.interpreter")?.trim() || undefined,
				onChunk,
				signal: abortController.signal,
			});
			this.recordPythonResult(code, result, options);
			return result;
		})();
		return await this.trackExecution(execution, abortController, executionId);
	}

	/** Rejects new eval work once session disposal begins. */
	assertExecutionAllowed(): void {
		if (this.#disposing) throw new Error("Python execution is unavailable while session disposal is in progress");
	}

	/** Tracks eval work so callers can cancel one execution without affecting siblings. */
	trackExecution<T>(
		execution: Promise<T>,
		abortController: AbortController,
		executionId = this.#allocateExecutionId(),
	): Promise<T> {
		if (this.#executions.has(executionId)) {
			throw new Error(`Eval execution already exists: ${executionId}`);
		}
		this.#executions.set(executionId, { controller: abortController, execution });
		void execution.then(
			() => {
				this.#deleteExecution(executionId, execution);
			},
			() => {
				this.#deleteExecution(executionId, execution);
			},
		);
		return execution;
	}

	/** Cancels one running eval execution by its server-owned execution ID. */
	abortExecution(executionId: string): boolean {
		const active = this.#executions.get(executionId);
		if (!active) return false;
		active.controller.abort();
		return true;
	}

	/** Records a Python execution result in session history. */
	recordPythonResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		this.recordEvalResult({
			language: "py",
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			excludeFromContext: options?.excludeFromContext,
		});
	}

	/** Appends a user-initiated eval to the existing session transcript authority. */
	recordEvalResult(
		result: Omit<PythonExecutionMessage, "role" | "timestamp"> & { timestamp?: number },
	): PythonExecutionMessage {
		const message: PythonExecutionMessage = {
			role: "pythonExecution",
			...result,
			timestamp: result.timestamp ?? Date.now(),
		};
		if (this.#host.isStreaming()) {
			this.#pendingMessages.push(message);
		} else {
			this.#host.appendSessionMessage(message);
		}
		return message;
	}

	/** Cancels every running eval execution. Reserved for session disposal and owner cleanup. */
	abort(): void {
		for (const { controller } of this.#executions.values()) controller.abort();
	}

	/** Whether an eval execution is currently running. */
	get isRunning(): boolean {
		return this.#executions.size > 0;
	}

	/** Whether Python results are waiting for a safe persistence boundary. */
	get hasPendingMessages(): boolean {
		return this.#pendingMessages.length > 0;
	}

	/** Read-only snapshot of completed evals awaiting the next safe transcript boundary. */
	pendingMessages(): readonly PythonExecutionMessage[] {
		return this.#pendingMessages.slice();
	}

	/** Returns the stable owner shared by eval and session-owned tools. */
	getKernelOwnerId(): string {
		return this.#kernelOwnerId;
	}

	/** Returns the eval session shared with the Python backend. */
	getSessionId(): string | null {
		if (this.#parentSessionId !== undefined) return this.#parentSessionId;
		return defaultEvalSessionId({
			cwd: this.#host.sessionManager.getCwd(),
			getSessionFile: () => this.#host.sessionManager.getSessionFile() ?? null,
		});
	}

	/** Flushes deferred Python results into agent state and persistence. */
	flushPending(): void {
		if (this.#pendingMessages.length === 0) return;
		for (const message of this.#pendingMessages) this.#host.appendSessionMessage(message);
		this.#pendingMessages = [];
	}

	/** Prevents new Python executions before asynchronous disposal starts. */
	beginDispose(): void {
		this.#disposing = true;
	}

	/** Waits for active work and disposes every retained eval kernel owned by the session. */
	async disposeKernels(): Promise<void> {
		const settled = await this.#prepareExecutionsForDispose();
		if (!settled) {
			logger.warn("Detaching retained eval-kernel ownership during dispose while eval execution is still active");
		}
		const results = await Promise.allSettled([
			disposeKernelSessionsByOwner(this.#kernelOwnerId),
			disposeRubyKernelSessionsByOwner(this.#kernelOwnerId),
			disposeJuliaKernelSessionsByOwner(this.#kernelOwnerId),
			disposeVmContextsByOwner(this.#kernelOwnerId),
		]);
		const errors: unknown[] = [];
		for (const result of results) if (result.status === "rejected") errors.push(result.reason);
		if (errors.length > 0) throw new AggregateError(errors, "Failed to dispose one or more eval kernels");
	}

	#allocateExecutionId(): string {
		this.#nextExecutionId += 1;
		return `session-eval-${this.#nextExecutionId}`;
	}

	#deleteExecution(executionId: string, execution: Promise<unknown>): void {
		const active = this.#executions.get(executionId);
		if (active?.execution === execution) this.#executions.delete(executionId);
	}

	async #waitForExecutionsToSettle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#executions.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) return false;
			const settled = await Promise.race([
				Promise.allSettled(Array.from(this.#executions.values(), active => active.execution)).then(() => true),
				Bun.sleep(remainingMs).then(() => false),
			]);
			if (!settled && this.#executions.size > 0) return false;
		}
		return true;
	}

	async #prepareExecutionsForDispose(): Promise<boolean> {
		if (!(await this.#waitForExecutionsToSettle(3_000))) {
			logger.warn("Aborting active Python execution during dispose before retained kernel cleanup");
			this.abort();
			if (!(await this.#waitForExecutionsToSettle(1_000))) {
				logger.warn(
					"Python execution is still active after dispose aborted all active runs; retained kernel ownership will still be detached",
				);
				return false;
			}
		}
		return true;
	}
}
