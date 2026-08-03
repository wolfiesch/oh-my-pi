/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */
import type { AgentMessage, AgentToolResult, ThinkingLevel, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Effort, ImageContent, Model, ToolExample } from "@oh-my-pi/pi-ai";
import type { AdvisorRuntimeStatus } from "../../advisor";
import type { SettingTab } from "../../config/settings-schema";
import type { SettingsSnapshot } from "../../config/settings-snapshot";
import type { BashResult } from "../../exec/bash-executor";
import type { ContextUsage } from "../../extensibility/extensions/types";
import type { AgentSessionEvent, SessionStats } from "../../session/agent-session";
import type {
	SessionCatalogEntry,
	SessionCatalogPage,
	SessionCatalogScope,
	SessionWorkspaceRoot,
} from "../../session/session-catalog";
import type { ToolInventory } from "../../session/session-tools";

export type {
	ToolInventory,
	ToolInventoryEntry,
	ToolInventoryPresentation,
	ToolInventorySource,
} from "../../session/session-tools";

import type { FileEntry } from "../../session/session-entries";
import type { SessionWorkspace } from "../../session/session-workspace";
import type { AvailableSlashCommandSource } from "../../slash-commands/available-commands";
import type {
	AgentProgress,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "../../task";
import type { TodoPhase } from "../../tools/todo";
import type { RpcMessagesPage } from "./rpc-messages";

export type RpcJsonValue = string | number | boolean | null | RpcJsonValue[] | { [key: string]: RpcJsonValue };

export interface RpcSettingsChange {
	path: string;
	value: RpcJsonValue;
}

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Protocol
	| { id?: string; type: "negotiate_protocol"; protocolVersion: number }
	| { id?: string; type: "get_capabilities" }

	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "cancel_operation"; operationId: string }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_operations" }
	| { id?: string; type: "get_tool_inventory" }
	| { id?: string; type: "set_tool_activation"; activate?: string[]; deactivate?: string[] }
	| { id?: string; type: "set_fast_mode"; enabled: boolean }
	| { id?: string; type: "get_advisor_state" }
	| { id?: string; type: "set_advisor_enabled"; enabled: boolean }
	| { id?: string; type: "get_available_commands" }
	| { id?: string; type: "get_settings"; tab?: SettingTab }
	| { id?: string; type: "set_settings"; changes: RpcSettingsChange[] }
	| { id?: string; type: "set_todos"; phases: TodoPhase[] }
	| { id?: string; type: "set_host_tools"; tools: RpcHostToolDefinition[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }
	| { id?: string; type: "set_subagent_subscription"; level: RpcSubagentSubscriptionLevel }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| {
			id?: string;
			type: "list_sessions";
			scope?: SessionCatalogScope;
			cwd?: string;
			cursor?: string;
			limit?: number;
			search?: string;
	  }
	| { id?: string; type: "get_session_info"; session: string; scope?: SessionCatalogScope; cwd?: string }
	| { id?: string; type: "list_workspace_roots" }
	| { id?: string; type: "resume_session"; session: string; scope?: SessionCatalogScope; cwd?: string }
	| { id?: string; type: "fork_session" }
	| { id?: string; type: "rename_session"; session: string; name: string; scope?: SessionCatalogScope; cwd?: string }
	| { id?: string; type: "delete_session"; session: string; scope?: SessionCatalogScope; cwd?: string }
	| { id?: string; type: "handoff"; customInstructions?: string }

	// Messages
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_messages_page"; cursor?: string; limit?: number }

	// Login
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string };

// ============================================================================
// RPC State
// ============================================================================

export type RpcSessionActivityPhase = "provider" | "maintenance" | "idle";
export interface RpcAdvisorState {
	configured: boolean;
	active: boolean;
	advisors: Array<{ name: string; status: AdvisorRuntimeStatus }>;
}

