import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Settings } from "../config/settings";
import { truncateTail } from "../session/streaming-output";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "../task/types";
import type { ToolSession } from "../tools";
import { cancelAgentRegistration } from "../tools/hub/jobs";
import { executeSend } from "../tools/hub/messaging";
import type { CancelOutcome, CoordinationDetails } from "../tools/hub/types";
import { AgentLifecycleManager } from "./agent-lifecycle";
import {
	type AgentKind,
	type AgentRef,
	AgentRegistry,
	type AgentStatus,
	MAIN_AGENT_ID,
	type RegistryEvent,
} from "./agent-registry";

export interface AgentControlSnapshot {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	activity?: string;
	hasLiveSession: boolean;
}

export interface AgentControlProjectedResult {
	status: "running" | "completed" | "failed" | "cancelled";
	resultText?: string;
	errorText?: string;
}

export interface AgentControlResult {
	agentId: string;
	source: "registry" | "job";
	agentStatus: AgentStatus;
	jobStatus?: AgentControlProjectedResult["status"];
	resultText?: string;
	errorText?: string;
	truncated: boolean;
}

export interface AgentControlSendResult {
	delivered: boolean;
	outcome?: "injected" | "woken" | "revived" | "failed";
	error?: string;
}

export interface AgentControlReleaseResult {
	released: boolean;
	tombstone: boolean;
}

type AgentControlSession = Pick<ToolSession, "agentRegistry" | "agentLifecycle">;

export interface AgentControlServiceOptions {
	session: AgentControlSession;
	registry?: AgentRegistry;
	lifecycle?: AgentLifecycleManager;
	senderId?: string;
	settings: Settings;
	projectResult?: (agentId: string) => AgentControlProjectedResult | undefined;
}

export type AgentControlRegistryUpdate = {
	change: RegistryEvent["type"];
	agent: AgentControlSnapshot;
};

/**
 * Shared control facade over the process roster and lifecycle authorities.
 * It never writes AgentRegistry state: every transition is delegated to the
 * lifecycle manager, and every asynchronous transition remains bound to the
 * exact AgentRef generation selected at the command boundary.
 */
export class AgentControlService {
	readonly #session: AgentControlSession;
	readonly #registry: AgentRegistry;
	readonly #lifecycle: AgentLifecycleManager;
	readonly #senderId: string;
	readonly #settings: Settings;
	readonly #projectResult: ((agentId: string) => AgentControlProjectedResult | undefined) | undefined;

	constructor(options: AgentControlServiceOptions) {
		this.#session = options.session;
		this.#registry = options.registry ?? AgentRegistry.global();
		this.#lifecycle = options.lifecycle ?? AgentLifecycleManager.global();
		this.#senderId = options.senderId ?? MAIN_AGENT_ID;
		this.#settings = options.settings;
		this.#projectResult = options.projectResult;
	}

