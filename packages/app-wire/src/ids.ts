import { fail } from "./errors.ts";
import { MAX_ID_BYTES } from "./limits.ts";

export type HostId = string & { readonly __hostId: unique symbol };
export type SessionId = string & { readonly __sessionId: unique symbol };
export type EntryId = string & { readonly __entryId: unique symbol };
export type AgentId = string & { readonly __agentId: unique symbol };
export type TerminalId = string & { readonly __terminalId: unique symbol };
export type RequestId = string & { readonly __requestId: unique symbol };
export type PairingId = string & { readonly __pairingId: unique symbol };

export function id<T extends string>(value: unknown, path: string): T {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_BYTES || /[\u0000\r\n]/u.test(value)) fail("BOUNDS", "invalid identifier", path);
  return value as T;
}
export const hostId = (value: unknown, path = "hostId"): HostId => id<HostId>(value, path);
export const sessionId = (value: unknown, path = "sessionId"): SessionId => id<SessionId>(value, path);
export const entryId = (value: unknown, path = "entryId"): EntryId => id<EntryId>(value, path);
export const agentId = (value: unknown, path = "agentId"): AgentId => id<AgentId>(value, path);
export const terminalId = (value: unknown, path = "terminalId"): TerminalId => id<TerminalId>(value, path);
export const requestId = (value: unknown, path = "requestId"): RequestId => id<RequestId>(value, path);
export const pairingId = (value: unknown, path = "pairingId"): PairingId => id<PairingId>(value, path);

export interface SessionKey { readonly hostId: HostId; readonly sessionId: SessionId }
export function sameSession(a: SessionKey, b: SessionKey): boolean {
  return a.hostId === b.hostId && a.sessionId === b.sessionId;
}
