import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { RestoredQueuedMessage } from "./agent-session-types";
import type { CustomMessage } from "./messages";
import {
	isAdvisorCard,
	isDisplayableQueuedMessage,
	isHiddenUserCompanion,
	isUserQueuedMessage,
	queueChipText,
	toRestoredQueuedMessage,
} from "./queued-messages";

export type SessionQueueLane = "steering" | "followUp";
export interface SessionQueueEntry {
	entryId: string;
	lane: SessionQueueLane;
	text: string;
	operationId?: string;
}
export interface SessionQueueSnapshot {
	steering: SessionQueueEntry[];
	followUp: SessionQueueEntry[];
	rowCount: number;
	displayableCount: number;
	pendingCount: number;
	pendingNextTurnCount: number;
}
export interface SessionQueueClearResult {
	steering: RestoredQueuedMessage[];
	followUp: RestoredQueuedMessage[];
	snapshot: SessionQueueSnapshot;
}

export class SessionQueueEntryNotFoundError extends Error {
	constructor(entryId: string) {
		super(`Queued message is no longer pending: ${entryId}`);
		this.name = "SessionQueueEntryNotFoundError";
	}
}
export class SessionQueueInvalidPositionError extends Error {
	constructor(toIndex: number, rowCount: number) {
		super(`Queue position ${toIndex} is outside the lane row range 0..${Math.max(0, rowCount - 1)}`);
		this.name = "SessionQueueInvalidPositionError";
	}
}

