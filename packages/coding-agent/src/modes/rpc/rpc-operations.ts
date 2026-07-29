import { Snowflake } from "@oh-my-pi/pi-utils";
import type { RpcOperationCommand, RpcOperationTerminalFrame } from "./rpc-types";

export interface RpcOperationHandle {
	readonly operationId: string;
	readonly requestId: string | undefined;
	readonly command: RpcOperationCommand;
}

type ActiveRpcOperation = RpcOperationHandle & { settled: boolean };

/** Owns exactly-once terminal settlement for accepted asynchronous RPC work. */
export class RpcOperationManager {
	readonly #active = new Map<string, ActiveRpcOperation>();
	readonly #output: (frame: RpcOperationTerminalFrame) => void;
	readonly #nextId: () => string;

	constructor(output: (frame: RpcOperationTerminalFrame) => void, nextId = () => Snowflake.next() as string) {
		this.#output = output;
		this.#nextId = nextId;
	}

	start(requestId: string | undefined, command: RpcOperationCommand): RpcOperationHandle {
		const operation: ActiveRpcOperation = {
			operationId: this.#nextId(),
			requestId,
			command,
			settled: false,
		};
		this.#active.set(operation.operationId, operation);
		return operation;
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

	abortAll(reason: string): void {
		for (const operation of Array.from(this.#active.values())) {
			this.#settle(operation, {
				type: "operation_aborted",
				operationId: operation.operationId,
				requestId: operation.requestId,
				command: operation.command,
				reason,
			});
		}
	}

	get activeCount(): number {
		return this.#active.size;
	}

	#settle(handle: RpcOperationHandle, frame: RpcOperationTerminalFrame): boolean {
		const operation = this.#active.get(handle.operationId);
		if (!operation || operation.settled) return false;
		operation.settled = true;
		this.#active.delete(handle.operationId);
		this.#output(frame);
		return true;
	}
}
