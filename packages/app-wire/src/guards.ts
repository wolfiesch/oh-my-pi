import { AppWireError, fail } from "./errors.ts";
import { MAX_ARRAY_ITEMS, MAX_CAPABILITIES, MAX_ID_BYTES, MAX_INPUT_BYTES, MAX_JSON_DEPTH, MAX_MAP_KEYS, MAX_STRING_BYTES } from "./limits.ts";

export type JsonObject = Record<string, unknown>;

export function object(value: unknown, path = "frame"): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_FRAME", "expected object", path);
  return value as JsonObject;
}
export function string(value: unknown, path: string, max = MAX_STRING_BYTES): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail("BOUNDS", "expected bounded non-empty string", path);
  return value;
}
export function optionalString(value: unknown, path: string, max = MAX_STRING_BYTES): void {
  if (value !== undefined) string(value, path, max);
}
export function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("INVALID_FRAME", "expected boolean", path);
  return value;
}
export function safeSeq(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("UNSAFE_SEQUENCE", "sequence must be a safe non-negative integer", path);
  return value;
}
export function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("INVALID_FRAME", "expected finite number", path);
  return value;
}
export function boundedArray(value: unknown, path: string, max = MAX_ARRAY_ITEMS): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail("BOUNDS", "expected bounded array", path);
  return value;
}
export function boundedMap(value: unknown, path: string, max = MAX_MAP_KEYS): JsonObject {
  const out = object(value, path);
  if (Object.keys(out).length > max) fail("BOUNDS", "too many object keys", path);
  return out;
}
export function capabilitiesArray(value: unknown, path: string): string[] {
  const items = boundedArray(value, path, MAX_CAPABILITIES);
  for (let i = 0; i < items.length; i++) string(items[i], `${path}[${i}]`, 128);
  return items as string[];
}
export function parseBounded(input: string | Uint8Array): unknown {
  if (typeof input === "string" && input.length > MAX_INPUT_BYTES) fail("OVERSIZED_INPUT", "input exceeds protocol limit");
  const bytes = typeof input === "string" ? new TextEncoder().encode(input).byteLength : input.byteLength;
  if (bytes > MAX_INPUT_BYTES) fail("OVERSIZED_INPUT", "input exceeds protocol limit");
  let text: string;
  try { text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input); }
  catch { fail("INVALID_JSON", "input is not valid UTF-8"); }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 92) escaped = true;
      else if (c === 34) inString = false;
      continue;
    }
    if (c === 34) inString = true;
    else if (c === 123 || c === 91) { depth++; if (depth > MAX_JSON_DEPTH) fail("BOUNDS", "JSON nesting exceeds protocol limit"); }
    else if (c === 125 || c === 93) depth--;
  }
  if (inString || depth !== 0) fail("INVALID_JSON", "unterminated JSON");
  try { return JSON.parse(text) as unknown; } catch (error) {
    if (error instanceof AppWireError) throw error;
    fail("INVALID_JSON", "invalid JSON");
  }
}
export function inputObject(input: unknown): JsonObject {
  return object(typeof input === "string" || input instanceof Uint8Array ? parseBounded(input) : input);
}
