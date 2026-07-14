/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
	MAX_ARRAY_ITEMS,
	MAX_INPUT_BYTES,
	MAX_JSON_DEPTH,
	MAX_JSON_NODES,
	MAX_MAP_KEYS,
	MAX_STRING_BYTES,
	parseBounded,
	TRANSCRIPT_IMAGE_MAX_BYTES,
	TRANSCRIPT_IMAGE_MIME_TYPES,
	utf8ByteLength,
} from "@oh-my-pi/app-wire";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { isZodSchema, zodToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { $env, isRecord, postmortem, readJsonl, Snowflake } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import { buildSkillPromptMessage, parseSkillInvocation } from "../../extensibility/skills";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { type Theme, theme } from "../../modes/theme/theme";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import { BLOB_EXTERNALIZE_THRESHOLD } from "../../session/session-persistence";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import type { EventBus } from "../../utils/event-bus";
import { initializeExtensions } from "../runtime-init";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import { resolveRpcPromptImages } from "./rpc-prompt-images";
import { registerRpcSessionTeardown } from "./rpc-session-teardown";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "./rpc-subagents";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcPromptResultFrame,
	RpcResponse,
	RpcSessionEntryFrame,
	RpcSessionState,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

export { RPC_APP_IMAGE_ROOT_ENV, resolveRpcPromptImages } from "./rpc-prompt-images";
// Re-export types for consumers
export type * from "./rpc-types";

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

/** Pending extension UI request map that can fail closed when the RPC client disconnects. */
export class RpcPendingExtensionRequests extends Map<string, PendingExtensionRequest> {
	#closedError: Error | undefined;

	override set(id: string, request: PendingExtensionRequest): this {
		if (this.#closedError) {
			request.reject(this.#closedError);
			return this;
		}
		return super.set(id, request);
	}

	/** Reject every active and future extension UI request. */
	rejectAll(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const requests = Array.from(this.values());
		this.clear();
		for (const request of requests) {
			request.reject(this.#closedError);
		}
	}
}

type RpcOutput = (
	obj:
		| RpcResponse
		| RpcExtensionUIRequest
		| RpcHostToolCallRequest
		| RpcHostToolCancelRequest
		| RpcHostUriRequest
		| RpcHostUriCancelRequest
		| object,
) => void;
type RpcSessionEntryManager = Pick<AgentSession["sessionManager"], "subscribeEntryAppended">;

/** Leave one maximum-sized app-wire string of headroom below the supervisor's line ceiling. */
export const RPC_AGENT_END_MAX_BYTES = MAX_INPUT_BYTES - MAX_STRING_BYTES;

const rpcTextEncoder = new TextEncoder();

export const RPC_INLINE_IMAGE_DATA_ENV = "OMP_APP_RPC_INLINE_IMAGE_DATA";

export type RpcTransportFrame<T extends object = object> = T & {
	/** The full image bytes remain in the OMP transcript but were omitted from this JSONL notification. */
	inlineImageDataOmitted?: true;
	/** Some non-routing data was projected to keep this internal notification within app-wire bounds. */
	transportDataOmitted?: true;
	/** Coarse, bounded reasons for transport-only projection. */
	transportOmissionReasons?: string[];
};

const RPC_TRANSCRIPT_IMAGE_DIGEST_KEY = "appImageSha256";

interface RpcImageProjection {
	value: unknown;
	omitted: boolean;
}

function transcriptImageDigest(data: string, mimeType: unknown): string | undefined {
	if (
		data.length < BLOB_EXTERNALIZE_THRESHOLD ||
		data.length > Math.ceil(TRANSCRIPT_IMAGE_MAX_BYTES / 3) * 4 ||
		!(TRANSCRIPT_IMAGE_MIME_TYPES as readonly unknown[]).includes(mimeType) ||
		data.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/u.test(data)
	)
		return undefined;
	const decoded = Buffer.from(data, "base64");
	if (
		decoded.byteLength === 0 ||
		decoded.byteLength > TRANSCRIPT_IMAGE_MAX_BYTES ||
		decoded.toString("base64") !== data
	)
		return undefined;
	return createHash("sha256").update(decoded).digest("hex");
}

function omitInlineImageData(value: unknown): RpcImageProjection {
	if (typeof value === "string" && /^data:image\/[a-z0-9.+-]+;base64,/iu.test(value)) {
		return { value: "[inline image data omitted]", omitted: true };
	}
	if (Array.isArray(value)) {
		let omitted = false;
		const items = value.map(item => {
			const projected = omitInlineImageData(item);
			omitted ||= projected.omitted;
			return projected.value;
		});
		return omitted ? { value: items, omitted } : { value, omitted };
	}
	if (!isRecord(value)) return { value, omitted: false };
	if (value.type === "image" && typeof value.data === "string" && value.data.length > 0) {
		const projected: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (key === RPC_TRANSCRIPT_IMAGE_DIGEST_KEY) continue;
			projected[key] = key === "data" ? "" : item;
		}
		const digest = transcriptImageDigest(value.data, value.mimeType);
		if (digest) projected[RPC_TRANSCRIPT_IMAGE_DIGEST_KEY] = digest;
		return { value: projected, omitted: true };
	}

	let omitted = false;
	const projected: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (key === RPC_TRANSCRIPT_IMAGE_DIGEST_KEY) {
			omitted = true;
			continue;
		}
		const result = omitInlineImageData(item);
		omitted ||= result.omitted;
		projected[key] = result.value;
	}
	return omitted ? { value: projected, omitted } : { value, omitted };
}

const RPC_TRANSPORT_MAX_ARRAY_ITEMS = Math.min(MAX_ARRAY_ITEMS - 1, 900);
const RPC_TRANSPORT_MAX_MAP_KEYS = Math.min(MAX_MAP_KEYS - 4, 450);
const RPC_TRANSPORT_MAX_DEPTH = Math.min(MAX_JSON_DEPTH - 4, 28);
const RPC_TRANSPORT_MAX_NODES = Math.min(MAX_JSON_NODES - 1_000, 10_000);
const RPC_TRANSPORT_STRING_CONTENT_BYTES = 550_000;
const RPC_TRANSPORT_STRING_BYTES = Math.min(MAX_STRING_BYTES - 256, 60_000);
const RPC_TRANSPORT_KEY_BYTES = 1_024;
const RPC_TRANSPORT_OMITTED = "[transport data omitted]";
const RPC_TRANSPORT_TRUNCATED = "… [transport data truncated]";
const RPC_TRANSPORT_MARKER_KEYS = new Set([
	"inlineImageDataOmitted",
	RPC_TRANSCRIPT_IMAGE_DIGEST_KEY,
	"transportDataOmitted",
	"transportOmissionReasons",
]);
const RPC_TRANSPORT_ENVELOPE_KEYS = [
	"type",
	"id",
	"requestId",
	"commandId",
	"command",
	"toolCallId",
	"toolName",
	"sessionId",
	"agentId",
	"parentId",
	"status",
	"success",
	"isError",
] as const;

interface RpcProjectionState {
	contentBytes: number;
	nodes: number;
	omissions: Set<string>;
	ancestors: WeakSet<object>;
}

function sanitizedUnicode(value: string, state: RpcProjectionState): string {
	let result = "";
	let changed = false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				result += value[index]! + value[index + 1]!;
				index++;
			} else {
				result += "�";
				changed = true;
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			result += "�";
			changed = true;
		} else result += value[index]!;
	}
	if (changed) state.omissions.add("invalid_unicode_replaced");
	return result;
}

