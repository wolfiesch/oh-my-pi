import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
	type CatalogFrame,
	type CatalogItem,
	COMMAND_DESCRIPTORS,
	catalogId,
	DESKTOP_CATALOG_COMMANDS,
	decodeCatalog,
	hostId,
	type SettingsFrame,
} from "@oh-my-pi/app-wire";
import type { ModelRegistry } from "../../config/model-registry.ts";
import { getKnownRoleIds, getRoleInfo } from "../../config/model-roles.ts";
import type { SettingsDesktopSnapshot } from "../../config/settings.ts";
import { SETTINGS_SCHEMA, type SettingPath } from "../../config/settings-schema.ts";
import type { AgentRegistry } from "../../registry/agent-registry.ts";
import { BUILTIN_SLASH_COMMAND_DEFS } from "../../slash-commands/builtin-registry.ts";
import { loadBundledAgents } from "../../task/agents.ts";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "../../tools/index.ts";

const MAX_ITEMS = 1000;
const MAX_PATHS = 256;
const MAX_DEPTH = 8;
const MAX_NODES = 5000;
const MAX_STRING = 8192;
const SECRET_KEY = /(?:password|passwd|secret|token|credential|api[_-]?key|private[_-]?key|access[_-]?key|auth)/iu;
const SETTING_TYPES = new Set(["boolean", "number", "string", "enum", "array", "record"]);
const CATALOG_KINDS = new Set(["tool", "model", "command", "setting", "skill", "agent", "provider", "mode"]);
type SettingControlType = "boolean" | "number" | "string" | "enum" | "array" | "record";
type SettingScope = "global" | "session" | "project" | "cli" | "read-only";

