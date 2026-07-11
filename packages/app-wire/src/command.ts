import { fail } from "./errors.ts";
import { commandId, confirmationId, hostId, requestId, revision, sessionId, type CommandId, type ConfirmationId, type HostId, type RequestId, type Revision, type SessionId } from "./ids.ts";
import { boundedArray, boundedMap, boundedText, controlFree, inputObject, safeRelativePath, safeSeq } from "./guards.ts";
import { MAX_FILE_BYTES, PROTOCOL_VERSION } from "./limits.ts";
import type { DeviceCapability } from "./capabilities.ts";
export interface CommandDescriptor { capability: DeviceCapability; scope: "host" | "session"; revision: "none" | "optional" | "required"; confirmation: "none" | "challenge"; }
export const COMMAND_DESCRIPTORS: Readonly<Record<string, CommandDescriptor>> = {
  "host.list": { capability: "sessions.read", scope: "host", revision: "none", confirmation: "none" },
  "session.list": { capability: "sessions.read", scope: "host", revision: "none", confirmation: "none" },
  "session.create": { capability: "sessions.manage", scope: "host", revision: "none", confirmation: "none" },
  "session.attach": { capability: "sessions.read", scope: "session", revision: "none", confirmation: "none" },
  "session.prompt": { capability: "sessions.prompt", scope: "session", revision: "optional", confirmation: "none" },
  "session.cancel": { capability: "sessions.control", scope: "session", revision: "optional", confirmation: "challenge" },
  "session.close": { capability: "sessions.manage", scope: "session", revision: "required", confirmation: "challenge" },
  "files.read": { capability: "files.read", scope: "session", revision: "optional", confirmation: "none" },
  "files.write": { capability: "files.write", scope: "session", revision: "required", confirmation: "challenge" },
  "files.patch": { capability: "files.write", scope: "session", revision: "required", confirmation: "challenge" },
  "files.list": { capability: "files.list", scope: "session", revision: "optional", confirmation: "none" },
  "files.diff": { capability: "files.diff", scope: "session", revision: "optional", confirmation: "none" },
  "review.read": { capability: "files.read", scope: "session", revision: "optional", confirmation: "none" },
  "review.apply": { capability: "files.write", scope: "session", revision: "required", confirmation: "challenge" },
  "agent.cancel": { capability: "agents.control", scope: "session", revision: "optional", confirmation: "challenge" },
  "bash.run": { capability: "bash.run", scope: "session", revision: "optional", confirmation: "challenge" },
  "term.open": { capability: "term.open", scope: "session", revision: "optional", confirmation: "challenge" },
  "audit.read": { capability: "audit.read", scope: "host", revision: "none", confirmation: "none" },
  "audit.tail": { capability: "audit.read", scope: "host", revision: "none", confirmation: "none" },
  "config.write": { capability: "config.write", scope: "host", revision: "required", confirmation: "challenge" },
  "settings.read": { capability: "config.read", scope: "host", revision: "none", confirmation: "none" },
  "settings.write": { capability: "config.write", scope: "host", revision: "required", confirmation: "challenge" },
  "catalog.get": { capability: "catalog.read", scope: "host", revision: "none", confirmation: "none" },
  "host.watch": { capability: "sessions.read", scope: "host", revision: "none", confirmation: "none" },
  "session.watch": { capability: "sessions.read", scope: "session", revision: "none", confirmation: "none" },
  "controller.lease.acquire": { capability: "sessions.control", scope: "session", revision: "required", confirmation: "none" },
  "controller.lease.renew": { capability: "sessions.control", scope: "session", revision: "required", confirmation: "none" },
  "controller.lease.release": { capability: "sessions.control", scope: "session", revision: "required", confirmation: "none" },
  "prompt.lease.acquire": { capability: "sessions.prompt", scope: "session", revision: "required", confirmation: "none" },
  "prompt.lease.renew": { capability: "sessions.prompt", scope: "session", revision: "required", confirmation: "none" },
  "prompt.lease.release": { capability: "sessions.prompt", scope: "session", revision: "required", confirmation: "none" },
  "preview.launch": { capability: "preview.control", scope: "session", revision: "optional", confirmation: "challenge" },
  "preview.state": { capability: "preview.read", scope: "session", revision: "optional", confirmation: "none" },
  "preview.navigate": { capability: "preview.control", scope: "session", revision: "optional", confirmation: "none" },
  "preview.capture": { capability: "preview.read", scope: "session", revision: "optional", confirmation: "none" },
};
export const COMMAND_CAPABILITIES: Readonly<Record<string, DeviceCapability>> = Object.fromEntries(Object.entries(COMMAND_DESCRIPTORS).map(([name, descriptor]) => [name, descriptor.capability]));
export interface CommandFrame { v: typeof PROTOCOL_VERSION; type: "command"; requestId: RequestId; commandId: CommandId; hostId: HostId; sessionId?: SessionId; command: string; expectedRevision?: Revision; confirmationId?: ConfirmationId; args: Record<string, unknown>; }
const FILE_COMMANDS: Record<string, true> = { "files.read": true, "files.write": true, "files.patch": true, "files.list": true, "files.diff": true, "review.read": true, "review.apply": true };
export function decodeCommand(input: unknown): CommandFrame {
  const frame = inputObject(input);
  if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
  if (frame.type !== "command") fail("INVALID_FRAME", "expected command frame", "type");
  requestId(frame.requestId); commandId(frame.commandId); const host = hostId(frame.hostId);
  const command = controlFree(frame.command, "command", 128); const descriptor = COMMAND_DESCRIPTORS[command];
  if (descriptor === undefined) fail("INVALID_FRAME", "unknown command", "command");
  const session = frame.sessionId === undefined ? undefined : sessionId(frame.sessionId);
  if (descriptor.scope === "session" && session === undefined) fail("INVALID_FRAME", "sessionId is required for session command", "sessionId");
  if (descriptor.scope === "host" && session !== undefined) fail("INVALID_FRAME", "sessionId is forbidden for host command", "sessionId");
  if (descriptor.revision === "none" && frame.expectedRevision !== undefined) fail("STALE_REVISION", "expectedRevision is forbidden for this command", "expectedRevision");
  if (descriptor.revision === "required" && frame.expectedRevision === undefined) fail("STALE_REVISION", "expectedRevision is required", "expectedRevision");
  if (frame.expectedRevision !== undefined) revision(frame.expectedRevision);
  // A missing confirmationId is the intentional first attempt; the server must issue a challenge. Present tokens are bounded and validated below.
  if (descriptor.confirmation === "none" && frame.confirmationId !== undefined) fail("CONFIRMATION_INVALID", "confirmationId is not valid for this command", "confirmationId");
  if (frame.confirmationId !== undefined) confirmationId(frame.confirmationId);
  const args = frame.args === undefined ? {} : boundedMap(frame.args, "args");
  if (FILE_COMMANDS[command] === true) for (const key of ["path", "filePath", "targetPath", "cwd"]) if (args[key] !== undefined) safeRelativePath(args[key], `args.${key}`);
  return { ...frame, hostId: host, sessionId: session, command, args } as unknown as CommandFrame;
}
export function requiredCapability(command: string): DeviceCapability | undefined { return COMMAND_DESCRIPTORS[command]?.capability; }