function encodedStringContentBytes(value: string): number {
	const encoded = JSON.stringify(value);
	return rpcTextEncoder.encode(encoded.slice(1, -1)).byteLength;
}

function truncateProjectedString(value: string, state: RpcProjectionState): string {
	const safe = sanitizedUnicode(value, state);
	const available = Math.max(0, RPC_TRANSPORT_STRING_CONTENT_BYTES - state.contentBytes);
	const fullUtf8Bytes = utf8ByteLength(safe);
	const fullEncodedBytes = encodedStringContentBytes(safe);
	if (
		fullUtf8Bytes <= RPC_TRANSPORT_STRING_BYTES &&
		fullEncodedBytes <= available &&
		fullEncodedBytes <= RPC_TRANSPORT_STRING_BYTES
	) {
		state.contentBytes += fullEncodedBytes;
		return safe;
	}

	state.omissions.add("oversized_string");
	const suffixUtf8 = utf8ByteLength(RPC_TRANSPORT_TRUNCATED);
	const suffixEncoded = encodedStringContentBytes(RPC_TRANSPORT_TRUNCATED);
	const utf8Limit = Math.max(0, RPC_TRANSPORT_STRING_BYTES - suffixUtf8);
	const encodedLimit = Math.max(0, Math.min(available, RPC_TRANSPORT_STRING_BYTES) - suffixEncoded);
	if (utf8Limit === 0 || encodedLimit === 0) return RPC_TRANSPORT_OMITTED;

	let prefix = "";
	let prefixUtf8 = 0;
	let prefixEncoded = 0;
	for (const character of safe) {
		const characterUtf8 = utf8ByteLength(character);
		const characterEncoded = encodedStringContentBytes(character);
		if (prefixUtf8 + characterUtf8 > utf8Limit || prefixEncoded + characterEncoded > encodedLimit) break;
		prefix += character;
		prefixUtf8 += characterUtf8;
		prefixEncoded += characterEncoded;
	}
	const result = `${prefix}${RPC_TRANSPORT_TRUNCATED}`;
	state.contentBytes += encodedStringContentBytes(result);
	return result;
}

function projectedObjectKey(key: string, state: RpcProjectionState): string {
	const safe = sanitizedUnicode(key, state);
	if (utf8ByteLength(safe) <= RPC_TRANSPORT_KEY_BYTES) {
		state.contentBytes += encodedStringContentBytes(safe);
		return safe;
	}
	state.omissions.add("oversized_map_key");
	let result = "";
	for (const character of safe) {
		if (utf8ByteLength(result + character) > RPC_TRANSPORT_KEY_BYTES - 16) break;
		result += character;
	}
	result += "…[truncated]";
	state.contentBytes += encodedStringContentBytes(result);
	return result;
}

function transportProjectionMarker(state: RpcProjectionState, reason: string): string {
	state.omissions.add(reason);
	return RPC_TRANSPORT_OMITTED;
}

function projectRpcTransportValue(value: unknown, state: RpcProjectionState, depth: number, path: string): unknown {
	state.nodes++;
	if (state.nodes > RPC_TRANSPORT_MAX_NODES) return transportProjectionMarker(state, "json_node_limit");
	if (depth > RPC_TRANSPORT_MAX_DEPTH) return transportProjectionMarker(state, "json_depth_limit");
	if (typeof value === "string") {
		if (/^data:image\/[a-z0-9.+-]+;base64,/iu.test(value)) {
			state.omissions.add("inline_image_data");
			return "[inline image data omitted]";
		}
		return truncateProjectedString(value, state);
	}
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		return transportProjectionMarker(state, "non_finite_number");
	}
	if (typeof value === "bigint") {
		state.omissions.add("non_json_value");
		return truncateProjectedString(value.toString(), state);
	}
	if (typeof value !== "object") return transportProjectionMarker(state, "non_json_value");
	if (state.ancestors.has(value)) return transportProjectionMarker(state, "cyclic_value");
	state.ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const limit = Math.min(value.length, RPC_TRANSPORT_MAX_ARRAY_ITEMS);
			if (limit < value.length) state.omissions.add("array_items");
			const result: unknown[] = [];
			for (let index = 0; index < limit; index++) {
				if (state.nodes >= RPC_TRANSPORT_MAX_NODES) {
					state.omissions.add("json_node_limit");
					break;
				}
				result.push(projectRpcTransportValue(value[index], state, depth + 1, `${path}[${index}]`));
			}
			return result;
		}

		const source = value as Record<string, unknown>;
		if (source.type === "image" && typeof source.data === "string" && source.data.length > 0) {
			state.omissions.add("inline_image_data");
			const image: Record<string, unknown> = {};
			for (const [key, item] of Object.entries(source)) {
				if (key === RPC_TRANSCRIPT_IMAGE_DIGEST_KEY) continue;
				image[key] = key === "data" ? "" : projectRpcTransportValue(item, state, depth + 1, `${path}.${key}`);
			}
			const digest = transcriptImageDigest(source.data, source.mimeType);
			if (digest) image[RPC_TRANSCRIPT_IMAGE_DIGEST_KEY] = digest;
			return image;
		}

		const entries = Object.entries(source);
		const ordered =
			depth === 0
				? [
						...RPC_TRANSPORT_ENVELOPE_KEYS.flatMap(key =>
							Object.hasOwn(source, key) ? ([[key, source[key]]] as Array<[string, unknown]>) : [],
						),
						...entries.filter(([key]) => !RPC_TRANSPORT_ENVELOPE_KEYS.includes(key as never)),
					]
				: entries;
		const result: Record<string, unknown> = {};
		let kept = 0;
		for (const [rawKey, item] of ordered) {
			if (RPC_TRANSPORT_MARKER_KEYS.has(rawKey)) continue;
			if (kept >= RPC_TRANSPORT_MAX_MAP_KEYS || state.nodes >= RPC_TRANSPORT_MAX_NODES) {
				state.omissions.add(kept >= RPC_TRANSPORT_MAX_MAP_KEYS ? "map_keys" : "json_node_limit");
				break;
			}
			const key = projectedObjectKey(rawKey, state);
			if (Object.hasOwn(result, key)) {
				state.omissions.add("map_key_collision");
				continue;
			}
			if (rawKey === "rawContent" || rawKey === "payload") {
				result[key] = transportProjectionMarker(state, rawKey === "rawContent" ? "raw_content" : "payload");
			} else result[key] = projectRpcTransportValue(item, state, depth + 1, `${path}.${rawKey}`);
			kept++;
		}
		return result;
	} finally {
		state.ancestors.delete(value);
	}
}

