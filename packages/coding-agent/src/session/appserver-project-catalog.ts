import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ProjectId } from "@oh-my-pi/app-wire";
import { parseSessionTranscriptMetadata, type SessionRecord, stableProjectId } from "@oh-my-pi/appserver";
import { getConfigDirName, normalizeProfileName } from "@oh-my-pi/pi-utils/dirs";

const DEFAULT_MAX_PROFILES = 64;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 16_384;
const DEFAULT_MAX_TRANSCRIPTS = 4_096;
const TRANSCRIPT_METADATA_BYTES = 128 * 1024;

export interface ProjectRootCatalog {
	resolve(project: ProjectId): Promise<string>;
}

export async function resolveProjectRootFromRecords(
	project: ProjectId,
	records: readonly SessionRecord[],
	catalog?: ProjectRootCatalog,
): Promise<string> {
	const roots = [...new Set(records.filter(record => record.projectId === project).map(record => record.cwd))];
	if (roots.length === 0) {
		if (catalog) return catalog.resolve(project);
		throw new Error("unknown project");
	}
	if (roots.length !== 1) throw new Error("ambiguous project");
	return roots[0]!;
}

export interface SameFamilyProjectCatalogOptions {
	maxProfiles?: number;
	maxDirectoryEntries?: number;
	maxTranscripts?: number;
	/** Test seam for exercising the otherwise cryptographically-improbable ambiguous-id branch. */
	projectIdForRoot?: (root: string) => ProjectId;
}

interface ScanBudget {
	directoryEntries: number;
	profiles: number;
	transcripts: number;
}

function limit(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 0) throw new Error(`${name} must be a non-negative integer`);
	return resolved;
}

async function realDirectory(candidate: string): Promise<boolean> {
	try {
		const info = await fs.lstat(candidate);
		return !info.isSymbolicLink() && info.isDirectory();
	} catch {
		return false;
	}
}

async function realDirectoryChain(paths: readonly string[]): Promise<boolean> {
	for (const candidate of paths) if (!(await realDirectory(candidate))) return false;
	return true;
}

async function readDirectory(candidate: string, maximum: number): Promise<syncFs.Dirent[]> {
	if (maximum === 0) return [];
	let directory: syncFs.Dir | undefined;
	try {
		const before = await fs.lstat(candidate);
		if (before.isSymbolicLink() || !before.isDirectory()) return [];
		directory = await fs.opendir(candidate);
		const entries: syncFs.Dirent[] = [];
		while (entries.length < maximum) {
			const entry = await directory.read();
			if (!entry) break;
			entries.push(entry);
		}
		const after = await fs.lstat(candidate);
		if (after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino)
			return [];
		return entries.sort((left, right) => left.name.localeCompare(right.name));
	} catch {
		return [];
	} finally {
		if (directory) {
			try {
				await directory.close();
			} catch {}
		}
	}
}

async function canonicalExistingDirectory(candidate: string): Promise<string | undefined> {
	try {
		const canonical = await fs.realpath(candidate);
		const info = await fs.stat(canonical);
		return info.isDirectory() ? canonical : undefined;
	} catch {
		return undefined;
	}
}

function validNativeProfileName(name: string): boolean {
	try {
		return normalizeProfileName(name) === name;
	} catch {
		return false;
	}
}

/**
 * A read-only project catalog derived from the default OMP profile family.
 *
 * Only `<family>/agent/sessions` and `<family>/profiles/<native>/agent/sessions`
 * are considered. Sibling config roots and custom `PI_CONFIG_DIR` profiles are
 * intentionally outside this authority boundary.
 */
export class SameFamilyProjectCatalog implements ProjectRootCatalog {
	readonly #familyRoot: string;
	readonly #maxProfiles: number;
	readonly #maxDirectoryEntries: number;
	readonly #maxTranscripts: number;
	readonly #projectIdForRoot: (root: string) => ProjectId;
	#snapshot?: Promise<Map<ProjectId, Set<string>>>;

