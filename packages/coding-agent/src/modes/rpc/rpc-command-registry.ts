import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import { isTodoPhase } from "../../tools/todo";
import {
	RPC_EVENT_TYPES,
	RPC_EXTENSION_UI_METHODS,
	type RpcCapabilityDisabledReason,
	type RpcCapabilityManifest,
	type RpcCommand,
	type RpcCommandConcurrencyClass,
	type RpcCommandExecution,
	type RpcCommandSchedulingClass,
	type RpcCommandScope,
	type RpcCommandType,
	type RpcInputSchema,
} from "./rpc-types";

export const RPC_APPLICATION_API_VERSION = 1;

interface RpcFieldDefinition {
	optional: boolean;
	expected: string;
	schema: Readonly<Record<string, unknown>>;
	validate(value: unknown): boolean;
}

export interface RpcCapabilityContext {
	features?: ReadonlySet<string>;
}

type RpcCommandAvailabilityResult =
	| { availability: "available" | "conditional"; disabledReason?: never }
	| { availability: "unavailable"; disabledReason: RpcCapabilityDisabledReason };

interface RpcCommandMetadata {
	version: number;
	scope: RpcCommandScope;
	execution: RpcCommandExecution;
	concurrencyClass?: RpcCommandConcurrencyClass;
	requiredFeatures: readonly string[];
	availability(context: RpcCapabilityContext): RpcCommandAvailabilityResult;
}

interface RpcCommandDefinition<TCommand extends RpcCommand = RpcCommand> extends RpcCommandMetadata {
	scheduling: RpcCommandSchedulingClass;
	fields: Readonly<Record<string, RpcFieldDefinition>>;
	example: TCommand;
}

type RpcCommandDefinitions = {
	[TType in RpcCommandType]: RpcCommandDefinition<Extract<RpcCommand, { type: TType }>>;
};

function required(
	expected: string,
	validate: (value: unknown) => boolean,
	schema: Readonly<Record<string, unknown>> = { description: expected },
): RpcFieldDefinition {
	return { optional: false, expected, schema, validate };
}

function optional(
	expected: string,
	validate: (value: unknown) => boolean,
	schema: Readonly<Record<string, unknown>> = { description: expected },
): RpcFieldDefinition {
	return { optional: true, expected, schema, validate: value => value === null || validate(value) };
}

const stringField = required("a string", value => typeof value === "string", { type: "string" });
const optionalStringField = optional("a string", value => typeof value === "string", {
	type: ["string", "null"],
});
const booleanField = required("a boolean", value => typeof value === "boolean", { type: "boolean" });
const optionalObjectArrayField = optional(
	"an array of objects",
	value => Array.isArray(value) && value.every(item => isRecord(item)),
	{ type: ["array", "null"], items: { type: "object" } },
);
const nonNegativeIntegerField = optional(
	"a non-negative integer",
	value => Number.isSafeInteger(value) && Number(value) >= 0,
	{ type: ["integer", "null"], minimum: 0 },
);
const positiveIntegerField = optional("a positive integer", value => Number.isSafeInteger(value) && Number(value) > 0, {
	type: ["integer", "null"],
	minimum: 1,
});

function enumField<const TValue extends string>(...values: readonly TValue[]): RpcFieldDefinition {
	return required(values.map(value => JSON.stringify(value)).join(" or "), value => values.includes(value as TValue), {
		type: "string",
		enum: values,
	});
}

function optionalEnumField<const TValue extends string>(...values: readonly TValue[]): RpcFieldDefinition {
	return optional(values.map(value => JSON.stringify(value)).join(" or "), value => values.includes(value as TValue), {
		type: ["string", "null"],
		enum: [...values, null],
	});
}

const AVAILABLE: RpcCommandAvailabilityResult = { availability: "available" };

function requiresFeature(feature: string): Pick<RpcCommandMetadata, "requiredFeatures" | "availability"> {
	return {
		requiredFeatures: [feature],
		availability: context => ({
			availability: context.features?.has(feature) ? "available" : "conditional",
		}),
	};
}

type RpcCommandMetadataOverrides = Partial<
	Pick<RpcCommandMetadata, "version" | "execution" | "requiredFeatures" | "availability">
>;