function withRpcTransportOmissions<T extends object>(value: T, state: RpcProjectionState): RpcTransportFrame<T> {
	const reasons = [...state.omissions].sort().slice(0, 32);
	if (reasons.length === 0) return value;
	return {
		...value,
		...(state.omissions.has("inline_image_data") ? { inlineImageDataOmitted: true as const } : {}),
		transportDataOmitted: true,
		transportOmissionReasons: reasons,
	};
}

function minimalRpcTransportFrame<T extends object>(frame: T, state: RpcProjectionState): RpcTransportFrame<T> {
	state.omissions.add("frame_projection");
	const source = frame as Record<string, unknown>;
	const minimal: Record<string, unknown> = {};
	const minimalState: RpcProjectionState = {
		contentBytes: 0,
		nodes: 0,
		omissions: state.omissions,
		ancestors: new WeakSet(),
	};
	for (const key of RPC_TRANSPORT_ENVELOPE_KEYS) {
		if (!Object.hasOwn(source, key)) continue;
		minimal[key] = projectRpcTransportValue(source[key], minimalState, 1, `frame.${key}`);
	}
	if (typeof minimal.type !== "string") minimal.type = "transport_projection";
	return withRpcTransportOmissions(minimal as T, minimalState);
}

/**
 * Prepare an internal appserver child frame without copying embedded image bytes
 * onto stdout. The original event/entry remains untouched and SessionManager has
 * already persisted it before a durable-entry notification is emitted.
 */
export function rpcTransportFrame<T extends object>(
	frame: T,
	managedAppserverTransport: boolean,
): RpcTransportFrame<T> {
	if (!managedAppserverTransport) return frame;
	if (isBoundedRpcFrame(frame)) {
		const projected = omitInlineImageData(frame);
		if (!projected.omitted) return frame;
		const candidate = { ...(projected.value as T), inlineImageDataOmitted: true as const };
		if (isBoundedRpcFrame(candidate)) return candidate;
	}

	const state: RpcProjectionState = {
		contentBytes: 0,
		nodes: 0,
		omissions: new Set(),
		ancestors: new WeakSet(),
	};
	const projected = projectRpcTransportValue(frame, state, 0, "frame");
	if (projected && typeof projected === "object" && !Array.isArray(projected)) {
		const candidate = withRpcTransportOmissions(projected as T, state);
		if (isBoundedRpcFrame(candidate)) return candidate;
	}
	const minimal = minimalRpcTransportFrame(frame, state);
	if (isBoundedRpcFrame(minimal)) return minimal;
	return {
		type: "transport_projection",
		transportDataOmitted: true,
		transportOmissionReasons: ["frame_projection"],
	} as unknown as RpcTransportFrame<T>;
}
type RpcAgentEndStatus = "completed" | "failed" | "cancelled";

function serializedJsonBytes(value: object): number | undefined {
	try {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) return undefined;
		return rpcTextEncoder.encode(encoded).byteLength;
	} catch {
		return undefined;
	}
}

function isBoundedRpcFrame(value: object): boolean {
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(value);
	} catch {
		return false;
	}
	if (encoded === undefined || rpcTextEncoder.encode(encoded).byteLength > RPC_AGENT_END_MAX_BYTES) return false;
	try {
		parseBounded(encoded);
		return true;
	} catch {
		return false;
	}
}

function rpcAgentEndStatus(messages: Extract<AgentSessionEvent, { type: "agent_end" }>["messages"]): RpcAgentEndStatus {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") continue;
		if ("stopReason" in message && message.stopReason === "error") return "failed";
		if ("stopReason" in message && message.stopReason === "aborted") return "cancelled";
		return "completed";
	}
	return "completed";
}

/**
 * Keep RPC terminal events below the appserver's one-line transport ceiling.
 *
 * Every durable message has already crossed this channel as a `session_entry`.
 * `agent_end.messages` is a redundant run aggregate, so retain the newest
 * contiguous suffix that fits while preserving the terminal event itself.
 */
export function boundedRpcSessionEvent(event: AgentSessionEvent): AgentSessionEvent {
	if (event.type !== "agent_end" || isBoundedRpcFrame(event)) return event;

	const terminal = {
		messageCount: event.messages.length,
		status: rpcAgentEndStatus(event.messages),
	};
	const empty = { ...event, messages: [], ...terminal };
	const minimal = { type: "agent_end" as const, messages: [], ...terminal };
	const emptyEvent = isBoundedRpcFrame(empty) ? empty : minimal;
	let bytes = serializedJsonBytes(emptyEvent);
	if (bytes === undefined) return minimal;

	let maxSuffixLength = 0;
	for (let index = event.messages.length - 1; index >= 0 && maxSuffixLength < MAX_ARRAY_ITEMS; index--) {
		const messageBytes = serializedJsonBytes(event.messages[index]!);
		if (messageBytes === undefined) break;
		const separatorBytes = maxSuffixLength === 0 ? 0 : 1;
		if (bytes + separatorBytes + messageBytes > RPC_AGENT_END_MAX_BYTES) break;
		bytes += separatorBytes + messageBytes;
		maxSuffixLength++;
	}

	let low = 0;
	let high = maxSuffixLength;
	while (low < high) {
		const candidateLength = Math.ceil((low + high) / 2);
		const candidate = { ...event, messages: event.messages.slice(-candidateLength), ...terminal };
		if (isBoundedRpcFrame(candidate)) low = candidateLength;
		else high = candidateLength - 1;
	}
	return low === 0 ? emptyEvent : { ...event, messages: event.messages.slice(-low), ...terminal };
}

export interface RpcSessionEntrySubscription {
	bind(sessionManager: RpcSessionEntryManager): void;
	unbind(): void;
	switchTo(sessionManager: RpcSessionEntryManager): void;
	dispose(): void;
}

