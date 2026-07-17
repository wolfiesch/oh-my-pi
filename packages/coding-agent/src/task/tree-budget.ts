/** Optional aggregate limits applied across one root session's task descendants. */
export interface TaskTreeBudgetLimits {
	maxSpawns?: number;
	maxRequests?: number;
	maxTokens?: number;
}

/** Current task-tree consumption and the first aggregate limit that was exceeded. */
export interface TaskTreeBudgetSnapshot {
	spawns: number;
	requests: number;
	tokens: number;
	maxSpawns: number;
	maxRequests: number;
	maxTokens: number;
	exhausted: boolean;
	reason?: string;
}

/** Session-wide safety budget shared by task and eval-agent descendants. */
export class TaskTreeBudget {
	#maxSpawns: number;
	#maxRequests: number;
	#maxTokens: number;
	readonly #controller = new AbortController();
	#spawns = 0;
	#requests = 0;
	#tokens = 0;
	#reason?: string;

	constructor(limits: TaskTreeBudgetLimits = {}) {
		this.#maxSpawns = normalizeLimit(limits.maxSpawns);
		this.#maxRequests = normalizeLimit(limits.maxRequests);
		this.#maxTokens = normalizeLimit(limits.maxTokens);
	}

	/** Apply configured task settings to the shared budget before a new descendant starts. */
	updateLimits(limits: TaskTreeBudgetLimits): void {
		if (limits.maxSpawns !== undefined) this.#maxSpawns = normalizeLimit(limits.maxSpawns);
		if (limits.maxRequests !== undefined) this.#maxRequests = normalizeLimit(limits.maxRequests);
		if (limits.maxTokens !== undefined) this.#maxTokens = normalizeLimit(limits.maxTokens);
		if (this.#reason) return;
		const reason = this.#usageExhaustReason();
		if (reason) this.#exhaust(reason);
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	reserveSpawns(count: number): string | undefined {
		if (this.#reason) return this.#reason;
		const next = this.#spawns + Math.max(0, Math.trunc(count));
		if (this.#maxSpawns > 0 && next > this.#maxSpawns) {
			return `Task tree spawn budget exceeded (${next} requested; budget ${this.#maxSpawns})`;
		}
		this.#spawns = next;
		return undefined;
	}

	releaseSpawns(count: number): void {
		this.#spawns = Math.max(0, this.#spawns - Math.max(0, Math.trunc(count)));
	}

	recordRequest(tokens: number): string | undefined {
		this.#requests += 1;
		this.#tokens += Math.max(0, Math.trunc(tokens));
		const reason = this.#usageExhaustReason();
		if (reason && !this.#reason) return this.#exhaust(reason);
		return this.#reason;
	}

	snapshot(): TaskTreeBudgetSnapshot {
		return {
			spawns: this.#spawns,
			requests: this.#requests,
			tokens: this.#tokens,
			maxSpawns: this.#maxSpawns,
			maxRequests: this.#maxRequests,
			maxTokens: this.#maxTokens,
			exhausted: this.#reason !== undefined,
			reason: this.#reason,
		};
	}

	/** First aggregate limit currently exceeded, or undefined while within budget. */
	#usageExhaustReason(): string | undefined {
		if (this.#maxSpawns > 0 && this.#spawns > this.#maxSpawns) {
			return `Task tree spawn budget exceeded (${this.#spawns} spawns; budget ${this.#maxSpawns})`;
		}
		if (this.#maxRequests > 0 && this.#requests > this.#maxRequests) {
			return `Task tree request budget exceeded (${this.#requests} requests; budget ${this.#maxRequests})`;
		}
		if (this.#maxTokens > 0 && this.#tokens > this.#maxTokens) {
			return `Task tree token budget exceeded (${this.#tokens} tokens; budget ${this.#maxTokens})`;
		}
		return undefined;
	}

	#exhaust(reason: string): string {
		this.#reason = reason;
		this.#controller.abort(new Error(reason));
		return reason;
	}
}

function normalizeLimit(value: number | undefined): number {
	return Number.isFinite(value) && value !== undefined && value > 0 ? Math.trunc(value) : 0;
}