function classifiedCommand<TCommand extends RpcCommand>(
	scope: RpcCommandScope,
	example: TCommand,
	fields: Readonly<Record<string, RpcFieldDefinition>> = {},
	scheduling: RpcCommandSchedulingClass = "serial",
	metadata: RpcCommandMetadataOverrides = {},
): RpcCommandDefinition<TCommand> {
	return {
		version: metadata.version ?? 1,
		scope,
		execution: metadata.execution ?? "sync",
		concurrencyClass: scheduling,
		requiredFeatures: metadata.requiredFeatures ?? [],
		availability: metadata.availability ?? (() => AVAILABLE),
		scheduling,
		fields,
		example,
	};
}

const hostCommand = <TCommand extends RpcCommand>(
	example: TCommand,
	fields: Readonly<Record<string, RpcFieldDefinition>> = {},
	scheduling: RpcCommandSchedulingClass = "serial",
	metadata: RpcCommandMetadataOverrides = {},
) => classifiedCommand("host", example, fields, scheduling, metadata);

const sessionCommand = <TCommand extends RpcCommand>(
	example: TCommand,
	fields: Readonly<Record<string, RpcFieldDefinition>> = {},
	scheduling: RpcCommandSchedulingClass = "serial",
	metadata: RpcCommandMetadataOverrides = {},
) => classifiedCommand("session", example, fields, scheduling, metadata);

const turnCommand = <TCommand extends RpcCommand>(
	example: TCommand,
	fields: Readonly<Record<string, RpcFieldDefinition>> = {},
	scheduling: RpcCommandSchedulingClass = "serial",
	metadata: RpcCommandMetadataOverrides = {},
) => classifiedCommand("turn", example, fields, scheduling, metadata);

const agentCommand = <TCommand extends RpcCommand>(
	example: TCommand,
	fields: Readonly<Record<string, RpcFieldDefinition>> = {},
	scheduling: RpcCommandSchedulingClass = "serial",
	metadata: RpcCommandMetadataOverrides = {},
) => classifiedCommand("agent", example, fields, scheduling, metadata);

