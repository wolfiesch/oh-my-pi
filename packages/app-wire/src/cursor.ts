import { fail } from "./errors.ts";
import { safeSeq } from "./guards.ts";

export interface Cursor { epoch: number; seq: number }
export function isCursor(value: unknown): value is Cursor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  return typeof cursor.epoch === "number" && Number.isSafeInteger(cursor.epoch) && cursor.epoch >= 0 &&
    typeof cursor.seq === "number" && Number.isSafeInteger(cursor.seq) && cursor.seq >= 0;
}
export function decodeCursor(value: unknown, path = "cursor"): Cursor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_FRAME", "cursor must be an object", path);
  const cursor = value as Record<string, unknown>;
  if (typeof cursor.epoch !== "number" || !Number.isSafeInteger(cursor.epoch) || cursor.epoch < 0) fail("UNSAFE_SEQUENCE", "epoch must be a safe non-negative integer", `${path}.epoch`);
  return { epoch: cursor.epoch, seq: safeSeq(cursor.seq, `${path}.seq`) };
}