export interface DesktopSettingsPort {
	get(path: SettingPath): unknown;
	isConfigured?(path: SettingPath): boolean;
	set(path: SettingPath, value: unknown): void;
	override?(path: SettingPath, value: unknown): void;
	clearOverride?(path: SettingPath): void;
	flush?(): Promise<void> | void;
	getDesktopSnapshot(path: SettingPath): SettingsDesktopSnapshot;
	restoreDesktopSnapshot(snapshot: SettingsDesktopSnapshot): void;
	clearGlobal(path: SettingPath): void;
}
export interface CatalogProvider {
	list?: () => unknown[] | Promise<unknown[]>;
	metadata?: () => unknown[] | Promise<unknown[]>;
}
export type SkillLoader = () => unknown | Promise<unknown>;
export interface PluginManagerLike {
	list(): unknown[] | Promise<unknown[]>;
}
export interface McpManagerLike {
	getConnectedServers(): string[];
	getAllServerNames(): string[];
}
export interface OperationContextLike {
	hostId?: string;
	currentRevision?: string;
	expectedRevision?: string;
}
export interface DesktopConfigAuthorityOptions {
	settings: DesktopSettingsPort;
	hostId?: string;
	platform?: string;
	modelRegistry?:
		| Pick<ModelRegistry, "getAll" | "getAvailable">
		| { getAll?: () => unknown[]; getAvailable?: () => unknown[] };
	agentRegistry?: Pick<AgentRegistry, "list"> | { list: () => unknown[] };
	skillsLoader?: SkillLoader;
	pluginManager?: PluginManagerLike;
	mcpManager?: McpManagerLike;
	skillsProvider?: CatalogProvider | SkillLoader;
	pluginProvider?: CatalogProvider | (() => unknown[] | Promise<unknown[]>);
	mcpProvider?: CatalogProvider | (() => unknown[] | Promise<unknown[]>);
	/** Legacy aliases retained for callers that have not adopted explicit adapters. */
	skills?: CatalogProvider | SkillLoader;
	plugins?: CatalogProvider | (() => unknown[] | Promise<unknown[]>);
	mcp?: CatalogProvider | (() => unknown[] | Promise<unknown[]>);
}
export interface SettingsReadArgs {
	paths?: string[];
	path?: string;
	category?: string;
}
export interface SettingsWriteEdit {
	path: string;
	value?: unknown;
	scope?: SettingScope | string;
	reset?: boolean;
	controlType?: string;
	type?: string;
}
export interface SettingsWriteArgs extends Partial<SettingsWriteEdit> {
	edits?: SettingsWriteEdit[];
	expectedRevision?: string;
}
export interface CatalogGetArgs {
	kind?: string;
	search?: string;
	query?: string;
}
interface SettingDefinition {
	type: SettingControlType;
	default?: unknown;
	values?: readonly string[];
	ui?: Record<string, unknown>;
	[key: string]: unknown;
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonical(object[key])}`)
		.join(",")}}`;
}
function revisionFor(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
function text(value: unknown, max = MAX_STRING): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, max);
}
function pathSafe(value: string): string {
	return isAbsolute(value) ? "<redacted-path>" : value;
}
function secretKey(key: string): boolean {
	return SECRET_KEY.test(key);
}
function safeMetadata(value: unknown, depth = 0, state = { nodes: 0 }, key = ""): unknown {
	if (++state.nodes > MAX_NODES || depth > MAX_DEPTH) return "<redacted-bounds>";
	if (secretKey(key) || typeof value === "function" || typeof value === "bigint" || value === undefined)
		return undefined;
	if (typeof value === "string") return pathSafe(text(value) ?? "");
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value))
		return value
			.slice(0, MAX_ITEMS)
			.map(item => safeMetadata(item, depth + 1, state, key))
			.filter(item => item !== undefined);
	if (typeof value !== "object") return undefined;
	const result: Record<string, unknown> = {};
	for (const [childKey, child] of Object.entries(value as Record<string, unknown>).slice(0, 256)) {
		const clean = safeMetadata(child, depth + 1, state, childKey);
		if (clean !== undefined) result[text(childKey, 256) ?? "<redacted-key>"] = clean;
	}
	return result;
}
function settingDefinition(path: string): SettingDefinition | undefined {
	const candidate = (SETTINGS_SCHEMA as unknown as Record<string, unknown>)[path];
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
	const def = candidate as Record<string, unknown>;
	return typeof def.type === "string" && SETTING_TYPES.has(def.type)
		? (def as unknown as SettingDefinition)
		: undefined;
}
function settingSensitive(path: string): boolean {
	return path.split(".").some(secretKey);
}
function sourceFor(settings: DesktopSettingsPort, path: SettingPath): string {
	return settings.getDesktopSnapshot(path).source;
}
function controlMetadata(def: SettingDefinition): Record<string, unknown> {
	const result: Record<string, unknown> = { controlType: def.type };
	if (Array.isArray(def.values)) result.options = def.values.slice(0, 256);
	const ui = def.ui;
	if (ui && Array.isArray(ui.options))
		result.options = ui.options
			.slice(0, 256)
			.map(option => {
				if (!option || typeof option !== "object") return undefined;
				const item = option as Record<string, unknown>;
				return {
					value: safeMetadata(item.value),
					label: safeMetadata(item.label),
					description: safeMetadata(item.description),
				};
			})
			.filter(Boolean);
	for (const key of [
		"min",
		"max",
		"unit",
		"scopes",
		"restartRequired",
		"platform",
		"availability",
		"maxItems",
		"maxEntries",
	])
		if (def[key] !== undefined) result[key] = safeMetadata(def[key]);
	return result;
}
function containsSecretKey(value: unknown, depth = 0): boolean {
	if (depth > MAX_DEPTH || !value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(item => containsSecretKey(item, depth + 1));
	return Object.entries(value as Record<string, unknown>).some(
		([key, child]) => secretKey(key) || containsSecretKey(child, depth + 1),
	);
}
const STRING_ARRAY_SETTINGS = new Set([
	"extensions",
	"enabledModels",
	"disabledProviders",
	"disabledExtensions",
	"modelProviderOrder",
	"statusLine.leftSegments",
	"statusLine.rightSegments",
	"hindsight.recallTypes",
	"ttsr.disabledRules",
	"shellMinimizer.only",
	"shellMinimizer.except",
	"tools.essentialOverride",
	"mcp.discoveryDefaultServers",
	"goal.continuationModes",
	"task.disabledAgents",
	"skills.customDirectories",
	"skills.ignoredSkills",
	"skills.includeSkills",
	"providers.webSearchExclude",
	"cycleOrder",
]);
function validateNested(value: unknown, path: string, depth = 0): void {
	if (depth > MAX_DEPTH) throw new Error(`value exceeds nesting limit for ${path}`);
	if (typeof value === "string") {
		if (value.length > MAX_STRING) throw new Error(`string exceeds limit for ${path}`);
		return;
	}
	if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
	if (Array.isArray(value)) {
		if (value.length > MAX_ITEMS) throw new Error(`array exceeds limit for ${path}`);
		value.forEach((item, index) => {
			validateNested(item, `${path}[${index}]`, depth + 1);
		});
		return;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length > 256) throw new Error(`map exceeds limit for ${path}`);
		for (const [key, child] of entries) {
			if (key.length > MAX_STRING || secretKey(key))
				throw new Error(`secret-like keys cannot be written for ${path}`);
			validateNested(child, `${path}.${key}`, depth + 1);
		}
		return;
	}
	throw new Error(`value for ${path} is not serializable`);
}
function shapeOf(value: unknown): unknown {
	if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return typeof value;
	if (Array.isArray(value)) return value.length > 0 ? { array: shapeOf(value[0]) } : { array: "unknown" };
	if (value && typeof value === "object") {
		return {
			object: Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, shapeOf(child)]),
			),
		};
	}
	return "unknown";
}
function validateShape(value: unknown, shape: unknown, path: string): void {
	if (shape === "unknown") return;
	if (typeof shape === "string") {
		if (typeof value !== shape || (shape === "number" && !Number.isFinite(value)))
			throw new Error(`invalid typed value for ${path}`);
		return;
	}
	if (!shape || typeof shape !== "object") return;
	const spec = shape as Record<string, unknown>;
	if ("array" in spec) {
		if (!Array.isArray(value)) throw new Error(`invalid array value for ${path}`);
		for (const [index, item] of value.entries()) validateShape(item, spec.array, `${path}[${index}]`);
		return;
	}
	if ("object" in spec) {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error(`invalid record value for ${path}`);
		const expected = spec.object as Record<string, unknown>;
		for (const [key, expectedShape] of Object.entries(expected)) {
			if (!(key in (value as Record<string, unknown>))) throw new Error(`missing record key ${path}.${key}`);
			validateShape((value as Record<string, unknown>)[key], expectedShape, `${path}.${key}`);
		}
		return;
	}
}
function validateValue(def: SettingDefinition, value: unknown, path: string): void {
	validateNested(value, path);
	switch (def.type) {
		case "boolean":
			if (typeof value !== "boolean") throw new Error(`invalid boolean value for ${path}`);
			break;
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`invalid number value for ${path}`);
			else {
				if (typeof def.min === "number" && value < def.min) throw new Error(`${path} is below minimum`);
				if (typeof def.max === "number" && value > def.max) throw new Error(`${path} is above maximum`);
			}
			break;
		case "string":
			if (typeof value !== "string") throw new Error(`invalid string value for ${path}`);
			break;
		case "enum":
			if (!Array.isArray(def.values) || !def.values.includes(value as string))
				throw new Error(`invalid enum value for ${path}`);
			break;
		case "array": {
			const maxItems = typeof def.maxItems === "number" ? Math.min(def.maxItems, MAX_ITEMS) : MAX_ITEMS;
			if (!Array.isArray(value) || value.length > maxItems) throw new Error(`invalid array value for ${path}`);
			const sample =
				Array.isArray(def.default) && def.default.length > 0
					? shapeOf(def.default[0])
					: STRING_ARRAY_SETTINGS.has(path)
						? "string"
						: "unknown";
			validateShape(value, { array: sample }, path);
			break;
		}
		case "record": {
			const maxEntries = typeof def.maxEntries === "number" ? Math.min(def.maxEntries, 256) : 256;
			if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > maxEntries)
				throw new Error(`invalid map value for ${path}`);
			if (path === "modelTags") {
				for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
					if (!child || typeof child !== "object" || Array.isArray(child))
						throw new Error(`invalid record value for ${path}.${key}`);
					const tag = child as Record<string, unknown>;
					if (typeof tag.name !== "string") throw new Error(`invalid typed value for ${path}.${key}.name`);
					if (tag.color !== undefined && typeof tag.color !== "string")
						throw new Error(`invalid typed value for ${path}.${key}.color`);
					if (tag.hidden !== undefined && typeof tag.hidden !== "boolean")
						throw new Error(`invalid typed value for ${path}.${key}.hidden`);
				}
			} else {
				let sample: unknown = "unknown";
				if (path === "modelRoles" || path === "task.agentModelOverrides") sample = "string";
				else if (path === "retry.fallbackChains") sample = { array: "string" };
				for (const [key, child] of Object.entries(value as Record<string, unknown>))
					validateShape(child, sample, `${path}.${key}`);
			}
			break;
		}
	}
	if (containsSecretKey(value)) throw new Error(`secret-like keys cannot be written for ${path}`);
	if (safeMetadata(value) === undefined) throw new Error(`value for ${path} is not serializable`);
}
function normalizeProvider(
	provider: CatalogProvider | (() => unknown | Promise<unknown>) | undefined,
): Promise<unknown[]> {
	if (!provider) return Promise.resolve([]);
	try {
		const output = typeof provider === "function" ? provider() : (provider.list?.() ?? provider.metadata?.() ?? []);
		return Promise.resolve(output).then(value => {
			if (Array.isArray(value)) return value;
			if (!value || typeof value !== "object") throw new Error("provider unavailable");
			const record = value as Record<string, unknown>;
			if (Array.isArray(record.skills)) return record.skills;
			if (Array.isArray(record.items)) return record.items;
			throw new Error("provider unavailable");
		});
	} catch {
		return Promise.reject(new Error("provider unavailable"));
	}
}
function itemFromUnknown(
	value: unknown,
	fallbackKind: CatalogItem["kind"],
	fallbackId: string,
): CatalogItem | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const id = pathSafe(text(source.id, 256) ?? text(source.name, 256) ?? text(fallbackId, 256) ?? "item");
	const name = pathSafe(text(source.name, 256) ?? text(source.displayName, 256) ?? id);
	if (!id || !name) return undefined;
	const item: CatalogItem = { id: catalogId(id), kind: fallbackKind, name };
	const description = text(source.description, 4096);
	if (description) item.description = description;
	const capabilities = Array.isArray(source.capabilities)
		? source.capabilities
				.flatMap(capability => [text(capability, 256)])
				.filter((capability): capability is string => capability !== undefined)
				.slice(0, 128)
		: undefined;
	if (capabilities?.length) item.capabilities = capabilities;
	const metadata: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(source)) {
		if (["id", "kind", "name", "displayName", "description", "capabilities"].includes(key)) continue;
		const clean = safeMetadata(child, 1, { nodes: 0 }, key);
		if (clean !== undefined) metadata[text(key, 256) ?? "<redacted-key>"] = clean;
	}
	if (Object.keys(metadata).length) item.metadata = metadata;
	return item;
}
function unsupportedItem(kind: CatalogItem["kind"], id: string, reason: string): CatalogItem {
	const safeId = text(id, 256) ?? "unavailable";
	return {
		id: catalogId(safeId),
		kind,
		name: safeId,
		supported: false,
		reason: text(reason, 4096) ?? "provider unavailable",
	};
}