export const RPC_COMMAND_DEFINITIONS = {
	negotiate_protocol: hostCommand(
		{ type: "negotiate_protocol", protocolVersion: 2 },
		{ protocolVersion: required("an integer", value => Number.isSafeInteger(value)) },
	),
	get_capabilities: hostCommand({ type: "get_capabilities" }),
	prompt: turnCommand(
		{ type: "prompt", message: "hello" },
		{
			message: stringField,
			images: optionalObjectArrayField,
			streamingBehavior: optionalEnumField("steer", "followUp"),
		},
		"serial",
		{ execution: "operation" },
	),
	steer: turnCommand(
		{ type: "steer", message: "continue" },
		{ message: stringField, images: optionalObjectArrayField },
		"control",
	),
	follow_up: turnCommand(
		{ type: "follow_up", message: "then summarize" },
		{ message: stringField, images: optionalObjectArrayField },
		"control",
	),
	abort: turnCommand({ type: "abort" }, {}, "control"),
	abort_and_prompt: turnCommand(
		{ type: "abort_and_prompt", message: "try again" },
		{ message: stringField, images: optionalObjectArrayField },
		"control",
		{ execution: "operation" },
	),
	cancel_operation: turnCommand(
		{ type: "cancel_operation", operationId: "operation-1" },
		{ operationId: stringField },
		"control",
	),
	new_session: sessionCommand({ type: "new_session" }, { parentSession: optionalStringField }),
	get_state: sessionCommand({ type: "get_state" }),
	get_operations: sessionCommand({ type: "get_operations" }, {}, "concurrent"),
	set_fast_mode: sessionCommand(
		{ type: "set_fast_mode", enabled: false },
		{ enabled: booleanField },
		"serial",
		requiresFeature("model.fast-mode"),
	),
	get_available_commands: sessionCommand({ type: "get_available_commands" }),
	set_todos: sessionCommand(
		{ type: "set_todos", phases: [] },
		{ phases: required("an array of valid todo phases", value => Array.isArray(value) && value.every(isTodoPhase)) },
	),
	set_host_tools: hostCommand(
		{ type: "set_host_tools", tools: [] },
		{
			tools: required(
				"an array of host tool definitions",
				value =>
					Array.isArray(value) &&
					value.every(
						tool =>
							isRecord(tool) &&
							typeof tool.name === "string" &&
							typeof tool.description === "string" &&
							isRecord(tool.parameters),
					),
			),
		},
	),
	set_host_uri_schemes: hostCommand(
		{ type: "set_host_uri_schemes", schemes: [] },
		{
			schemes: required(
				"an array of host URI scheme definitions",
				value =>
					Array.isArray(value) &&
					value.every(
						scheme =>
							isRecord(scheme) &&
							typeof scheme.scheme === "string" &&
							(scheme.description === undefined || typeof scheme.description === "string") &&
							(scheme.writable === undefined || typeof scheme.writable === "boolean") &&
							(scheme.immutable === undefined || typeof scheme.immutable === "boolean"),
					),
			),
		},
	),
	set_subagent_subscription: agentCommand(
		{ type: "set_subagent_subscription", level: "off" },
		{ level: enumField("off", "progress", "events") },
		"serial",
		requiresFeature("subagent-event-bus"),
	),
	get_subagents: agentCommand({ type: "get_subagents" }, {}, "serial", requiresFeature("subagent-event-bus")),
	get_subagent_messages: agentCommand(
		{ type: "get_subagent_messages" },
		{
			subagentId: optionalStringField,
			sessionFile: optionalStringField,
			fromByte: nonNegativeIntegerField,
		},
		"serial",
		requiresFeature("subagent-event-bus"),
	),
	set_model: sessionCommand(
		{ type: "set_model", provider: "anthropic", modelId: "claude" },
		{ provider: stringField, modelId: stringField },
	),
	cycle_model: sessionCommand({ type: "cycle_model" }),
	get_available_models: sessionCommand({ type: "get_available_models" }),
	set_thinking_level: sessionCommand(
		{ type: "set_thinking_level", level: ThinkingLevel.Medium },
		{ level: enumField("inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max") },
	),
	cycle_thinking_level: sessionCommand({ type: "cycle_thinking_level" }),
	set_steering_mode: sessionCommand(
		{ type: "set_steering_mode", mode: "one-at-a-time" },
		{ mode: enumField("all", "one-at-a-time") },
	),
	set_follow_up_mode: sessionCommand(
		{ type: "set_follow_up_mode", mode: "one-at-a-time" },
		{ mode: enumField("all", "one-at-a-time") },
	),
	set_interrupt_mode: sessionCommand(
		{ type: "set_interrupt_mode", mode: "immediate" },
		{ mode: enumField("immediate", "wait") },
	),
	compact: sessionCommand({ type: "compact" }, { customInstructions: optionalStringField }),
	set_auto_compaction: sessionCommand({ type: "set_auto_compaction", enabled: true }, { enabled: booleanField }),
	set_auto_retry: sessionCommand({ type: "set_auto_retry", enabled: true }, { enabled: booleanField }),
	abort_retry: sessionCommand({ type: "abort_retry" }, {}, "control"),
	bash: sessionCommand({ type: "bash", command: "pwd" }, { command: stringField }, "concurrent"),
	abort_bash: sessionCommand({ type: "abort_bash" }, {}, "control"),
	get_session_stats: sessionCommand({ type: "get_session_stats" }),
	export_html: sessionCommand({ type: "export_html" }, { outputPath: optionalStringField }),
	switch_session: sessionCommand(
		{ type: "switch_session", sessionPath: "/tmp/session.jsonl" },
		{ sessionPath: stringField },
	),
	branch: sessionCommand({ type: "branch", entryId: "entry-1" }, { entryId: stringField }),
	get_branch_messages: sessionCommand({ type: "get_branch_messages" }),
	get_last_assistant_text: sessionCommand({ type: "get_last_assistant_text" }),
	set_session_name: sessionCommand({ type: "set_session_name", name: "Session" }, { name: stringField }),
	handoff: sessionCommand({ type: "handoff" }, { customInstructions: optionalStringField }),
	get_messages: sessionCommand({ type: "get_messages" }),
	get_messages_page: sessionCommand(
		{ type: "get_messages_page" },
		{ cursor: optionalStringField, limit: positiveIntegerField },
	),
	get_login_providers: hostCommand({ type: "get_login_providers" }),
	login: hostCommand({ type: "login", providerId: "anthropic" }, { providerId: stringField }),
} as const satisfies RpcCommandDefinitions;