/**
 * Route durable session appends through the RPC output writer.
 *
 * Binding a new manager first detaches the old manager, so switching sessions
 * cannot leave a stale transcript listener behind. A writer failure also
 * detaches the listener before rethrowing; SessionManager isolates that error
 * from persistence and other subscribers.
 */
export function createRpcSessionEntrySubscription(
	output: (frame: RpcSessionEntryFrame) => void,
): RpcSessionEntrySubscription {
	let boundManager: RpcSessionEntryManager | undefined;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;

	const detach = () => {
		const cleanup = unsubscribe;
		unsubscribe = undefined;
		boundManager = undefined;
		cleanup?.();
	};

	const bind = (sessionManager: RpcSessionEntryManager) => {
		if (disposed) return;
		if (boundManager === sessionManager && unsubscribe) return;
		detach();
		try {
			unsubscribe = sessionManager.subscribeEntryAppended(entry => {
				if (disposed) return;
				try {
					output({ type: "session_entry", entry });
				} catch (error) {
					disposed = true;
					detach();
					throw error;
				}
			});
			boundManager = sessionManager;
		} catch (error) {
			detach();
			throw error;
		}
	};

	return {
		bind,
		unbind() {
			if (!disposed) detach();
		},
		switchTo(sessionManager) {
			if (disposed) return;
			detach();
			bind(sessionManager);
		},
		dispose() {
			disposed = true;
			detach();
		},
	};
}

export type RpcSessionChangeCommand = Extract<
	RpcCommand,
	{ type: "new_session" } | { type: "switch_session" } | { type: "branch" }
>;

export type RpcSessionChangeResult =
	| { type: "new_session"; data: { cancelled: boolean } }
	| { type: "switch_session"; data: { cancelled: boolean } }
	| { type: "branch"; data: { text: string; cancelled: boolean } };

export type RpcSessionChangeSession = Pick<AgentSession, "newSession" | "switchSession" | "branch">;

export type RpcSkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;
export type RpcSkillCommandResult = { agentInvoked: true };

export async function tryRunRpcSkillCommand(
	session: RpcSkillCommandSession,
	text: string,
	streamingBehavior: "steer" | "followUp" = "steer",
): Promise<RpcSkillCommandResult | false> {
	if (!session.skillsSettings?.enableSkillCommands) return false;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return false;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return false;
	const built = await buildSkillPromptMessage(skill, parsed.args, "user");
	await session.promptCustomMessage(
		{
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: built.message,
			display: true,
			details: built.details,
			attribution: "user",
		},
		{ streamingBehavior },
	);
	return { agentInvoked: true };
}

export function reportLocalOnlyPromptResult(input: {
	id: string | undefined;
	prompt: Promise<boolean>;
	output: (obj: RpcPromptResultFrame) => void;
	hasExtensionAgentMessageTask?: () => boolean;
	waitForExtensionAgentMessageTasks?: () => Promise<void>;
}): void {
	void input.prompt
		.then(async agentInvoked => {
			if (agentInvoked) return;
			await input.waitForExtensionAgentMessageTasks?.();
			if (!input.hasExtensionAgentMessageTask?.()) {
				input.output({ type: "prompt_result", id: input.id, agentInvoked: false });
			}
		})
		.catch(error => {
			input.output({
				type: "prompt_result",
				id: input.id,
				error: error instanceof Error ? error.message : String(error),
			});
		});
}

type RpcExtensionUserMessageScope = {
	hasAgentMessageTask: boolean;
	pendingAgentMessageTasks: Set<Promise<void>>;
};

/**
 * Tracks extension-originated messages while an RPC prompt is executing.
 * A slash command can resolve the outer prompt as local-only while also
 * scheduling agent work through pi.sendUserMessage() or pi.sendMessage()
 * with triggerTurn; that prompt must not report agentInvoked:false to the host.
 */
export class RpcExtensionUserMessageTracker {
	#activePromptScopes = new Set<RpcExtensionUserMessageScope>();

	markAgentMessageTask(): void {
		for (const scope of this.#activePromptScopes) {
			scope.hasAgentMessageTask = true;
		}
	}

	trackAgentMessageTask(task: Promise<unknown>): void {
		for (const scope of this.#activePromptScopes) {
			this.#trackAgentMessageTaskForScope(scope, task);
		}
	}

	#trackAgentMessageTaskForScope(scope: RpcExtensionUserMessageScope, task: Promise<unknown>): void {
		const scopedTask = task.then(
			() => {
				scope.hasAgentMessageTask = true;
			},
			() => {},
		);
		scope.pendingAgentMessageTasks.add(scopedTask);
		void scopedTask.finally(() => {
			scope.pendingAgentMessageTasks.delete(scopedTask);
		});
	}

	async #waitForAgentMessageTasks(scope: RpcExtensionUserMessageScope): Promise<void> {
		while (scope.pendingAgentMessageTasks.size > 0) {
			await Promise.allSettled(Array.from(scope.pendingAgentMessageTasks));
		}
	}

	watchPrompt<T>(startPrompt: () => Promise<T>): {
		prompt: Promise<T>;
		hasAgentMessageTask: () => boolean;
		waitForAgentMessageTasks: () => Promise<void>;
	} {
		const scope: RpcExtensionUserMessageScope = {
			hasAgentMessageTask: false,
			pendingAgentMessageTasks: new Set(),
		};
		this.#activePromptScopes.add(scope);
		let prompt: Promise<T>;
		try {
			prompt = startPrompt();
		} catch (error) {
			this.#activePromptScopes.delete(scope);
			throw error;
		}
		return {
			prompt: prompt.finally(() => {
				this.#activePromptScopes.delete(scope);
			}),
			hasAgentMessageTask: () => scope.hasAgentMessageTask,
			waitForAgentMessageTasks: () => this.#waitForAgentMessageTasks(scope),
		};
	}
}

export function watchAndReportLocalOnlyPromptResult(input: {
	id: string | undefined;
	startPrompt: () => Promise<boolean>;
	output: (obj: RpcPromptResultFrame) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
}): void {
	const trackedPrompt = input.extensionUserMessageTracker.watchPrompt(input.startPrompt);
	reportLocalOnlyPromptResult({
		id: input.id,
		prompt: trackedPrompt.prompt,
		output: input.output,
		hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
	});
}

/**
 * Dependencies for {@link dispatchRpcInputFrame}. Provided by the RPC mode
 * entrypoint; broken out so tests can drive the input loop with stubs.
 */
