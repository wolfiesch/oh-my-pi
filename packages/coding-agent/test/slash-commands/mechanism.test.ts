import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import {
	launchMechanismServer,
	parseMechanismArgs,
	stopMechanismServer,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/mechanism";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";

function createRuntimeHarness() {
	const setText = mock((_text: string) => {});
	const showStatus = mock((_text: string) => {});
	const ctx = {
		editor: { setText },
		showStatus,
		sessionManager: { getCwd: () => "/tmp" },
		settings: {},
		session: {},
		refreshSlashCommandState: async () => {},
	} as unknown as InteractiveModeContext;
	return { setText, showStatus, runtime: { ctx } as BuiltinSlashCommandRuntime };
}

function createAgentSession(sessionId: string): AgentSession {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getRecentEntries: () => [],
			subscribeEntryAppended: () => () => {},
		},
		subscribe: () => () => {},
		onDispose: () => () => {},
		deliverIrcMessage: async () => "injected" as const,
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
}

describe("/mechanism slash command routing", () => {
	beforeEach(() => {
		stopMechanismServer();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(() => {
		stopMechanismServer();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		mock.restore();
	});

	it("resolves /mechanism to the builtin command, not a skill namespace", () => {
		const parsed = parseSlashCommand("/mechanism --bad");

		expect(parsed?.name).toBe("mechanism");
		expect(lookupBuiltinSlashCommand(parsed!.name)?.name).toBe("mechanism");
		expect(lookupBuiltinSlashCommand("skill")).toBeUndefined();
	});

	it("consumes invalid mechanism args in the builtin handler", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/mechanism --bad", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith("Unknown option: --bad. Usage: /mechanism [on|off]");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("parses explicit mechanism on/off actions", () => {
		expect(parseMechanismArgs("")).toEqual({ action: "on", port: 3848 });
		expect(parseMechanismArgs("on --port 4321")).toEqual({ action: "on", port: 4321 });
		expect(parseMechanismArgs("off")).toEqual({ action: "off", port: 3848 });
		expect(parseMechanismArgs("stop -p 4321")).toEqual({ action: "off", port: 4321 });
		expect(parseMechanismArgs("on off")).toEqual({
			error: "Multiple mechanism actions provided. Usage: /mechanism [on|off]",
		});
	});

	it("handles /mechanism off without launching or killing the host process", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/mechanism off", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith("Mechanism server is not running.");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("unsubscribes the IRC delivery observer when mechanism stops", async () => {
		const pushIrc = mock((_from: string, _to: string) => []);
		const stop = mock(() => {});
		const noopEvents = () => [];
		mock.module("@oh-my-pi/omp-mechanism", () => ({
			startRuntimeServer: async () => ({
				port: 4999,
				stop,
				reset: noopEvents,
				pushRoster: noopEvents,
				pushAgent: noopEvents,
				removeAgent: noopEvents,
				pushStatus: noopEvents,
				pushEntry: noopEvents,
				pushAgentEvent: noopEvents,
				pushIrc,
				pushCompaction: noopEvents,
				pushRetry: noopEvents,
				pushFallback: noopEvents,
				pushThinking: noopEvents,
				pushNotice: noopEvents,
			}),
		}));

		const registry = AgentRegistry.global();
		registry.register({
			id: "Main",
			displayName: "main",
			kind: "main",
			session: createAgentSession("main-session"),
		});
		registry.register({
			id: "Scout",
			displayName: "task",
			kind: "sub",
			session: createAgentSession("scout-session"),
		});

		await launchMechanismServer(createAgentSession("host-session"), 4999);
		await IrcBus.global().send({ from: "Main", to: "Scout", body: "first" });
		expect(pushIrc).toHaveBeenCalledTimes(1);
		expect(pushIrc).toHaveBeenCalledWith("Main", "Scout");

		expect(stopMechanismServer()).toBe(true);
		expect(stop).toHaveBeenCalledTimes(1);

		await IrcBus.global().send({ from: "Main", to: "Scout", body: "after stop" });
		expect(pushIrc).toHaveBeenCalledTimes(1);
	});
});
