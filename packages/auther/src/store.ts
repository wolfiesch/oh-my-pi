import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AuthCredential, AuthStorage, type StoredAuthCredential } from "@oh-my-pi/pi-ai";
import { getAgentDbPath, getConfigRootDir } from "@oh-my-pi/pi-utils";

export type AutherEntryCategory = "metered" | "meterable_unconfigured" | "not_applicable";
export type AutherCredentialType = "api_key" | "oauth";
export type AutherSpendKind = "openrouter" | "openai";

export interface AutherEntryMeta {
	credId: number;
	displayName: string;
	brandId: string;
	tags: string[];
	category: AutherEntryCategory;
	spendKind: AutherSpendKind | null;
	notes: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface AutherListEntry {
	id: number;
	provider: string;
	credentialType: AutherCredentialType;
	displayName: string;
	brandId: string;
	tags: string[];
	category: AutherEntryCategory;
	spendKind: AutherSpendKind | null;
	notes: string | null;
	disabledCause: string | null;
	email: string | null;
	accountId: string | null;
	projectId: string | null;
	enterpriseUrl: string | null;
	expires: number | null;
	secretPreview: string | null;
	hasSecret: boolean;
	isOAuth: boolean;
	isApiKey: boolean;
}

export interface AutherSecret {
	id: number;
	provider: string;
	type: AutherCredentialType;
	key?: string;
	access?: string;
	refresh?: string;
}

export interface AddApiKeyEntryInput {
	provider: string;
	displayName: string;
	key: string;
	brandId?: string;
	tags?: string[];
	category?: AutherEntryCategory;
	spendKind?: AutherSpendKind | null;
	notes?: string | null;
}

export interface UpdateEntryInput {
	displayName?: string;
	brandId?: string;
	tags?: string[];
	category?: AutherEntryCategory;
	spendKind?: AutherSpendKind | null;
	notes?: string | null;
}

interface AutherMetaRow {
	cred_id: number;
	display_name: string;
	brand_id: string;
	tags: string;
	category: AutherEntryCategory;
	spend_kind: string | null;
	notes: string | null;
	created_at: number | null;
	updated_at: number | null;
}

const META_SCHEMA = `CREATE TABLE IF NOT EXISTS auther_entry_meta (
	cred_id INTEGER PRIMARY KEY,
	display_name TEXT NOT NULL,
	brand_id TEXT NOT NULL,
	tags TEXT NOT NULL DEFAULT '[]',
	category TEXT NOT NULL CHECK(category IN ('metered','meterable_unconfigured','not_applicable')),
	spend_kind TEXT,
	notes TEXT,
	created_at INTEGER,
	updated_at INTEGER
)`;

const METERED_PROVIDERS: Record<string, true> = {
	openrouter: true,
	openai: true,
	anthropic: true,
	"openai-codex": true,
	"google-antigravity": true,
	"google-gemini-cli": true,
	zai: true,
	"kimi-code": true,
	"github-copilot": true,
	"minimax-code": true,
};
const INFRA_PROVIDERS: Record<string, true> = {
	cloudflare: true,
	namecheap: true,
	fastmail: true,
	elevenlabs: true,
	brave: true,
	firecrawl: true,
};

let storagePromise: Promise<AuthStorage> | undefined;
let metaDb: Database | undefined;

export async function openStorage(): Promise<AuthStorage> {
	storagePromise ??= AuthStorage.create(getAgentDbPath()).then(async storage => {
		await storage.reload();
		return storage;
	});
	return storagePromise;
}

export function openMetaDb(): Database {
	if (metaDb) return metaDb;
	const dbPath = path.join(getConfigRootDir(), "auther-meta.db");
	const parent = path.dirname(dbPath);
	fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
	metaDb = new Database(dbPath);
	metaDb.run(META_SCHEMA);
	return metaDb;
}

export async function getDashboardToken(): Promise<string> {
	const tokenPath = path.join(getConfigRootDir(), "auther.token");
	const parent = path.dirname(tokenPath);
	await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
	await fs.promises.chmod(parent, 0o700).catch(() => undefined);
	try {
		const token = (await Bun.file(tokenPath).text()).trim();
		await fs.promises.chmod(tokenPath, 0o600).catch(() => undefined);
		if (/^[0-9a-f]{64}$/i.test(token)) return token.toLowerCase();
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const token = createHexToken();
	await Bun.write(tokenPath, `${token}\n`);
	await fs.promises.chmod(tokenPath, 0o600);
	return token;
}

export async function listEntries(storage?: AuthStorage): Promise<AutherListEntry[]> {
	const activeStorage = storage ?? (await openStorage());
	const rows = activeStorage.listStoredCredentials();
	const db = openMetaDb();
	const stmt = db.query<AutherMetaRow, [number]>("SELECT * FROM auther_entry_meta WHERE cred_id = ?");
	return rows.map(row => buildListEntry(row, stmt.get(row.id) ?? undefined));
}

export async function getSecret(id: number, storage?: AuthStorage): Promise<AutherSecret | null> {
	const row = findStoredCredential(storage ?? (await openStorage()), id);
	if (!row) return null;
	const credential = row.credential;
	if (credential.type === "api_key") {
		return { id: row.id, provider: row.provider, type: "api_key", key: credential.key };
	}
	return {
		id: row.id,
		provider: row.provider,
		type: "oauth",
		access: credential.access,
		refresh: credential.refresh,
	};
}

export async function addApiKeyEntry(input: AddApiKeyEntryInput, storage?: AuthStorage): Promise<AutherListEntry> {
	const activeStorage = storage ?? (await openStorage());
	const provider = requireNonEmpty(input.provider, "provider");
	const displayName = requireNonEmpty(input.displayName, "displayName");
	const key = requireNonEmpty(input.key, "key");
	activeStorage.upsertCredential(provider, { type: "api_key", key });
	await activeStorage.reload();
	const row = activeStorage
		.listStoredCredentials(provider)
		.find(entry => entry.credential.type === "api_key" && entry.credential.key === key);
	if (!row) throw new Error("Upserted credential was not found after reload");
	const now = Date.now();
	const base = synthesizeMeta(row);
	const meta: AutherEntryMeta = {
		...base,
		displayName,
		brandId: normalizeOptionalString(input.brandId) ?? base.brandId,
		tags: normalizeTags(input.tags),
		category: input.category ?? base.category,
		spendKind: input.spendKind === undefined ? base.spendKind : input.spendKind,
		notes: normalizeNullableString(input.notes),
		createdAt: now,
		updatedAt: now,
	};
	upsertMeta(meta);
	return buildListEntry(row, metaToRow(meta));
}

export async function updateEntry(
	id: number,
	input: UpdateEntryInput,
	storage?: AuthStorage,
): Promise<AutherListEntry | null> {
	const row = findStoredCredential(storage ?? (await openStorage()), id);
	if (!row) return null;
	const existing = readMeta(id);
	const base = existing ? rowToMeta(existing) : synthesizeMeta(row);
	const now = Date.now();
	const next: AutherEntryMeta = {
		...base,
		displayName:
			input.displayName === undefined ? base.displayName : requireNonEmpty(input.displayName, "displayName"),
		brandId: input.brandId === undefined ? base.brandId : requireNonEmpty(input.brandId, "brandId"),
		tags: input.tags === undefined ? base.tags : normalizeTags(input.tags),
		category: input.category ?? base.category,
		spendKind: input.spendKind === undefined ? base.spendKind : input.spendKind,
		notes: input.notes === undefined ? base.notes : normalizeNullableString(input.notes),
		createdAt: base.createdAt || now,
		updatedAt: now,
	};
	upsertMeta(next);
	return buildListEntry(row, metaToRow(next));
}

export async function deleteEntry(id: number, storage?: AuthStorage): Promise<boolean> {
	const activeStorage = storage ?? (await openStorage());
	const row = findStoredCredential(activeStorage, id);
	if (!row) return false;
	const disabled = activeStorage.disableCredentialById(id, "deleted via Auther");
	if (!disabled) return false;
	openMetaDb().query("DELETE FROM auther_entry_meta WHERE cred_id = ?").run(id);
	await activeStorage.reload();
	return true;
}

export function resolveProviderBrandId(provider: string): string {
	const normalized = provider.trim().toLowerCase();
	if (normalized === "openai-codex") return "openai";
	if (normalized === "google-antigravity" || normalized === "google-gemini-cli") return "googlegemini";
	return normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "credential";
}

function buildListEntry(row: StoredAuthCredential, metaRow: AutherMetaRow | undefined): AutherListEntry {
	const meta = metaRow ? rowToMeta(metaRow) : synthesizeMeta(row);
	const credential = row.credential;
	const previewSecret = credential.type === "api_key" ? credential.key : credential.access;
	const hasSecret =
		credential.type === "api_key" ? credential.key.length > 0 : Boolean(credential.access || credential.refresh);
	return {
		id: row.id,
		provider: row.provider,
		credentialType: credential.type,
		displayName: meta.displayName,
		brandId: meta.brandId,
		tags: meta.tags,
		category: meta.category,
		spendKind: meta.spendKind,
		notes: meta.notes,
		disabledCause: row.disabledCause,
		email: credential.type === "oauth" ? (credential.email ?? null) : null,
		accountId: credential.type === "oauth" ? (credential.accountId ?? null) : null,
		projectId: credential.type === "oauth" ? (credential.projectId ?? null) : null,
		enterpriseUrl: credential.type === "oauth" ? (credential.enterpriseUrl ?? null) : null,
		expires: credential.type === "oauth" ? (credential.expires ?? null) : null,
		secretPreview: previewSecret ? maskSecret(previewSecret) : null,
		hasSecret,
		isOAuth: credential.type === "oauth",
		isApiKey: credential.type === "api_key",
	};
}

function synthesizeMeta(row: StoredAuthCredential): AutherEntryMeta {
	const now = Date.now();
	return {
		credId: row.id,
		displayName: synthesizeDisplayName(row.provider, row.credential),
		brandId: resolveProviderBrandId(row.provider),
		tags: [],
		category: defaultCategory(row.provider),
		spendKind: defaultSpendKind(row.provider),
		notes: null,
		createdAt: now,
		updatedAt: now,
	};
}

function synthesizeDisplayName(provider: string, credential: AuthCredential): string {
	const providerName = humanizeProvider(provider);
	if (credential.type === "api_key") return providerName;
	const identity = credential.email ?? credential.accountId ?? credential.projectId ?? credential.enterpriseUrl;
	return identity ? `${providerName} (${identity})` : providerName;
}

function defaultCategory(provider: string): AutherEntryCategory {
	const normalized = provider.toLowerCase();
	if (METERED_PROVIDERS[normalized]) return "metered";
	if (INFRA_PROVIDERS[normalized]) return "meterable_unconfigured";
	return "meterable_unconfigured";
}

function defaultSpendKind(provider: string): AutherSpendKind | null {
	const normalized = provider.toLowerCase();
	if (normalized === "openrouter") return "openrouter";
	if (normalized === "openai") return "openai";
	return null;
}

function humanizeProvider(provider: string): string {
	return provider
		.split(/[-_]+/g)
		.filter(Boolean)
		.map(part => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function maskSecret(secret: string): string {
	const tail = secret.slice(-4);
	return tail ? `••••${tail}` : "••••";
}

function findStoredCredential(storage: AuthStorage, id: number): StoredAuthCredential | undefined {
	return storage.listStoredCredentials().find(row => row.id === id);
}

function readMeta(id: number): AutherMetaRow | undefined {
	const stmt = openMetaDb().query<AutherMetaRow, [number]>("SELECT * FROM auther_entry_meta WHERE cred_id = ?");
	return stmt.get(id) ?? undefined;
}

function upsertMeta(meta: AutherEntryMeta): void {
	openMetaDb()
		.query(
			`INSERT INTO auther_entry_meta (cred_id, display_name, brand_id, tags, category, spend_kind, notes, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(cred_id) DO UPDATE SET
				display_name = excluded.display_name,
				brand_id = excluded.brand_id,
				tags = excluded.tags,
				category = excluded.category,
				spend_kind = excluded.spend_kind,
				notes = excluded.notes,
				updated_at = excluded.updated_at`,
		)
		.run(
			meta.credId,
			meta.displayName,
			meta.brandId,
			JSON.stringify(meta.tags),
			meta.category,
			meta.spendKind,
			meta.notes,
			meta.createdAt,
			meta.updatedAt,
		);
}

function rowToMeta(row: AutherMetaRow): AutherEntryMeta {
	return {
		credId: row.cred_id,
		displayName: row.display_name,
		brandId: row.brand_id,
		tags: parseTags(row.tags),
		category: row.category,
		spendKind: parseSpendKind(row.spend_kind),
		notes: row.notes,
		createdAt: row.created_at ?? 0,
		updatedAt: row.updated_at ?? 0,
	};
}

function metaToRow(meta: AutherEntryMeta): AutherMetaRow {
	return {
		cred_id: meta.credId,
		display_name: meta.displayName,
		brand_id: meta.brandId,
		tags: JSON.stringify(meta.tags),
		category: meta.category,
		spend_kind: meta.spendKind,
		notes: meta.notes,
		created_at: meta.createdAt,
		updated_at: meta.updatedAt,
	};
}

function parseTags(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return normalizeTags(parsed.filter((value): value is string => typeof value === "string"));
	} catch {
		return [];
	}
}

function normalizeTags(tags: string[] | undefined): string[] {
	if (!tags) return [];
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const tag of tags) {
		const trimmed = tag.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		normalized.push(trimmed);
	}
	return normalized;
}

function parseSpendKind(value: string | null): AutherSpendKind | null {
	return value === "openrouter" || value === "openai" ? value : null;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeNullableString(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function requireNonEmpty(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${field} is required`);
	return trimmed;
}

function createHexToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let token = "";
	for (const byte of bytes) {
		token += byte.toString(16).padStart(2, "0");
	}
	return token;
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
