import { fail } from "./errors.ts";
import { commandId, confirmationId, hostId, leaseId, requestId, revision, sessionId, terminalId, type CommandId, type ConfirmationId, type HostId, type RequestId, type Revision, type SessionId } from "./ids.ts";
import { boundedArray, boundedMap, boundedMetadata, boundedText, controlFree, inputObject, isSecretLikeKey, safeRelativePath, safeSeq } from "./guards.ts";
import { MAX_FILE_BYTES, PROTOCOL_VERSION } from "./limits.ts";
import { decodeCursor, type Cursor } from "./cursor.ts";
import { decodeSessionRef, type SessionRef } from "./session-index.ts";
import type { DeviceCapability } from "./capabilities.ts";
export type RevisionOwner = "none" | "session" | "authority";
export interface CommandDescriptor {
  capability: DeviceCapability;
  scope: "host" | "session";
  revision: "none" | "optional" | "required";
  revisionOwner: RevisionOwner;
  confirmation: "none" | "challenge";
}
export const COMMAND_DESCRIPTORS: Readonly<Record<string, CommandDescriptor>> = {
  "host.list": { capability: "sessions.read", scope: "host", revision: "none", revisionOwner: "none", confirmation: "none" },
  "session.list": { capability: "sessions.read", scope: "host", revision: "none", revisionOwner: "none", confirmation: "none" },
  "session.create": { capability: "sessions.manage", scope: "host", revision: "none", revisionOwner: "none", confirmation: "none" },
  "session.attach": { capability: "sessions.read", scope: "session", revision: "none", revisionOwner: "none", confirmation: "none" },
  "session.prompt": { capability: "sessions.prompt", scope: "session", revision: "optional", revisionOwner: "session", confirmation: "none" },
  "session.cancel": { capability: "sessions.control", scope: "session", revision: "optional", revisionOwner: "session", confirmation: "challenge" },
  "session.close": { capability: "sessions.manage", scope: "session", revision: "required", revisionOwner: "session", confirmation: "challenge" },
  "files.read": { capability: "files.read", scope: "session", revision: "optional", revisionOwner: "authority", confirmation: "none" },
  "files.write": { capability: "files.write", scope: "session", revision: "required", revisionOwner: "authority", confirmation: "challenge" },
  "files.patch": { capability: "files.write", scope: "session", revision: "required", revisionOwner: "authority", confirmation: "challenge" },
  "files.list": { capability: "files.list", scope: "session", revision: "optional", revisionOwner: "authority", confirmation: "none" },
  "files.diff": { capability: "files.diff", scope: "session", revision: "optional", revisionOwner: "authority", confirmation: "none" },
  "review.read": { capability: "files.read", scope: "session", revision: "optional", revisionOwner: "authority", confirmation: "none" },
  "review.apply": { capability: "files.write", scope: "session", revision: "required", revisionOwner: "authority", confirmation: "challenge" },
  "agent.cancel": { capability: "agents.control", scope: "session", revision: "optional", revisionOwner: "session", confirmation: "challenge" },
  "bash.run": { capability: "bash.run", scope: "session", revision: "optional", revisionOwner: "session", confirmation: "challenge" },
  "term.open": { capability: "term.open", scope: "session", revision: "optional", revisionOwner: "session", confirmation: "challenge" },
  "audit.read": { capability: "audit.read", scope: "host", revision: "none", revisionOwner: "none", confirmation: "none" },
  "audit.tail": { capability: "audit.read", scope: "host", revision: "none", revisionOwner: "none", confirmation: "none" },
  "config.write": { capability: "config.write", scope: "host", revision: "required", revisionOwner: "authority", confirmation: "challenge" },
  "settings.read": { capability: "config.read", scope: "host", revision: "none", revisionOwner: "none", confirmation: "none" },
  "settings.write": { capability: "config.write", scope: "host", revision: "required", revisionOwner: "authority", confirmation: "challenge" },
  "catalog.get": { capability: "catalog.read", scope: "host", revision: "none", revisionOwner: "none", confirmation: "none" },
  "host.watch": { capability: "sessions.read", scope: "host", revision: "none", revisionOwner: "none", confirmation: "none" },
  "session.watch": { capability: "sessions.read", scope: "session", revision: "none", revisionOwner: "none", confirmation: "none" },
  "controller.lease.acquire": { capability: "sessions.control", scope: "session", revision: "required", revisionOwner: "session", confirmation: "none" },
  "controller.lease.renew": { capability: "sessions.control", scope: "session", revision: "required", revisionOwner: "session", confirmation: "none" },
  "controller.lease.release": { capability: "sessions.control", scope: "session", revision: "required", revisionOwner: "session", confirmation: "none" },
  "prompt.lease.acquire": { capability: "sessions.prompt", scope: "session", revision: "required", revisionOwner: "session", confirmation: "none" },
  "prompt.lease.renew": { capability: "sessions.prompt", scope: "session", revision: "required", revisionOwner: "session", confirmation: "none" },
  "prompt.lease.release": { capability: "sessions.prompt", scope: "session", revision: "required", revisionOwner: "session", confirmation: "none" },
  "preview.launch": { capability: "preview.control", scope: "session", revision: "optional", revisionOwner: "session", confirmation: "challenge" },
  "preview.state": { capability: "preview.read", scope: "session", revision: "optional", revisionOwner: "session", confirmation: "none" },
  "preview.navigate": { capability: "preview.control", scope: "session", revision: "optional", revisionOwner: "session", confirmation: "none" },
  "preview.capture": { capability: "preview.read", scope: "session", revision: "optional", revisionOwner: "session", confirmation: "none" },
};
export const COMMAND_CAPABILITIES: Readonly<Record<string,DeviceCapability>>=Object.fromEntries(Object.entries(COMMAND_DESCRIPTORS).map(([name,descriptor])=>[name,descriptor.capability]));
export interface CommandFrame { v:typeof PROTOCOL_VERSION; type:"command"; requestId:RequestId; commandId:CommandId; hostId:HostId; sessionId?:SessionId; command:string; expectedRevision?:Revision; confirmationId?:ConfirmationId; args:Record<string,unknown>; }
export function validateCommandDescriptor(command: string, descriptor: CommandDescriptor): void {
  const validRevision = descriptor.revision === "none" || descriptor.revision === "optional" || descriptor.revision === "required";
  const validOwner = descriptor.revisionOwner === "none" || descriptor.revisionOwner === "session" || descriptor.revisionOwner === "authority";
  const ownerMatchesRevision = descriptor.revision === "none" ? descriptor.revisionOwner === "none" : descriptor.revisionOwner !== "none";
  if (!validRevision || !validOwner || !ownerMatchesRevision) fail("INVALID_FRAME", "invalid command revision descriptor", `command.${command}`);
}
for (const [command, descriptor] of Object.entries(COMMAND_DESCRIPTORS)) validateCommandDescriptor(command, descriptor);
export function decodeCommand(input: unknown): CommandFrame {
  const frame = inputObject(input);
  if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
  if (frame.type !== "command") fail("INVALID_FRAME", "expected command frame", "type");
  requestId(frame.requestId);
  commandId(frame.commandId);
  const host = hostId(frame.hostId);
  const command = controlFree(frame.command, "command", 128);
  const descriptor = COMMAND_DESCRIPTORS[command];
  if (descriptor === undefined) fail("INVALID_FRAME", "unknown command", "command");
  validateCommandDescriptor(command, descriptor);
  const session = frame.sessionId === undefined ? undefined : sessionId(frame.sessionId);
  if (descriptor.scope === "session" && session === undefined) fail("INVALID_FRAME", "sessionId is required for session command", "sessionId");
  if (descriptor.scope === "host" && session !== undefined) fail("INVALID_FRAME", "sessionId is forbidden for host command", "sessionId");
  if (descriptor.revision === "none" && frame.expectedRevision !== undefined) fail("STALE_REVISION", "expectedRevision is forbidden", "expectedRevision");
  if (descriptor.revision === "required" && frame.expectedRevision === undefined) fail("STALE_REVISION", "expectedRevision is required", "expectedRevision");
  if (frame.expectedRevision !== undefined) revision(frame.expectedRevision);
  if (descriptor.confirmation === "none" && frame.confirmationId !== undefined) fail("CONFIRMATION_INVALID", "confirmationId is not valid", "confirmationId");
  if (frame.confirmationId !== undefined) confirmationId(frame.confirmationId);
  const args = decodeCommandArguments(command, frame.args === undefined ? {} : frame.args);
  return { ...frame, hostId: host, sessionId: session, command, args } as unknown as CommandFrame;
}
export function requiredCapability(command:string):DeviceCapability|undefined { return COMMAND_DESCRIPTORS[command]?.capability; }
export type CommandArguments=Record<string,unknown>; export type CommandResult=Record<string,unknown>;
function args(value:unknown,path="args"):Record<string,unknown>{return boundedMap(value,path);} function result(value:unknown):Record<string,unknown>{return boundedMap(value,"result");}
function absPath(value:unknown,path:string):string { const text=controlFree(value,path,4096); if(!text.startsWith("/")) fail("UNSAFE_PATH","cwd must be absolute",path); return text; }
function url(value:unknown,path:string):string { const text=controlFree(value,path,4096); let parsed:URL; try{parsed=new URL(text);}catch{fail("INVALID_FRAME","invalid URL",path);} if((parsed.protocol!=="http:"&&parsed.protocol!=="https:")||parsed.username!==""||parsed.password!=="") fail("INVALID_FRAME","URL must be http(s) without credentials",path); return text; }
function metadata(value:unknown,path:string):Record<string,unknown>{return boundedMetadata(value,path,isSecretLikeKey);}
function decodeSessions(value:unknown):CommandResult{const x=result(value), cursor=decodeCursor(x.cursor,"result.cursor"), values=boundedArray(x.sessions,"result.sessions"); const sessions=values.map((v,i)=>decodeSessionRef(v,`result.sessions[${i}]`)); return {...x,cursor,sessions};}
function decodeCreate(value:unknown):CommandResult{const x=result(value);return {...x,session:decodeSessionRef(x.session,"result.session")};}
function decodeAttach(value:unknown):CommandResult{const x=result(value);if(typeof x.attached!=="boolean")fail("INVALID_FRAME","attached must be boolean","result.attached");return {...x,attached:x.attached,cursor:decodeCursor(x.cursor,"result.cursor")};}
function boolField(value:unknown,key:string):CommandResult{const x=result(value);if(typeof x[key]!=="boolean")fail("INVALID_FRAME",`${key} must be boolean`,`result.${key}`);return {...x,[key]:x[key]};}
function decodeEntries(value:unknown):CommandResult{const x=result(value), values=boundedArray(x.entries,"result.entries"); for(const [i,v] of values.entries()) {const item=boundedMap(v,`result.entries[${i}]`);safeRelativePath(item.path,`result.entries[${i}].path`);controlFree(item.kind,`result.entries[${i}].kind`,32);} return {...x,entries:values};}
function decodeAuditResult(value:unknown):CommandResult{const x=result(value), events=boundedArray(x.events,"result.events"); for(const [i,v] of events.entries()){const event=boundedMap(v,`result.events[${i}]`);controlFree(event.action,`result.events[${i}].action`,128);controlFree(event.actor,`result.events[${i}].actor`,256);} return {...x,events};}
function decodeCatalogResult(value:unknown):CommandResult{const x=result(value);return {...x,items:boundedArray(x.items,"result.items").map((v,i)=>metadata(v,`result.items[${i}]`))};}
function decodeTerminalResult(value:unknown):CommandResult{const x=result(value);terminalId(x.terminalId,"result.terminalId");return x;}
function decodeLeaseResult(value:unknown):CommandResult{const x=result(value);leaseId(x.leaseId,"result.leaseId");if(x.cursor!==undefined)decodeCursor(x.cursor,"result.cursor");return x;}
function decodeWatchResult(value:unknown):CommandResult{const x=result(value);controlFree(x.watchId,"result.watchId",256);decodeCursor(x.cursor,"result.cursor");return x;}
function decodePreviewCaptureResult(value:unknown):CommandResult{const x=result(value);const content=boundedText(x.content,"result.content",MAX_FILE_BYTES);if(!/^[A-Za-z0-9+/]*={0,2}$/u.test(content)||content.length%4!==0)fail("INVALID_FRAME","capture content must be base64","result.content");return x;}
export const COMMAND_ARGUMENT_DECODERS:Readonly<Record<string,(value:unknown)=>CommandArguments>>={
  "host.list":args,"session.list":args,"session.create":value=>{const x=args(value);if(x.cwd!==undefined)absPath(x.cwd,"args.cwd");if(x.title!==undefined)boundedText(x.title,"args.title",512);return x;},"session.attach":value=>{const x=args(value);if(x.cursor!==undefined)decodeCursor(x.cursor,"args.cursor");return x;},"session.prompt":value=>{const x=args(value);boundedText(x.message,"args.message",MAX_FILE_BYTES);return x;},"session.cancel":args,"session.close":args,
  "files.read":value=>{const x=args(value);safeRelativePath(x.path);return x;},"files.write":value=>{const x=args(value);safeRelativePath(x.path);boundedText(x.content,"args.content",MAX_FILE_BYTES);return x;},"files.patch":value=>{const x=args(value);safeRelativePath(x.path);boundedText(x.patch,"args.patch",MAX_FILE_BYTES);return x;},"files.list":value=>{const x=args(value);if(x.path!==undefined)safeRelativePath(x.path,"args.path");return x;},"files.diff":value=>{const x=args(value);safeRelativePath(x.path);return x;},"review.read":value=>{const x=args(value);controlFree(x.reviewId,"args.reviewId",256);return x;},"review.apply":value=>{const x=args(value);controlFree(x.reviewId,"args.reviewId",256);return x;},"agent.cancel":value=>{const x=args(value);controlFree(x.agentId,"args.agentId",256);return x;},"bash.run":value=>{const x=args(value);boundedText(x.command,"args.command",MAX_FILE_BYTES);return x;},
  "term.open":value=>{const x=args(value);if(x.cwd!==undefined)absPath(x.cwd,"args.cwd");if(x.shell!==undefined)controlFree(x.shell,"args.shell",256);if(x.env!==undefined){const env=boundedMap(x.env,"args.env");for(const [key,val] of Object.entries(env)){controlFree(key,`args.env.${key}`,128);boundedText(val,`args.env.${key}`,4096);}}if(x.cols!==undefined){const cols=safeSeq(x.cols,"args.cols");if(cols===0||cols>1000)fail("BOUNDS","invalid cols","args.cols");}if(x.rows!==undefined){const rows=safeSeq(x.rows,"args.rows");if(rows===0||rows>500)fail("BOUNDS","invalid rows","args.rows");}return x;},"audit.read":args,"audit.tail":value=>{const x=args(value);decodeCursor(x.cursor,"args.cursor");return x;},"config.write":value=>metadata(value,"args"),"settings.read":args,"settings.write":value=>metadata(value,"args"),"catalog.get":args,"host.watch":value=>{const x=args(value);decodeCursor(x.cursor,"args.cursor");return x;},"session.watch":value=>{const x=args(value);decodeCursor(x.cursor,"args.cursor");return x;},"controller.lease.acquire":value=>{const x=args(value);controlFree(x.ownerId,"args.ownerId",256);return x;},"controller.lease.renew":value=>{const x=args(value);leaseId(x.leaseId,"args.leaseId");return x;},"controller.lease.release":value=>{const x=args(value);leaseId(x.leaseId,"args.leaseId");return x;},"prompt.lease.acquire":value=>{const x=args(value);controlFree(x.ownerId,"args.ownerId",256);return x;},"prompt.lease.renew":value=>{const x=args(value);leaseId(x.leaseId,"args.leaseId");return x;},"prompt.lease.release":value=>{const x=args(value);leaseId(x.leaseId,"args.leaseId");return x;},"preview.launch":value=>{const x=args(value);url(x.url,"args.url");return x;},"preview.state":args,"preview.navigate":value=>{const x=args(value);url(x.url,"args.url");return x;},"preview.capture":args,
};
export const COMMAND_RESULT_DECODERS:Readonly<Record<string,(value:unknown)=>CommandResult>>={
  "host.list":decodeSessions,"session.list":decodeSessions,"session.create":decodeCreate,"session.attach":decodeAttach,"session.prompt":value=>boolField(value,"accepted"),"session.cancel":value=>boolField(value,"cancelled"),"session.close":value=>boolField(value,"closed"),"files.read":value=>{const x=result(value);boundedText(x.content,"result.content",MAX_FILE_BYTES);return x;},"files.write":result,"files.patch":result,"files.list":decodeEntries,"files.diff":value=>{const x=result(value);boundedText(x.diff,"result.diff",MAX_FILE_BYTES);return x;},"review.read":result,"review.apply":result,"agent.cancel":value=>boolField(value,"cancelled"),"bash.run":result,"term.open":decodeTerminalResult,"audit.read":decodeAuditResult,"audit.tail":decodeAuditResult,"config.write":value=>metadata(value,"result"),"settings.read":value=>metadata(value,"result"),"settings.write":value=>metadata(value,"result"),"catalog.get":decodeCatalogResult,"host.watch":decodeWatchResult,"session.watch":decodeWatchResult,"controller.lease.acquire":decodeLeaseResult,"controller.lease.renew":decodeLeaseResult,"controller.lease.release":decodeLeaseResult,"prompt.lease.acquire":decodeLeaseResult,"prompt.lease.renew":decodeLeaseResult,"prompt.lease.release":decodeLeaseResult,"preview.launch":result,"preview.state":result,"preview.navigate":result,"preview.capture":decodePreviewCaptureResult,
};
export function decodeCommandArguments(command:string,value:unknown):CommandArguments{const decoder=COMMAND_ARGUMENT_DECODERS[command];if(decoder===undefined)fail("INVALID_FRAME","command has no typed argument decoder","command");return decoder(value);} export function decodeCommandResult(command:string,value:unknown):CommandResult{const decoder=COMMAND_RESULT_DECODERS[command];if(decoder===undefined)fail("INVALID_FRAME","command has no typed result decoder","command");return decoder(value);}
