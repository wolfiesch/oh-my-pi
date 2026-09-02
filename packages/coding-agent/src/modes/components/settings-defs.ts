/**
 * UI adapter over the schema. Reads `ui.options` declared inline in
 * settings-schema.ts and produces typed widget definitions for the
 * settings selector.
 *
 * To add a new setting to the UI: declare it in `settings-schema.ts`
 * with a `ui` block carrying `tab` and `group` (the group must be listed
 * in `TAB_GROUPS[tab]`). If it needs a submenu, include `options: [...]`
 * (or `options: "runtime"` for runtime-injected lists like themes).
 */

import { TERMINAL } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import {
	type AnyUiMetadata,
	getDefault,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	isCredential,
	SETTING_TABS,
	type SettingPath,
	type SettingTab,
	type SubmenuOption,
	TAB_GROUPS,
} from "../../config/settings-schema";

// ═══════════════════════════════════════════════════════════════════════════
// UI Definition Types
// ═══════════════════════════════════════════════════════════════════════════

export type SettingValue = boolean | string;

interface BaseSettingDef {
	path: SettingPath;
	label: string;
	description: string;
	/** Risk note shown in warning styling; set for settings that can get the user flagged or banned. */
	warning?: string;
	tab: SettingTab;
	/** Section within the tab; items are ordered by TAB_GROUPS[tab] and rendered under a heading row. */
	group?: string;
	/**
	 * Optional visibility predicate. When supplied and returning false, the
	 * setting is hidden from the UI. Applies to every variant — booleans,
	 * enums, submenus, and text inputs.
	 */
	condition?: () => boolean;
}

export interface BooleanSettingDef extends BaseSettingDef {
	type: "boolean";
}

export interface EnumSettingDef extends BaseSettingDef {
	type: "enum";
	values: readonly string[];
}

type OptionList = ReadonlyArray<SubmenuOption>;

export interface SubmenuSettingDef extends BaseSettingDef {
	type: "submenu";
	options: OptionList;
	onPreview?: (value: string) => void;
	onPreviewCancel?: (originalValue: string) => void;
}

export interface TextInputSettingDef extends BaseSettingDef {
	type: "text";
	secret: boolean;
}

export interface ProviderLimitsSettingDef extends BaseSettingDef {
	type: "providerLimits";
}

/** Array-of-enum setting edited as a toggle list; `ordered` lists render positions and support reordering. */
export interface MultiSelectSettingDef extends BaseSettingDef {
	type: "multiselect";
	options: OptionList;
	ordered: boolean;
}

export type SettingDef =
	| BooleanSettingDef
	| EnumSettingDef
	| SubmenuSettingDef
	| TextInputSettingDef
	| ProviderLimitsSettingDef
	| MultiSelectSettingDef;

// ═══════════════════════════════════════════════════════════════════════════
// Condition Functions
// ═══════════════════════════════════════════════════════════════════════════

const CONDITIONS: Record<string, (settings?: Settings) => boolean> = {
	macOS: () => process.platform === "darwin",
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	advisorEnabled: settings => {
		try {
			return (settings ?? Settings.instance).get("advisor.enabled") === true;
		} catch {
			return false;
		}
	},
	hindsightActive: settings => {
		try {
			return (settings ?? Settings.instance).get("memory.backend") === "hindsight";
		} catch {
			return false;
		}
	},
	mnemopiActive: settings => {
		try {
			return (settings ?? Settings.instance).get("memory.backend") === "mnemopi";
		} catch {
			return false;
		}
	},
	autolearnActive: settings => {
		try {
			return (settings ?? Settings.instance).get("autolearn.enabled") === true;
		} catch {
			return false;
		}
	},
	autoThinkingActive: settings => {
		try {
			return (settings ?? Settings.instance).get("defaultThinkingLevel") === "auto";
		} catch {
			return false;
		}
	},
	usageAwareFallbackEnabled: settings => {
		try {
			return (settings ?? Settings.instance).get("retry.usageAwareFallback") === true;
		} catch {
			return false;
		}
	},
	planModeEnabled: settings => {
		try {
			return (settings ?? Settings.instance).get("plan.enabled");
		} catch {
			return false;
		}
	},
	unexpectedStopSmart: () => {
		try {
			return Settings.instance.get("features.unexpectedStopDetection") === "smart";
		} catch {
			return false;
		}
	},
};

/**
 * Settings read by visibility predicates. External serializers use this map
 * to refuse evaluation when a predicate would reveal a setting they cannot
 * otherwise disclose; the built-in panel remains unrestricted.
 */
const CONDITION_SETTING_DEPENDENCIES: Record<string, readonly SettingPath[]> = {
	hasImageProtocol: [],
	advisorEnabled: ["advisor.enabled"],
	hindsightActive: ["memory.backend"],
	mnemopiActive: ["memory.backend"],
	autolearnActive: ["autolearn.enabled"],
	autoThinkingActive: ["defaultThinkingLevel"],
	usageAwareFallbackEnabled: ["retry.usageAwareFallback"],
	planModeEnabled: ["plan.enabled"],
};

export type SettingPanelControlKind = SettingDef["type"];

