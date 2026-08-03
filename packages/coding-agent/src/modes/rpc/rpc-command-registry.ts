import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import { isTodoPhase } from "../../tools/todo";
import { sanitizeExternalToolText } from "../../tools/xdev";
import {
	RPC_EVENT_TYPES,
	RPC_EXTENSION_UI_METHODS,
	type RpcCapabilityDisabledReason,
	type RpcCapabilityManifest,
	type RpcCommand,
	type RpcCommandCapability,
	type RpcCommandConcurrencyClass,
	type RpcCommandConfirmation,
	type RpcCommandExecution,
	type RpcCommandSchedulingClass,
	type RpcCommandScope,
	type RpcCommandType,
	type RpcInputSchema,
} from "./rpc-types";

export const RPC_APPLICATION_API_VERSION = 2;

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
	confirmation: RpcCommandConfirmation;
	requiredFeatures: readonly string[];
	availability(context: RpcCapabilityContext): RpcCommandAvailabilityResult;
	outputSchema?: RpcInputSchema;
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
const booleanField = required("a boolean", value => typeof value === "boolean", { type: "boolean" });
const boundedStringField = (name: string, maxLength: number): RpcFieldDefinition =>
	required(name, value => typeof value === "string" && value.length <= maxLength, {
		type: "string",
		maxLength,
	});
const optionalBoundedStringField = (name: string, maxLength: number): RpcFieldDefinition =>
	optional(name, value => typeof value === "string" && value.length <= maxLength, {
		type: ["string", "null"],
		maxLength,
	});
const optionalStringField = optional("a string", value => typeof value === "string", {
	type: ["string", "null"],
});
const optionalBooleanField = optional("a boolean", value => typeof value === "boolean", {
	type: ["boolean", "null"],
});
const releaseTombstoneField = optional("a boolean (defaults to false)", value => typeof value === "boolean", {
	type: ["boolean", "null"],
	default: false,
});
const agentIdField = required(
	"a non-empty agent id of at most 256 UTF-8 bytes",
	value => typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 256,
	{ type: "string", minLength: 1, maxLength: 256, "x-maxUtf8Bytes": 256 },
);
const optionalAgentIdField = optional(
	"a non-empty agent or message id of at most 256 UTF-8 bytes",
	value => typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 256,
	{ type: ["string", "null"], minLength: 1, maxLength: 256, "x-maxUtf8Bytes": 256 },
);
const agentMessageField = required(
	"a non-empty message of at most 65536 UTF-8 bytes",
	value => typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 65_536,
	{ type: "string", minLength: 1, maxLength: 65_536, "x-maxUtf8Bytes": 65_536 },
);
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
const optionalIntegerField = optional("an integer", value => Number.isSafeInteger(value), {
	type: ["integer", "null"],
});
const optionalBoundedPositiveIntegerField = (maximum: number): RpcFieldDefinition =>
	optional(
		`a positive integer no greater than ${maximum}`,
		value => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum,
		{ type: ["integer", "null"], minimum: 1, maximum },
	);

const MAX_OPAQUE_ID_BYTES = 256;
const opaqueIdField = required(
	`a non-empty opaque id of at most ${MAX_OPAQUE_ID_BYTES} UTF-8 bytes`,
	value => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_OPAQUE_ID_BYTES,
	{ type: "string", minLength: 1, maxLength: MAX_OPAQUE_ID_BYTES, "x-maxUtf8Bytes": MAX_OPAQUE_ID_BYTES },
);

const MAX_TOOL_ACTIVATION_NAMES = 2048;
const MAX_TOOL_ACTIVATION_NAME_BYTES = 256;
const optionalToolNameArrayField: RpcFieldDefinition = {
	optional: true,
	expected: `an array of at most ${MAX_TOOL_ACTIVATION_NAMES} safe tool names`,
	schema: {
		type: "array",
		items: {
			type: "string",
			minLength: 1,
			maxLength: MAX_TOOL_ACTIVATION_NAME_BYTES,
			"x-maxUtf8Bytes": MAX_TOOL_ACTIVATION_NAME_BYTES,
		},
		maxItems: MAX_TOOL_ACTIVATION_NAMES,
	},
	validate: value =>
		Array.isArray(value) &&
		value.length <= MAX_TOOL_ACTIVATION_NAMES &&
		value.every(
			name =>
				typeof name === "string" &&
				name.length > 0 &&
				Buffer.byteLength(name, "utf8") <= MAX_TOOL_ACTIVATION_NAME_BYTES &&
				sanitizeExternalToolText(name) === name,
		),
};
export class RpcToolActivationValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcToolActivationValidationError";
	}
}