function inputSchemaFor(name: RpcCommandType, definition: RpcCommandDefinition): RpcInputSchema {
	const properties: Record<string, Record<string, unknown>> = {
		id: { type: "string" },
		type: { const: name },
	};
	const requiredFields = ["type"];
	for (const [fieldName, field] of Object.entries(definition.fields)) {
		const example = (definition.example as unknown as Record<string, unknown>)[fieldName];
		properties[fieldName] = example === undefined ? { ...field.schema } : { ...field.schema, example };
		if (!field.optional) requiredFields.push(fieldName);
	}
	return { type: "object", properties, required: requiredFields, additionalProperties: false };
}

export function getRpcCapabilityManifest(context: RpcCapabilityContext = {}): RpcCapabilityManifest {
	return {
		applicationApiVersion: RPC_APPLICATION_API_VERSION,
		commands: Object.entries(RPC_COMMAND_DEFINITIONS).map(([name, definition]) => {
			const availability = definition.availability(context);
			const descriptor = {
				id: `rpc.command.${name}`,
				name: name as RpcCommandType,
				version: definition.version,
				scope: definition.scope,
				execution: definition.execution,
				inputSchema: inputSchemaFor(name as RpcCommandType, definition),
				concurrencyClass: definition.concurrencyClass,
				requiredFeatures: [...definition.requiredFeatures],
			};
			return availability.availability === "unavailable"
				? { ...descriptor, availability: "unavailable" as const, disabledReason: availability.disabledReason }
				: { ...descriptor, availability: availability.availability };
		}),
		events: [...RPC_EVENT_TYPES],
		extensionUiMethods: [...RPC_EXTENSION_UI_METHODS],
		hostProtocols: ["tools", "uris"],
	};
}

export interface RpcCommandValidationFailure {
	ok: false;
	id?: string;
	command: string;
	error: string;
	code: "invalid_request" | "unsupported_command";
}

export type RpcCommandValidationResult =
	| { ok: true; command: RpcCommand; scheduling: RpcCommandSchedulingClass }
	| RpcCommandValidationFailure;

export function validateRpcCommand(value: unknown): RpcCommandValidationResult {
	if (!isRecord(value)) {
		return {
			ok: false,
			command: "parse",
			error: "RPC command must be a JSON object",
			code: "invalid_request",
		};
	}

	const id = typeof value.id === "string" ? value.id : undefined;
	if (value.id !== undefined && id === undefined) {
		return {
			ok: false,
			command: typeof value.type === "string" ? value.type : "parse",
			error: 'RPC command field "id" must be a string',
			code: "invalid_request",
		};
	}
	if (typeof value.type !== "string") {
		return {
			ok: false,
			id,
			command: "parse",
			error: 'RPC command field "type" must be a string',
			code: "invalid_request",
		};
	}

	const definitions: Readonly<Record<string, RpcCommandDefinition>> = RPC_COMMAND_DEFINITIONS;
	const definition = definitions[value.type];
	if (!definition) {
		return {
			ok: false,
			id,
			command: value.type,
			error: `Unknown RPC command: ${value.type}`,
			code: "unsupported_command",
		};
	}

	for (const [fieldName, field] of Object.entries(definition.fields)) {
		const fieldValue = value[fieldName];
		if (fieldValue === undefined) {
			if (field.optional) continue;
			return {
				ok: false,
				id,
				command: value.type,
				error: `RPC command field "${fieldName}" is required`,
				code: "invalid_request",
			};
		}
		if (!field.validate(fieldValue)) {
			return {
				ok: false,
				id,
				command: value.type,
				error: `RPC command field "${fieldName}" must be ${field.expected}`,
				code: "invalid_request",
			};
		}
	}

	const allowedFields = new Set(["id", "type", ...Object.keys(definition.fields)]);
	for (const fieldName of Object.keys(value)) {
		if (allowedFields.has(fieldName)) continue;
		return {
			ok: false,
			id,
			command: value.type,
			error: `RPC command field "${fieldName}" is not supported`,
			code: "invalid_request",
		};
	}

	const normalized = { ...value };
	for (const [fieldName, field] of Object.entries(definition.fields)) {
		if (field.optional && normalized[fieldName] === null) delete normalized[fieldName];
	}

	return {
		ok: true,
		command: normalized as RpcCommand,
		scheduling: definition.scheduling,
	};
}
