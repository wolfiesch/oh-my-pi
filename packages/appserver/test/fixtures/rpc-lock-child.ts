#!/usr/bin/env bun
import { postmortem, readJsonl } from "@oh-my-pi/pi-utils";
import { registerRpcSessionTeardown } from "../../../coding-agent/src/modes/rpc/rpc-session-teardown";
import { acquireSessionLock } from "../../../coding-agent/src/session/session-lock";

const sessionArg = process.argv.indexOf("--session");
const sessionPath = sessionArg >= 0 ? process.argv[sessionArg + 1] : undefined;
if (!sessionPath) throw new Error("--session is required");

const lock = acquireSessionLock(sessionPath);
const teardown = registerRpcSessionTeardown({
	beginDispose() {},
	cleanupProtocol() {},
	disposeSession: async () => lock.release(),
});
const output = (frame: Record<string, unknown>): void => {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
};

output({ type: "ready" });
for await (const value of readJsonl(Bun.stdin.stream())) {
	if (!value || typeof value !== "object" || Array.isArray(value)) continue;
	const frame = value as Record<string, unknown>;
	const id = typeof frame.id === "string" ? frame.id : undefined;
	if (typeof frame.type !== "string") continue;
	if (frame.type === "prompt") {
		output({ type: "agent_start" });
		output({ type: "turn_end" });
		output({ type: "agent_end", messages: [] });
		output({ type: "prompt_result", id, agentInvoked: true });
		output({ id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
		continue;
	}
	if (frame.type === "get_state") {
		output({
			id,
			type: "response",
			command: "get_state",
			success: true,
			data: {
				isStreaming: false,
				isCompacting: false,
				isPaused: false,
				messageCount: 2,
				queuedMessageCount: 0,
				steeringMode: "one-at-a-time",
				followUpMode: "all",
				interruptMode: "wait",
			},
		});
		continue;
	}
	output({ id, type: "response", command: frame.type, success: true, data: {} });
}

await teardown.shutdown();
await postmortem.quit(0);
process.exit(0);