export function validateRpcToolActivationBatch(
	command: Extract<RpcCommand, { type: "set_tool_activation" }>,
	allToolNames: readonly string[],
): { activate: string[]; deactivate: string[] } {
	const activate = command.activate ?? [];
	const deactivate = command.deactivate ?? [];
	const validName = (name: unknown): name is string =>
		typeof name === "string" &&
		name.length > 0 &&
		Buffer.byteLength(name, "utf8") <= MAX_TOOL_ACTIVATION_NAME_BYTES &&
		sanitizeExternalToolText(name) === name;
	if (
		activate.length > MAX_TOOL_ACTIVATION_NAMES ||
		deactivate.length > MAX_TOOL_ACTIVATION_NAMES ||
		!activate.every(validName) ||
		!deactivate.every(validName)
	) {
		throw new RpcToolActivationValidationError(
			`Tool activation lists must contain at most ${MAX_TOOL_ACTIVATION_NAMES} safe names of at most ${MAX_TOOL_ACTIVATION_NAME_BYTES} bytes`,
		);
	}
	if (activate.length === 0 && deactivate.length === 0) {
		throw new RpcToolActivationValidationError(
			"Tool activation request must activate or deactivate at least one tool",
		);
	}
	if (new Set(activate).size !== activate.length) {
		throw new RpcToolActivationValidationError("Tool activation request contains duplicate activate names");
	}
	if (new Set(deactivate).size !== deactivate.length) {
		throw new RpcToolActivationValidationError("Tool activation request contains duplicate deactivate names");
	}
	const deactivateSet = new Set(deactivate);
	const overlap = activate.filter(name => deactivateSet.has(name));
	if (overlap.length > 0) {
		throw new RpcToolActivationValidationError(
			`Tool activation request names cannot be both activated and deactivated: ${overlap.join(", ")}`,
		);
	}
	const registered = new Set(allToolNames);
	const unknown = [...activate, ...deactivate].filter(name => !registered.has(name));
	if (unknown.length > 0) {
		throw new RpcToolActivationValidationError(
			`Tool activation request contains unregistered names: ${unknown.join(", ")}`,
		);
	}
	return { activate: [...activate], deactivate: [...deactivate] };
}

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
	Pick<
		RpcCommandMetadata,
		"version" | "execution" | "confirmation" | "requiredFeatures" | "availability" | "outputSchema"
	>
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
		confirmation: metadata.confirmation ?? "none",
		requiredFeatures: metadata.requiredFeatures ?? [],
		availability: metadata.availability ?? (() => AVAILABLE),
		outputSchema: metadata.outputSchema,
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
	eval_execute: sessionCommand(
		{ type: "eval_execute", language: "py", code: "print('hello')" },
		{
			language: enumField("py", "js", "rb", "jl"),
			code: boundedStringField("code no longer than 262144 characters", 262_144),
			title: optionalBoundedStringField("a title no longer than 512 characters", 512),
			timeout: optionalBoundedPositiveIntegerField(3_600),
			reset: optionalBooleanField,
			excludeFromContext: optionalBooleanField,
		},
		"concurrent",
		{
			execution: "operation",
			confirmation: "required",
			outputSchema: {
				type: "object",
				properties: {
					operationId: { type: "string", maxLength: 128 },
					accepted: { const: true },
				},
				required: ["operationId", "accepted"],
				additionalProperties: false,
			},
		},
	),
	get_eval_history: sessionCommand(
		{ type: "get_eval_history" },
		{ limit: optionalBoundedPositiveIntegerField(100) },
		"concurrent",
		{
			outputSchema: {
				type: "object",
				properties: {
					entries: {
						type: "array",
						maxItems: 100,
						items: {
							type: "object",
							properties: {
								language: { enum: ["py", "js", "rb", "jl"] },
								code: { type: "string", maxLength: 262_144 },
								output: { type: "string", maxLength: 262_144 },
								exitCode: { type: "integer" },
								cancelled: { type: "boolean" },
								truncated: { type: "boolean" },
								timestamp: { type: "number" },
								excludeFromContext: { type: "boolean" },
							},
							required: ["language", "code", "output", "cancelled", "truncated", "timestamp"],
							additionalProperties: false,
						},
					},
				},
				required: ["entries"],
				additionalProperties: false,
			},
		},
	),
	set_mode: sessionCommand(
		{ type: "set_mode", mode: "plan" },
		{
			mode: enumField("none", "plan", "plan_paused"),
			planFilePath: optionalStringField,
			workflow: optionalEnumField("parallel", "iterative"),
			when: optionalEnumField("immediate", "next_idle"),
		},
		"serial",
		{ execution: "operation" },
	),
	get_plan: sessionCommand({ type: "get_plan" }, {}, "concurrent"),
	resolve_plan_approval: sessionCommand(
		{ type: "resolve_plan_approval", approvalId: "approval-1", decision: "approve" },
		{
			approvalId: opaqueIdField,
			decision: enumField("approve", "refine", "reject"),
			preserveContext: optionalBooleanField,
			compactBeforeExecute: optionalBooleanField,
			executionModelRole: optionalBoundedStringField("a model role no longer than 256 characters", 256),
			editedContent: optionalBoundedStringField("edited plan content no longer than 1048576 characters", 1_048_576),
			feedback: optionalBoundedStringField("feedback no longer than 65536 characters", 65_536),
		},
		"serial",
		{ execution: "operation" },
	),
	new_session: sessionCommand({ type: "new_session" }, { parentSession: optionalStringField }),
	get_state: sessionCommand({ type: "get_state" }),
	get_operations: sessionCommand({ type: "get_operations" }, {}, "concurrent"),
	get_advisor_state: sessionCommand({ type: "get_advisor_state" }, {}, "concurrent"),
	set_advisor_enabled: sessionCommand({ type: "set_advisor_enabled", enabled: false }, { enabled: booleanField }),
	get_tool_inventory: sessionCommand({ type: "get_tool_inventory" }),
	set_tool_activation: sessionCommand(
		{ type: "set_tool_activation", activate: ["read"], deactivate: ["bash"] },
		{ activate: optionalToolNameArrayField, deactivate: optionalToolNameArrayField },
	),
	list_provider_auth: sessionCommand({ type: "list_provider_auth" }, {}, "concurrent"),
	begin_provider_auth: sessionCommand(
		{ type: "begin_provider_auth", providerId: "anthropic", method: "oauth_callback" },
		{ providerId: stringField, method: enumField("oauth_callback", "paste_code", "device_code", "api_key") },
		"serial",
		{ execution: "operation" },
	),
	cancel_provider_auth: sessionCommand(
		{ type: "cancel_provider_auth", operationId: "operation-1" },
		{ operationId: opaqueIdField },
		"control",
	),
	remove_provider_auth: sessionCommand(
		{ type: "remove_provider_auth", providerId: "anthropic" },
		{ providerId: stringField },
		"serial",
		{ confirmation: "required" },
	),
	set_fast_mode: sessionCommand(
		{ type: "set_fast_mode", enabled: false },
		{ enabled: booleanField },
		"serial",
		requiresFeature("model.fast-mode"),
	),
	get_available_commands: sessionCommand({ type: "get_available_commands" }),
	get_settings: sessionCommand({ type: "get_settings" }, { tab: optionalStringField }, "concurrent"),
	set_settings: sessionCommand(
		{ type: "set_settings", changes: [{ path: "colorBlindMode", value: true }] },
		{
			changes: required("a nonempty array of at most 100 setting changes", value => Array.isArray(value), {
				type: "array",
				minItems: 1,
				maxItems: 100,
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						value: {
							type: ["string", "number", "boolean", "array", "object", "null"],
						},
					},
					required: ["path", "value"],
					additionalProperties: false,
				},
			}),
		},
		"serial",
	),
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
	list_agents: agentCommand(
		{ type: "list_agents" },
		{ includeAdvisors: optionalBooleanField },
		"concurrent",
		requiresFeature("agent-control"),
	),
	get_agent: agentCommand(
		{ type: "get_agent", agentId: "SubagentA" },
		{ agentId: agentIdField },
		"concurrent",
		requiresFeature("agent-control"),
	),
	get_agent_result: agentCommand(
		{ type: "get_agent_result", agentId: "SubagentA" },
		{ agentId: agentIdField },
		"concurrent",
		requiresFeature("agent-control"),
	),
	send_agent_message: agentCommand(
		{ type: "send_agent_message", agentId: "SubagentA", message: "continue" },
		{ agentId: agentIdField, message: agentMessageField, replyTo: optionalAgentIdField },
		"control",
		requiresFeature("agent-control"),
	),
	park_agent: agentCommand(
		{ type: "park_agent", agentId: "SubagentA" },
		{ agentId: agentIdField },
		"control",
		requiresFeature("agent-control"),
	),
	resume_agent: agentCommand(
		{ type: "resume_agent", agentId: "SubagentA" },
		{ agentId: agentIdField },
		"control",
		requiresFeature("agent-control"),
	),
	cancel_agent: agentCommand({ type: "cancel_agent", agentId: "SubagentA" }, { agentId: agentIdField }, "control", {
		...requiresFeature("agent-control"),
		confirmation: "required",
	}),
	release_agent: agentCommand(
		{ type: "release_agent", agentId: "SubagentA" },
		{ agentId: agentIdField, tombstone: releaseTombstoneField },
		"control",
		{ ...requiresFeature("agent-control"), confirmation: "required" },
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
	list_sessions: hostCommand(
		{ type: "list_sessions", scope: "cwd", cwd: "/workspace", limit: 50 },
		{
			scope: optionalEnumField("cwd", "all"),
			cwd: optionalStringField,
			cursor: optionalStringField,
			limit: optionalIntegerField,
			search: optionalStringField,
		},
		"concurrent",
	),
	get_session_info: hostCommand(
		{ type: "get_session_info", session: "01901234" },
		{ session: stringField, scope: optionalEnumField("cwd", "all"), cwd: optionalStringField },
		"concurrent",
	),
	list_workspace_roots: hostCommand({ type: "list_workspace_roots" }, {}, "concurrent"),
	resume_session: sessionCommand(
		{ type: "resume_session", session: "01901234" },
		{ session: stringField, scope: optionalEnumField("cwd", "all"), cwd: optionalStringField },
	),
	fork_session: sessionCommand({ type: "fork_session" }),
	rename_session: hostCommand(
		{ type: "rename_session", session: "01901234", name: "Investigation" },
		{ session: stringField, name: stringField, scope: optionalEnumField("cwd", "all"), cwd: optionalStringField },
	),
	delete_session: hostCommand(
		{ type: "delete_session", session: "01901234" },
		{ session: stringField, scope: optionalEnumField("cwd", "all"), cwd: optionalStringField },
		"serial",
		{ confirmation: "required" },
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
		commands: Object.entries(RPC_COMMAND_DEFINITIONS).map(([name, definition]): RpcCommandCapability => {
			const availability = definition.availability(context);
			const descriptor = {
				id: `rpc.command.${name}`,
				name: name as RpcCommandType,
				version: definition.version,
				scope: definition.scope,
				execution: definition.execution,
				inputSchema: inputSchemaFor(name as RpcCommandType, definition),
				...(definition.concurrencyClass === undefined ? {} : { concurrencyClass: definition.concurrencyClass }),
				confirmation: definition.confirmation,
				requiredFeatures: [...definition.requiredFeatures],
				...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
			};
			if (availability.availability === "unavailable") {
				return { ...descriptor, availability: "unavailable", disabledReason: availability.disabledReason };
			}
			return { ...descriptor, availability: availability.availability };
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
