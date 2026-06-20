/**
 * Provider auth service for OMP Home.
 *
 * Opens the SELECTED profile's `agent.db` via `AuthStorage` (short-lived; one
 * store per request) and surfaces a secret-free view: per-provider auth origin
 * (oauth / api_key / env / fallback / none), masked credential rows, and
 * account identity for OAuth. Supports add-api-key, delete, and health-check.
 *
 * No secret bytes ever cross the API boundary: api_key values mask to last-4;
 * OAuth rows show account email/id/project, never access/refresh tokens.
 */

import { type AuthCredential, AuthStorage, getEnvApiKeyName, type StoredAuthCredential } from "@oh-my-pi/pi-ai";
import { CATALOG_PROVIDERS, DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog";
import { resolveProfile } from "./profiles";

/** Masked view of one stored credential row. */
export interface MaskedCredential {
	id: number;
	type: "api_key" | "oauth";
	/** `••••<last4>` for api_key; omitted for oauth. */
	masked?: string;
	/** OAuth account email, when known. */
	email?: string;
	/** OAuth account id, when known. */
	accountId?: string;
	/** OAuth project id, when known. */
	projectId?: string;
	/** Soft-disabled cause, when present. */
	disabledCause?: string | null;
}

/** Per-provider auth summary (secret-free). */
export interface ProviderAuthEntry {
	provider: string;
	defaultModel: string;
	/** Precedence-accurate auth source. */
	originKind: "runtime" | "config" | "oauth" | "api_key" | "env" | "fallback" | "none";
	/** Env var name when originKind === "env". */
	envVar?: string;
	credentialCount: number;
	accounts: MaskedCredential[];
}

function maskApiKey(key: string): string {
	if (key.length <= 4) return "••••";
	return `••••${key.slice(-4)}`;
}

async function withStorage<T>(dbPath: string, fn: (storage: AuthStorage) => Promise<T>): Promise<T> {
	const storage = await AuthStorage.create(dbPath);
	try {
		await storage.reload();
		return await fn(storage);
	} finally {
		storage.close();
	}
}

function maskCredential(row: StoredAuthCredential): MaskedCredential {
	const base: MaskedCredential = { id: row.id, type: row.credential.type };
	if (row.credential.type === "api_key") {
		base.masked = maskApiKey(row.credential.key);
	} else {
		if (row.credential.email) base.email = row.credential.email;
		if (row.credential.accountId) base.accountId = row.credential.accountId;
		if (row.credential.projectId) base.projectId = row.credential.projectId;
	}
	if (row.disabledCause) base.disabledCause = row.disabledCause;
	return base;
}

/**
 * List every catalog provider with its auth summary. Providers with no
 * configured auth report `originKind: "none"` and an empty account list.
 */
export async function listProviders(profileId: string): Promise<ProviderAuthEntry[]> {
	const { dbPath } = await resolveProfile(profileId);
	return withStorage(dbPath, async storage => {
		const entries: ProviderAuthEntry[] = [];
		for (const catalogEntry of CATALOG_PROVIDERS) {
			const provider = catalogEntry.id;
			const origin = storage.getCredentialOrigin(provider);
			const stored = storage.listStoredCredentials(provider);
			const accounts = stored.map(maskCredential);
			entries.push({
				provider,
				defaultModel: DEFAULT_MODEL_PER_PROVIDER[provider as keyof typeof DEFAULT_MODEL_PER_PROVIDER] ?? "",
				originKind: origin?.kind ?? "none",
				envVar: origin?.kind === "env" ? (origin.envVar ?? getEnvApiKeyName(provider)) : undefined,
				credentialCount: accounts.length,
				accounts,
			});
		}
		return entries;
	});
}

/** Add an API-key credential to a provider (appends to any existing rows). */
export async function addApiKeyCredential(
	profileId: string,
	provider: string,
	key: string,
): Promise<MaskedCredential[]> {
	if (!key || typeof key !== "string") throw new Error("API key is required");
	const { dbPath } = await resolveProfile(profileId);
	return withStorage(dbPath, async storage => {
		const existing = storage.listStoredCredentials(provider).map(row => row.credential);
		const next: AuthCredential[] = [...existing, { type: "api_key", key }];
		await storage.set(provider, next);
		const stored = storage.listStoredCredentials(provider);
		return stored.map(maskCredential);
	});
}

/** Delete one credential row by id. */
export async function deleteCredential(
	profileId: string,
	provider: string,
	credentialId: number,
): Promise<MaskedCredential[]> {
	const { dbPath } = await resolveProfile(profileId);
	return withStorage(dbPath, async storage => {
		await storage.removeCredential(provider, credentialId);
		const stored = storage.listStoredCredentials(provider);
		return stored.map(maskCredential);
	});
}

/** Health-check all credentials for a provider (usage-endpoint probe). */
export async function testProvider(
	profileId: string,
	provider: string,
): Promise<{ id: number; ok: boolean | null; reason?: string; email?: string; accountId?: string }[]> {
	const { dbPath } = await resolveProfile(profileId);
	return withStorage(dbPath, async storage => {
		const results = await storage.checkCredentials({ timeoutMs: 10_000 });
		return results
			.filter(result => result.provider === provider)
			.map(result => ({
				id: result.id,
				ok: result.ok,
				reason: result.reason,
				email: result.email,
				accountId: result.accountId,
			}));
	});
}