	list(options: { includeAdvisors?: boolean } = {}): AgentControlSnapshot[] {
		return this.#registry
			.list()
			.filter(ref => ref.id !== this.#senderId && (options.includeAdvisors === true || ref.kind !== "advisor"))
			.map(ref => this.#snapshot(ref))
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	get(agentId: string): AgentControlSnapshot {
		return this.#snapshot(this.#readableTarget(agentId));
	}

	captureMutationTarget(agentId: string): AgentRef {
		return this.#mutableTarget(agentId);
	}
	getResult(agentId: string): AgentControlResult {
		const ref = this.#readableTarget(agentId);
		const projected = this.#projectResult?.(agentId);
		if (!projected) {
			return {
				agentId,
				source: "registry",
				agentStatus: ref.status,
				truncated: false,
			};
		}
		const result = projected.resultText
			? truncateTail(projected.resultText, { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES })
			: undefined;
		const error = projected.errorText
			? truncateTail(projected.errorText, { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES })
			: undefined;
		return {
			agentId,
			source: "job",
			agentStatus: ref.status,
			jobStatus: projected.status,
			resultText: result?.content,
			errorText: error?.content,
			truncated: Boolean(result?.truncated || error?.truncated),
		};
	}

	async send(
		agentId: string,
		message: string,
		replyTo?: string,
		signal?: AbortSignal,
	): Promise<AgentControlSendResult> {
		const ref = this.#mutableTarget(agentId);
		const result: AgentToolResult<CoordinationDetails> = await executeSend(
			{
				registry: this.#registry,
				senderId: this.#senderId,
				settings: this.#settings,
				expectedTarget: ref,
			},
			{ to: agentId, message, replyTo },
			signal,
		);
		const receipt = result.details?.receipts?.[0];
		return {
			delivered: receipt !== undefined && receipt.outcome !== "failed",
			outcome: receipt?.outcome,
			error:
				receipt?.error ?? (result.isError ? result.content.find(part => part.type === "text")?.text : undefined),
		};
	}

	async park(agentId: string): Promise<AgentControlSnapshot> {
		const ref = this.#mutableTarget(agentId);
		await this.#lifecycle.park(agentId);
		const current = this.#registry.get(agentId);
		if (current !== ref) throw new Error(`Agent "${agentId}" changed during the lifecycle operation.`);
		if (current.status !== "parked" || current.session !== null) {
			throw new Error(`Agent "${agentId}" is not in an idle adopted state that can be parked.`);
		}
		return this.#snapshot(current);
	}

	async resume(agentId: string): Promise<AgentControlSnapshot> {
		const ref = this.#mutableTarget(agentId);
		await this.#lifecycle.ensureLive(agentId, ref);
		return this.#snapshotExact(agentId, ref);
	}

	async cancel(agentId: string, expected?: AgentRef): Promise<CancelOutcome> {
		const ref = this.#mutableTarget(agentId);
		if (expected && ref !== expected) {
			return { id: agentId, status: "not_found", message: `Agent ${agentId} changed before it could be cancelled.` };
		}
		return cancelAgentRegistration(this.#session, this.#senderId, agentId, ref, {
			allowTransitiveOwnership: true,
		});
	}

	async release(
		agentId: string,
		options: { tombstone?: boolean } = {},
		expected?: AgentRef,
	): Promise<AgentControlReleaseResult> {
		const ref = this.#mutableTarget(agentId);
		if (expected && ref !== expected) throw new Error(`Agent "${agentId}" changed before it could be released.`);
		const tombstone = options.tombstone === true;
		const released = await this.#lifecycle.release(agentId, ref, { tombstone });
		return { released, tombstone };
	}

	onRegistryUpdate(listener: (update: AgentControlRegistryUpdate) => void): () => void {
		return this.#registry.onChange(event => {
			if (event.ref.id === this.#senderId) return;
			listener({ change: event.type, agent: this.#snapshot(event.ref) });
		});
	}

	#readableTarget(agentId: string): AgentRef {
		const ref = this.#registry.get(agentId);
		if (!ref || ref.id === this.#senderId) throw new Error(`Unknown agent "${agentId}".`);
		return ref;
	}

	#mutableTarget(agentId: string): AgentRef {
		const ref = this.#readableTarget(agentId);
		if (ref.kind === "advisor") throw new Error(`Agent "${agentId}" is a read-only advisor transcript.`);
		if (ref.kind !== "sub" || !this.#isOwnedDescendant(ref)) {
			throw new Error(`Agent "${agentId}" is outside this session's control scope.`);
		}
		if (ref.status === "aborted") throw new Error(`Agent "${agentId}" is terminal and cannot be controlled.`);
		return ref;
	}

	#isOwnedDescendant(ref: AgentRef): boolean {
		if (this.#senderId === MAIN_AGENT_ID) return true;
		const visited = new Set<string>();
		let parentId = ref.parentId;
		while (parentId && !visited.has(parentId)) {
			if (parentId === this.#senderId) return true;
			visited.add(parentId);
			parentId = this.#registry.get(parentId)?.parentId;
		}
		return false;
	}

	#snapshotExact(agentId: string, expected: AgentRef): AgentControlSnapshot {
		const current = this.#registry.get(agentId);
		if (current !== expected) throw new Error(`Agent "${agentId}" changed during the lifecycle operation.`);
		return this.#snapshot(current);
	}

	#snapshot(ref: AgentRef): AgentControlSnapshot {
		return {
			id: ref.id,
			displayName: ref.displayName,
			kind: ref.kind,
			parentId: ref.parentId,
			status: ref.status,
			sessionFile: ref.sessionFile,
			createdAt: ref.createdAt,
			lastActivity: ref.lastActivity,
			activity: ref.activity,
			hasLiveSession: ref.session !== null,
		};
	}
}
