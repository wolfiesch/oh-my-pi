/**
 * Typed dashboard API client. Every `/api/*` call attaches the bearer token the
 * server injected into `window.__AUTHER_TOKEN__`; same-origin broker stream
 * proxying keeps the browser off the broker's cross-origin `/v1` surface.
 */
import type { OAuthProviderInfo, RefresherSchedule, UsageReport } from "@oh-my-pi/pi-ai";
import type { SpendResult, UsageFetchResult } from "../metering";
import type { OAuthSessionStatus, OAuthSessionView } from "../oauth-sessions";
import type {
	AddApiKeyEntryInput,
	AutherEntryCategory,
	AutherListEntry,
	AutherSecret,
	AutherSpendKind,
	UpdateEntryInput,
} from "../store";

declare global {
	interface Window {
		__AUTHER_TOKEN__?: string;
	}
}

/** A credential as presented in the dashboard grid. */
export type AutherEntry = AutherListEntry;
export type {
	AddApiKeyEntryInput,
	AutherEntryCategory,
	AutherSecret,
	AutherSpendKind,
	OAuthProviderInfo,
	OAuthSessionStatus,
	OAuthSessionView,
	RefresherSchedule,
	SpendResult,
	UpdateEntryInput,
	UsageFetchResult,
	UsageReport,
};

/** `GET /api/broker` — the device-facing broker endpoint + redacted token. */
export interface BrokerInfo {
	url: string;
	tokenPresent: boolean;
	token: string;
	refresher?: RefresherSchedule;
}

/** `POST /api/entries/:id/refresh` outcome. */
export type RefreshResult = { status: "ok"; entry: AutherEntry } | { status: "reauth_required"; error?: string };

/** `GET /api/spend/:id` — a provider spend report or an unavailable marker. */
export type SpendFetchResult = SpendResult | { status: "unavailable"; error: string };

const API_BASE = "/api";

export class ApiError extends Error {
	status: number;
	endpoint: string;
	constructor(status: number, endpoint: string, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.endpoint = endpoint;
	}
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
	const token = typeof window === "undefined" ? undefined : window.__AUTHER_TOKEN__;
	const headers: Record<string, string> = { ...extra };
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

async function fetchJson<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
	const res = await fetch(endpoint, { ...options, headers: authHeaders(options.headers as Record<string, string>) });
	if (!res.ok) {
		let msg = `HTTP ${res.status}`;
		try {
			const body = (await res.json()) as { error?: string };
			if (body?.error) msg = body.error;
		} catch {
			// Non-JSON error body; keep the HTTP status text.
		}
		throw new ApiError(res.status, endpoint, msg);
	}
	return res.json() as Promise<T>;
}

function jsonBody(method: "POST" | "PUT" | "DELETE", body?: unknown, signal?: AbortSignal): RequestInit {
	const options: RequestInit = { method, signal, headers: { "Content-Type": "application/json" } };
	if (body !== undefined) options.body = JSON.stringify(body);
	return options;
}

// ── Entries ──────────────────────────────────────────────────────────────────

export const getEntries = (signal?: AbortSignal): Promise<AutherEntry[]> =>
	fetchJson<AutherEntry[]>(`${API_BASE}/entries`, { signal });

export const getSecret = (id: number, signal?: AbortSignal): Promise<AutherSecret> =>
	fetchJson<AutherSecret>(`${API_BASE}/entries/${id}/secret`, { signal });

export const addEntry = (input: AddApiKeyEntryInput, signal?: AbortSignal): Promise<{ entry: AutherEntry }> =>
	fetchJson<{ entry: AutherEntry }>(`${API_BASE}/entries`, jsonBody("POST", input, signal));

export const updateEntry = (
	id: number,
	input: UpdateEntryInput,
	signal?: AbortSignal,
): Promise<{ entry: AutherEntry }> =>
	fetchJson<{ entry: AutherEntry }>(`${API_BASE}/entries/${id}`, jsonBody("PUT", input, signal));

export const deleteEntry = (id: number, signal?: AbortSignal): Promise<{ ok: boolean }> =>
	fetchJson<{ ok: boolean }>(`${API_BASE}/entries/${id}`, jsonBody("DELETE", undefined, signal));

export const refreshEntry = (id: number, signal?: AbortSignal): Promise<RefreshResult> =>
	fetchJson<RefreshResult>(`${API_BASE}/entries/${id}/refresh`, jsonBody("POST", undefined, signal));

// ── Metering ─────────────────────────────────────────────────────────────────

export const getUsage = (signal?: AbortSignal): Promise<UsageFetchResult> =>
	fetchJson<UsageFetchResult>(`${API_BASE}/usage`, { signal });

export const getSpend = (id: number, signal?: AbortSignal): Promise<SpendFetchResult> =>
	fetchJson<SpendFetchResult>(`${API_BASE}/spend/${id}`, { signal });

// ── Broker ───────────────────────────────────────────────────────────────────

export const getBroker = (signal?: AbortSignal): Promise<BrokerInfo> =>
	fetchJson<BrokerInfo>(`${API_BASE}/broker`, { signal });

export function openBrokerStream(signal?: AbortSignal): Promise<Response> {
	return fetch(`${API_BASE}/broker/stream`, {
		headers: authHeaders({ Accept: "text/event-stream" }),
		signal,
	});
}

// ── OAuth login sessions ──────────────────────────────────────────────────────

export const getOAuthProviders = (signal?: AbortSignal): Promise<OAuthProviderInfo[]> =>
	fetchJson<OAuthProviderInfo[]>(`${API_BASE}/oauth/providers`, { signal });

export const startOAuthLogin = (provider: string, signal?: AbortSignal): Promise<OAuthSessionView> =>
	fetchJson<OAuthSessionView>(`${API_BASE}/oauth/login/start`, jsonBody("POST", { provider }, signal));

export const getOAuthSession = (loginId: string, signal?: AbortSignal): Promise<OAuthSessionView> =>
	fetchJson<OAuthSessionView>(`${API_BASE}/oauth/login/${encodeURIComponent(loginId)}`, { signal });

export const submitOAuthInput = (loginId: string, value: string, signal?: AbortSignal): Promise<OAuthSessionView> =>
	fetchJson<OAuthSessionView>(
		`${API_BASE}/oauth/login/${encodeURIComponent(loginId)}/input`,
		jsonBody("POST", { value }, signal),
	);

export const cancelOAuthLogin = (loginId: string, signal?: AbortSignal): Promise<OAuthSessionView> =>
	fetchJson<OAuthSessionView>(
		`${API_BASE}/oauth/login/${encodeURIComponent(loginId)}/cancel`,
		jsonBody("POST", undefined, signal),
	);
