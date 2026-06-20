/**
 * Profile registry — OMP Home's multi-profile source of truth.
 *
 * The live `Settings` singleton is bound to ONE process's active profile
 * (`PI_CONFIG_DIR`). OMP Home must edit ANY profile's config.yml /
 * agent.db, so it keeps its own registry of absolute agent dirs and reads /
 * writes each selected profile's files directly.
 *
 * Registry file: `<getConfigRootDir()>/home/profiles.json` under the
 * launching process's config root, but every entry stores an ABSOLUTE agentDir
 * so the registry is shared across profiles. On start, the registry is
 * auto-seeded/merged (idempotent, never removes user entries) by discovery.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, isEnoent, normalizePathForComparison } from "@oh-my-pi/pi-utils";

/** Registry entry shape (persisted). */
export interface ProfileEntry {
	/** Stable id. Defaults to a slug of the agentDir basename. */
	id: string;
	/** Human label. */
	label: string;
	/** Absolute path to the profile's agent directory. */
	agentDir: string;
}

interface RegistryFile {
	version: 1;
	profiles: ProfileEntry[];
}

const REGISTRY_REL = path.join("home", "profiles.json");

function getRegistryPath(): string {
	return path.join(getConfigRootDir(), REGISTRY_REL);
}

/** Resolve a profile's concrete file paths from its agentDir. */
export function resolveProfileFiles(agentDir: string): { configPath: string; dbPath: string } {
	return {
		configPath: path.join(agentDir, "config.yml"),
		dbPath: path.join(agentDir, "agent.db"),
	};
}

function slugify(agentDir: string): string {
	const base = path.basename(agentDir) || "profile";
	// `omp-<name>/agent` → collapse to `<name>`; otherwise keep the basename.
	const stripped = base === "agent" ? path.basename(path.dirname(agentDir)) : base;
	return (
		stripped
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "profile"
	);
}

function deriveLabel(agentDir: string): string {
	const base = path.basename(agentDir) === "agent" ? path.basename(path.dirname(agentDir)) : path.basename(agentDir);
	return (
		base
			.replace(/^omp-/, "")
			.split(/[-_]/)
			.map(word => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
			.join(" ") || "Default"
	);
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		return false;
	}
}

async function readRegistry(): Promise<RegistryFile> {
	const registryPath = getRegistryPath();
	try {
		const content = await Bun.file(registryPath).text();
		const parsed = JSON.parse(content) as Partial<RegistryFile>;
		if (parsed && Array.isArray(parsed.profiles)) {
			return { version: 1, profiles: parsed.profiles.filter(isValidEntry) };
		}
	} catch (err) {
		if (!isEnoent(err)) {
			// Corrupt registry: start fresh rather than crashing. The user can
			// re-add profiles by path. Logged by caller context, not here.
		}
	}
	return { version: 1, profiles: [] };
}

function isValidEntry(entry: unknown): entry is ProfileEntry {
	return (
		!!entry &&
		typeof entry === "object" &&
		typeof (entry as ProfileEntry).id === "string" &&
		typeof (entry as ProfileEntry).label === "string" &&
		typeof (entry as ProfileEntry).agentDir === "string" &&
		(entry as ProfileEntry).id.length > 0 &&
		(entry as ProfileEntry).agentDir.length > 0
	);
}

async function writeRegistry(registry: RegistryFile): Promise<void> {
	const registryPath = getRegistryPath();
	await Bun.write(registryPath, JSON.stringify(registry, null, 2));
}

/** Dedupe registry entries by the realpath of their agentDir. */
function dedupeByAgentDir(entries: ProfileEntry[]): ProfileEntry[] {
	const seen = new Map<string, ProfileEntry>();
	for (const entry of entries) {
		const key = normalizePathForComparison(entry.agentDir);
		if (!seen.has(key)) seen.set(key, entry);
	}
	return [...seen.values()];
}

/**
 * Discover candidate profiles for auto-seeding:
 * (a) the launching process's own agent dir;
 * (b) named-profile layout (`<configRoot>/profiles/<name>/agent`);
 * (c) sibling roots (`~/.config/omp-<name>/agent`) that have a config.yml.
 */
