import { fail } from "./errors.ts";
import { controlFree } from "./guards.ts";
import { MAX_ID_BYTES } from "./limits.ts";

export type HostId = string & { readonly __hostId: unique symbol };
export type SessionId = string & { readonly __sessionId: unique symbol };
export type ProjectId = string & { readonly __projectId: unique symbol };
export type EntryId = string & { readonly __entryId: unique symbol };
export type AgentId = string & { readonly __agentId: unique symbol };
export type TerminalId = string & { readonly __terminalId: unique symbol };
export type RequestId = string & { readonly __requestId: unique symbol };
export type CommandId = string & { readonly __commandId: unique symbol };
export type PairingId = string & { readonly __pairingId: unique symbol };
export type ConfirmationId = string & { readonly __confirmationId: unique symbol };
export type Revision = string & { readonly __revision: unique symbol };

export function id<T extends string>(value: unknown, path: string): T {
	return controlFree(value, path, MAX_ID_BYTES) as T;
}
export const hostId = (v: unknown, p = "hostId"): HostId => id<HostId>(v, p);
export const sessionId = (v: unknown, p = "sessionId"): SessionId => id<SessionId>(v, p);
export const projectId = (v: unknown, p = "projectId"): ProjectId => id<ProjectId>(v, p);
export const entryId = (v: unknown, p = "entryId"): EntryId => id<EntryId>(v, p);
export const agentId = (v: unknown, p = "agentId"): AgentId => id<AgentId>(v, p);
export const terminalId = (v: unknown, p = "terminalId"): TerminalId => id<TerminalId>(v, p);
export const requestId = (v: unknown, p = "requestId"): RequestId => id<RequestId>(v, p);
export const commandId = (v: unknown, p = "commandId"): CommandId => id<CommandId>(v, p);
export const pairingId = (v: unknown, p = "pairingId"): PairingId => id<PairingId>(v, p);
export const confirmationId = (v: unknown, p = "confirmationId"): ConfirmationId => id<ConfirmationId>(v, p);
export const revision = (v: unknown, p = "revision"): Revision => id<Revision>(v, p);
export interface SessionKey {
	readonly hostId: HostId;
	readonly sessionId: SessionId;
}
export function sameSession(a: SessionKey, b: SessionKey): boolean {
	return a.hostId === b.hostId && a.sessionId === b.sessionId;
}
