import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import { isTodoPhase } from "../../tools/todo";
import type { RpcCapabilityManifest, RpcCommand, RpcCommandSchedulingClass, RpcCommandType } from "./rpc-types";

export const RPC_APPLICATION_API_VERSION = 1;

interface RpcFieldDefinition {
	optional: boolean;
	expected: string;
	validate(value: unknown): boolean;
}

interface RpcCommandDefinition<TCommand extends RpcCommand = RpcCommand> {
	version: number;
	scheduling: RpcCommandSchedulingClass;
	fields: Readonly<Record<string, RpcFieldDefinition>>;
	example: TCommand;
}

type RpcCommandDefinitions = {
	[TType in RpcCommandType]: RpcCommandDefinition<Extract<RpcCommand, { type: TType }>>;
};

function required(expected: string, validate: (value: unknown) => boolean): RpcFieldDefinition {
	return { optional: false, expected, validate };
}

function optional(expected: string, validate: (value: unknown) => boolean): RpcFieldDefinition {
	return { optional: true, expected, validate: value => value === null || validate(value) };
}

const stringField = required("a string", value => typeof value === "string");
const optionalStringField = optional("a string", value => typeof value === "string");
const booleanField = required("a boolean", value => typeof value === "boolean");
const optionalObjectArrayField = optional(
	"an array of objects",
	value => Array.isArray(value) && value.every(item => isRecord(item)),
);
const nonNegativeIntegerField = optional(
	"a non-negative integer",
	value => Number.isSafeInteger(value) && Number(value) >= 0,
);
const positiveIntegerField = optional("a positive integer", value => Number.isSafeInteger(value) && Number(value) > 0);

function enumField<const TValue extends string>(...values: readonly TValue[]): RpcFieldDefinition {
	return required(values.map(value => JSON.stringify(value)).join(" or "), value => values.includes(value as TValue));
}

function optionalEnumField<const TValue extends string>(...values: readonly TValue[]): RpcFieldDefinition {
	return optional(values.map(value => JSON.stringify(value)).join(" or "), value => values.includes(value as TValue));
}

function command<TCommand extends RpcCommand>(
	example: TCommand,
	fields: Readonly<Record<string, RpcFieldDefinition>> = {},
	scheduling: RpcCommandSchedulingClass = "serial",
): RpcCommandDefinition<TCommand> {
	return {
		version: 1,
		scheduling,
		fields,
		example,
	};
}

