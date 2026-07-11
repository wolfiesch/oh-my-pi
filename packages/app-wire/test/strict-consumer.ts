import {
	APP_WIRE_VERSION,
	COMMAND_DESCRIPTORS,
	commandId,
	decodeClientFrame,
	decodeServerFrame,
	hostId,
	requestId,
	type AppFrame,
	type CommandFrame,
	type ResultFrame,
} from "../src/index.ts";

const command: CommandFrame = {
	v: "omp-app/1",
	type: "command",
	requestId: requestId("request"),
	commandId: commandId("command"),
	hostId: hostId("host"),
	command: "session.create",
	args: {},
};
const decoded: AppFrame = decodeClientFrame(command);
const result: ResultFrame = {
	v: "omp-app/1",
	type: "response",
	requestId: requestId("request"),
	commandId: commandId("command"),
	hostId: hostId("host"),
	ok: true,
};
void decodeServerFrame(result);
void decoded;
void APP_WIRE_VERSION;
void COMMAND_DESCRIPTORS["session.create"];
