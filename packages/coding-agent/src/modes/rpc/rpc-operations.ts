import { Snowflake } from "@oh-my-pi/pi-utils";
import type {
	RpcActiveOperation,
	RpcCancelOperationResult,
	RpcOperationCancellationCode,
	RpcOperationCancellationReason,
	RpcOperationCommand,
	RpcOperationStartedFrame,
	RpcOperationsSnapshot,
	RpcOperationTerminalFrame,
} from "./rpc-types";

export interface RpcOperationHandle {
	readonly operationId: string;
	readonly requestId: string | undefined;
	readonly command: RpcOperationCommand;
}

type ActiveRpcOperation = RpcOperationHandle & {
	acceptedAt: number;
	startedAt?: number;
};

type RpcOperationOutputFrame = RpcOperationStartedFrame | RpcOperationTerminalFrame;
type UnsettledTerminalFrame = RpcOperationTerminalFrame extends infer TFrame
	? TFrame extends RpcOperationTerminalFrame
		? Omit<TFrame, "settledAt">
		: never
	: never;

const RECENT_OPERATION_LIMIT = 128;
const RECENT_OPERATION_TTL_MS = 5 * 60_000;

/** Owns server-generated IDs, lifecycle timing, and exactly-once settlement. */
export class RpcOperationManager {
	readonly #active = new Map<string, ActiveRpcOperation>();
	readonly #recent = new Map<string, { frame: RpcOperationTerminalFrame; expiresAt: number }>();
	readonly #output: (frame: RpcOperationOutputFrame) => void;
	readonly #nextId: () => string;
	readonly #now: () => number;

	constructor(
		output: (frame: RpcOperationOutputFrame) => void,
		nextId = () => Snowflake.next() as string,
		now = Date.now,
	) {
		this.#output = output;
		this.#nextId = nextId;
		this.#now = now;
	}

	/** Accept work without starting it. The caller can emit the response before {@link begin}. */
	start(requestId: string | undefined, command: RpcOperationCommand): RpcOperationHandle {
		const operation: ActiveRpcOperation = {
			operationId: this.#nextId(),
			requestId,
			command,
			acceptedAt: this.#now(),
		};
		this.#active.set(operation.operationId, operation);
		return operation;
	}

	/** Mark the point where accepted work actually begins. */
	begin(handle: RpcOperationHandle): boolean {
		const operation = this.#active.get(handle.operationId);
		if (!operation || operation.startedAt !== undefined) return false;
		operation.startedAt = this.#now();
		this.#output({
			type: "operation_started",
			operationId: operation.operationId,
			requestId: operation.requestId,
			command: operation.command,
			startedAt: operation.startedAt,
		});
		return true;
	}

	isActive(handle: RpcOperationHandle): boolean {
		return this.#active.has(handle.operationId);
	}

	/** Whether accepted or started work for this command is still unsettled. */
	hasActiveCommand(command: RpcOperationCommand): boolean {
		for (const operation of this.#active.values()) {
			if (operation.command === command) return true;
		}
		return false;
	}

	complete(handle: RpcOperationHandle, agentInvoked: boolean): boolean {
		return this.#settle(handle, {
			type: "operation_completed",
			operationId: handle.operationId,
			requestId: handle.requestId,
			command: handle.command,
			agentInvoked,
		});
	}

	fail(handle: RpcOperationHandle, error: Error, code = "operation_failed"): boolean {
		return this.#settle(handle, {
			type: "operation_failed",
			operationId: handle.operationId,
			requestId: handle.requestId,
			command: handle.command,
			error: error.message,
			code,
		});
	}

	cancel(
		operationId: string,
		reason: RpcOperationCancellationReason = "user",
		code: RpcOperationCancellationCode = "cancelled_by_client",
	): { result: RpcCancelOperationResult; wasStarted: boolean } {
		this.#pruneRecent();
		const operation = this.#active.get(operationId);
		if (operation) {
			const wasStarted = operation.startedAt !== undefined;
			const frame = this.#cancelFrame(operation, reason, code);
			this.#settle(operation, frame);
			return {
				result: { operationId, status: "cancelled", terminal: this.#recent.get(operationId)!.frame },
				wasStarted,
			};
		}
		const terminal = this.#recent.get(operationId)?.frame;
		if (!terminal) return { result: { operationId, status: "not_found" }, wasStarted: false };
		return {
			result: {
				operationId,
				status:
					terminal.type === "operation_cancelled"
						? "cancelled"
						: terminal.type === "operation_completed"
							? "completed"
							: "failed",
				terminal,
			},
			wasStarted: false,
		};
	}

	cancelAll(reason: RpcOperationCancellationReason, code: RpcOperationCancellationCode): void {
		for (const operation of Array.from(this.#active.values())) {
			this.#settle(operation, this.#cancelFrame(operation, reason, code));
		}
	}

	snapshot(): RpcOperationsSnapshot {
		this.#pruneRecent();
		const active: RpcActiveOperation[] = Array.from(this.#active.values(), operation => ({
			operationId: operation.operationId,
			requestId: operation.requestId,
			command: operation.command,
			status: operation.startedAt === undefined ? "accepted" : "started",
			acceptedAt: operation.acceptedAt,
			startedAt: operation.startedAt,
		}));
		return {
			active,
			recent: Array.from(this.#recent.values(), entry => entry.frame),
		};
	}

	get activeCount(): number {
		return this.#active.size;
	}

	#cancelFrame(
		operation: RpcOperationHandle,
		reason: RpcOperationCancellationReason,
		code: RpcOperationCancellationCode,
	): Omit<Extract<RpcOperationTerminalFrame, { type: "operation_cancelled" }>, "settledAt"> {
		return {
			type: "operation_cancelled",
			operationId: operation.operationId,
			requestId: operation.requestId,
			command: operation.command,
			reason,
			code,
		};
	}

	#settle(handle: RpcOperationHandle, frame: UnsettledTerminalFrame): boolean {
		const operation = this.#active.get(handle.operationId);
		if (!operation) return false;
		this.#active.delete(handle.operationId);
		const terminal = { ...frame, settledAt: this.#now() } as RpcOperationTerminalFrame;
		this.#recent.set(handle.operationId, {
			frame: terminal,
			expiresAt: terminal.settledAt + RECENT_OPERATION_TTL_MS,
		});
		this.#pruneRecent();
		this.#output(terminal);
		return true;
	}

	#pruneRecent(): void {
		const now = this.#now();
		for (const [operationId, entry] of this.#recent) {
			if (entry.expiresAt > now) continue;
			this.#recent.delete(operationId);
		}
		while (this.#recent.size > RECENT_OPERATION_LIMIT) {
			const oldest = this.#recent.keys().next().value;
			if (typeof oldest !== "string") break;
			this.#recent.delete(oldest);
		}
	}
}
