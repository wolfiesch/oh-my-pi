import { describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import {
	getUi,
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	TAB_GROUPS,
	TAB_METADATA,
} from "../src/config/settings-schema";
import { buildSettingsSnapshot, isSettingTab } from "../src/config/settings-snapshot";
import { isSettingPanelVisible } from "../src/modes/components/settings-defs";

const paths = Object.keys(SETTINGS_SCHEMA) as SettingPath[];

/**
 * Names that read like credentials. Used ONLY to assert the boundary held; the
 * boundary itself is the explicit `rpcReadable` allowlist, never this pattern.
 */
const CREDENTIAL_NAME = /token|apikey|api_key|password|passwd|credential|bearer/i;
const NOT_CREDENTIALS: Record<string, true> = {
	"display.showTokenUsage": true,
	"compaction.thresholdTokens": true,
	"compaction.reserveTokens": true,
	"compaction.keepRecentTokens": true,
	"compaction.idleThresholdTokens": true,
	"branchSummary.reserveTokens": true,
	"memories.phase1InputTokenLimit": true,
	"memories.fallbackTokenLimit": true,
	"memories.summaryInjectionTokenLimit": true,
	"mnemopi.injectionTokenLimit": true,
	"hindsight.recallMaxTokens": true,
	"commit.mapReduceMaxFileTokens": true,
};

describe("settings snapshot", () => {
	it("describes every setting and withholds values by default", () => {
		const snapshot = buildSettingsSnapshot(Settings.isolated());
		expect(snapshot.settings).toHaveLength(paths.length);
		const disclosed = snapshot.settings.filter(entry => "value" in entry);
		const redacted = snapshot.settings.filter(entry => entry.redacted === true);
		expect(disclosed.length + redacted.length).toBe(paths.length);
		// Deny-by-default: the allowlist is a small, deliberate minority.
		expect(disclosed.length).toBeLessThan(paths.length / 2);
		for (const entry of redacted) expect(entry).not.toHaveProperty("value");
	});

	it("never discloses a credential-shaped value", () => {
		const snapshot = buildSettingsSnapshot(Settings.isolated());
		const leaked = snapshot.settings.filter(
			entry => "value" in entry && CREDENTIAL_NAME.test(entry.path) && NOT_CREDENTIALS[entry.path] !== true,
		);
		expect(leaked.map(entry => entry.path)).toEqual([]);
	});

	it("never discloses a secret-marked value", () => {
		const snapshot = buildSettingsSnapshot(Settings.isolated());
		for (const entry of snapshot.settings) {
			if (getUi(entry.path as SettingPath)?.secret !== true) continue;
			expect(entry).not.toHaveProperty("value");
			expect(entry.redacted).toBe(true);
		}
		const canonicalCredential = snapshot.settings.find(entry => entry.path === "mnemopi.embeddingApiKey");
		expect(canonicalCredential?.ui?.secret).toBe(true);
	});

	it("emits the exact non-secret wire shape for a configured setting", () => {
		const settings = Settings.isolated({ colorBlindMode: true });
		const entry = buildSettingsSnapshot(settings).settings.find(item => item.path === "colorBlindMode");
		expect(entry).toEqual({
			path: "colorBlindMode",
			type: "boolean",
			default: false,
			value: true,
			configured: true,
			ui: {
				tab: "appearance",
				group: "Theme",
				label: "Color-Blind Mode",
				description: "Use blue instead of green for diff additions",
				renderable: true,
				control: "boolean",
				visible: true,
			},
		});
	});

	it("carries schema metadata for redacted settings but no user state", () => {
		// A configured credential must reveal neither its value nor its existence.
		const settings = Settings.isolated({ "auth.broker.token": "super-secret-broker-token" });
		const entry = buildSettingsSnapshot(settings).settings.find(item => item.path === "auth.broker.token");
		// Metadata is public repository content; the value and its presence are not.
		expect(entry?.type).toBe("string");
		expect(entry?.redacted).toBe(true);
		expect(entry).not.toHaveProperty("value");
		expect(entry).not.toHaveProperty("configured");
		expect(JSON.stringify(entry)).not.toContain("super-secret-broker-token");
	});

	it("keeps the credential veto when a credential is also allowlisted", () => {
		const definition = SETTINGS_SCHEMA["auth.broker.token"] as (typeof SETTINGS_SCHEMA)["auth.broker.token"] & {
			rpcReadable?: true;
		};
		definition.rpcReadable = true;
		try {
			const settings = Settings.isolated({ "auth.broker.token": "credential-must-stay-redacted" });
			const entry = buildSettingsSnapshot(settings).settings.find(item => item.path === "auth.broker.token");
			expect(entry?.redacted).toBe(true);
			expect(entry).not.toHaveProperty("value");
			expect(entry).not.toHaveProperty("configured");
			expect(JSON.stringify(entry)).not.toContain("credential-must-stay-redacted");
		} finally {
			delete definition.rpcReadable;
		}
	});

	it("omits configured status from every redacted entry", () => {
		for (const entry of buildSettingsSnapshot(Settings.isolated()).settings) {
			if (entry.redacted !== true) continue;
			expect(entry).not.toHaveProperty("configured");
		}
	});

	it("omits default when a setting has none, so the wire has one shape", () => {
		const snapshot = buildSettingsSnapshot(Settings.isolated());
		const withoutDefault = snapshot.settings.find(entry => entry.path === "auth.broker.token");
		expect(withoutDefault).not.toHaveProperty("default");
		const withDefault = snapshot.settings.find(entry => entry.path === "colorBlindMode");
		expect(withDefault?.default).toBe(false);
		// JSON must not silently drop a declared field: what survives a round
		// trip is exactly what the type promises.
		for (const entry of snapshot.settings) {
			const roundTripped = JSON.parse(JSON.stringify(entry));
			expect(Object.keys(roundTripped).sort()).toEqual(Object.keys(entry).sort());
		}
	});

	it("discloses exactly the reviewed set and nothing else", () => {
		// Read off the built snapshot, not off `isRpcReadable`: deriving the
		// expectation from the same helper the code uses would pass no matter what
		// the endpoint actually emits.
		//
		// The list is exact on purpose. Annotating one more setting widens
		// disclosure, and a category check ("appearance booleans and enums") would
		// still pass while it happened. Widening this set must be a deliberate
		// edit here.
		const disclosed = buildSettingsSnapshot(Settings.isolated())
			.settings.filter(entry => entry.redacted !== true)
			.map(entry => entry.path)
			.sort();
		expect(disclosed).toEqual([
			"colorBlindMode",
			"display.cacheMissMarker",
			"display.collapseCompacted",
			"display.shimmer",
			"display.showTokenUsage",
			"display.smoothStreaming",
			"images.autoResize",
			"images.blockImages",
			"showHardwareCursor",
			"statusLine.compactThinkingLevel",
			"statusLine.preset",
			"statusLine.separator",
			"statusLine.sessionAccent",
			"statusLine.showHookStatus",
			"statusLine.transparent",
			"symbolPreset",
			"task.showResolvedModelBadge",
			"terminal.showImages",
			"terminal.showProgress",
			"tui.hyperlinks",
			"tui.imeSafeCursor",
			"tui.renderMermaid",
			"tui.scrollbackRebuild",
			"tui.textSizing",
			"tui.tight",
			"tui.titleState",
		]);
	});

	it("keeps every disclosed setting inside its reviewed shape", () => {
		// Settings the panel already shows, whose values are a bool or one of a
		// fixed enum, so none can carry a path, a URL or a credential.
		for (const entry of buildSettingsSnapshot(Settings.isolated()).settings) {
			if (entry.redacted === true) continue;
			expect(entry.ui).toBeDefined();
			expect(entry.ui?.tab).toBe("appearance");
			expect(entry.ui?.secret).not.toBe(true);
			expect(["boolean", "enum"]).toContain(entry.type);
		}
	});

	it("preserves the rendering metadata a client would otherwise duplicate", () => {
		const byPath = new Map(buildSettingsSnapshot(Settings.isolated()).settings.map(e => [e.path, e]));
		// Static choices, including their labels.
		expect(byPath.get("symbolPreset")?.ui?.options).toEqual(getUi("symbolPreset")?.options);
		expect(byPath.get("symbolPreset")?.ui).not.toHaveProperty("secret");
		// A runtime-populated submenu must stay distinguishable from "no choices".
		expect(byPath.get("theme.dark")).toEqual({
			path: "theme.dark",
			type: "string",
			default: "titanium",
			redacted: true,
			ui: {
				tab: "appearance",
				group: "Theme",
				label: "Dark Theme",
				description: "Theme used when the terminal has a dark background",
				renderable: true,
				control: "submenu",
				visible: true,
				options: "runtime",
			},
		});
		// Ordered selection semantics.
		expect(byPath.get("providers.webSearchOrder")?.ui?.ordered).toBe(true);
		// Choices narrowed by undisclosed runtime state must not masquerade as
		// an authoritative static list.
		expect(byPath.get("providers.webSearchOrder")?.ui?.options).toBe("runtime");
		expect(byPath.get("defaultThinkingLevel")?.ui?.options).toBe("runtime");
		expect(byPath.get("providers.webSearchExclude")?.ui?.options).toEqual(
			getUi("providers.webSearchExclude")?.options,
		);
		// A config-only setting keeps its top-level prose.
		expect(byPath.get("tui.maxInlineImageColumns")?.description).toContain("inline images");
	});

	it("uses the panel's canonical number and array renderability", () => {
		const entries = buildSettingsSnapshot(Settings.isolated()).settings;
		const threshold = entries.find(entry => entry.path === "model.toolCallLoopGuard.threshold");
		const exemptTools = entries.find(entry => entry.path === "model.toolCallLoopGuard.exemptTools");
		const immuneTurns = entries.find(entry => entry.path === "advisor.immuneTurns");
		const webSearchOrder = entries.find(entry => entry.path === "providers.webSearchOrder");
		expect(threshold?.ui).toEqual({
			tab: "model",
			group: "Thinking",
			label: "Tool-Call Loop Threshold",
			description: "Consecutive identical tool calls required before the corrective steer is injected",
			renderable: false,
			control: null,
			visible: false,
		});
		expect(exemptTools?.ui).toEqual({
			tab: "model",
			group: "Thinking",
			label: "Tool-Call Loop Exempt Tools",
			description: "Tool names that may repeat consecutively without triggering the cross-turn loop guard",
			renderable: false,
			control: null,
			visible: false,
		});
		expect(immuneTurns?.ui?.renderable).toBe(true);
		expect(webSearchOrder?.ui?.renderable).toBe(true);
		expect(entries.find(entry => entry.path === "providers.maxInFlightRequests")?.ui?.control).toBe("providerLimits");
		expect(entries.find(entry => entry.path === "retry.fallbackChains")?.ui?.control).toBe("text");
	});

	it("omits mnemopi visibility when it depends on a redacted setting", () => {
		const inactiveSettings = Settings.isolated();
		const activeSettings = Settings.isolated({ "memory.backend": "mnemopi" });
		const inactive = buildSettingsSnapshot(inactiveSettings).settings.find(entry => entry.path === "mnemopi.dbPath");
		const active = buildSettingsSnapshot(activeSettings).settings.find(entry => entry.path === "mnemopi.dbPath");
		const expected = {
			path: "mnemopi.dbPath",
			type: "string",
			redacted: true,
			ui: {
				tab: "memory",
				group: "Mnemopi",
				label: "Mnemopi DB Path",
				description: "Optional SQLite DB path. Defaults to the agent memories directory.",
				renderable: true,
				control: "text",
				// Visibility is indeterminate without disclosing memory.backend.
			},
		} as const;
		expect(inactive).toEqual(expected);
		expect(active).toEqual(expected);

		// The disclosure policy applies only to serialization. The ordinary
		// settings panel still evaluates the same condition against live state.
		expect(isSettingPanelVisible("mnemopi.dbPath", inactiveSettings)).toBe(false);
		expect(isSettingPanelVisible("mnemopi.dbPath", activeSettings)).toBe(true);
	});

	it("omits visibility for an unregistered RPC condition without changing panel behavior", () => {
		const settings = Settings.isolated();
		expect(getUi("providers.unexpectedStopModel")?.condition).toBe("unexpectedStopDetection");
		const entry = buildSettingsSnapshot(settings).settings.find(
			item => item.path === "providers.unexpectedStopModel",
		);
		expect(entry?.ui).not.toHaveProperty("visible");
		expect(isSettingPanelVisible("providers.unexpectedStopModel", settings)).toBe(true);
	});

	it("does not let redacted visibility dependencies change the RPC snapshot", () => {
		const baseline = buildSettingsSnapshot(Settings.isolated());
		const variants = [
			Settings.isolated({ "advisor.enabled": true }),
			Settings.isolated({ "memory.backend": "hindsight" }),
			Settings.isolated({ "memory.backend": "mnemopi" }),
			Settings.isolated({ "autolearn.enabled": true }),
			Settings.isolated({ defaultThinkingLevel: "auto" }),
			Settings.isolated({ "retry.usageAwareFallback": true }),
			Settings.isolated({ "plan.enabled": false }),
		];
		for (const settings of variants) expect(buildSettingsSnapshot(settings)).toEqual(baseline);
	});

	it("preserves canonical tab and section ordering", () => {
		const snapshot = buildSettingsSnapshot(Settings.isolated());
		expect(snapshot.tabs.map(tab => tab.id)).toEqual(SETTING_TABS);
		for (const tab of snapshot.tabs) {
			expect(tab).toEqual({
				id: tab.id,
				...TAB_METADATA[tab.id],
				groups: TAB_GROUPS[tab.id],
			});
		}
		expect(snapshot.tabs.find(tab => tab.id === "appearance")?.groups).toEqual([
			"Theme",
			"Status Line",
			"Display",
			"Images",
		]);
	});

	it("scopes to a tab and exposes enum choices", () => {
		const snapshot = buildSettingsSnapshot(Settings.isolated(), "appearance");
		expect(snapshot.tabs).toEqual([{ id: "appearance", ...TAB_METADATA.appearance, groups: TAB_GROUPS.appearance }]);
		expect(snapshot.settings.length).toBeGreaterThan(0);
		for (const entry of snapshot.settings) expect(entry.ui?.tab).toBe("appearance");
		const preset = snapshot.settings.find(entry => entry.path === "symbolPreset");
		expect(preset?.values?.length).toBeGreaterThan(0);
		expect(preset).toHaveProperty("value");
	});
});

describe("settings tab guard", () => {
	it("accepts every real tab", () => {
		for (const tab of SETTING_TABS) expect(isSettingTab(tab)).toBe(true);
	});

	it("rejects anything an RPC frame could actually carry", () => {
		// Frames are cast from parsed JSON, so the guard must survive non-strings
		// as well as typos; the handler turns a false here into `invalid_tab`.
		for (const value of ["appearence", "", "APPEARANCE", 1, 0, true, null, undefined, {}, [], ["appearance"]])
			expect(isSettingTab(value)).toBe(false);
	});

	it("guards the same tab set the snapshot filters on", () => {
		for (const tab of SETTING_TABS) {
			const scoped = buildSettingsSnapshot(Settings.isolated(), tab);
			for (const entry of scoped.settings) expect(entry.ui?.tab).toBe(tab);
		}
	});
});
