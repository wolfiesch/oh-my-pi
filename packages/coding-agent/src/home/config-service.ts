/**
 * Config read/validate/write service for OMP Home.
 *
 * Operates on a SELECTED profile's config.yml directly (via the comment-
 * preserving config-writer), independent of the live `Settings` singleton.
 * Reads surface schema metadata (type/enum/default/description/tab) so the
 * client can render the General editor generically; writes validate against
 * the schema helpers before touching disk.
 */

import { applyConfigEdits, type ConfigEdit, readConfigDoc } from "../config/config-writer";
import {
	type AnyUiMetadata,
	getDefault,
	getEnumValues,
	getType,
	getUi,
	SETTINGS_SCHEMA,
	type SettingPath,
} from "../config/settings-schema";
import { type ProfileEntry, resolveProfile } from "./profiles";

/** UI-facing schema metadata for one setting. */
export interface SchemaMeta {
	path: string;
	type: string;
	enumValues?: readonly string[];
	default: unknown;
	description: string;
	label: string;
	tab?: string;
	group?: string;
}

/** UI-facing resolved config (file value ?? schema default). */
export interface ResolvedConfig {
	values: Record<string, unknown>;
	/** The raw parsed object (file value only, no defaults applied). */
	raw: Record<string, unknown>;
	schema: SchemaMeta[];
}

function getByPath(obj: Record<string, unknown>, segments: readonly string[]): unknown {
	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function buildSchemaMeta(): SchemaMeta[] {
	const meta: SchemaMeta[] = [];
	for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		const ui: AnyUiMetadata | undefined = getUi(path);
		meta.push({
			path,
			type: getType(path),
			enumValues: getEnumValues(path),
			default: getDefault(path),
			description: ui?.description ?? "",
			label: ui?.label ?? path,
			tab: ui?.tab,
			group: ui?.group,
		});
	}
	return meta;
}

/**
 * Read a profile's config.yml, returning resolved values (file ?? default),
 * the raw parsed object, and full schema metadata for the client editor.
 */
export async function readProfileConfig(profileId: string): Promise<ResolvedConfig> {
	const profile = await resolveProfile(profileId);
	return readProfileConfigFor(profile);
}

export async function readProfileConfigFor(
	profile: ProfileEntry & { configPath: string; dbPath: string },
): Promise<ResolvedConfig> {
	const schema = buildSchemaMeta();
	const raw = await readConfigDoc(profile.configPath);
	const values: Record<string, unknown> = {};
	for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		const fileValue = getByPath(raw, path.split("."));
		values[path] = fileValue !== undefined ? fileValue : getDefault(path);
	}
	return { values, raw, schema };
}

/** Thrown when a config edit fails validation (caller maps to HTTP 400). */
export class ConfigValidationError extends Error {}

function assertNumber(value: unknown): void {
	if (typeof value === "number" && Number.isFinite(value)) return;
	throw new ConfigValidationError("expected number");
}

function assertStringArray(value: unknown): void {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
		throw new ConfigValidationError("expected string array");
	}
}

function assertStringRecord(value: unknown): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ConfigValidationError("expected a record/object");
	}
}

function findRecordAncestor(path: string): string | undefined {
	let cursor = path;
	while (cursor.includes(".")) {
		cursor = cursor.slice(0, cursor.lastIndexOf("."));
		const def = SETTINGS_SCHEMA[cursor as SettingPath];
		if (def?.type === "record") return cursor;
	}
	return undefined;
}

function validateRecordChild(path: string, value: unknown): void {
	const ancestor = findRecordAncestor(path);
	if (!ancestor) throw new ConfigValidationError(`Unknown setting path: ${path}`);
	if (value === undefined) return;
	if (ancestor === "modelRoles" || ancestor === "task.agentModelOverrides") {
		if (typeof value !== "string") throw new ConfigValidationError(`${path}: expected string`);
		return;
	}
}

/**
 * Validate a single edit against the schema (type/enum/array/record). Mirrors
 * the type discipline of `parseAndSetValue` without re-implementing its
 * side-effect hooks. Throws ConfigValidationError on reject.
 */
export function validateConfigEdit(path: string, value: unknown): void {
	const def = SETTINGS_SCHEMA[path as SettingPath];
	if (!def) {
		validateRecordChild(path, value);
		return;
	}
	// Delete is always allowed for known paths.
	if (value === undefined) return;

	switch (def.type) {
		case "boolean":
			if (typeof value !== "boolean") throw new ConfigValidationError(`${path}: expected boolean`);
			break;
		case "number":
			assertNumber(value); // throws on invalid
			break;
		case "string":
			if (typeof value !== "string") throw new ConfigValidationError(`${path}: expected string`);
			break;
		case "enum": {
			const allowed = getEnumValues(path as SettingPath);
			if (typeof value !== "string" || !allowed?.includes(value)) {
				throw new ConfigValidationError(`${path}: must be one of ${(allowed ?? []).join(", ")}`);
			}
			break;
		}
		case "array":
			assertStringArray(value); // throws on invalid
			break;
		case "record":
			assertStringRecord(value); // throws on invalid
			break;
	}
}

/**
 * Validate then atomically apply a batch of config edits to the profile's
 * config.yml. Returns the re-read resolved config so the caller syncs the UI.
 */
export async function writeProfileConfig(profileId: string, edits: ConfigEdit[]): Promise<ResolvedConfig> {
	if (!Array.isArray(edits)) throw new ConfigValidationError("edits must be an array");
	// Validate ALL edits before applying ANY (atomicity).
	for (const edit of edits) {
		validateConfigEdit(edit.path, edit.value);
	}
	const profile = await resolveProfile(profileId);
	await applyConfigEdits(profile.configPath, edits);
	return readProfileConfigFor(profile);
}
