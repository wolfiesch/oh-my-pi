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
}
export const COMMAND_DESCRIPTORS: Readonly<Record<string, CommandDescriptor>> = {
	"host.list": { capability: "sessions.read", scope: "host" },
	"session.list": { capability: "sessions.read", scope: "host" },
	"session.prompt": { capability: "sessions.prompt", scope: "session" },
	"session.cancel": { capability: "sessions.control", scope: "session" },
	"session.close": { capability: "sessions.manage", scope: "session" },
	"files.read": { capability: "files.read", scope: "session" },
	"files.write": { capability: "files.read", scope: "session" },
	"files.patch": { capability: "files.read", scope: "session" },
	"review.read": { capability: "files.read", scope: "session" },
	"review.apply": { capability: "files.read", scope: "session" },
	"agent.cancel": { capability: "agents.control", scope: "session" },
	"bash.run": { capability: "bash.run", scope: "session" },
	"term.open": { capability: "term.open", scope: "session" },
	"audit.read": { capability: "audit.read", scope: "host" },
	"config.write": { capability: "config.write", scope: "host" },
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
	if (frame.expectedRevision !== undefined) revision(frame.expectedRevision);
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
