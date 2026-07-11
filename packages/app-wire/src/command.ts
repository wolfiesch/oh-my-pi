import { fail } from "./errors.ts";
import {
	commandId,
	confirmationId,
	hostId,
	requestId,
	revision,
	sessionId,
	type CommandId,
	type ConfirmationId,
	type HostId,
	type RequestId,
	type Revision,
	type SessionId,
} from "./ids.ts";
import { boundedMap, inputObject, safeRelativePath, controlFree } from "./guards.ts";
import { PROTOCOL_VERSION } from "./limits.ts";
import type { DeviceCapability } from "./capabilities.ts";
export interface CommandDescriptor {
	capability: DeviceCapability;
	scope: "host" | "session";
	revision: "none" | "optional" | "required";
	confirmation: "none" | "challenge";
}
export const COMMAND_DESCRIPTORS: Readonly<Record<string, CommandDescriptor>> = {
	"host.list": { capability: "sessions.read", scope: "host", revision: "none", confirmation: "none" },
	"session.list": { capability: "sessions.read", scope: "host", revision: "none", confirmation: "none" },
	"session.prompt": { capability: "sessions.prompt", scope: "session", revision: "optional", confirmation: "none" },
	"session.cancel": {
		capability: "sessions.control",
		scope: "session",
		revision: "optional",
		confirmation: "challenge",
	},
	"session.close": {
		capability: "sessions.manage",
		scope: "session",
		revision: "required",
		confirmation: "challenge",
	},
	"files.read": { capability: "files.read", scope: "session", revision: "optional", confirmation: "none" },
	"files.write": { capability: "files.write", scope: "session", revision: "required", confirmation: "challenge" },
	"files.patch": { capability: "files.write", scope: "session", revision: "required", confirmation: "challenge" },
	"review.read": { capability: "files.read", scope: "session", revision: "optional", confirmation: "none" },
	"review.apply": { capability: "files.write", scope: "session", revision: "required", confirmation: "challenge" },
	"agent.cancel": { capability: "agents.control", scope: "session", revision: "optional", confirmation: "challenge" },
	"bash.run": { capability: "bash.run", scope: "session", revision: "optional", confirmation: "challenge" },
	"term.open": { capability: "term.open", scope: "session", revision: "optional", confirmation: "challenge" },
	"audit.read": { capability: "audit.read", scope: "host", revision: "none", confirmation: "none" },
	"config.write": { capability: "config.write", scope: "host", revision: "required", confirmation: "challenge" },
};
export const COMMAND_CAPABILITIES: Readonly<Record<string, DeviceCapability>> = Object.fromEntries(
	Object.entries(COMMAND_DESCRIPTORS).map(([name, descriptor]) => [name, descriptor.capability]),
);
export interface CommandFrame {
	v: typeof PROTOCOL_VERSION;
	type: "command";
	requestId: RequestId;
	commandId: CommandId;
	hostId: HostId;
	sessionId?: SessionId;
	command: string;
	expectedRevision?: Revision;
	confirmationId?: ConfirmationId;
	args: Record<string, unknown>;
}
const FILE_COMMANDS: Record<string, true> = {
	"files.read": true,
	"files.write": true,
	"files.patch": true,
	"review.read": true,
	"review.apply": true,
};
export function decodeCommand(input: unknown): CommandFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "command") fail("INVALID_FRAME", "expected command frame", "type");
	requestId(frame.requestId);
	commandId(frame.commandId);
	const host = hostId(frame.hostId);
	const command = controlFree(frame.command, "command", 128);
	const descriptor = COMMAND_DESCRIPTORS[command];
	if (!descriptor) fail("INVALID_FRAME", "unknown command", "command");
	const session = frame.sessionId === undefined ? undefined : sessionId(frame.sessionId);
	if (descriptor.scope === "session" && session === undefined)
		fail("INVALID_FRAME", "sessionId is required for session command", "sessionId");
	if (descriptor.scope === "host" && session !== undefined)
		fail("INVALID_FRAME", "sessionId is forbidden for host command", "sessionId");
	if (descriptor.revision === "required" && frame.expectedRevision === undefined)
		fail("STALE_REVISION", "expectedRevision is required", "expectedRevision");
	if (frame.expectedRevision !== undefined) revision(frame.expectedRevision);
	if (descriptor.confirmation === "none" && frame.confirmationId !== undefined)
		fail("CONFIRMATION_INVALID", "confirmationId is not valid for this command", "confirmationId");
	if (frame.confirmationId !== undefined) confirmationId(frame.confirmationId);
	const args = frame.args === undefined ? {} : boundedMap(frame.args, "args");
	if (FILE_COMMANDS[command])
		for (const key of ["path", "filePath", "targetPath", "cwd"])
			if (args[key] !== undefined) safeRelativePath(args[key], `args.${key}`);
	return { ...frame, hostId: host, sessionId: session, command, args } as unknown as CommandFrame;
}
export function requiredCapability(command: string): DeviceCapability | undefined {
	return COMMAND_DESCRIPTORS[command]?.capability;
}