export interface RpcInputFrameDeps {
	handleCommand: (command: RpcCommand) => Promise<RpcResponse>;
	output: RpcOutput;
	errorResponse: (id: string | undefined, command: string, message: string) => RpcResponse;
	trackBackgroundTask?: (task: Promise<void>) => void;
	pendingExtensionRequests: Map<string, PendingExtensionRequest>;
	onHostToolResult: (frame: RpcHostToolResult) => void;
	onHostToolUpdate: (frame: RpcHostToolUpdate) => void;
	onHostUriResult: (frame: RpcHostUriResult) => void;
}

/**
 * Structural guard for a well-formed extension UI response frame. Mirrors the
 * shape declared in {@link RpcExtensionUIResponse} — a truthy record with
 * `type === "extension_ui_response"` and a string `id`. Payload variants (value,
 * confirmed, cancelled) are validated at the read site.
 */
function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_response" && typeof value.id === "string";
}

/** Dispatch side-channel frames that must overtake the serialized command queue. */
export function dispatchRpcControlFrame(parsed: unknown, deps: RpcInputFrameDeps): boolean {
	if (isRpcExtensionUIResponse(parsed)) {
		const pending = deps.pendingExtensionRequests.get(parsed.id);
		if (pending) pending.resolve(parsed);
		return true;
	}

	if (isRpcHostToolResult(parsed)) {
		deps.onHostToolResult(parsed);
		return true;
	}

	if (isRpcHostToolUpdate(parsed)) {
		deps.onHostToolUpdate(parsed);
		return true;
	}

	if (isRpcHostUriResult(parsed)) {
		deps.onHostUriResult(parsed);
		return true;
	}

	return false;
}

/**
 * Dispatch a single parsed frame from the RPC input stream.
 *
 * Bash commands are dispatched in the background so the caller can keep reading
 * subsequent frames while a shell command is still running. This lets a client
 * send `abort_bash` while a long-running `bash` is in flight. Response
 * correlation is preserved via each command's `id`; ordering across concurrent
 * commands is not guaranteed and clients MUST match on `id`.
 *
 * @returns `undefined` when the frame was routed to a side-channel handler
 *   (extension UI response, host tool/URI frames) or dispatched in the
 *   background (`bash`). Otherwise a promise that resolves once the response
 *   for the command has been emitted via `output`. Errors from `handleCommand`
 *   on non-`bash` commands propagate; the caller is expected to wrap them.
 */
export function dispatchRpcInputFrame(parsed: unknown, deps: RpcInputFrameDeps): Promise<void> | undefined {
	if (dispatchRpcControlFrame(parsed, deps)) return undefined;
	// Regular RPC command. The transport contract states each remaining frame
	// is an {@link RpcCommand}; `handleCommand`'s `default` arm surfaces
	// unknown discriminants as an error response, so we do not shape-check
	// the union here.
	const command = parsed as RpcCommand;

	// `bash` can run for a long time. Dispatch it in the background so a
	// subsequent `abort_bash` frame can be read and handled without waiting
	// for the shell command to finish on its own. The response is emitted
	// when `handleCommand` resolves; clients correlate via `command.id`.
	if (command.type === "bash") {
		const task = (async () => {
			try {
				deps.output(await deps.handleCommand(command));
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				deps.output(deps.errorResponse(command.id, "bash", message));
			}
		})();
		deps.trackBackgroundTask?.(task);
		return undefined;
	}

	return (async () => {
		deps.output(await deps.handleCommand(command));
	})();
}

/** Serializes ordinary RPC commands while allowing control frames to dispatch immediately. */
export class RpcInputDispatcher {
	#tail: Promise<void> = Promise.resolve();
	#tasks = new Set<Promise<void>>();
	readonly #deps: RpcInputFrameDeps;
	readonly #afterSerialCommand: (() => Promise<void>) | undefined;

	constructor(options: { deps: RpcInputFrameDeps; afterSerialCommand?: () => Promise<void> }) {
		this.#deps = options.deps;
		this.#afterSerialCommand = options.afterSerialCommand;
	}

	/** Accept a parsed input frame without blocking the stdin reader. */
	dispatch(parsed: unknown): void {
		try {
			if (dispatchRpcControlFrame(parsed, this.#deps)) return;

			const command = parsed as RpcCommand;
			if (command.type === "bash") {
				dispatchRpcInputFrame(command, this.#deps);
				return;
			}

			const task = this.#tail.then(
				() => this.#dispatchSerialCommand(command),
				() => this.#dispatchSerialCommand(command),
			);
			this.#tail = task.catch(() => {});
			this.#tasks.add(task);
			void task.finally(() => {
				this.#tasks.delete(task);
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(undefined, "parse", `Failed to parse command: ${message}`));
		}
	}

	/** Await every accepted serial command, including commands queued before EOF. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	async #dispatchSerialCommand(command: RpcCommand): Promise<void> {
		try {
			const awaited = dispatchRpcInputFrame(command, this.#deps);
			if (awaited) await awaited;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(command.id, command.type, message));
		} finally {
			await this.#afterSerialCommand?.();
		}
	}
}

/**
 * Coordinates deferred shutdown with in-flight background input tasks.
 *
 * `pi.shutdown()` from an extension only *requests* shutdown; the process must
 * not exit while a background-dispatched command (`bash`, see
 * {@link dispatchRpcInputFrame}) still owes the client a response frame. The
 * coordinator tracks those tasks, re-checks the shutdown request whenever one
 * settles (covering a shutdown requested mid-bash with no follow-up client
 * frame), and drains every tracked task before invoking `performShutdown`.
 * The shutdown sequence is latched so concurrent triggers (input loop and
 * settling tasks) run it exactly once.
 */
export class RpcShutdownCoordinator {
	#tasks = new Set<Promise<void>>();
	#shutdown: Promise<void> | undefined;
	readonly #isShutdownRequested: () => boolean;
	readonly #performShutdown: () => Promise<void>;

	constructor(options: { isShutdownRequested: () => boolean; performShutdown: () => Promise<void> }) {
		this.#isShutdownRequested = options.isShutdownRequested;
		this.#performShutdown = options.performShutdown;
	}

	/**
	 * Track a background input task. When it settles it is untracked and the
	 * shutdown request is re-checked, so a deferred shutdown fires even when
	 * no further client frames arrive.
	 */
	track(task: Promise<void>): void {
		this.#tasks.add(task);
		void task.finally(() => {
			this.#tasks.delete(task);
			// Fire-and-forget: performShutdown ends the process. Rejections are
			// not expected — hook errors are caught inside extensionRunner.emit,
			// and background tasks catch their own dispatch errors.
			void this.checkShutdownRequested();
		});
	}

	/** Await every tracked task, including tasks tracked while draining. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	/**
	 * If shutdown was requested, drain background tasks (so every owed
	 * response frame is written) before running the shutdown sequence.
	 */
	checkShutdownRequested(): Promise<void> {
		if (!this.#shutdown) {
			if (!this.#isShutdownRequested()) return Promise.resolve();
			this.#shutdown = this.drain().then(() => this.#performShutdown());
		}
		return this.#shutdown;
	}
}

export type RpcSubagentResetRegistry = Pick<RpcSubagentRegistry, "clear">;

export async function handleRpcSessionChange(
	session: RpcSessionChangeSession,
	command: RpcSessionChangeCommand,
	subagentRegistry?: RpcSubagentResetRegistry,
): Promise<RpcSessionChangeResult> {
	switch (command.type) {
		case "new_session": {
			const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const cancelled = !(await session.newSession(options));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "new_session", data: { cancelled } };
		}

		case "switch_session": {
			const cancelled = !(await session.switchSession(command.sessionPath));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "switch_session", data: { cancelled } };
		}

		case "branch": {
			const result = await session.branch(command.entryId);
			if (!result.cancelled) subagentRegistry?.clear();
			return { type: "branch", data: { text: result.selectedText, cancelled: result.cancelled } };
		}
	}
	throw new Error("Unsupported RPC session change command");
}

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
		};
	});
}

