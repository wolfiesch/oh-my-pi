import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai";
import { updateEntry } from "./store";

export type OAuthSessionStatus = "pending" | "awaiting_redirect" | "awaiting_input" | "done" | "error" | "cancelled";

export interface OAuthSessionPromptView {
	message: string;
	placeholder: string | null;
}

export interface OAuthSessionView {
	loginId: string;
	provider: string;
	status: OAuthSessionStatus;
	authUrl: string | null;
	instructions: string | null;
	prompt: OAuthSessionPromptView | null;
	progress: string | null;
	error: string | null;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
	entryIds: number[];
}

export class OAuthSessionRequestError extends Error {
	status: number;

	constructor(message: string, status = 400) {
		super(message);
		this.name = "OAuthSessionRequestError";
		this.status = status;
	}
}

interface PendingInput {
	resolve: (value: string) => void;
}

interface OAuthSession {
	loginId: string;
	provider: string;
	status: OAuthSessionStatus;
	authUrl: string | null;
	instructions: string | null;
	prompt: OAuthSessionPromptView | null;
	progress: string | null;
	error: string | null;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
	entryIds: number[];
	beforeIds: Set<number>;
	abortController: AbortController;
	pendingInput?: PendingInput;
}

interface SessionUpdate {
	status?: OAuthSessionStatus;
	authUrl?: string | null;
	instructions?: string | null;
	prompt?: OAuthSessionPromptView | null;
	progress?: string | null;
	error?: string | null;
	entryIds?: number[];
}

const SESSION_TTL_MS = 10 * 60_000;
const SESSION_CLEANUP_INTERVAL_MS = 60_000;
const TERMINAL_SESSION_RETAIN_MS = 5 * 60_000;
const MANUAL_CODE_PROMPT: OAuthSessionPromptView = {
	message: "Paste the authorization code (or full redirect URL):",
	placeholder: "code#state or full redirect URL",
};

export class OAuthSessionManager {
	readonly #storage: AuthStorage;
	readonly #sessions = new Map<string, OAuthSession>();
	#cleanupTimer: NodeJS.Timeout | undefined;

	constructor(storage: AuthStorage) {
		this.#storage = storage;
		this.#cleanupTimer = setInterval(() => this.#cleanupExpiredSessions(), SESSION_CLEANUP_INTERVAL_MS);
		this.#cleanupTimer.unref?.();
	}