/** The exact control kind used by the built-in settings panel, or `null` when config-only. */
export function getSettingPanelControlKind(path: SettingPath): SettingPanelControlKind | null {
	const ui = getUi(path);
	if (!ui) return null;
	switch (getType(path)) {
		case "boolean":
			return "boolean";
		case "enum":
			return ui.options === undefined ? "enum" : "submenu";
		case "number":
			return Array.isArray(ui.options) ? "submenu" : null;
		case "string":
			return ui.options === undefined ? "text" : "submenu";
		case "array":
			return Array.isArray(ui.options) ? "multiselect" : null;
		case "record":
			return path === "providers.maxInFlightRequests" ? "providerLimits" : "text";
	}
	return null;
}

/** Whether the built-in settings panel has a control for this schema entry. */
export function isSettingPanelRenderable(path: SettingPath): boolean {
	return getSettingPanelControlKind(path) !== null;
}

/** Evaluate visibility for an external serializer without crossing its disclosure boundary. */
export function getSettingPanelVisibility(
	path: SettingPath,
	settings: Settings,
	canReadSetting: (dependency: SettingPath) => boolean,
): boolean | undefined {
	const conditionName = getUi(path)?.condition;
	if (conditionName === undefined) return true;
	const condition = CONDITIONS[conditionName];
	if (!condition) return undefined;
	// A newly registered state-reading predicate is indeterminate for
	// serialization until its dependencies are explicitly classified above.
	if (!Object.hasOwn(CONDITION_SETTING_DEPENDENCIES, conditionName)) return undefined;
	if (CONDITION_SETTING_DEPENDENCIES[conditionName].some(dependency => !canReadSetting(dependency))) return undefined;
	return condition(settings);
}

/** Evaluate the same visibility condition used by the built-in settings panel. */
export function isSettingPanelVisible(path: SettingPath, settings?: Settings): boolean {
	const conditionName = getUi(path)?.condition;
	if (conditionName === undefined) return true;
	const condition = CONDITIONS[conditionName];
	// Preserve the panel's established behavior for an unknown condition name:
	// without a registered predicate, the setting remains unconditionally visible.
	return condition ? condition(settings) : true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Schema to UI Conversion
// ═══════════════════════════════════════════════════════════════════════════

function resolveOptions(ui: AnyUiMetadata): OptionList | "runtime" | undefined {
	if (!ui.options) return undefined;
	if (ui.options === "runtime") return "runtime";
	return ui.options;
}

function pathToSettingDef(path: SettingPath): SettingDef | null {
	const ui = getUi(path);
	const control = getSettingPanelControlKind(path);
	if (!ui || control === null) return null;

	const visibilityCondition = ui.condition ? CONDITIONS[ui.condition] : undefined;
	const condition = visibilityCondition ? () => visibilityCondition() : undefined;
	const base = {
		path,
		label: ui.label,
		description: ui.description,
		warning: ui.warning,
		tab: ui.tab,
		group: ui.group,
		condition,
	};

	switch (control) {
		case "boolean":
			return { ...base, type: "boolean" };
		case "enum":
			return { ...base, type: "enum", values: getEnumValues(path) ?? [] };
		case "submenu": {
			const options = resolveOptions(ui);
			return { ...base, type: "submenu", options: !options || options === "runtime" ? [] : options };
		}
		case "text":
			return { ...base, type: "text", secret: isCredential(path) };
		case "providerLimits":
			return { ...base, type: "providerLimits" };
		case "multiselect": {
			const options = resolveOptions(ui);
			return {
				...base,
				type: "multiselect",
				options: !options || options === "runtime" ? [] : options,
				ordered: ui.ordered === true,
			};
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/** Cache of generated definitions */
let cachedDefs: SettingDef[] | null = null;

/** Get all setting definitions with UI */
export function getAllSettingDefs(): SettingDef[] {
	if (cachedDefs) return cachedDefs;

	const defs: SettingDef[] = [];
	for (const tab of SETTING_TABS) {
		for (const path of getPathsForTab(tab)) {
			const def = pathToSettingDef(path);
			if (def) defs.push(def);
		}
	}
	cachedDefs = defs;
	return defs;
}

/**
 * Get settings for a specific tab, ordered by the tab's group layout
 * (TAB_GROUPS). Ungrouped settings sort first; within a group, schema
 * declaration order is preserved.
 */
export function getSettingsForTab(tab: SettingTab): SettingDef[] {
	const defs = getAllSettingDefs().filter(def => def.tab === tab);
	const order = TAB_GROUPS[tab];
	const rank = (def: SettingDef): number => {
		if (!def.group) return -1;
		const index = order.indexOf(def.group);
		return index >= 0 ? index : order.length;
	};
	return defs.sort((a, b) => rank(a) - rank(b));
}

/** Get a setting definition by path */
export function getSettingDef(path: SettingPath): SettingDef | undefined {
	return getAllSettingDefs().find(def => def.path === path);
}

/** Get default value for display */
export function getDisplayDefault(path: SettingPath): string {
	const value = getDefault(path);
	if (value === undefined) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	return String(value);
}
