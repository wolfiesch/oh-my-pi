import { fail } from "./errors.js";
import { bool, boundedArray, boundedMap, boundedText, controlFree, inputObject, safeSeq } from "./guards.js";
import type { ContextUsage } from "./session-index.js";

export type SessionQueueMode = "all" | "one-at-a-time";
export interface SessionModel {
	id: string;
	provider: string;
	displayName?: string;
	selector?: string;
	role?: string;
}
export interface QueuedMessages {
	steering: string[];
	followUp: string[];
}
const MAX_QUEUE_ITEMS = 128;
const MAX_QUEUE_TEXT = 65_536;
export interface SessionStateResult {
	isStreaming: boolean;
	isCompacting: boolean;
	isPaused: boolean;
	messageCount: number;
	queuedMessageCount: number;
	steeringMode: SessionQueueMode;
	followUpMode: SessionQueueMode;
	interruptMode: "immediate" | "wait";
	queuedMessages?: QueuedMessages;
	model?: SessionModel;
	thinking?: string;
	fast?: boolean;
	sessionName?: string;
	contextUsage?: ContextUsage;
}
const KEYS = new Set([
	"isStreaming",
	"isCompacting",
	"isPaused",
	"messageCount",
	"queuedMessageCount",
	"steeringMode",
	"followUpMode",
	"interruptMode",
	"model",
	"thinking",
	"fast",
	"sessionName",
	"contextUsage",
	"queuedMessages",
]);
function strict(value: unknown, path: string): Record<string, unknown> {
	const out = boundedMap(value, path);
	for (const key of Object.keys(out))
		if (!KEYS.has(key)) fail("INVALID_FRAME", "unknown state field", `${path}.${key}`);
	return out;
}
function mode(value: unknown, path: string): SessionQueueMode {
	const text = controlFree(value, path, 32);
	if (text !== "all" && text !== "one-at-a-time") fail("INVALID_FRAME", "invalid queue mode", path);
	return text;
}
function context(value: unknown, path: string): ContextUsage {
	const out = boundedMap(value, path);
	const used = safeSeq(out.used, `${path}.used`);
	const limit = safeSeq(out.limit, `${path}.limit`);
	if (used > limit) fail("BOUNDS", "context usage exceeds limit", path);
	return { used, limit };
}
function queues(value: unknown, path: string): QueuedMessages {
	const raw = boundedMap(value, path);
	const decode = (entry: unknown, index: number): string => boundedText(entry, `${path}.${index}`, MAX_QUEUE_TEXT);
	const steering = boundedArray(raw.steering, `${path}.steering`, MAX_QUEUE_ITEMS).map(decode);
	const followUp = boundedArray(raw.followUp, `${path}.followUp`, MAX_QUEUE_ITEMS).map(decode);
	return { steering, followUp };
}
export function decodeSessionStateResult(value: unknown): SessionStateResult {
	const out = strict(value, "result");
	const isStreaming = bool(out.isStreaming, "result.isStreaming");
	const isCompacting = bool(out.isCompacting, "result.isCompacting");
	const isPaused = bool(out.isPaused, "result.isPaused");
	const messageCount = safeSeq(out.messageCount, "result.messageCount");
	const queuedMessageCount = safeSeq(out.queuedMessageCount, "result.queuedMessageCount");
	const steeringMode = mode(out.steeringMode, "result.steeringMode");
	const followUpMode = mode(out.followUpMode, "result.followUpMode");
	const interruptMode = controlFree(out.interruptMode, "result.interruptMode", 32);
	if (interruptMode !== "immediate" && interruptMode !== "wait")
		fail("INVALID_FRAME", "invalid interrupt mode", "result.interruptMode");
	let model: SessionModel | undefined;
	if (out.model !== undefined) {
		const raw = boundedMap(out.model, "result.model");
		const keys = Object.keys(raw);
		if (
			keys.some(
				key => key !== "id" && key !== "provider" && key !== "displayName" && key !== "selector" && key !== "role",
			)
		)
			fail("INVALID_FRAME", "unknown model field", "result.model");
		model = {
			id: controlFree(raw.id, "result.model.id", 256),
			provider: controlFree(raw.provider, "result.model.provider", 256),
			...(raw.displayName === undefined
				? {}
				: { displayName: controlFree(raw.displayName, "result.model.displayName", 256) }),
			...(raw.selector === undefined ? {} : { selector: controlFree(raw.selector, "result.model.selector", 512) }),
			...(raw.role === undefined ? {} : { role: controlFree(raw.role, "result.model.role", 256) }),
		};
	}
	const thinking = out.thinking === undefined ? undefined : controlFree(out.thinking, "result.thinking", 64);
	if (
		thinking !== undefined &&
		!["inherit", "off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)
	)
		fail("INVALID_FRAME", "invalid thinking level", "result.thinking");
	const fast = out.fast === undefined ? undefined : bool(out.fast, "result.fast");
	const sessionName =
		out.sessionName === undefined ? undefined : controlFree(out.sessionName, "result.sessionName", 512);
	const contextUsage = out.contextUsage === undefined ? undefined : context(out.contextUsage, "result.contextUsage");
	const queuedMessages =
		out.queuedMessages === undefined ? undefined : queues(out.queuedMessages, "result.queuedMessages");
	return {
		isStreaming,
		isCompacting,
		isPaused,
		messageCount,
		queuedMessageCount,
		steeringMode,
		followUpMode,
		interruptMode,
		...(model ? { model } : {}),
		...(thinking === undefined ? {} : { thinking }),
		...(fast === undefined ? {} : { fast }),
		...(sessionName === undefined ? {} : { sessionName }),
		...(contextUsage ? { contextUsage } : {}),
		...(queuedMessages ? { queuedMessages } : {}),
	};
}
export function decodeSessionStateFrame(input: unknown): SessionStateResult {
	return decodeSessionStateResult(inputObject(input));
}
