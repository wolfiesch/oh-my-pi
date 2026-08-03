import type { RpcEvalOutputFrame } from "./rpc-types";

export const MAX_RPC_EVAL_OUTPUT_CHARACTERS = 262_144;
export const MAX_RPC_EVAL_OUTPUT_CHUNK_CHARACTERS = 65_536;

/** Converts EvalTool's rolling-tail updates into a bounded append-only RPC stream. */
export class RpcEvalOutputStream {
	#observedTail = "";
	#emittedCharacters = 0;
	#sequence = 0;
	#closed = false;
	#truncated = false;

	constructor(
		readonly operationId: string,
		readonly isActive: () => boolean,
		readonly output: (frame: RpcEvalOutputFrame) => void,
	) {}

	push(nextTail: string): void {
		if (this.#closed || !this.isActive() || nextTail === this.#observedTail) return;
		if (!nextTail.startsWith(this.#observedTail)) {
			// The rolling tail discarded bytes. Stop rather than resend overlap.
			this.#observedTail = nextTail;
			this.#closed = true;
			this.#truncated = true;
			this.output({
				type: "eval_output",
				operationId: this.operationId,
				sequence: this.#sequence++,
				chunk: "",
				truncated: true,
			});
			return;
		}
		const delta = nextTail.slice(this.#observedTail.length);
		this.#observedTail = nextTail;
		const remaining = MAX_RPC_EVAL_OUTPUT_CHARACTERS - this.#emittedCharacters;
		if (remaining <= 0) {
			this.#closed = true;
			this.#truncated = true;
			this.output({
				type: "eval_output",
				operationId: this.operationId,
				sequence: this.#sequence++,
				chunk: "",
				truncated: true,
			});
			return;
		}
		const boundedDelta = delta.slice(0, remaining);
		if (boundedDelta.length < delta.length) {
			this.#closed = true;
			this.#truncated = true;
		}
		for (let offset = 0; offset < boundedDelta.length; offset += MAX_RPC_EVAL_OUTPUT_CHUNK_CHARACTERS) {
			const chunk = boundedDelta.slice(offset, offset + MAX_RPC_EVAL_OUTPUT_CHUNK_CHARACTERS);
			this.#emittedCharacters += chunk.length;
			this.output({
				type: "eval_output",
				operationId: this.operationId,
				sequence: this.#sequence++,
				chunk,
				truncated: this.#truncated && offset + chunk.length === boundedDelta.length,
			});
		}
	}

	/** Reconciles the canonical final result without treating a dropped trailing line break as tail loss. */
	complete(finalOutput: string): void {
		if (
			this.#closed ||
			!this.isActive() ||
			finalOutput === this.#observedTail ||
			(this.#observedTail.startsWith(finalOutput) && this.#observedTail.slice(finalOutput.length).trim() === "")
		) {
			return;
		}
		this.push(finalOutput);
	}

	get truncated(): boolean {
		return this.#truncated;
	}
}
