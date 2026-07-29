import { describe, expect, test } from "bun:test";
import {
	getRpcCapabilityManifest,
	RPC_APPLICATION_API_VERSION,
	RPC_COMMAND_DEFINITIONS,
	validateRpcCommand,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-command-registry";

describe("RPC command registry", () => {
	test("covers every command with a valid example and advertised scheduling class", () => {
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
			expect(
				manifest.commands.some(
					capability =>
						capability.name === name &&
						capability.version === definition.version &&
						capability.scheduling === definition.scheduling,
				),
			).toBe(true);
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
	});
});