export interface RpcSessionState {
	model?: Model;
	thinkingLevel: ThinkingLevel | undefined;
	isStreaming: boolean;
	/** Provider generation, post-turn maintenance, or terminal idle. */
	activityPhase: RpcSessionActivityPhase;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	tokensPerSecond: number | null;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: TodoPhase[];
	/** For session dump / export (plain-text parity with /dump). */
	systemPrompt?: string[];
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	/** Current context window usage. */
	contextUsage?: ContextUsage;
	advisor?: RpcAdvisorState;
}

export interface RpcAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface RpcAvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: RpcAvailableSlashCommand[];
}
export interface RpcToolInventoryUpdateFrame {
	type: "tool_inventory_update";
}

export interface RpcToolActivationResult {
	/** Enabled names after authoritative reconciliation (top-level plus mounted). */
	enabledToolNames: string[];
	/** Top-level names after authoritative reconciliation. */
	activeToolNames: string[];
	/** Names mounted under `xd://` after authoritative reconciliation. */
	mountedToolNames: string[];
	/** Actual enabled-set additions, not an echo of the request. */
	activated: string[];
	/** Actual enabled-set removals, not an echo of the request. */
	deactivated: string[];
	inventoryAvailable: boolean;
	/** Present only when the just-committed authoritative inventory is representable. */
	inventory?: ToolInventory;
}

export interface RpcPromptResultFrame {
	type: "prompt_result";
	id?: string;
	operationId?: string;
	agentInvoked: boolean;
}

export type RpcOperationCommand = "prompt" | "abort_and_prompt";
export type RpcOperationCancellationReason = "user" | "replaced" | "session_transition" | "client_disconnected";
export type RpcOperationCancellationCode =
	| "cancelled_by_client"
	| "replaced_by_prompt"
	| "session_changed"
	| "client_disconnected";

interface RpcOperationFrameBase {
	operationId: string;
	requestId?: string;
	command: RpcOperationCommand;
}

export interface RpcOperationStartedFrame extends RpcOperationFrameBase {
	type: "operation_started";
	startedAt: number;
}

export type RpcOperationTerminalFrame =
	| (RpcOperationFrameBase & {
			type: "operation_completed";
			agentInvoked: boolean;
			settledAt: number;
	  })
	| (RpcOperationFrameBase & {
			type: "operation_failed";
			error: string;
			code?: string;
			settledAt: number;
	  })
	| (RpcOperationFrameBase & {
			type: "operation_cancelled";
			reason: RpcOperationCancellationReason;
			code: RpcOperationCancellationCode;
			settledAt: number;
	  });

export interface RpcOperationAccepted {
	operationId: string;
	accepted: true;
}

export interface RpcActiveOperation extends RpcOperationFrameBase {
	status: "accepted" | "started";
	acceptedAt: number;
	startedAt?: number;
}

export interface RpcOperationsSnapshot {
	active: RpcActiveOperation[];
	recent: RpcOperationTerminalFrame[];
}

export type RpcCancelOperationResult =
	| {
			operationId: string;
			status: "cancelled" | "completed" | "failed";
			terminal: RpcOperationTerminalFrame;
	  }
	| { operationId: string; status: "not_found" };
export interface RpcCommandOutputFrame {
	type: "command_output";
	text: string;
}

export interface RpcSessionInfoUpdateFrame {
	type: "session_info_update";
	title?: string;
	sessionId: string;
}

export interface RpcConfigUpdateFrame {
	type: "config_update";
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	advisor?: RpcAdvisorState;
}

/** Pull-only invalidation signal; clients should call get_settings for current values. */
export interface RpcSettingsUpdateFrame {
	type: "settings_update";
}

export interface RpcExtensionErrorFrame {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
}

export type RpcCommandSchedulingClass = "serial" | "concurrent" | "control";
export type RpcCommandScope = "host" | "session" | "turn" | "agent";
export type RpcCommandExecution = "sync" | "operation" | "host-only" | "unavailable";
export type RpcCommandConfirmation = "none" | "required";
export type RpcCommandAvailability = "available" | "conditional" | "unavailable";
export type RpcCommandConcurrencyClass = RpcCommandSchedulingClass;