export class DesktopConfigAuthority {
	readonly #settings: DesktopSettingsPort;
	readonly #hostId: string;
	readonly #platform: string;
	readonly #options: DesktopConfigAuthorityOptions;
	constructor(options: DesktopConfigAuthorityOptions) {
		if (!options?.settings) throw new Error("settings is required");
		this.#settings = options.settings;
		this.#hostId = options.hostId ?? "desktop";
		this.#platform = options.platform ?? process.platform;
		this.#options = options;
	}
	#settingItems(): CatalogItem[] {
		return Object.keys(SETTINGS_SCHEMA)
			.sort()
			.flatMap(path => {
				const def = settingDefinition(path);
				if (!def) return [];
				const ui = def.ui;
				const sensitive = settingSensitive(path);
				const configured = this.#settings.isConfigured?.(path as SettingPath) ?? false;
				const metadata: Record<string, unknown> = {
					path,
					label: text(ui?.label) ?? path,
					description: text(ui?.description),
					...controlMetadata(def),
					default: sensitive ? undefined : safeMetadata(def.default),
					effective: sensitive ? undefined : safeMetadata(this.#settings.get(path as SettingPath)),
					effectiveSource: sourceFor(this.#settings, path as SettingPath),
					configured,
					sensitive,
					scopes: ["global", "session"],
					platform: this.#platform,
					availability: this.#platform === "darwin" || path !== "power.sleepPrevention",
					...(ui?.tab ? { tab: ui.tab } : {}),
					...(ui?.group ? { group: ui.group } : {}),
				};
				return [
					{
						id: catalogId(`setting:${path}`),
						kind: "setting",
						name: path,
						description: text(ui?.description),
						metadata: safeMetadata(metadata) as Record<string, unknown>,
					},
				];
			});
	}
	#revisionData(paths?: readonly string[]): Record<string, unknown> {
		const settings: Record<string, unknown> = {};
		for (const path of [...(paths && paths.length > 0 ? paths : Object.keys(SETTINGS_SCHEMA))].sort()) {
			const def = settingDefinition(path);
			if (!def) continue;
			const sensitive = settingSensitive(path);
			settings[path] = safeMetadata({
				...controlMetadata(def),
				...(sensitive
					? {}
					: {
							default: def.default,
							effective: this.#settings.get(path as SettingPath),
						}),
				effectiveSource: sourceFor(this.#settings, path as SettingPath),
				configured: this.#settings.isConfigured?.(path as SettingPath) ?? false,
				sensitive,
			}) as Record<string, unknown>;
		}
		return { settings };
	}
	#revision(): string {
		return revisionFor(this.#revisionData());
	}
	settingsRead(args: SettingsReadArgs = {}, context?: OperationContextLike): SettingsFrame {
		let paths = args.paths ?? (args.path ? [args.path] : undefined);
		if (paths && paths.length > MAX_PATHS) throw new Error("too many settings paths");
		if (args.category) {
			const category = args.category;
			paths = Object.keys(SETTINGS_SCHEMA).filter(
				path =>
					path === category ||
					path.startsWith(`${category}.`) ||
					settingDefinition(path)?.ui?.tab === category ||
					settingDefinition(path)?.ui?.group === category,
			);
		}
		if (paths)
			for (const path of paths) if (!settingDefinition(path)) throw new Error(`unknown setting path: ${path}`);
		const hostIdVal = context?.hostId ? hostId(context.hostId) : hostId(this.#hostId);
		return {
			v: "omp-app/1",
			type: "settings",
			hostId: hostIdVal,
			revision: this.#revision() as SettingsFrame["revision"],
			settings: this.#revisionData(paths).settings as Record<string, unknown>,
		};
	}
	#validateEdit(edit: SettingsWriteEdit): {
		path: SettingPath;
		scope: "global" | "session";
		reset: boolean;
		def: SettingDefinition;
	} {
		if (!edit || typeof edit.path !== "string") throw new Error("invalid settings edit");
		const path = edit.path;
		const def = settingDefinition(path);
		if (!def) throw new Error(`unknown setting path: ${path}`);
		const scope = edit.scope ?? "global";
		if (scope !== "global" && scope !== "session") throw new Error(`unsupported settings scope: ${scope}`);
		if (settingSensitive(path))
			throw new Error("sensitive setting values cannot be written through desktop authority");
		const reset = edit.reset === true;
		if (!reset) {
			const controlType = edit.controlType ?? edit.type;
			if (controlType !== undefined && controlType !== def.type)
				throw new Error(`setting type mismatch for ${path}`);
			if (edit.value === undefined) throw new Error(`value is required for ${path}`);
			validateValue(def, edit.value, path);
		}
		return { path: path as SettingPath, scope, reset, def };
	}
	#applyEdit(
		edit: SettingsWriteEdit,
		normalized: { path: SettingPath; scope: "global" | "session"; reset: boolean },
	): void {
		if (normalized.reset) {
			if (normalized.scope === "session") {
				if (!this.#settings.clearOverride) throw new Error("session reset unavailable");
				this.#settings.clearOverride(normalized.path);
			} else this.#settings.clearGlobal(normalized.path);
			return;
		}
		if (normalized.scope === "session") {
			if (!this.#settings.override) throw new Error("session overrides unavailable");
			this.#settings.override(normalized.path, edit.value);
		} else this.#settings.set(normalized.path, edit.value);
	}
	#restartRequired(def: SettingDefinition): boolean {
		if (typeof def.restartRequired === "boolean") return def.restartRequired;
		if (def.ui && typeof def.ui.restartRequired === "boolean") return def.ui.restartRequired;
		return false;
	}
	#mutationQueue: Promise<void> = Promise.resolve();
	settingsWrite(args: SettingsWriteArgs, context?: string | OperationContextLike): Promise<Record<string, unknown>> {
		const task = this.#mutationQueue.then(() => this.#settingsWriteNow(args, context));
		this.#mutationQueue = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}
	async #settingsWriteNow(
		args: SettingsWriteArgs,
		context?: string | OperationContextLike,
	): Promise<Record<string, unknown>> {
		const wanted = (typeof context === "string" ? context : context?.expectedRevision) ?? args.expectedRevision;
		const edits = args.edits ?? [
			{
				path: args.path ?? "",
				value: args.value,
				scope: args.scope,
				reset: args.reset,
				controlType: args.controlType,
				type: args.type,
			},
		];
		if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX_PATHS)
			throw new Error("invalid settings edits");
		if (wanted !== undefined && wanted !== this.#revision()) throw new Error("settings revision conflict");
		const normalized = edits.map(edit => this.#validateEdit(edit));
		const snapshots = new Map<SettingPath, SettingsDesktopSnapshot>();
		for (const edit of normalized)
			if (!snapshots.has(edit.path)) snapshots.set(edit.path, this.#settings.getDesktopSnapshot(edit.path));
		const results: Record<string, unknown>[] = [];
		try {
			for (const [index, edit] of edits.entries()) {
				const item = normalized[index];
				this.#applyEdit(edit, item);
				results.push({
					path: item.path,
					scope: item.scope,
					reset: item.reset,
					restartRequired: this.#restartRequired(item.def),
				});
			}
			await this.#settings.flush?.();
		} catch {
			for (const snapshot of snapshots.values()) {
				try {
					this.#settings.restoreDesktopSnapshot(snapshot);
				} catch {
					/* continue restoring every target */
				}
			}
			try {
				await this.#settings.flush?.();
			} catch {
				/* rollback persistence is best effort */
			}
			throw new Error("settings write failed");
		}
		return {
			accepted: true,
			edits: results,
			path: results.length === 1 ? results[0].path : undefined,
			scope: results.length === 1 ? results[0].scope : undefined,
			reset: results.length === 1 ? results[0].reset : undefined,
			revision: this.#revision(),
			restartRequired: results.some(result => result.restartRequired === true),
		};
	}
	async #catalogRaw(): Promise<CatalogItem[]> {
		const items = this.#settingItems();
		for (const name of Object.keys({ ...BUILTIN_TOOLS, ...HIDDEN_TOOLS }).sort())
			items.push({ id: catalogId(`tool:${name}`), kind: "tool", name, metadata: { builtin: true } });
		for (const command of BUILTIN_SLASH_COMMAND_DEFS)
			items.push({
				id: catalogId(`command:/${command.name}`),
				kind: "command",
				name: `/${command.name}`,
				description: text(command.description),
				metadata: safeMetadata({
					aliases: command.aliases,
					subcommands: command.subcommands,
					inlineHint: command.inlineHint,
				}) as Record<string, unknown>,
			});
		for (const name of DESKTOP_CATALOG_COMMANDS) {
			const descriptor = COMMAND_DESCRIPTORS[name];
			items.push({
				id: catalogId(`command:${name}`),
				kind: "command",
				name,
				capabilities: [descriptor.capability],
				supported: true,
			});
		}

		const modelRegistry = this.#options.modelRegistry;
		let models: unknown[] = [];
		try {
			models = modelRegistry?.getAvailable?.() ?? [];
		} catch {
			/* fail soft below */
		}
		if (!modelRegistry || models.length === 0)
			items.push(
				unsupportedItem("model", "availability:models", "model registry unavailable or no available models"),
			);
		const modelProviders = new Set<string>();
		for (const [index, model] of models.entries()) {
			if (!model || typeof model !== "object" || Array.isArray(model)) {
				items.push(unsupportedItem("model", `availability:model:${index}`, "malformed model metadata"));
				continue;
			}
			const raw = model as Record<string, unknown>;
			const provider = pathSafe(text(raw.provider, 256) ?? "unknown");
			const id = pathSafe(text(raw.id, 256) ?? text(raw.name, 256) ?? `model-${index}`);
			const name = pathSafe(text(raw.name, 256) ?? id);
			modelProviders.add(provider);
			items.push({
				id: catalogId(`model:${provider}/${id}`),
				kind: "model",
				name,
				description: text(raw.description, 4096),
				metadata: safeMetadata({
					provider,
					modelId: id,
					contextWindow: raw.contextWindow,
					capabilities: raw.capabilities,
				}) as Record<string, unknown>,
			});
		}
		for (const provider of [...modelProviders].sort())
			items.push({ id: catalogId(`provider:${provider}`), kind: "provider", name: provider });

		const agentRegistry = this.#options.agentRegistry;
		let rawAgents: unknown[] = [];
		let agentRegistryError = false;
		if (agentRegistry) {
			try {
				rawAgents = agentRegistry.list();
				if (!Array.isArray(rawAgents)) {
					rawAgents = [];
					agentRegistryError = true;
				}
			} catch {
				agentRegistryError = true;
			}
		} else {
			try {
				rawAgents = loadBundledAgents();
			} catch {
				agentRegistryError = true;
			}
		}

		if (agentRegistryError) {
			items.push(unsupportedItem("agent", "availability:agents", "agent registry unavailable"));
		} else {
			const disabledAgents = this.#settings.get("task.disabledAgents" as SettingPath);
			const disabledAgentsArray = Array.isArray(disabledAgents) ? disabledAgents : [];
			const agentModelOverrides = this.#settings.get("task.agentModelOverrides" as SettingPath);
			const overridesRecord =
				agentModelOverrides && typeof agentModelOverrides === "object"
					? (agentModelOverrides as Record<string, unknown>)
					: {};

			const agentItems: CatalogItem[] = [];
			for (const [index, agent] of rawAgents.entries()) {
				if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
					agentItems.push(unsupportedItem("agent", `availability:agent:${index}`, "malformed agent metadata"));
					continue;
				}
				const a = agent as Record<string, unknown>;
				const agentId = pathSafe(text(a.id, 256) ?? text(a.name, 256) ?? `agent-${index}`);
				const agentName = pathSafe(text(a.name, 256) ?? text(a.displayName, 256) ?? agentId);
				if (!agentId || !agentName) {
					agentItems.push(unsupportedItem("agent", `availability:agent:${index}`, "malformed agent metadata"));
					continue;
				}

				const agentDescription = text(a.description, 4096);
				const enabled =
					!disabledAgentsArray.includes(agentName) && !(a.name && disabledAgentsArray.includes(String(a.name)));

				const rawOverride =
					overridesRecord[agentName] ?? (a.name && overridesRecord[String(a.name)]) ?? overridesRecord[agentId];
				const overrideChain =
					typeof rawOverride === "string"
						? rawOverride
								.split(",")
								.map(s => s.trim())
								.filter(Boolean)
						: Array.isArray(rawOverride)
							? rawOverride.map(s => String(s).trim()).filter(Boolean)
							: [];

				const metadata: Record<string, unknown> = {
					enabled,
					overrides: overrideChain,
				};

				agentItems.push({
					id: catalogId(`agent:${agentId}`),
					kind: "agent",
					name: agentName,
					...(agentDescription ? { description: agentDescription } : {}),
					metadata: safeMetadata(metadata) as Record<string, unknown>,
				});
			}

			agentItems.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
			items.push(...agentItems);
		}

		const skillsProvider = this.#options.skillsLoader ?? this.#options.skillsProvider ?? this.#options.skills;
		const pluginProvider = this.#options.pluginManager ?? this.#options.pluginProvider ?? this.#options.plugins;
		let mcpProvider: CatalogProvider | (() => unknown | Promise<unknown>) | undefined =
			this.#options.mcpProvider ?? this.#options.mcp;
		if (this.#options.mcpManager) {
			mcpProvider = () => {
				const all = this.#options.mcpManager!.getAllServerNames();
				const connected = new Set(this.#options.mcpManager!.getConnectedServers());
				return all.map(name => ({ id: name, name, connected: connected.has(name) }));
			};
		}
		const providers: Array<{
			kind: CatalogItem["kind"];
			label: string;
			provider?: CatalogProvider | (() => unknown | Promise<unknown>);
		}> = [
			{ kind: "skill", label: "skills", provider: skillsProvider },
			{ kind: "provider", label: "plugins", provider: pluginProvider },
			{ kind: "provider", label: "mcp", provider: mcpProvider },
		];
		for (const { kind, label, provider } of providers) {
			if (!provider) {
				items.push(unsupportedItem(kind, `availability:${label}`, `${label} provider unavailable`));
				continue;
			}
			let values: unknown[];
			try {
				values = await normalizeProvider(provider);
			} catch {
				items.push(unsupportedItem(kind, `availability:${label}`, `${label} provider unavailable`));
				continue;
			}
			for (const [index, value] of values.entries()) {
				const item = itemFromUnknown(value, kind, `${label}:${index}`);
				items.push(item ?? unsupportedItem(kind, `availability:${label}:${index}`, `malformed ${label} metadata`));
			}
		}
		// Reuse the canonical role helpers through their narrow runtime settings surface.
		const settingsAdapter = {
			get: (path: string) => {
				const val = this.#settings.get(path as SettingPath);
				if (path === "cycleOrder") {
					return Array.isArray(val) ? val : [];
				}
				if (path === "modelTags") {
					return val && typeof val === "object" ? val : {};
				}
				return val;
			},
			getModelRoles: () => {
				const roles = this.#settings.get("modelRoles" as SettingPath);
				if (roles && typeof roles === "object" && !Array.isArray(roles)) {
					const normalized: Record<string, string> = {};
					for (const [r, v] of Object.entries(roles)) {
						let modelId: string | undefined;
						if (typeof v === "string") {
							modelId = v;
						} else if (Array.isArray(v)) {
							const arr = v.filter(x => typeof x === "string");
							if (arr.length === v.length) {
								modelId = arr.join(",");
							}
						}
						if (modelId !== undefined) {
							normalized[r] = modelId;
						}
					}
					return normalized;
				}
				return {};
			},
		} as unknown as import("../../config/settings.ts").Settings;

		const knownRoleIds = getKnownRoleIds(settingsAdapter);
		const cycleOrder = this.#settings.get("cycleOrder" as SettingPath);
		const cycleOrderArray = Array.isArray(cycleOrder) ? cycleOrder : [];
		const modelRoles = settingsAdapter.getModelRoles();

		for (const role of knownRoleIds) {
			const roleInfo = getRoleInfo(role, settingsAdapter);
			const modelId = modelRoles[role];
			const cycleIndex = cycleOrderArray.indexOf(role);
			const cycle = cycleIndex !== -1;

			const metadata: Record<string, unknown> = {
				role: text(role, 256) ?? role,
				...(roleInfo.tag ? { tag: text(roleInfo.tag, 256) } : {}),
				...(modelId ? { modelId: pathSafe(modelId) } : {}),
				cycle,
				...(cycle ? { cycleIndex } : {}),
			};
			items.push({
				id: catalogId(`mode:role:${role}`),
				kind: "mode",
				name: text(role, 256) ?? "role",
				description: text(roleInfo.name, 256),
				metadata: safeMetadata(metadata) as Record<string, unknown>,
			});
		}
		return items;
	}
	async catalogGet(args: CatalogGetArgs = {}, context?: OperationContextLike): Promise<CatalogFrame> {
		const deduped = new Map<string, CatalogItem>();
		for (const item of await this.#catalogRaw()) {
			if (!CATALOG_KINDS.has(item.kind) || deduped.has(item.id)) continue;
			const clean = safeMetadata(item) as Record<string, unknown>;
			if (typeof clean.id === "string" && typeof clean.name === "string")
				deduped.set(item.id, clean as unknown as CatalogItem);
		}
		const needle = (args.search ?? args.query)?.toLowerCase();
		let items = [...deduped.values()];
		if (args.kind) items = items.filter(item => item.kind === args.kind);
		if (needle)
			items = items.filter(item =>
				`${item.name} ${item.description ?? ""} ${item.id}`.toLowerCase().includes(needle),
			);
		items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
		const hostIdVal = context?.hostId ? hostId(context.hostId) : hostId(this.#hostId);
		const frame = decodeCatalog({
			v: "omp-app/1",
			type: "catalog",
			hostId: hostIdVal,
			revision: this.#revision(),
			items: items.slice(0, MAX_ITEMS),
		});
		if (frame.type !== "catalog") throw new Error("catalog decoder returned settings frame");
		return frame;
	}
	async configWrite(_args: unknown): Promise<never> {
		throw new Error("config.write is unsupported; use validated settings.write");
	}
}
export function createDesktopConfigAuthority(options: DesktopConfigAuthorityOptions): DesktopConfigAuthority {
	return new DesktopConfigAuthority(options);
}
