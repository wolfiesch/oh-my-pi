import { createHash } from "node:crypto";
import type { CommandId, ServerFrame } from "@oh-my-pi/app-wire";
import type { CommandOutcome } from "./types.ts";

function payloadHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export type IdempotencyResult = { kind: "new" } | { kind: "replay"; outcome: CommandOutcome } | { kind: "conflict"; hash: string };
export class IdempotencyStore {
  #entries = new Map<string, { hash: string; outcome?: CommandOutcome }>();
  begin(commandId: CommandId, payload: unknown): IdempotencyResult {
    const hash = payloadHash(payload); const existing = this.#entries.get(commandId);
    if (!existing) { this.#entries.set(commandId, { hash }); return { kind: "new" }; }
    if (existing.hash !== hash) return { kind: "conflict", hash };
    return existing.outcome ? { kind: "replay", outcome: existing.outcome } : { kind: "new" };
  }
  complete(commandId: CommandId, payload: unknown, outcome: CommandOutcome): void {
    const hash = payloadHash(payload); const current = this.#entries.get(commandId); if (current?.hash === hash) current.outcome = outcome; else this.#entries.set(commandId, { hash, outcome });
  }
  unknown(commandId: CommandId): void { const current = this.#entries.get(commandId); if (current) current.outcome = { unknown: true, frame: { v: "omp-app/1", type: "error", code: "outcome_unknown", message: "child ended before command outcome", requestId: commandId } as ServerFrame }; }
}
export { payloadHash };