export interface RpcCapabilityDisabledReason {
	code: string;
	message: string;
}

export interface RpcInputSchema {
	type: "object";
	properties: Record<string, Record<string, unknown>>;
	required: string[];
	additionalProperties: false;
}

interface RpcCommandCapabilityBase {
	/** Stable protocol identity. Unlike the display name, this must never be repurposed. */
	id: string;
	name: RpcCommandType;
	version: number;
	scope: RpcCommandScope;
	execution: RpcCommandExecution;
	inputSchema?: RpcInputSchema;
	outputSchema?: Record<string, unknown>;
	concurrencyClass?: RpcCommandConcurrencyClass;
	confirmation: RpcCommandConfirmation;
	requiredFeatures: string[];
}

export type RpcCommandCapability = RpcCommandCapabilityBase &
	(
		| { availability: "available" | "conditional"; disabledReason?: never }
		| { availability: "unavailable"; disabledReason: RpcCapabilityDisabledReason }
	);

export interface RpcCapabilityManifest {
	applicationApiVersion: number;
	commands: RpcCommandCapability[];
	events: RpcEventType[];
	extensionUiMethods: RpcExtensionUIMethod[];
	hostProtocols: string[];
}

export interface RpcReadyFrame {
	type: "ready";
	protocolVersion: 1;
	supportedProtocolVersions: [1, 2];
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
	/** Present on servers with application-level capability discovery. */
	capabilities?: RpcCapabilityManifest;
}

export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

export interface RpcHandoffResult {
	savedPath?: string;
}

export interface RpcSessionInfoResult {
	session: SessionCatalogEntry;
	workspace: SessionWorkspace;
	active: boolean;
}

export interface RpcResumeSessionResult {
	cancelled: boolean;
	sessionFile?: string;
	cwd: string;
	cwdChanged: boolean;
}

export interface RpcForkSessionResult {
	cancelled: boolean;
	sessionFile?: string;
}

export interface RpcRenameSessionResult {
	renamed: boolean;
	active: boolean;
}

export interface RpcDeleteSessionResult {
	deleted: boolean;
	cancelled: boolean;
	wasActive: boolean;
	newSessionStarted: boolean;
	deleteError?: { code: "delete_failed"; message: string };
}

export type RpcSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface RpcSubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource: AgentProgress["agentSource"];
	description?: string;
	status: AgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: AgentProgress;
	parentToolCallId?: string;
}