/** Sole session-layer owner of read/filter/replace queue mutations. */
export class SessionQueueService {
	readonly #entryIds = new WeakMap<AgentMessage, string>();
	readonly #messageTags = new WeakMap<AgentMessage, string>();
	#nextEntryId = 0;
	constructor(
		readonly agent: Agent,
		readonly pendingNextTurnCount: () => number,
	) {}
	#setQueues(steering: readonly AgentMessage[], followUp: readonly AgentMessage[]): void {
		this.agent.replaceQueues([...steering], [...followUp]);
	}
	#idFor(message: AgentMessage): string {
		let id = this.#entryIds.get(message);
		if (!id) {
			id = `queue_${Date.now().toString(36)}_${(++this.#nextEntryId).toString(36)}`;
			this.#entryIds.set(message, id);
		}
		return id;
	}
	#entries(lane: SessionQueueLane, queue: readonly AgentMessage[]): SessionQueueEntry[] {
		return queue.filter(isUserQueuedMessage).map(message => {
			const operationId = this.#messageTags.get(message);
			return {
				entryId: this.#idFor(message),
				lane,
				text: queueChipText(message),
				...(operationId ? { operationId } : {}),
			};
		});
	}
	snapshot(): SessionQueueSnapshot {
		const steeringAll = this.agent.peekSteeringQueue();
		const followUpAll = this.agent.peekFollowUpQueue();
		const steering = this.#entries("steering", steeringAll);
		const followUp = this.#entries("followUp", followUpAll);
		const pendingNextTurnCount = this.pendingNextTurnCount();
		const displayableCount =
			steeringAll.filter(isDisplayableQueuedMessage).length + followUpAll.filter(isDisplayableQueuedMessage).length;
		return {
			steering,
			followUp,
			rowCount: steering.length + followUp.length,
			displayableCount,
			pendingCount: displayableCount + pendingNextTurnCount,
			pendingNextTurnCount,
		};
	}
	clear(options?: { lane?: SessionQueueLane | "all"; forInterrupt?: boolean }): SessionQueueClearResult {
		const lane = options?.lane ?? "all";
		const steeringAll = this.agent.peekSteeringQueue();
		const followUpAll = this.agent.peekFollowUpQueue();
		const clearSteering = lane === "all" || lane === "steering";
		const clearFollowUp = lane === "all" || lane === "followUp";
		const steering = clearSteering ? steeringAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage) : [];
		const followUp = clearFollowUp ? followUpAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage) : [];
		const keep = (message: AgentMessage): boolean =>
			options?.forInterrupt === true
				? isAdvisorCard(message)
				: !isUserQueuedMessage(message) && !isHiddenUserCompanion(message);
		this.#setQueues(
			clearSteering ? steeringAll.filter(keep) : steeringAll,
			clearFollowUp ? followUpAll.filter(keep) : followUpAll,
		);
		return { steering, followUp, snapshot: this.snapshot() };
	}
	remove(entryId: string): { removed: RestoredQueuedMessage; snapshot: SessionQueueSnapshot } {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		for (const [lane, queue] of [
			["steering", steering],
			["followUp", followUp],
		] as const) {
			const index = queue.findIndex(message => isUserQueuedMessage(message) && this.#idFor(message) === entryId);
			if (index < 0) continue;
			let start = index;
			while (start > 0 && isHiddenUserCompanion(queue[start - 1]!)) start--;
			const next = queue.slice();
			const [removed] = next.splice(index, 1);
			if (start < index) next.splice(start, index - start);
			this.#setQueues(lane === "steering" ? next : steering, lane === "followUp" ? next : followUp);
			return { removed: toRestoredQueuedMessage(removed!), snapshot: this.snapshot() };
		}
		throw new SessionQueueEntryNotFoundError(entryId);
	}
	reorder(entryId: string, toIndex: number): SessionQueueSnapshot {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		for (const [lane, queue] of [
			["steering", steering],
			["followUp", followUp],
		] as const) {
			const units: AgentMessage[][] = [];
			const skeleton: Array<AgentMessage | number> = [];
			let companions: AgentMessage[] = [];
			for (const message of queue) {
				if (isHiddenUserCompanion(message)) {
					companions.push(message);
					continue;
				}
				if (isUserQueuedMessage(message)) {
					skeleton.push(units.length);
					units.push([...companions, message]);
					companions = [];
					continue;
				}
				skeleton.push(...companions, message);
				companions = [];
			}
			skeleton.push(...companions);
			const fromIndex = units.findIndex(unit => this.#idFor(unit[unit.length - 1]!) === entryId);
			if (fromIndex < 0) continue;
			if (!Number.isSafeInteger(toIndex) || toIndex < 0 || toIndex >= units.length)
				throw new SessionQueueInvalidPositionError(toIndex, units.length);
			const reordered = units.slice();
			const [moved] = reordered.splice(fromIndex, 1);
			reordered.splice(toIndex, 0, moved!);
			let slot = 0;
			const next: AgentMessage[] = [];
			for (const item of skeleton) {
				if (typeof item === "number") next.push(...reordered[slot++]!);
				else next.push(item);
			}
			this.#setQueues(lane === "steering" ? next : steering, lane === "followUp" ? next : followUp);
			return this.snapshot();
		}
		throw new SessionQueueEntryNotFoundError(entryId);
	}
	popLast(): RestoredQueuedMessage | undefined {
		const snapshot = this.snapshot();
		const entry = snapshot.steering.at(-1) ?? snapshot.followUp.at(-1);
		return entry ? this.remove(entry.entryId).removed : undefined;
	}
	getTag(message: AgentMessage): string | undefined {
		return this.#messageTags.get(message);
	}
	setTag(message: AgentMessage, tag: string): void {
		this.#messageTags.set(message, tag);
	}
	removeByTag(tag: string): number {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		const keptSteering = steering.filter(message => this.#messageTags.get(message) !== tag);
		const keptFollowUp = followUp.filter(message => this.#messageTags.get(message) !== tag);
		const removed = steering.length + followUp.length - keptSteering.length - keptFollowUp.length;
		if (removed > 0) this.#setQueues(keptSteering, keptFollowUp);
		return removed;
	}
	extractAdvisorCards(): CustomMessage[] {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		const cards = [...steering, ...followUp].filter(isAdvisorCard);
		if (cards.length > 0)
			this.#setQueues(
				steering.filter(message => !isAdvisorCard(message)),
				followUp.filter(message => !isAdvisorCard(message)),
			);
		return cards;
	}
	parkBlockedFollowUps(blocked: boolean): AgentMessage[] {
		if (!blocked || this.agent.peekSteeringQueue().length > 0) return [];
		const parked = [...this.agent.peekFollowUpQueue()];
		if (parked.length > 0) this.#setQueues(this.agent.peekSteeringQueue(), []);
		return parked;
	}
	restoreParkedFollowUps(parked: readonly AgentMessage[]): void {
		if (parked.length > 0)
			this.#setQueues(this.agent.peekSteeringQueue(), [...parked, ...this.agent.peekFollowUpQueue()]);
	}
}
