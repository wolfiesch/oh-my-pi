import { createHash } from "node:crypto";
import type { CommandId, ServerFrame } from "@oh-my-pi/app-wire";
import type { CommandOutcome } from "./types.ts";

function semantic(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(semantic);
	if (!value || typeof value !== "object") return value;
	const object = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(object)
			.filter(key => key !== "requestId")
			.sort()
			.map(key => [key, semantic(object[key])]),
	);
}
function payloadHash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(semantic(value)))
		.digest("hex");
}
export type IdempotencyResult =
	| { kind: "new" }
	| { kind: "pending"; outcome: Promise<CommandOutcome> }
	| { kind: "replay"; outcome: CommandOutcome }
	| { kind: "conflict"; hash: string };
export class IdempotencyStore {
	#entries = new Map<
		string,
		{
			hash: string;
			outcome?: CommandOutcome;
			pending?: Promise<CommandOutcome>;
			resolve?: (outcome: CommandOutcome) => void;
		}
	>();
	begin(commandId: CommandId, payload: unknown): IdempotencyResult {
		const hash = payloadHash(payload);
		const existing = this.#entries.get(commandId);
		if (!existing) {
			const gate = Promise.withResolvers<CommandOutcome>();
			this.#entries.set(commandId, { hash, pending: gate.promise, resolve: gate.resolve });
			return { kind: "new" };
		}
		if (existing.hash !== hash) return { kind: "conflict", hash };
		if (existing.outcome) return { kind: "replay", outcome: existing.outcome };
		return { kind: "pending", outcome: existing.pending! };
	}
	complete(commandId: CommandId, payload: unknown, outcome: CommandOutcome): void {
		const hash = payloadHash(payload);
		const current = this.#entries.get(commandId);
		if (!current || current.hash !== hash) {
			this.#entries.set(commandId, { hash, outcome });
			return;
		}
		current.outcome = outcome;
		current.resolve?.(outcome);
		current.pending = undefined;
		current.resolve = undefined;
	}
	unknown(commandId: CommandId): void {
		const current = this.#entries.get(commandId);
		if (current)
			this.complete(
				commandId,
				{ commandId },
				{
					unknown: true,
					frame: {
						v: "omp-app/1",
						type: "error",
						code: "outcome_unknown",
						message: "child ended before command outcome",
						requestId: commandId,
					} as ServerFrame,
				},
			);
	}
}
export { payloadHash };
