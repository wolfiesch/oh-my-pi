import type {
	AgentRosterEntry,
	ConfigEdit,
	LaunchResult,
	MaskedCredential,
	ModelPreview,
	ProfileSummary,
	ProviderAuthEntry,
	ProviderTestResult,
	ResolvedConfig,
	RoutingGraph,
	ToolId,
	ToolStatus,
} from "../../api-types";

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

async function fetchJson<T>(endpoint: string, options?: RequestInit): Promise<T> {
	const res = await fetch(endpoint, options);
	if (!res.ok) {
		let msg = `HTTP ${res.status}`;
		try {
			const j = (await res.json()) as { error?: string };
			if (j?.error) msg = j.error;
		} catch {
			// Non-JSON error body; keep the HTTP status text.
		}
		throw new ApiError(res.status, endpoint, msg);
	}
	return res.json() as Promise<T>;
}

// ---- GET endpoints ----

export const getProfiles = (signal?: AbortSignal) =>
	fetchJson<{ profiles: ProfileSummary[] }>(`${API_BASE}/profiles`, { signal });

export const getConfig = (id: string, signal?: AbortSignal) =>
	fetchJson<ResolvedConfig>(`${API_BASE}/profiles/${encodeURIComponent(id)}/config`, { signal });

export const getAgents = (id: string, signal?: AbortSignal) =>
	fetchJson<{ agents: AgentRosterEntry[] }>(`${API_BASE}/profiles/${encodeURIComponent(id)}/agents`, {
		signal,
	});

export const getProviders = (id: string, signal?: AbortSignal) =>
	fetchJson<{ providers: ProviderAuthEntry[] }>(`${API_BASE}/profiles/${encodeURIComponent(id)}/providers`, {
		signal,
	});

export const getGraph = (id: string, signal?: AbortSignal) =>
	fetchJson<RoutingGraph>(`${API_BASE}/profiles/${encodeURIComponent(id)}/graph`, { signal });

export const getTools = (profileId: string | null, signal?: AbortSignal) =>
	fetchJson<{ tools: ToolStatus[] }>(
		`${API_BASE}/tools${profileId ? `?profile=${encodeURIComponent(profileId)}` : ""}`,
		{ signal },
	);

export const getCatalogModels = (signal?: AbortSignal) =>
	fetchJson<{ models: ModelPreview[]; defaultModelPerProvider: Record<string, string> }>(
		`${API_BASE}/catalog/models`,
		{ signal },
	);

export const getThemeColors = (signal?: AbortSignal) =>
	fetchJson<{ colors: string[] }>(`${API_BASE}/theme-colors`, { signal });

// ---- Mutate (POST/PUT/DELETE) — returns parsed JSON ----

export function putConfig(id: string, edits: ConfigEdit[], signal?: AbortSignal): Promise<ResolvedConfig> {
	return fetchJson<ResolvedConfig>(`${API_BASE}/profiles/${encodeURIComponent(id)}/config`, {
		method: "PUT",
		signal,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ edits }),
	});
}

export function launchTool(tool: ToolId, profileId: string | null, signal?: AbortSignal): Promise<LaunchResult> {
	const body: Record<string, unknown> = {};
	if (profileId) body.profileId = profileId;
	return fetchJson<LaunchResult>(`${API_BASE}/tools/${encodeURIComponent(tool)}/launch`, {
		method: "POST",
		signal,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

export function stopTool(tool: ToolId, profileId: string | null, signal?: AbortSignal): Promise<{ stopped: boolean }> {
	const body: Record<string, unknown> = {};
	if (profileId) body.profileId = profileId;
	return fetchJson<{ stopped: boolean }>(`${API_BASE}/tools/${encodeURIComponent(tool)}/stop`, {
		method: "POST",
		signal,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

export function addProviderCredential(
	id: string,
	provider: string,
	key: string,
	signal?: AbortSignal,
): Promise<{ accounts: MaskedCredential[] }> {
	return fetchJson<{ accounts: MaskedCredential[] }>(
		`${API_BASE}/profiles/${encodeURIComponent(id)}/providers/${encodeURIComponent(provider)}/credentials`,
		{
			method: "POST",
			signal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "api_key", key }),
		},
	);
}

export function deleteProviderCredential(
	id: string,
	provider: string,
	credentialId: number,
	signal?: AbortSignal,
): Promise<{ accounts: MaskedCredential[] }> {
	return fetchJson<{ accounts: MaskedCredential[] }>(
		`${API_BASE}/profiles/${encodeURIComponent(id)}/providers/${encodeURIComponent(provider)}/credentials/${credentialId}`,
		{ method: "DELETE", signal },
	);
}

export function testProviderEndpoint(
	id: string,
	provider: string,
	signal?: AbortSignal,
): Promise<{ results: ProviderTestResult[] }> {
	return fetchJson<{ results: ProviderTestResult[] }>(
		`${API_BASE}/profiles/${encodeURIComponent(id)}/providers/${encodeURIComponent(provider)}/test`,
		{ method: "POST", signal },
	);
}

// Generic mutate for any other POST/PUT/DELETE (profiles add/remove, etc.).
export function mutate<T>(
	endpoint: string,
	method: "POST" | "PUT" | "DELETE",
	body?: unknown,
	signal?: AbortSignal,
): Promise<T> {
	const options: RequestInit = { method, signal, headers: { "Content-Type": "application/json" } };
	if (body !== undefined) {
		options.body = JSON.stringify(body);
	}
	return fetchJson<T>(`${API_BASE}${endpoint}`, options);
}

// Re-export the edit shape so route components can import it alongside the client.
export type { ConfigEdit, LaunchResult, ToolId, ToolStatus };
