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
			expect(capability?.confirmation).toBe(definition.confirmation);
			expect(capability?.requiredFeatures).toEqual([...definition.requiredFeatures]);
			expect(capability?.inputSchema?.properties.type).toEqual({ const: name });
			expect(capability?.inputSchema?.additionalProperties).toBe(false);
		}
	});

	test("advertises authoritative serial tool inventory reads and update signals in API v2", () => {
		const manifest = getRpcCapabilityManifest();
		expect(manifest.applicationApiVersion).toBe(2);
		expect(RPC_COMMAND_DEFINITIONS.get_tool_inventory.scheduling).toBe("serial");
		expect(manifest.commands.find(command => command.name === "get_tool_inventory")).toMatchObject({
			scope: "session",
			concurrencyClass: "serial",
			availability: "available",
		});
		expect(manifest.events).toContain("tool_inventory_update");
		expect(RPC_COMMAND_DEFINITIONS.set_tool_activation.scheduling).toBe("serial");
		expect(manifest.commands.find(command => command.name === "set_tool_activation")).toMatchObject({
			scope: "session",
			execution: "sync",
			concurrencyClass: "serial",
			availability: "available",
			inputSchema: {
				properties: {
					activate: { type: "array", maxItems: 2048, items: { "x-maxUtf8Bytes": 256 } },
					deactivate: { type: "array", maxItems: 2048, items: { "x-maxUtf8Bytes": 256 } },
				},
				required: ["type"],
			},
		});
	});
	test("advertises bounded queue and owner-scoped job controls", () => {
		const manifest = getRpcCapabilityManifest();
		for (const name of ["get_queue", "remove_queued_message", "reorder_queued_message", "clear_queue"]) {
			expect(manifest.commands.find(command => command.name === name)).toMatchObject({
				scope: "session",
				execution: "sync",
				concurrencyClass: "control",
			});
		}
		expect(manifest.commands.find(command => command.name === "cancel_job")).toMatchObject({
			scope: "agent",
			concurrencyClass: "control",
			inputSchema: { properties: { jobIds: { maxItems: 64, uniqueItems: true } } },
		});
		expect(manifest.events).toEqual(expect.arrayContaining(["queue_update", "job_update"]));
		expect(
			validateRpcCommand({ type: "cancel_job", jobIds: Array.from({ length: 65 }, (_, i) => `job-${i}`) }),
		).toMatchObject({
			ok: false,
			code: "invalid_request",
		});
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

	test("advertises advisor reads as concurrent and mutations as serial", () => {
		const manifest = getRpcCapabilityManifest();
		const read = manifest.commands.find(command => command.name === "get_advisor_state");
		const mutation = manifest.commands.find(command => command.name === "set_advisor_enabled");

		expect(read).toMatchObject({ scope: "session", concurrencyClass: "concurrent" });
		expect(mutation).toMatchObject({ scope: "session", concurrencyClass: "serial" });
		expect(validateRpcCommand({ type: "get_advisor_state" })).toMatchObject({
			ok: true,
			scheduling: "concurrent",
		});
		expect(validateRpcCommand({ type: "set_advisor_enabled", enabled: false })).toMatchObject({
			ok: true,
			scheduling: "serial",
		});
		expect(validateRpcCommand({ type: "get_advisor_state", enabled: true })).toMatchObject({
			ok: false,
			code: "invalid_request",
		});
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

	test("advertises the complete session catalog surface with truthful concurrency", () => {
		const manifest = getRpcCapabilityManifest();
		const expected = {
			list_sessions: ["host", "concurrent"],
			get_session_info: ["host", "concurrent"],
			list_workspace_roots: ["host", "concurrent"],
			resume_session: ["session", "serial"],
			fork_session: ["session", "serial"],
			rename_session: ["host", "serial"],
			delete_session: ["host", "serial"],
		} as const;

		for (const [name, [scope, concurrencyClass]] of Object.entries(expected)) {
			const command = manifest.commands.find(candidate => candidate.name === name);
			expect(command).toMatchObject({
				availability: "available",
				execution: "sync",
				scope,
				concurrencyClass,
			});
		}

		const deleteSession = manifest.commands.find(candidate => candidate.name === "delete_session");
		expect(deleteSession?.confirmation).toBe("required");
		expect(manifest.commands.find(candidate => candidate.name === "rename_session")?.confirmation).toBe("none");
	});
});