	async startLogin(provider: string): Promise<OAuthSessionView> {
		this.#cleanupExpiredSessions();
		const normalizedProvider = provider.trim();
		const providerInfo = getOAuthProviders().find(candidate => candidate.id === normalizedProvider);
		if (!providerInfo) {
			throw new OAuthSessionRequestError(`Unknown OAuth provider: ${normalizedProvider || "(empty)"}`);
		}
		if (!providerInfo.available) {
			throw new OAuthSessionRequestError(`OAuth provider is unavailable: ${normalizedProvider}`);
		}

		await this.#storage.reload();
		const beforeIds = new Set(this.#storage.listStoredCredentials().map(entry => entry.id));
		const now = Date.now();
		const session: OAuthSession = {
			loginId: crypto.randomUUID(),
			provider: normalizedProvider,
			status: "pending",
			authUrl: null,
			instructions: null,
			prompt: null,
			progress: null,
			error: null,
			createdAt: now,
			updatedAt: now,
			expiresAt: now + SESSION_TTL_MS,
			entryIds: [],
			beforeIds,
			abortController: new AbortController(),
		};
		this.#sessions.set(session.loginId, session);
		void this.#runLogin(session);
		return toSessionView(session);
	}

	getSession(loginId: string): OAuthSessionView | null {
		this.#cleanupExpiredSessions();
		const session = this.#sessions.get(loginId);
		return session ? toSessionView(session) : null;
	}

	submitInput(loginId: string, value: string): OAuthSessionView | null {
		this.#cleanupExpiredSessions();
		const session = this.#sessions.get(loginId);
		if (!session) return null;
		if (session.status !== "awaiting_input" || !session.pendingInput) {
			throw new OAuthSessionRequestError("Login session is not awaiting input");
		}
		const pendingInput = session.pendingInput;
		session.pendingInput = undefined;
		pendingInput.resolve(value);
		this.#applySessionUpdate(session, { status: "pending", prompt: null, error: null });
		return toSessionView(session);
	}

	cancelLogin(loginId: string): OAuthSessionView | null {
		this.#cleanupExpiredSessions();
		const session = this.#sessions.get(loginId);
		if (!session) return null;
		this.#cancelSession(session, "Login cancelled");
		return toSessionView(session);
	}

	close(): void {
		if (this.#cleanupTimer !== undefined) {
			clearInterval(this.#cleanupTimer);
			this.#cleanupTimer = undefined;
		}
		for (const session of this.#sessions.values()) {
			if (!isTerminalStatus(session.status)) {
				this.#cancelSession(session, "Login manager stopped");
			}
		}
	}

	async #runLogin(session: OAuthSession): Promise<void> {
		try {
			await this.#storage.login(session.provider, {
				onAuth: info => {
					if (isTerminalStatus(session.status)) return;
					this.#applySessionUpdate(session, {
						status: "awaiting_redirect",
						authUrl: info.url,
						instructions: info.instructions ?? null,
						prompt: null,
						error: null,
					});
				},
				onPrompt: prompt =>
					this.#awaitInput(session, {
						message: prompt.message,
						placeholder: prompt.placeholder ?? null,
					}),
				onManualCodeInput: () => this.#awaitInput(session, MANUAL_CODE_PROMPT),
				onProgress: message => {
					if (isTerminalStatus(session.status)) return;
					this.#applySessionUpdate(session, { progress: message, error: null });
				},
				signal: session.abortController.signal,
			});
			if (isTerminalStatus(session.status)) return;
			await this.#storage.reload();
			const entryIds = this.#storage
				.listStoredCredentials()
				.map(entry => entry.id)
				.filter(id => !session.beforeIds.has(id));
			for (const id of entryIds) {
				await updateEntry(id, {}, this.#storage);
			}
			this.#applySessionUpdate(session, {
				status: "done",
				prompt: null,
				progress: null,
				error: null,
				entryIds,
			});
		} catch (error) {
			if (isTerminalStatus(session.status)) return;
			const aborted = session.abortController.signal.aborted;
			this.#applySessionUpdate(session, {
				status: aborted ? "cancelled" : "error",
				prompt: null,
				error: aborted ? "Login cancelled" : describeError(error),
			});
		} finally {
			session.pendingInput = undefined;
		}
	}

	async #awaitInput(session: OAuthSession, prompt: OAuthSessionPromptView): Promise<string> {
		if (isTerminalStatus(session.status)) return "";
		session.pendingInput?.resolve("");
		const pending = Promise.withResolvers<string>();
		session.pendingInput = { resolve: pending.resolve };
		this.#applySessionUpdate(session, {
			status: "awaiting_input",
			prompt,
			error: null,
		});
		try {
			return await pending.promise;
		} finally {
			if (session.pendingInput?.resolve === pending.resolve) {
				session.pendingInput = undefined;
			}
		}
	}

	#cancelSession(session: OAuthSession, reason: string): void {
		if (isTerminalStatus(session.status)) return;
		session.pendingInput?.resolve("");
		session.pendingInput = undefined;
		session.abortController.abort(new Error(reason));
		this.#applySessionUpdate(session, {
			status: "cancelled",
			prompt: null,
			error: reason,
		});
	}

	#expireSession(session: OAuthSession): void {
		if (isTerminalStatus(session.status)) return;
		session.pendingInput?.resolve("");
		session.pendingInput = undefined;
		session.abortController.abort(new Error("Login session expired"));
		this.#applySessionUpdate(session, {
			status: "error",
			prompt: null,
			error: "Login session expired",
		});
	}

	#cleanupExpiredSessions(now = Date.now()): void {
		for (const [loginId, session] of this.#sessions.entries()) {
			if (!isTerminalStatus(session.status) && session.expiresAt <= now) {
				this.#expireSession(session);
				continue;
			}
			if (isTerminalStatus(session.status) && session.updatedAt + TERMINAL_SESSION_RETAIN_MS <= now) {
				this.#sessions.delete(loginId);
			}
		}
	}

	#applySessionUpdate(session: OAuthSession, update: SessionUpdate): void {
		if (update.status !== undefined) session.status = update.status;
		if (update.authUrl !== undefined) session.authUrl = update.authUrl;
		if (update.instructions !== undefined) session.instructions = update.instructions;
		if (update.prompt !== undefined) session.prompt = update.prompt;
		if (update.progress !== undefined) session.progress = update.progress;
		if (update.error !== undefined) session.error = update.error;
		if (update.entryIds !== undefined) session.entryIds = update.entryIds;
		session.updatedAt = Date.now();
	}
}

function toSessionView(session: OAuthSession): OAuthSessionView {
	return {
		loginId: session.loginId,
		provider: session.provider,
		status: session.status,
		authUrl: session.authUrl,
		instructions: session.instructions,
		prompt: session.prompt,
		progress: session.progress,
		error: session.error,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		expiresAt: session.expiresAt,
		entryIds: session.entryIds,
	};
}

function isTerminalStatus(status: OAuthSessionStatus): boolean {
	return status === "done" || status === "error" || status === "cancelled";
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	return "Unknown error";
}