export interface RpcSubagentMessagesResult {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: FileEntry[];
	messages: AgentMessage[];
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Protocol
	| {
			id?: string;
			type: "response";
			command: "negotiate_protocol";
			success: true;
			data: { protocolVersion: 2 };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_capabilities";
			success: true;
			data: RpcCapabilityManifest;
	  }

	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true; data: RpcOperationAccepted }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "abort_and_prompt"; success: true; data: RpcOperationAccepted }
	| {
			id?: string;
			type: "response";
			command: "cancel_operation";
			success: true;
			data: RpcCancelOperationResult;
	  }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| { id?: string; type: "response"; command: "get_operations"; success: true; data: RpcOperationsSnapshot }
	| { id?: string; type: "response"; command: "get_advisor_state"; success: true; data: RpcAdvisorState }
	| { id?: string; type: "response"; command: "set_advisor_enabled"; success: true; data: RpcAdvisorState }
	| { id?: string; type: "response"; command: "get_tool_inventory"; success: true; data: ToolInventory }
	| {
			id?: string;
			type: "response";
			command: "set_tool_activation";
			success: true;
			data: RpcToolActivationResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "set_fast_mode";
			success: true;
			data: { enabled: boolean; active: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_commands";
			success: true;
			data: { commands: RpcAvailableSlashCommand[] };
	  }
	| { id?: string; type: "response"; command: "set_todos"; success: true; data: { todoPhases: TodoPhase[] } }
	| { id?: string; type: "response"; command: "set_host_tools"; success: true; data: { toolNames: string[] } }
	| { id?: string; type: "response"; command: "set_host_uri_schemes"; success: true; data: { schemes: string[] } }
	| {
			id?: string;
			type: "response";
			command: "set_subagent_subscription";
			success: true;
			data: { level: RpcSubagentSubscriptionLevel };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagents";
			success: true;
			data: { subagents: RpcSubagentSnapshot[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagent_messages";
			success: true;
			data: RpcSubagentMessagesResult;
	  }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model; thinkingLevel: ThinkingLevel | undefined; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_settings";
			success: true;
			data: SettingsSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command: "set_settings";
			success: true;
			data: SettingsSnapshot;
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: Effort } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "set_interrupt_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "list_sessions"; success: true; data: SessionCatalogPage }
	| { id?: string; type: "response"; command: "get_session_info"; success: true; data: RpcSessionInfoResult }
	| {
			id?: string;
			type: "response";
			command: "list_workspace_roots";
			success: true;
			data: { roots: SessionWorkspaceRoot[] };
	  }
	| { id?: string; type: "response"; command: "resume_session"; success: true; data: RpcResumeSessionResult }
	| { id?: string; type: "response"; command: "fork_session"; success: true; data: RpcForkSessionResult }
	| { id?: string; type: "response"; command: "rename_session"; success: true; data: RpcRenameSessionResult }
	| { id?: string; type: "response"; command: "delete_session"; success: true; data: RpcDeleteSessionResult }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "branch"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_branch_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| { id?: string; type: "response"; command: "handoff"; success: true; data: RpcHandoffResult | null }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| { id?: string; type: "response"; command: "get_messages_page"; success: true; data: RpcMessagesPage }

	// Login
	| {
			id?: string;
			type: "response";
			command: "get_login_providers";
			success: true;
			data: { providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }> };
	  }
	| { id?: string; type: "response"; command: "login"; success: true; data: { providerId: string } }

	// Error response (any command can fail); `code` is an optional machine-readable reason.
	| { id?: string; type: "response"; command: string; success: false; error: string; code?: string };

// ============================================================================
// Subagent Events (stdout)
// ============================================================================

export interface RpcSubagentLifecycleFrame {
	type: "subagent_lifecycle";
	payload: SubagentLifecyclePayload;
}

export interface RpcSubagentProgressFrame {
	type: "subagent_progress";
	payload: SubagentProgressPayload;
}

export interface RpcSubagentEventFrame {
	type: "subagent_event";
	payload: SubagentEventPayload;
}

export type RpcSubagentFrame = RpcSubagentLifecycleFrame | RpcSubagentProgressFrame | RpcSubagentEventFrame;

export type RpcSessionEventFrame = AgentSessionEvent | RpcSubagentFrame;

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "confirm";
			title: string;
			message: string;
			timeout?: number;
			/** Server-issued correlation for privileged RPC mutations. */
			operationId?: string;
			command?: "delete_session";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			url: string;
			/**
			 * Short loopback URL that 302-redirects to {@link url}. When present,
			 * hosts SHOULD surface it as the copy target so terminal viewport
			 * truncation cannot corrupt OAuth query parameters on the full URL.
			 */
			launchUrl?: string;
			instructions?: string;
	  };

// ============================================================================
// Host Tool Frames (bidirectional)
// ============================================================================

export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
	/** How this host tool is presented when enabled; omission normalizes to `"discoverable"` at the adapter boundary. */
	loadMode?: ToolLoadMode;
}

/** Emitted by the RPC server when it needs the host to execute a registered tool. */
export interface RpcHostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Emitted by the RPC server when a pending host tool call should be aborted. */
export interface RpcHostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to stream partial tool updates back to the RPC server. */
export interface RpcHostToolUpdate {
	type: "host_tool_update";
	id: string;
	partialResult: AgentToolResult<unknown>;
}