function parseValueDialogResponse(
	response: RpcExtensionUIResponse,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isSubagentSubscriptionLevel(value: unknown): value is RpcSubagentSubscriptionLevel {
	return value === "off" || value === "progress" || value === "events";
}

export function requestRpcEditor(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
	let settled = false;

	const cleanup = () => {
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: string | undefined) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		finish(undefined);
	};

	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
	pendingRequests.set(id, {
		resolve: response => {
			if ("cancelled" in response && response.cancelled) {
				finish(undefined);
			} else if ("value" in response) {
				finish(response.value);
			} else {
				finish(undefined);
			}
		},
		reject: fail,
	});
	output({
		type: "extension_ui_request",
		id,
		method: "editor",
		title,
		prefill,
		promptStyle: editorOptions?.promptStyle,
	} as RpcExtensionUIRequest);
	return promise;
}
/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	eventBus?: EventBus,
): Promise<never> {
	// Signal to RPC clients that the server is ready to accept commands
	// Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
	// process.stdout with no newline, which the reader merges with the next JSON line and
	// breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
	// may write there.
	process.env.PI_NOTIFICATIONS = "off";

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		process.stdout.write(`${JSON.stringify(obj)}\n`);
	};
	const sessionEntrySubscription = createRpcSessionEntrySubscription(output);
	sessionEntrySubscription.bind(session.sessionManager);
	const emitRpcTitles = shouldEmitRpcTitles();

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	const extensionUserMessageTracker = new RpcExtensionUserMessageTracker();

	const pendingExtensionRequests = new RpcPendingExtensionRequests();
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	const requestedSubagentSubscription = process.env.OMP_APP_SUBAGENT_SUBSCRIPTION;
	const initialSubagentSubscription = isSubagentSubscriptionLevel(requestedSubagentSubscription)
		? requestedSubagentSubscription
		: "off";
	const subagentRegistry = eventBus
		? new RpcSubagentRegistry(eventBus, output, initialSubagentSubscription)
		: undefined;
	const sessionTeardown = registerRpcSessionTeardown({
		beginDispose: () => session.beginDispose(),
		cleanupProtocol: () => {
			sessionEntrySubscription.dispose();
			hostToolBridge.rejectAllPending("RPC session shut down before host tool execution completed");
			hostUriBridge.clear("RPC session shut down before host URI request completed");
			subagentRegistry?.dispose();
		},
		disposeSession: reason => session.dispose(reason === undefined ? {} : { reason }),
	});
	// Readiness guarantees the parent can safely terminate this child: the
	// postmortem callback that releases the session lock is already armed.
	output({ type: "ready" });

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		constructor(
			private pendingRequests: Map<string, PendingExtensionRequest>,
			private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
		) {}

		/** Helper for dialog methods with signal/timeout support */
		#createDialogPromise<T>(
			opts: ExtensionUIDialogOptions | undefined,
			defaultValue: T,
			request: Record<string, unknown>,
			parseResponse: (response: RpcExtensionUIResponse) => T,
		): Promise<T> {
			if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

			const id = Snowflake.next() as string;
			const { promise, resolve, reject } = Promise.withResolvers<T>();
			let timeoutId: NodeJS.Timeout | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.pendingRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout !== undefined) {
				timeoutId = setTimeout(() => {
					opts.onTimeout?.();
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			this.pendingRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			this.output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
			return promise;
		}

		select(
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return this.#createDialogPromise(
				dialogOptions,
				undefined,
				{
					method: "select",
					title,
					options: options.map(getExtensionUISelectOptionLabel),
					timeout: dialogOptions?.timeout,
				},
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
			return this.#createDialogPromise(
				dialogOptions,
				false,
				{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
				response => {
					if ("cancelled" in response && response.cancelled) {
						if (response.timedOut) dialogOptions?.onTimeout?.();
						return false;
					}
					if ("confirmed" in response) return response.confirmed;
					return false;
				},
			);
		}

		input(
			title: string,
			placeholder?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return this.#createDialogPromise(
				dialogOptions,
				undefined,
				{ method: "input", title, placeholder, timeout: dialogOptions?.timeout },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		}

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		}

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		}

		setWorkingMessage(_message?: string): void {
			// Not supported in RPC mode
		}

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				this.output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		}

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		}

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		}

		setTitle(title: string): void {
			// Title updates are low-value noise for most RPC hosts; opt in via PI_RPC_EMIT_TITLE=1.
			if (!emitRpcTitles) return;
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		}

		async custom(): Promise<never> {
			// Custom UI not supported in RPC mode
			return undefined as never;
		}

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		}

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		}

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		}

		async editor(
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
			editorOptions?: { promptStyle?: boolean },
		): Promise<string | undefined> {
			return requestRpcEditor(this.pendingRequests, this.output, title, prefill, dialogOptions, editorOptions);
		}

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		}

		get theme(): Theme {
			return theme;
		}

		getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
			return Promise.resolve([]);
		}

		getTheme(_name: string): Promise<Theme | undefined> {
			return Promise.resolve(undefined);
		}

		setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
			// Theme switching not supported in RPC mode
			return Promise.resolve({ success: false, error: "Theme switching not supported in RPC mode" });
		}

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		}

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		}

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		}
	}

	// Wire up UI context for tool execution (ask tool, etc.) and extensions.
	// A single shared instance routes all responses received on stdin to the
	// correct waiting promise regardless of which code path created the request.
	const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, output);
	setToolUIContext?.(rpcUiContext, true);

	// Set up extensions with RPC-based UI context.
	try {
		await initializeExtensions(session, {
			reportSendError: (action, err) => {
				output(error(undefined, action, err.message));
			},
			reportRuntimeError: err => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
			onShutdown: () => {
				shutdownState.requested = true;
			},
			trackAgentInvokingMessage: task => {
				extensionUserMessageTracker.trackAgentMessageTask(task);
			},
			uiContext: rpcUiContext,
		});
	} catch (error) {
		sessionEntrySubscription.dispose();
		throw error;
	}

	// Output all agent events as JSON
	session.subscribe(event => {
		output(boundedRpcSessionEvent(event));
	});

	const getAvailableCommands = async () => buildAvailableSlashCommands(session);
	const reloadPluginState = async () => {
		const cwd = session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		resetCapabilities();
		session.setSlashCommands(await loadSlashCommands({ cwd }));
		await session.refreshSshTool({ activateIfAvailable: true });
		await emitAvailableCommandsUpdate();
	};
	const emitAvailableCommandsUpdate = async () => {
		output({ type: "available_commands_update", commands: await getAvailableCommands() });
	};
	session.subscribeCommandMetadataChanged(() => {
		void emitAvailableCommandsUpdate();
	});
	await emitAvailableCommandsUpdate();

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// The appserver receives this response only after managed image bytes
				// have been opened, validated, and converted to native ImageContent.
				const promptImages = await resolveRpcPromptImages(command.images, command.appImageRefs);
				const skillResult = await tryRunRpcSkillCommand(session, command.message, command.streamingBehavior);
				if (skillResult) {
					return success(id, "prompt", skillResult);
				}
				const builtinResult = await executeAcpBuiltinSlashCommand(command.message, {
					session,
					sessionManager: session.sessionManager,
					settings: session.settings,
					cwd: session.sessionManager.getCwd(),
					output: text => output({ type: "command_output", text }),
					refreshCommands: emitAvailableCommandsUpdate,
					reloadPlugins: reloadPluginState,
					notifyTitleChanged: async () => {
						output({ type: "session_info_update", title: session.sessionName, sessionId: session.sessionId });
					},
					notifyConfigChanged: async () => {
						output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
					},
				});
				if (builtinResult !== false) {
					if ("prompt" in builtinResult) {
						watchAndReportLocalOnlyPromptResult({
							id,
							startPrompt: () => session.prompt(builtinResult.prompt, { images: promptImages }),
							output,
							extensionUserMessageTracker,
						});
						return success(id, "prompt");
					}
					return success(id, "prompt", { agentInvoked: false });
				}

				// Don't await - events will stream
				// Extension commands are executed immediately, file prompt templates are expanded
				// If streaming and streamingBehavior specified, queues via steer/followUp
				watchAndReportLocalOnlyPromptResult({
					id,
					startPrompt: () =>
						session.prompt(command.message, {
							images: promptImages,
							streamingBehavior: command.streamingBehavior,
						}),
					output,
					extensionUserMessageTracker,
				});
				return success(id, "prompt");
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return success(id, "abort");
			}
			case "retry": {
				const retried = await session.retry();
				return success(id, "retry", { retried });
			}

			case "pause": {
				const changed = agentPauseGate.pause();
				return success(id, "pause", { paused: agentPauseGate.paused, changed });
			}

			case "resume": {
				const resumed = agentPauseGate.resume() !== undefined;
				return success(id, "resume", { paused: agentPauseGate.paused, resumed });
			}

			case "abort_and_prompt": {
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				session.prompt(command.message, { images: command.images }).catch(promptError =>
					output({
						type: "prompt_result",
						id,
						error: promptError instanceof Error ? promptError.message : String(promptError),
					}),
				);
				return success(id, "abort_and_prompt");
			}

			case "new_session":
			case "switch_session":
			case "branch": {
				try {
					const result = await handleRpcSessionChange(session, command, subagentRegistry);
					sessionEntrySubscription.bind(session.sessionManager);
					if (!result.data.cancelled) await emitAvailableCommandsUpdate();
					return success(id, result.type, result.data);
				} catch (error) {
					try {
						sessionEntrySubscription.bind(session.sessionManager);
					} catch {
						sessionEntrySubscription.dispose();
					}
					throw error;
				}
			}

			case "get_state": {
				const queued = session.getQueuedMessages();
				const state: RpcSessionState = {
					model: session.model
						? {
								...session.model,
								...(session.configuredModelSelector() ? { selector: session.configuredModelSelector() } : {}),
								...(session.configuredModelRole() ? { role: session.configuredModelRole() } : {}),
							}
						: undefined,
					thinkingLevel: session.configuredThinkingLevel(),
					fast: session.isFastModeEnabled(),
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					isPaused: agentPauseGate.paused,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					interruptMode: session.interruptMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					queuedMessageCount: session.queuedMessageCount,
					queuedMessages: {
						steering: queued.steering.slice(0, 128).map(text => text.slice(0, 65_536)),
						followUp: queued.followUp.slice(0, 128).map(text => text.slice(0, 65_536)),
					},
					todoPhases: session.getTodoPhases(),
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: isZodSchema(tool.parameters) ? zodToWireSchema(tool.parameters) : tool.parameters,
						examples: tool.examples,
					})),
					contextUsage: session.getContextUsage(),
				};
				return success(id, "get_state", state);
			}

			case "get_available_commands": {
				return success(id, "get_available_commands", { commands: await getAvailableCommands() });
			}

			case "set_todos": {
				session.setTodoPhases(command.phases);
				return success(id, "set_todos", { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const rpcTools = hostToolBridge.setTools(tools);
				await session.refreshRpcHostTools(rpcTools);
				return success(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
			}

			case "set_host_uri_schemes": {
				try {
					const schemes = hostUriBridge.setSchemes(command.schemes);
					return success(id, "set_host_uri_schemes", { schemes });
				} catch (err) {
					return error(id, "set_host_uri_schemes", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_subagent_subscription": {
				if (!subagentRegistry) {
					return error(id, "set_subagent_subscription", "Subagent event bus is unavailable");
				}
				if (!isSubagentSubscriptionLevel(command.level)) {
					return error(
						id,
						"set_subagent_subscription",
						`Invalid subagent subscription level: ${String(command.level)}`,
					);
				}
				subagentRegistry.setSubscriptionLevel(command.level);
				return success(id, "set_subagent_subscription", { level: subagentRegistry.getSubscriptionLevel() });
			}

			case "get_subagents": {
				if (!subagentRegistry) {
					return error(id, "get_subagents", "Subagent event bus is unavailable");
				}
				return success(id, "get_subagents", { subagents: subagentRegistry.getSubagents() });
			}

			case "get_subagent_messages": {
				if (!subagentRegistry) return error(id, "get_subagent_messages", "Subagent event bus is unavailable");
				try {
					if (command.fromByte !== undefined && !Number.isFinite(command.fromByte))
						return error(id, "get_subagent_messages", "fromByte must be a finite number");
					const sessionFile = subagentRegistry.resolveSessionFile(command);
					const transcript = await readRpcSubagentTranscript(sessionFile, command.fromByte);
					return success(id, "get_subagent_messages", transcript);
				} catch (err) {
					return error(id, "get_subagent_messages", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_model": {
				try {
					const hasSelector =
						command.selector !== undefined || (command.provider !== undefined && command.modelId !== undefined);
					const hasRole = command.role !== undefined;
					if (hasSelector === hasRole) throw new Error("provide exactly one selector or role");
					if (command.selector === undefined && !hasRole) {
						await session.setModelSelector({
							selector: `${command.provider}/${command.modelId}`,
							persist: command.persist,
						});
					} else {
						await session.setModelSelector({
							selector: command.selector,
							role: command.role,
							persist: command.persist,
						});
					}
					return success(id, "set_model", session.model);
				} catch (caught) {
					return error(id, "set_model", caught instanceof Error ? caught.message : String(caught));
				}
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = session.getAvailableModels();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				try {
					session.setThinkingLevelValidated(command.level);
					return success(id, "set_thinking_level");
				} catch (caught) {
					return error(id, "set_thinking_level", caught instanceof Error ? caught.message : String(caught));
				}
			}

			case "set_fast": {
				if (!session.setFastMode(command.enabled))
					return error(id, "set_fast", "Fast mode is unsupported for the current model");
				return success(id, "set_fast", { enabled: session.isFastModeEnabled() });
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				session.setInterruptMode(command.mode);
				return success(id, "set_interrupt_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return success(id, "get_branch_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				return success(id, "set_session_name");
			}

			case "handoff": {
				// Resetting the agent mid-stream lets the live turn keep emitting into a
				// session that handoff has already torn down. Refuse while a prompt is in
				// flight (mirrors the TUI /handoff guard).
				if (session.isStreaming) {
					return error(id, "handoff", "Cannot hand off while a response is in progress");
				}
				const result = await session.handoff(command.customInstructions);
				return success(id, "handoff", result ? { savedPath: result.savedPath } : null);
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Login
			// =================================================================

			case "get_login_providers": {
				const providers = getOAuthProviders().map(provider => ({
					id: provider.id,
					name: provider.name,
					available: provider.available,
					authenticated: session.modelRegistry.authStorage.hasAuth(provider.id),
				}));
				return success(id, "get_login_providers", { providers });
			}

			case "login": {
				const knownProvider = getOAuthProviders().find(p => p.id === command.providerId);
				if (!knownProvider) {
					return error(id, "login", `Unknown OAuth provider: ${command.providerId}`);
				}
				const uiCtx = new RpcExtensionUIContext(pendingExtensionRequests, output);
				// Track whether onAuth has fired. Providers that require interactive
				// input before a browser URL cannot be satisfied headlessly; after
				// onAuth, prompt input is the pasted OAuth code/redirect URL path.
				let authEmitted = false;
				try {
					await session.modelRegistry.authStorage.login(command.providerId, {
						onAuth: info => {
							authEmitted = true;
							output({
								type: "extension_ui_request",
								id: Snowflake.next() as string,
								method: "open_url",
								url: info.url,
								launchUrl: info.launchUrl,
								instructions: info.instructions,
							} as RpcExtensionUIRequest);
						},
						onProgress: message => {
							uiCtx.notify(message, "info");
						},
						onPrompt: async prompt => {
							if (!authEmitted) {
								// onPrompt called before any auth URL — provider requires
								// interactive input that cannot be satisfied headlessly.
								return Promise.reject(
									new Error(
										`Provider '${command.providerId}' requires interactive prompts ` +
											"which are not supported in RPC mode. Use the terminal UI to log in.",
									),
								);
							}
							return (await uiCtx.input(prompt.message, prompt.placeholder, { timeout: 600_000 })) ?? "";
						},
					});
					await session.modelRegistry.refresh();
					return success(id, "login", { providerId: command.providerId });
				} catch (err: unknown) {
					return error(id, "login", err instanceof Error ? err.message : String(err));
				}
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	// Deferred shutdown (pi.shutdown() from an extension) must not kill the
	// process while a background-dispatched bash still owes the client its
	// response frame. The coordinator drains tracked tasks before exiting and
	// re-checks the request as each task settles.
	const shutdownCoordinator = new RpcShutdownCoordinator({
		isShutdownRequested: () => shutdownState.requested,
		performShutdown: async () => {
			await sessionTeardown.shutdown();
			await postmortem.quit(0);
		},
	});

	const dispatchFrameDeps: RpcInputFrameDeps = {
		handleCommand,
		output,
		errorResponse: error,
		trackBackgroundTask: task => shutdownCoordinator.track(task),
		pendingExtensionRequests,
		onHostToolResult: frame => hostToolBridge.handleResult(frame),
		onHostToolUpdate: frame => hostToolBridge.handleUpdate(frame),
		onHostUriResult: frame => hostUriBridge.handleResult(frame),
	};

	const inputDispatcher = new RpcInputDispatcher({
		deps: dispatchFrameDeps,
		afterSerialCommand: () => shutdownCoordinator.checkShutdownRequested(),
	});

	// Keep the stdin reader moving: side-channel frames dispatch immediately,
	// ordinary commands serialize through inputDispatcher, and bash remains
	// background-dispatched so abort_bash can overtake it.
	for await (const parsed of readJsonl(Bun.stdin.stream())) {
		inputDispatcher.dispatch(parsed);
	}

	// stdin closed — RPC client is gone. Fail pending side-channel requests
	// first so active/queued commands can settle, then drain accepted work.
	pendingExtensionRequests.rejectAll("RPC client disconnected before extension UI response completed");
	hostToolBridge.close("RPC client disconnected before host tool execution completed");
	hostUriBridge.clear("RPC client disconnected before host URI request completed");
	await inputDispatcher.drain();
	await shutdownCoordinator.drain();
	subagentRegistry?.dispose();
	// Release the session lock and flush the postmortem before RPC exits.
	await sessionTeardown.shutdown();
	await postmortem.quit(0);
	process.exit(0);
}