	constructor(familyRoot: string, options: SameFamilyProjectCatalogOptions = {}) {
		this.#familyRoot = path.resolve(familyRoot);
		this.#maxProfiles = limit(options.maxProfiles, DEFAULT_MAX_PROFILES, "maxProfiles");
		this.#maxDirectoryEntries = limit(
			options.maxDirectoryEntries,
			DEFAULT_MAX_DIRECTORY_ENTRIES,
			"maxDirectoryEntries",
		);
		this.#maxTranscripts = limit(options.maxTranscripts, DEFAULT_MAX_TRANSCRIPTS, "maxTranscripts");
		this.#projectIdForRoot = options.projectIdForRoot ?? stableProjectId;
	}

	async resolve(project: ProjectId): Promise<string> {
		const cached = this.#snapshot !== undefined;
		if (!this.#snapshot) this.#snapshot = this.#scan();
		const snapshot = await this.#snapshot;
		const resolved = await this.#resolveSnapshot(project, snapshot);
		if (resolved) return resolved;
		if (!cached) throw new Error("unknown project");

		const refreshed = this.#scan();
		this.#snapshot = refreshed;
		const refreshedResolved = await this.#resolveSnapshot(project, await refreshed);
		if (!refreshedResolved) throw new Error("unknown project");
		return refreshedResolved;
	}

	async #resolveSnapshot(project: ProjectId, snapshot: Map<ProjectId, Set<string>>): Promise<string | undefined> {
		const current = new Set<string>();
		for (const candidate of snapshot.get(project) ?? []) {
			const canonical = await canonicalExistingDirectory(candidate);
			if (!canonical) continue;
			try {
				if (this.#projectIdForRoot(canonical) === project) current.add(canonical);
			} catch {}
		}
		if (current.size === 0) return undefined;
		if (current.size !== 1) throw new Error("ambiguous project");
		return [...current][0]!;
	}

	async #scan(): Promise<Map<ProjectId, Set<string>>> {
		const projects = new Map<ProjectId, Set<string>>();
		const budget: ScanBudget = {
			directoryEntries: this.#maxDirectoryEntries,
			profiles: this.#maxProfiles,
			transcripts: this.#maxTranscripts,
		};
		const seenFiles = new Set<string>();
		const defaultAgent = path.join(this.#familyRoot, "agent");
		const defaultSessions = path.join(defaultAgent, "sessions");
		if (await realDirectoryChain([this.#familyRoot, defaultAgent, defaultSessions]))
			await this.#scanSessions(defaultSessions, budget, seenFiles, projects);
		if (budget.profiles === 0 || budget.directoryEntries === 0 || budget.transcripts === 0) return projects;

		const profilesRoot = path.join(this.#familyRoot, "profiles");
		if (!(await realDirectoryChain([this.#familyRoot, profilesRoot]))) return projects;
		const maximum = Math.min(budget.profiles, budget.directoryEntries);
		const profiles = await readDirectory(profilesRoot, maximum);
		budget.profiles -= profiles.length;
		budget.directoryEntries -= profiles.length;
		for (const entry of profiles) {
			if (budget.transcripts === 0 || budget.directoryEntries === 0) break;
			if (!entry.isDirectory() || !validNativeProfileName(entry.name)) continue;
			const profileRoot = path.join(profilesRoot, entry.name);
			const agent = path.join(profileRoot, "agent");
			const sessions = path.join(agent, "sessions");
			if (!(await realDirectoryChain([profileRoot, agent, sessions]))) continue;
			await this.#scanSessions(sessions, budget, seenFiles, projects);
		}
		return projects;
	}

	async #scanSessions(
		root: string,
		budget: ScanBudget,
		seenFiles: Set<string>,
		projects: Map<ProjectId, Set<string>>,
	): Promise<void> {
		const entries = await readDirectory(root, budget.directoryEntries);
		budget.directoryEntries -= entries.length;
		for (const entry of entries) {
			if (budget.transcripts === 0) return;
			const candidate = path.join(root, entry.name);
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				await this.#scanTranscript(candidate, budget, seenFiles, projects);
				continue;
			}
			if (!entry.isDirectory() || (entry.name !== "-" && !entry.name.startsWith("-"))) continue;
			const children = await readDirectory(candidate, budget.directoryEntries);
			budget.directoryEntries -= children.length;
			for (const child of children) {
				if (budget.transcripts === 0) return;
				if (child.isFile() && child.name.endsWith(".jsonl"))
					await this.#scanTranscript(path.join(candidate, child.name), budget, seenFiles, projects);
			}
		}
	}

	async #scanTranscript(
		candidate: string,
		budget: ScanBudget,
		seenFiles: Set<string>,
		projects: Map<ProjectId, Set<string>>,
	): Promise<void> {
		if (budget.transcripts === 0) return;
		budget.transcripts -= 1;
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(candidate, syncFs.constants.O_RDONLY | syncFs.constants.O_NOFOLLOW);
			const before = await handle.stat();
			if (!before.isFile()) return;
			const identity = `${before.dev}:${before.ino}`;
			if (seenFiles.has(identity)) return;
			seenFiles.add(identity);
			const bytes = Buffer.allocUnsafe(Math.min(TRANSCRIPT_METADATA_BYTES, Math.max(1, before.size)));
			const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
			const after = await handle.stat();
			if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) return;
			const record = parseSessionTranscriptMetadata(bytes.subarray(0, bytesRead), candidate);
			const canonical = await canonicalExistingDirectory(record.cwd);
			if (!canonical) return;
			const project = this.#projectIdForRoot(canonical);
			const roots = projects.get(project) ?? new Set<string>();
			roots.add(canonical);
			projects.set(project, roots);
		} catch {
			// Malformed, oversized-metadata, raced, or inaccessible transcripts do
			// not contribute authority to the catalog.
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}
}

/** Build the personal default-profile family catalog, never a custom config family. */
export function defaultSameFamilyProjectCatalog(): ProjectRootCatalog | undefined {
	if (getConfigDirName() !== ".omp") return undefined;
	return new SameFamilyProjectCatalog(path.join(os.homedir(), ".omp"));
}