/** Sent by the host to complete a pending tool call. */
export interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
}

// ============================================================================
// Host URI Frames (bidirectional)
// ============================================================================

export interface RpcHostUriSchemeDefinition {
	/** URL scheme without trailing `://` (e.g. `db`, `notion`). */
	scheme: string;
	/** Optional human-readable description for logs/diagnostics. */
	description?: string;
	/** When true, the write tool is allowed to dispatch writes to this scheme. */
	writable?: boolean;
	/** When true, downstream callers suppress hashline anchors for resolved content. */
	immutable?: boolean;
}

export type RpcHostUriOperation = "read" | "write";

/** Emitted by the RPC server when it needs the host to satisfy a URI operation. */
export interface RpcHostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: RpcHostUriOperation;
	url: string;
	/** Present for write operations. */
	content?: string;
}

/** Emitted by the RPC server when a pending URI request should be aborted. */
export interface RpcHostUriCancelRequest {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to complete a pending URI request. */
export interface RpcHostUriResult {
	type: "host_uri_result";
	id: string;
	/**
	 * Required for successful `read` results. Ignored for `write` success.
	 * Set on errors when a textual explanation accompanies `isError`.
	 */
	content?: string;
	/** Defaults to `text/plain` when omitted. */
	contentType?: "text/markdown" | "application/json" | "text/plain";
	/** Optional resolution notes propagated to the read tool. */
	notes?: string[];
	/** Overrides the scheme-level `immutable` flag for this single resolution. */
	immutable?: boolean;
	/** When true, surface the result content as an error to the caller. */
	isError?: boolean;
	/** Optional error message; preferred over `content` for error surfacing. */
	error?: string;
}

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean; operationId?: string }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

type RpcManifestEvent =
	| RpcReadyFrame
	| RpcPromptResultFrame
	| RpcAvailableCommandsUpdateFrame
	| RpcToolInventoryUpdateFrame
	| RpcOperationStartedFrame
	| RpcOperationTerminalFrame
	| RpcSessionEventFrame
	| RpcExtensionUIRequest
	| RpcSettingsUpdateFrame
	| RpcHostToolCallRequest
	| RpcHostToolCancelRequest
	| RpcHostUriRequest
	| RpcHostUriCancelRequest
	| {
			type:
				| "command_output"
				| "session_info_update"
				| "config_update"
				| "extension_error"
				| "notice"
				| "goal_updated";
	  };

function eventInventory<const T extends readonly RpcManifestEvent["type"][]>(
	events: T & (Exclude<RpcManifestEvent["type"], T[number]> extends never ? unknown : never),
): T {
	return events;
}

/** Event names advertised by capability discovery, exhaustively linked to RPC output event discriminants. */
export const RPC_EVENT_TYPES = eventInventory([
	"ready",
	"prompt_result",
	"available_commands_update",
	"tool_inventory_update",
	"operation_started",
	"operation_completed",
	"operation_failed",
	"operation_cancelled",
	"command_output",
	"session_info_update",
	"config_update",
	"settings_update",
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
	"model_changed",
	"ttsr_triggered",
	"todo_reminder",
	"todo_auto_clear",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"goal_updated",
] as const);

export type RpcEventType = (typeof RPC_EVENT_TYPES)[number];
export type RpcExtensionUIMethod = RpcExtensionUIRequest["method"];

function extensionUiMethodInventory<const T extends readonly RpcExtensionUIMethod[]>(
	methods: T & (Exclude<RpcExtensionUIMethod, T[number]> extends never ? unknown : never),
): T {
	return methods;
}

/** Extension UI method inventory, exhaustively linked to RpcExtensionUIRequest. */
export const RPC_EXTENSION_UI_METHODS = extensionUiMethodInventory([
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
] as const);
// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