export type CommandArguments = Record<string, unknown>;
export type CommandResult = Record<string, unknown>;
function requireArgs(value: unknown, path = "args"): Record<string, unknown> { return boundedMap(value, path); }
function requiredPath(args: Record<string, unknown>): string { return safeRelativePath(args.path); }
function emptyArgs(value: unknown): CommandArguments { return requireArgs(value); }
function emptyResult(value: unknown): CommandResult { return requireArgs(value, "result"); }
function listResult(value: unknown): CommandResult { const result = requireArgs(value, "result"); boundedArray(result.items ?? result.entries, "result.items"); return result; }
export const COMMAND_ARGUMENT_DECODERS: Readonly<Record<string, (value: unknown) => CommandArguments>> = {
  "host.list": emptyArgs, "session.list": emptyArgs, "session.create": emptyArgs, "session.attach": emptyArgs,
  "session.prompt": value => { const args=requireArgs(value); boundedText(args.prompt,"args.prompt",MAX_FILE_BYTES); return args; },
  "session.cancel": emptyArgs, "session.close": emptyArgs, "files.read": value => { const args=requireArgs(value); requiredPath(args); return args; },
  "files.write": value => { const args=requireArgs(value); requiredPath(args); boundedText(args.content,"args.content",MAX_FILE_BYTES); return args; },
  "files.patch": value => { const args=requireArgs(value); requiredPath(args); boundedText(args.patch,"args.patch",MAX_FILE_BYTES); return args; },
  "files.list": value => { const args=requireArgs(value); if(args.path!==undefined) safeRelativePath(args.path); return args; },
  "files.diff": value => { const args=requireArgs(value); requiredPath(args); return args; },
  "review.read": emptyArgs, "review.apply": emptyArgs, "agent.cancel": emptyArgs, "bash.run": value => { const args=requireArgs(value); boundedText(args.command,"args.command",MAX_FILE_BYTES); return args; },
  "term.open": emptyArgs, "audit.read": emptyArgs, "audit.tail": emptyArgs, "config.write": value => requireArgs(value),
  "settings.read": emptyArgs, "settings.write": value => requireArgs(value), "catalog.get": emptyArgs,
  "host.watch": emptyArgs, "session.watch": emptyArgs,
  "controller.lease.acquire": emptyArgs, "controller.lease.renew": emptyArgs, "controller.lease.release": emptyArgs,
  "prompt.lease.acquire": emptyArgs, "prompt.lease.renew": emptyArgs, "prompt.lease.release": emptyArgs,
  "preview.launch": emptyArgs, "preview.state": emptyArgs, "preview.navigate": value => { const args=requireArgs(value); controlFree(args.url,"args.url",4096); return args; }, "preview.capture": emptyArgs,
};
export const COMMAND_RESULT_DECODERS: Readonly<Record<string, (value: unknown) => CommandResult>> = {
  "host.list": listResult, "session.list": listResult, "session.create": emptyResult, "session.attach": emptyResult,
  "session.prompt": emptyResult, "session.cancel": emptyResult, "session.close": emptyResult, "files.read": value => { const result=requireArgs(value,"result"); boundedText(result.content,"result.content",MAX_FILE_BYTES); return result; },
  "files.write": emptyResult, "files.patch": emptyResult, "files.list": listResult, "files.diff": value => { const result=requireArgs(value,"result"); boundedText(result.diff,"result.diff",MAX_FILE_BYTES); return result; },
  "review.read": emptyResult, "review.apply": emptyResult, "agent.cancel": emptyResult, "bash.run": emptyResult, "term.open": emptyResult,
  "audit.read": emptyResult, "audit.tail": value => { const result=requireArgs(value,"result"); boundedArray(result.events,"result.events").forEach((entry,i)=>boundedMap(entry,`result.events[${i}]`)); return result; },
  "config.write": emptyResult, "settings.read": emptyResult, "settings.write": emptyResult, "catalog.get": value => { const result=requireArgs(value,"result"); boundedArray(result.items,"result.items").forEach((item,i)=>boundedMap(item,`result.items[${i}]`)); return result; },
  "host.watch": emptyResult, "session.watch": emptyResult, "controller.lease.acquire": emptyResult, "controller.lease.renew": emptyResult, "controller.lease.release": emptyResult,
  "prompt.lease.acquire": emptyResult, "prompt.lease.renew": emptyResult, "prompt.lease.release": emptyResult,
  "preview.launch": emptyResult, "preview.state": emptyResult, "preview.navigate": emptyResult, "preview.capture": value => { const result=requireArgs(value,"result"); boundedText(result.content,"result.content",MAX_FILE_BYTES); return result; },
};
export function decodeCommandArguments(command: string, value: unknown): CommandArguments { const decoder=COMMAND_ARGUMENT_DECODERS[command]; if(decoder===undefined) fail("INVALID_FRAME","command has no typed argument decoder","command"); return decoder(value); }
export function decodeCommandResult(command: string, value: unknown): CommandResult { const decoder=COMMAND_RESULT_DECODERS[command]; if(decoder===undefined) fail("INVALID_FRAME","command has no typed result decoder","command"); return decoder(value); }
