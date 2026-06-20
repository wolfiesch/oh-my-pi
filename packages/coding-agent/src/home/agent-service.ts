/**
 * Agent roster service for OMP Home.
 *
 * Builds the per-profile agent roster the UI renders. Unlike the live
 * `discoverAgents` (which binds to the active profile), this scans the
 * SELECTED profile's `<agentDir>/agents/*.md` directly, then merges project
 * (cwd `.omp/agents`) + bundled agents, and computes each agent's effective
 * model selector via the precedence resolver in `config/model-routing.ts`.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { type EffectiveSelectorResult, resolveEffectiveSelector } from "../config/model-routing";
import { loadBundledAgents, parseAgent } from "../task/agents";
import type { AgentDefinition, AgentSource } from "../task/types";
import { readProfileConfigFor } from "./config-service";
import { type ProfileEntry, resolveProfile } from "./profiles";

/** One row in the agent roster. */
export interface AgentRosterEntry {
	name: string;
	description: string;
	source: AgentSource;
	filePath?: string;
	/** Agent frontmatter `model` (raw, may be a `pi/<role>` alias). */
	frontmatterModel?: string;
	/** task.agentModelOverrides[name], if set. */
	override?: string;
	/** Whether the agent is disabled via task.disabledAgents. */
	disabled: boolean;
	/** Effective resolved selector + source. */
	effective: EffectiveSelectorResult;
}

async function loadAgentsFromDir(dir: string, source: AgentSource): Promise<AgentDefinition[]> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name));
	const loaded: AgentDefinition[] = [];
	for (const file of files) {
		const filePath = path.join(dir, file.name);
		try {
			const content = await Bun.file(filePath).text();
			loaded.push(parseAgent(filePath, content, source, "warn"));
		} catch {
			// Skip unparseable agent files (matches discoverAgents warn-and-skip).
		}
	}
	return loaded;
}

function getByPath(obj: Record<string, unknown>, segments: readonly string[]): unknown {
	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function asStringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: Record<string, string> = {};
	for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
		if (typeof val === "string") result[key] = val;
	}
	return result;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

/** Merge user + project + bundled agents, deduping by name (first wins). */
async function collectAgents(profile: ProfileEntry, cwd: string): Promise<AgentDefinition[]> {
	const seen = new Set<string>();
	const merged: AgentDefinition[] = [];

	// User agents: selected profile's <agentDir>/agents/*.md
	const userAgentDir = path.join(profile.agentDir, "agents");
	const userAgents = await loadAgentsFromDir(userAgentDir, "user");
	for (const agent of userAgents) {
		if (!seen.has(agent.name)) {
			seen.add(agent.name);
			merged.push(agent);
		}
	}

	// Project agents: cwd/.omp/agents/*.md
	const projectAgentDir = path.join(cwd, ".omp", "agents");
	const projectAgents = await loadAgentsFromDir(projectAgentDir, "project");
	for (const agent of projectAgents) {
		if (!seen.has(agent.name)) {
			seen.add(agent.name);
			merged.push(agent);
		}
	}

	// Bundled agents.
	for (const agent of loadBundledAgents()) {
		if (!seen.has(agent.name)) {
			seen.add(agent.name);
			merged.push(agent);
		}
	}

	return merged;
}

/**
 * Build the agent roster for a profile. `cwd` is the project dir for project-
 * scoped agent discovery (defaults to process.cwd()).
 */
export async function listAgents(profileId: string, cwd: string = process.cwd()): Promise<AgentRosterEntry[]> {
	const profile = await resolveProfile(profileId);
	const config = await readProfileConfigFor(profile);
	const overrides = asStringRecord(config.values["task.agentModelOverrides"]);
	const disabledAgents = asStringArray(config.values["task.disabledAgents"]);
	const modelRoles = asStringRecord(config.values.modelRoles);

	const agents = await collectAgents(profile, cwd);
	agents.sort((a, b) => {
		// Bundled last; user/project alphabetical.
		const sourceOrder: Record<AgentSource, number> = { project: 0, user: 1, bundled: 2 };
		const so = sourceOrder[a.source] - sourceOrder[b.source];
		if (so !== 0) return so;
		return a.name.localeCompare(b.name);
	});

	return agents.map(agent => {
		const frontmatterModel = agent.model?.find(m => m.trim())?.trim();
		const override = overrides[agent.name]?.trim() || undefined;
		const effective = resolveEffectiveSelector({
			name: agent.name,
			frontmatterModel,
			overrides,
			disabledAgents,
			modelRoles,
		});
		return {
			name: agent.name,
			description: agent.description,
			source: agent.source,
			filePath: agent.filePath,
			frontmatterModel,
			override,
			disabled: disabledAgents.includes(agent.name),
			effective,
		};
	});
}

export { getByPath };
