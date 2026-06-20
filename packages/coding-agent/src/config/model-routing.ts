/**
 * Per-profile effective-model resolver for OMP Home.
 *
 * Faithful reimplementation of the precedence documented in
 * `config/model-resolver.ts` (resolveAgentModelPatterns / expandRoleAlias),
 * but operating on plain inputs rather than the live `Settings` singleton, so
 * OMP Home can resolve against ANY selected profile's config.yml
 * without activating it.
 *
 * Precedence (highest first):
 *   1. task.agentModelOverrides[name]
 *   2. agent frontmatter `model`
 *   3. modelRoles[role] when the agent's frontmatter is a `pi/<role>` alias
 *      resolving to a configured role
 *   4. modelRoles.default
 *
 * A leading `pi/<role>` selector expands against the provided modelRoles.
 * Concrete-catalog resolution (does the model exist / is it authed) is NOT
 * attempted here — the caller gets the resolved selector string verbatim.
 */

import { MODEL_ROLE_IDS } from "../config/model-roles";
import MODEL_PRIO from "../priority.json" with { type: "json" };

const PREFIX_MODEL_ROLE = "pi/";
const DEFAULT_MODEL_ROLE = "default";

/** Inputs to the per-agent effective-selector resolver. */
export interface EffectiveSelectorInput {
	/** Agent's frontmatter `model`, if any. */
	frontmatterModel?: string;
	/** The full task.agentModelOverrides map for this profile. */
	overrides: Record<string, string>;
	/** The full task.disabledAgents list for this profile. */
	disabledAgents: readonly string[];
	/** The profile's resolved modelRoles record (file value, not schema default). */
	modelRoles: Record<string, string>;
	/** Agent name. */
	name: string;
}

export interface EffectiveSelectorResult {
	/** The resolved selector string, or `undefined` when nothing resolves. */
	selector: string | undefined;
	/** Why this selector won — drives the inspector's "source" label. */
	source: "override" | "frontmatter" | "role" | "default" | "none";
	/** True when the agent is disabled via task.disabledAgents. */
	disabled: boolean;
}

/** Split a trailing `:level` thinking selector off a pattern, if valid. */
function splitThinkingSuffix(pattern: string, minColonIndex = -1): { base: string; level?: string } {
	const colonIdx = pattern.lastIndexOf(":");
	if (colonIdx <= minColonIndex) return { base: pattern };
	const candidate = pattern.slice(colonIdx + 1);
	// Thinking levels are the MODEL_ROLE-ish effort tokens; accept any bare
	// suffix that parses as a single lowercase word with no slashes — matching
	// the resolver's permissive handling is unnecessary for display, so we keep
	// the suffix attached when in doubt (see resolveConfiguredRolePattern).
	const validLevels: Record<string, true> = {
		minimal: true,
		low: true,
		medium: true,
		high: true,
		xhigh: true,
		auto: true,
		inherit: true,
		off: true,
	};
	return validLevels[candidate] !== undefined
		? { base: pattern.slice(0, colonIdx), level: candidate }
		: { base: pattern };
}

function getModelRoleAlias(value: string): string | undefined {
	const normalized = value.trim();
	if (!normalized.startsWith(PREFIX_MODEL_ROLE)) return undefined;
	const candidate = normalized.slice(PREFIX_MODEL_ROLE.length);
	return MODEL_ROLE_IDS.includes(candidate as never) ? candidate : undefined;
}

/**
 * Resolve a single role-aliased pattern against modelRoles, expanding `pi/x`
 * aliases one layer (mirroring expandRoleAlias / resolveConfiguredRolePattern).
 */
function resolveRolePattern(value: string, modelRoles: Record<string, string>): string | undefined {
	const normalized = value.trim();
	if (!normalized) return undefined;

	const { base: aliasCandidate, level: thinkingLevel } = splitThinkingSuffix(normalized, PREFIX_MODEL_ROLE.length);
	const role = getModelRoleAlias(aliasCandidate);
	if (!role) return normalized;

	const configured = modelRoles[role]?.trim();
	const resolved = configured ?? MODEL_PRIO[role as keyof typeof MODEL_PRIO]?.[0];
	if (!resolved) return undefined;

	return thinkingLevel ? `${resolved}:${thinkingLevel}` : resolved;
}

/**
 * Resolve the effective selector for one agent, per the documented precedence.
 */
export function resolveEffectiveSelector(input: EffectiveSelectorInput): EffectiveSelectorResult {
	const { frontmatterModel, overrides, disabledAgents, modelRoles, name } = input;
	const disabled = disabledAgents.includes(name);

	// 1. task.agentModelOverrides[name]
	const overrideRaw = overrides[name]?.trim();
	if (overrideRaw) {
		const resolved = resolveRolePattern(overrideRaw, modelRoles);
		if (resolved) return { selector: resolved, source: "override", disabled };
		// A raw (non-alias) override is already a concrete selector.
		return { selector: overrideRaw, source: "override", disabled };
	}

	// 2. agent frontmatter `model`
	const frontmatterRaw = frontmatterModel?.trim();
	if (frontmatterRaw) {
		const { base: aliasCandidate } = splitThinkingSuffix(frontmatterRaw, PREFIX_MODEL_ROLE.length);
		const alias = getModelRoleAlias(aliasCandidate);
		if (alias) {
			// `pi/<role>`: resolve through modelRoles[role], then fall to default.
			const resolved = resolveRolePattern(frontmatterRaw, modelRoles);
			if (resolved) return { selector: resolved, source: "role", disabled };
		} else {
			return { selector: frontmatterRaw, source: "frontmatter", disabled };
		}
	}

	// 3/4. modelRoles.default (and role-aliased default)
	const defaultValue = modelRoles[DEFAULT_MODEL_ROLE]?.trim();
	if (defaultValue) {
		const resolved = resolveRolePattern(defaultValue, modelRoles);
		return { selector: resolved ?? defaultValue, source: "default", disabled };
	}

	return { selector: undefined, source: "none", disabled };
}

/**
 * Expand a role alias against modelRoles for client-side live preview. Returns
 * the same selector when it is not an alias.
 */
export function expandRoleAliasFor(value: string | undefined, modelRoles: Record<string, string>): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return resolveRolePattern(trimmed, modelRoles) ?? trimmed;
}
