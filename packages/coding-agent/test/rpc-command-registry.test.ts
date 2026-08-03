import { describe, expect, test } from "bun:test";
import {
	getRpcCapabilityManifest,
	RPC_APPLICATION_API_VERSION,
	RPC_COMMAND_DEFINITIONS,
	validateRpcCommand,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-command-registry";

describe("RPC command registry", () => {
	test("projects every validated definition into a truthful descriptor", () => {
		const manifest = getRpcCapabilityManifest();
		const definitions = Object.entries(RPC_COMMAND_DEFINITIONS);

		expect(manifest.applicationApiVersion).toBe(RPC_APPLICATION_API_VERSION);
		expect(manifest.commands).toHaveLength(definitions.length);

		for (const [name, definition] of definitions) {
			const validation = validateRpcCommand(definition.example);
			expect(validation).toEqual({
				ok: true,
				command: definition.example,
				scheduling: definition.scheduling,
			});
			const capability = manifest.commands.find(descriptor => descriptor.name === name);
			expect(capability).toBeDefined();
			expect(capability?.id).toBe(`rpc.command.${name}`);
			expect(capability?.version).toBe(definition.version);
			expect(capability?.scope).toBe(definition.scope);
			expect(capability?.execution).toBe(definition.execution);
			expect(capability?.concurrencyClass).toBe(definition.concurrencyClass);
			expect(capability?.requiredFeatures).toEqual([...definition.requiredFeatures]);
			expect(capability?.inputSchema?.properties.type).toEqual({ const: name });
			expect(capability?.inputSchema?.additionalProperties).toBe(false);
		}
	});

	test("evaluates runtime-gated availability on every manifest query", () => {
		const unavailable = getRpcCapabilityManifest();
		const available = getRpcCapabilityManifest({ features: new Set(["subagent-event-bus", "model.fast-mode"]) });

		for (const name of ["set_subagent_subscription", "get_subagents", "get_subagent_messages", "set_fast_mode"]) {
			const conditional = unavailable.commands.find(command => command.name === name);
			const enabled = available.commands.find(command => command.name === name);
			expect(conditional?.availability).toBe("conditional");
			expect(conditional?.disabledReason).toBeUndefined();
			expect(enabled?.availability).toBe("available");
			expect(enabled?.disabledReason).toBeUndefined();
		}
	});

	test("preserves request ids on invalid and unsupported commands", () => {
		expect(validateRpcCommand({ id: "bad-1", type: "set_model", provider: "anthropic" })).toEqual({
			ok: false,
			id: "bad-1",
			command: "set_model",
			error: 'RPC command field "modelId" is required',
			code: "invalid_request",
		});
		expect(validateRpcCommand({ id: "bad-2", type: "future_command" })).toEqual({
			ok: false,
			id: "bad-2",
			command: "future_command",
			error: "Unknown RPC command: future_command",
			code: "unsupported_command",
		});
		expect(validateRpcCommand({ id: "bad-fast", type: "set_fast_mode", enabled: "yes" })).toEqual({
			ok: false,
			id: "bad-fast",
			command: "set_fast_mode",
			error: 'RPC command field "enabled" must be a boolean',
			code: "invalid_request",
		});
	});

	test("rejects unknown fields and normalizes legacy null optionals", () => {
		expect(validateRpcCommand({ id: "bad-3", type: "get_state", typo: true })).toEqual({
			ok: false,
			id: "bad-3",
			command: "get_state",
			error: 'RPC command field "typo" is not supported',
			code: "invalid_request",
		});
		expect(validateRpcCommand({ id: "ok-1", type: "compact", customInstructions: null })).toEqual({
			ok: true,
			command: { id: "ok-1", type: "compact" },
			scheduling: "serial",
		});
		const prompt = getRpcCapabilityManifest().commands.find(command => command.name === "prompt");
		expect(prompt?.inputSchema?.properties.streamingBehavior).toEqual({
			type: ["string", "null"],
			enum: ["steer", "followUp", null],
		});
	});
});