export const RPC_COMMAND_DEFINITIONS = {
	negotiate_protocol: command(
		{ type: "negotiate_protocol", protocolVersion: 2 },
		{ protocolVersion: required("an integer", value => Number.isSafeInteger(value)) },
	),
	get_capabilities: command({ type: "get_capabilities" }),
	prompt: command(
		{ type: "prompt", message: "hello" },
		{
			message: stringField,
			images: optionalObjectArrayField,
			streamingBehavior: optionalEnumField("steer", "followUp"),
		},
	),
	steer: command(
		{ type: "steer", message: "continue" },
		{ message: stringField, images: optionalObjectArrayField },
		"control",
	),
	follow_up: command(
		{ type: "follow_up", message: "then summarize" },
		{ message: stringField, images: optionalObjectArrayField },
		"control",
	),
	abort: command({ type: "abort" }, {}, "control"),
	abort_and_prompt: command(
		{ type: "abort_and_prompt", message: "try again" },
		{ message: stringField, images: optionalObjectArrayField },
		"control",
	),
	new_session: command({ type: "new_session" }, { parentSession: optionalStringField }),
	get_state: command({ type: "get_state" }),
	set_fast_mode: command({ type: "set_fast_mode", enabled: false }, { enabled: booleanField }),
	get_available_commands: command({ type: "get_available_commands" }),
	set_todos: command(
		{ type: "set_todos", phases: [] },
		{ phases: required("an array of valid todo phases", value => Array.isArray(value) && value.every(isTodoPhase)) },
	),
	set_host_tools: command(
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
	set_host_uri_schemes: command(
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
	set_subagent_subscription: command(
		{ type: "set_subagent_subscription", level: "off" },
		{ level: enumField("off", "progress", "events") },
	),
	get_subagents: command({ type: "get_subagents" }),
	get_subagent_messages: command(
		{ type: "get_subagent_messages" },
		{
			subagentId: optionalStringField,
			sessionFile: optionalStringField,
			fromByte: nonNegativeIntegerField,
		},
	),
	set_model: command(
		{ type: "set_model", provider: "anthropic", modelId: "claude" },
		{ provider: stringField, modelId: stringField },
	),
	cycle_model: command({ type: "cycle_model" }),
	get_available_models: command({ type: "get_available_models" }),
	set_thinking_level: command(
		{ type: "set_thinking_level", level: ThinkingLevel.Medium },
		{ level: enumField("inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max") },
	),
	cycle_thinking_level: command({ type: "cycle_thinking_level" }),
	set_steering_mode: command(
		{ type: "set_steering_mode", mode: "one-at-a-time" },
		{ mode: enumField("all", "one-at-a-time") },
	),
	set_follow_up_mode: command(
		{ type: "set_follow_up_mode", mode: "one-at-a-time" },
		{ mode: enumField("all", "one-at-a-time") },
	),
	set_interrupt_mode: command(
		{ type: "set_interrupt_mode", mode: "immediate" },
		{ mode: enumField("immediate", "wait") },
	),
	compact: command({ type: "compact" }, { customInstructions: optionalStringField }),
	set_auto_compaction: command({ type: "set_auto_compaction", enabled: true }, { enabled: booleanField }),
	set_auto_retry: command({ type: "set_auto_retry", enabled: true }, { enabled: booleanField }),
	abort_retry: command({ type: "abort_retry" }, {}, "control"),
	bash: command({ type: "bash", command: "pwd" }, { command: stringField }, "concurrent"),
	abort_bash: command({ type: "abort_bash" }, {}, "control"),
	get_session_stats: command({ type: "get_session_stats" }),
	export_html: command({ type: "export_html" }, { outputPath: optionalStringField }),
	switch_session: command({ type: "switch_session", sessionPath: "/tmp/session.jsonl" }, { sessionPath: stringField }),
	branch: command({ type: "branch", entryId: "entry-1" }, { entryId: stringField }),
	get_branch_messages: command({ type: "get_branch_messages" }),
	get_last_assistant_text: command({ type: "get_last_assistant_text" }),
	set_session_name: command({ type: "set_session_name", name: "Session" }, { name: stringField }),
	handoff: command({ type: "handoff" }, { customInstructions: optionalStringField }),
	get_messages: command({ type: "get_messages" }),
	get_messages_page: command(
		{ type: "get_messages_page" },
		{ cursor: optionalStringField, limit: positiveIntegerField },
	),
	get_login_providers: command({ type: "get_login_providers" }),
	login: command({ type: "login", providerId: "anthropic" }, { providerId: stringField }),
} as const satisfies RpcCommandDefinitions;

const RPC_EVENT_CAPABILITIES = [
	"ready",
	"prompt_result",
	"available_commands_update",
	"command_output",
	"session_info_update",
	"config_update",
	"extension_ui_request",
	"extension_error",
	"host_tool_call",
	"host_tool_cancel",
	"host_uri_request",
	"host_uri_cancel",
	"subagent_lifecycle",
	"subagent_progress",
	"subagent_event",
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"retry_fallback_applied",
	"retry_fallback_succeeded",
	"ttsr_triggered",
	"todo_reminder",
	"todo_auto_clear",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"goal_updated",
] as const;

const RPC_EXTENSION_UI_METHODS = [
	"select",
	"confirm",
	"input",
	"editor",
	"cancel",
	"notify",
	"setStatus",
	"setWidget",
	"setTitle",
	"set_editor_text",
	"open_url",
] as const;

export function getRpcCapabilityManifest(): RpcCapabilityManifest {
	return {
		applicationApiVersion: RPC_APPLICATION_API_VERSION,
		commands: Object.entries(RPC_COMMAND_DEFINITIONS).map(([name, definition]) => ({
			name: name as RpcCommandType,
			version: definition.version,
			scheduling: definition.scheduling,
		})),
		events: [...RPC_EVENT_CAPABILITIES],
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