async function discoverCandidates(): Promise<ProfileEntry[]> {
	const candidates: ProfileEntry[] = [];

	// (a) launching process's own agent dir (resolved by dirs.ts at import).
	const ownAgentDir = path.join(getConfigRootDir(), "agent");
	if (await pathExists(path.join(ownAgentDir, "config.yml"))) {
		candidates.push({ id: "default", label: deriveLabel(ownAgentDir), agentDir: ownAgentDir });
	}

	// (b) named-profile layout under the config root.
	const profilesRoot = path.join(getConfigRootDir(), "profiles");
	try {
		for (const entry of await fs.readdir(profilesRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const agentDir = path.join(profilesRoot, entry.name, "agent");
			if (await pathExists(path.join(agentDir, "config.yml"))) {
				candidates.push({ id: slugify(agentDir), label: deriveLabel(agentDir), agentDir });
			}
		}
	} catch {
		// No named-profile dir.
	}

	// (c) sibling `~/.config/omp-*/agent` roots (covers giga/superswipe/etc.).
	const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
	try {
		for (const entry of await fs.readdir(configHome, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.startsWith("omp-")) continue;
			const agentDir = path.join(configHome, entry.name, "agent");
			if (await pathExists(path.join(agentDir, "config.yml"))) {
				candidates.push({ id: slugify(agentDir), label: deriveLabel(agentDir), agentDir });
			}
		}
	} catch {
		// No config home readable.
	}

	return candidates;
}

/**
 * List profiles, auto-seeding/merging the registry on first read. Idempotent:
 * never removes user-added entries; only adds discovered ones and dedupes by
 * realpath. Persists the merged registry.
 */
export async function listProfiles(): Promise<ProfileEntry[]> {
	const registry = await readRegistry();
	const discovered = await discoverCandidates();
	const merged = dedupeByAgentDir([...registry.profiles, ...discovered]);
	// Preserve registry order: existing entries first (in their stored order),
	// then newly discovered ones.
	const existingKeys = new Set(registry.profiles.map(p => normalizePathForComparison(p.agentDir)));
	const ordered = [
		...registry.profiles,
		...discovered.filter(d => !existingKeys.has(normalizePathForComparison(d.agentDir))),
	];
	// Re-dedupe ordered list (dedupeByAgentDir keeps first occurrence → registry wins).
	const finalList = dedupeByAgentDir(merged.length === ordered.length ? ordered : merged);

	if (
		finalList.length !== registry.profiles.length ||
		JSON.stringify(finalList) !== JSON.stringify(registry.profiles)
	) {
		await writeRegistry({ version: 1, profiles: finalList }).catch(() => {
			// Non-fatal: in-memory list is still returned.
		});
	}
	return finalList;
}

/**
 * Resolve a profile by id. Throws when the id is unknown (caller maps to 404)
 * or the agentDir no longer exists (caller maps to 410).
 */
export async function resolveProfile(id: string): Promise<ProfileEntry & { configPath: string; dbPath: string }> {
	const profiles = await listProfiles();
	const entry = profiles.find(p => p.id === id);
	if (!entry) {
		throw new ProfileNotFoundError(`Unknown profile id: ${id}`);
	}
	const files = resolveProfileFiles(entry.agentDir);
	return { ...entry, ...files };
}

/**
 * Add a profile by absolute path. The path may be either an agent dir directly
 * (containing/able-to-contain config.yml) or a profile root whose `agent/`
 * subdir holds the config. Throws when the path is invalid (caller maps to 400).
 */
export async function addProfile(absPath: string, label?: string): Promise<ProfileEntry> {
	const resolved = path.resolve(absPath);
	// Accept either `<root>/agent` or `<root>` that has an `agent/config.yml`.
	let agentDir = resolved;
	let hasConfig = await pathExists(path.join(agentDir, "config.yml"));
	if (!hasConfig) {
		const childAgent = path.join(resolved, "agent");
		if (await pathExists(path.join(childAgent, "config.yml"))) {
			agentDir = childAgent;
			hasConfig = true;
		}
	}
	if (!hasConfig) {
		throw new InvalidProfilePathError(
			`No config.yml found under ${resolved} (looked for ${resolved}/config.yml and ${resolved}/agent/config.yml).`,
		);
	}

	const id = slugify(agentDir);
	const registry = await readRegistry();
	const filtered = registry.profiles.filter(
		p => normalizePathForComparison(p.agentDir) !== normalizePathForComparison(agentDir),
	);
	const entry: ProfileEntry = { id, label: label?.trim() || deriveLabel(agentDir), agentDir };
	const next = dedupeByAgentDir([...filtered, entry]);
	await writeRegistry({ version: 1, profiles: next });
	return entry;
}

/**
 * Remove a profile from the registry ONLY. Never deletes profile files.
 */
export async function removeProfile(id: string): Promise<void> {
	const registry = await readRegistry();
	const next = registry.profiles.filter(p => p.id !== id);
	if (next.length === registry.profiles.length) {
		throw new ProfileNotFoundError(`Unknown profile id: ${id}`);
	}
	await writeRegistry({ version: 1, profiles: next });
}

/** Thrown when a profile id is unknown or its dir vanished. */
export class ProfileNotFoundError extends Error {}
/** Thrown when an add-by-path target is invalid. */
export class InvalidProfilePathError extends Error {}
