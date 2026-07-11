import { describe, expect, test } from "bun:test";
import { decodeCatalog } from "@oh-my-pi/app-wire";
import type { SettingPath } from "../src/config/settings-schema.ts";
import { Settings, type SettingsDesktopSnapshot } from "../src/config/settings.ts";
import { DesktopConfigAuthority, type DesktopSettingsPort } from "../src/session/desktop-config-authority/index.ts";

function fakeSettings(initial: Record<string, unknown> = {}): DesktopSettingsPort {
	const values = new Map(Object.entries(initial));
	const configured = new Set(Object.keys(initial));
	const source = new Map<string, string>();
	for (const key of Object.keys(initial)) source.set(key, "global");
	return {
		get(path) { return values.get(path) ?? (path === "compaction.enabled" ? false : path === "power.sleepPrevention" ? "idle" : path === "auth.broker.token" ? undefined : ""); },
		isConfigured(path) { return configured.has(path); },
		set(path, value) { values.set(path, value); configured.add(path); source.set(path, "global"); },
		override(path, value) { values.set(path, value); configured.add(path); source.set(path, "session"); },
		clearOverride(path) { values.delete(path); configured.delete(path); source.delete(path); },
		clearGlobal(path) { values.delete(path); configured.delete(path); source.delete(path); },
		getDesktopSnapshot(path): SettingsDesktopSnapshot { const present = values.has(path); return { path, global: { present, value: values.get(path) }, project: { present: false }, configOverlay: { present: false }, override: { present: source.get(path) === "session", value: values.get(path) }, effective: values.get(path), source: (source.get(path) as SettingsDesktopSnapshot["source"]) ?? "default" }; },
		restoreDesktopSnapshot(snapshot) { if (snapshot.global.present) values.set(snapshot.path, snapshot.global.value); else values.delete(snapshot.path); },
		flush() {},
	};
}

function authority(settings = fakeSettings()) {
	return new DesktopConfigAuthority({ settings, hostId: "test-host", platform: "linux" });
}

describe("DesktopConfigAuthority", () => {
	test("reads deterministic effective settings and redacts sensitive values", () => {
		const settings = fakeSettings({ "auth.broker.token": "do-not-return", "compaction.enabled": true });
		const first = authority(settings).settingsRead({ paths: ["compaction.enabled", "auth.broker.token"] });
		const second = authority(settings).settingsRead({ paths: ["auth.broker.token", "compaction.enabled"] });
		expect(first.revision).toBe(second.revision);
		expect(first.settings["compaction.enabled"]).toMatchObject({ effective: true, effectiveSource: "global" });
		expect(first.settings["auth.broker.token"]).toMatchObject({ sensitive: true, configured: true });
		expect(first.settings["auth.broker.token"]).not.toHaveProperty("effective");
		expect(first.settings["auth.broker.token"]).not.toHaveProperty("default");
		expect(JSON.stringify(first)).not.toContain("do-not-return");
	});

	test("validates writes, session override, reset, and revision conflicts", async () => {
		const settings = fakeSettings({ "compaction.enabled": false });
		const config = authority(settings);
		const revision = config.settingsRead({ paths: ["compaction.enabled"] }).revision;
		await config.settingsWrite({ path: "compaction.enabled", value: true, scope: "session" }, revision);
		expect(settings.get("compaction.enabled")).toBe(true);
		await config.settingsWrite({ path: "compaction.enabled", reset: true, scope: "session" });
		expect(settings.get("compaction.enabled")).toBe(false);
		await expect(config.settingsWrite({ path: "compaction.enabled", value: true, expectedRevision: "stale" })).rejects.toThrow("revision conflict");
		await expect(config.settingsWrite({ path: "compaction.enabled", value: "bad", controlType: "boolean" })).rejects.toThrow("invalid boolean");
	});

	test("catalog is app-wire valid, sorted, and reports unavailable providers", async () => {
		const config = new DesktopConfigAuthority({ settings: fakeSettings(), modelRegistry: { getAvailable: () => [{ id: "model-a", name: "Model A", provider: "provider-a", apiKey: "super-secret-value" }] } });
		const frame = await config.catalogGet({});
		expect(decodeCatalog(frame).type).toBe("catalog");
		expect(frame.items.some(item => item.id === "availability:skills" && item.supported === false)).toBe(true);
		expect(frame.items.some(item => item.id === "model:provider-a/model-a")).toBe(true);
		expect(JSON.stringify(frame)).not.toContain("super-secret-value");
	});
	test("prevalidates batches and uses context CAS", async () => {
		const settings = fakeSettings({ "compaction.enabled": false, "power.sleepPrevention": "idle" });
		const config = authority(settings);
		const revision = config.settingsRead().revision;
		await expect(config.settingsWrite({ edits: [{ path: "compaction.enabled", value: true }, { path: "power.sleepPrevention", value: "bad" }], expectedRevision: revision })).rejects.toThrow("invalid enum");
		expect(settings.get("compaction.enabled")).toBe(false);
		await expect(config.settingsWrite({ path: "compaction.enabled", value: true }, { expectedRevision: "stale" })).rejects.toThrow("revision conflict");
	});

	test("rejects nested secrets and oversized values", async () => {
		const config = authority();
		await expect(config.settingsWrite({ path: "modelRoles", value: { password: "x" } })).rejects.toThrow("secret-like");
		await expect(config.settingsWrite({ path: "modelRoles", value: { role: "x".repeat(9000) } })).rejects.toThrow("string exceeds");
	});
	test("revision is always the full settings frame even for a path projection", () => {
		const config = authority(fakeSettings({ "compaction.enabled": false, "power.sleepPrevention": "idle" }));
		expect(config.settingsRead({ paths: ["compaction.enabled"] }).revision).toBe(config.settingsRead().revision);
	});

	test("rejects a subset hash and accepts the current full revision", async () => {
		const config = authority(fakeSettings({ "compaction.enabled": false, "power.sleepPrevention": "system" }));
		const subset = authority(fakeSettings({ "compaction.enabled": false, "power.sleepPrevention": "idle" })).settingsRead({ paths: ["compaction.enabled"] }).revision;
		await expect(config.settingsWrite({ path: "compaction.enabled", value: true, expectedRevision: subset })).rejects.toThrow("revision conflict");
		const full = config.settingsRead().revision;
		await expect(config.settingsWrite({ path: "compaction.enabled", value: true, expectedRevision: full })).resolves.toMatchObject({ accepted: true });
	});

	test("serializes same-revision writes so exactly one wins", async () => {
		const settings = fakeSettings({ "compaction.enabled": false });
		const config = authority(settings);
		const revision = config.settingsRead().revision;
		const outcomes = await Promise.allSettled([
			config.settingsWrite({ path: "compaction.enabled", value: true, expectedRevision: revision }),
			config.settingsWrite({ path: "compaction.enabled", value: false, expectedRevision: revision }),
		]);
		expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
	});

	test("prevalidation prevents an invalid second edit from mutating the first", async () => {
		const settings = fakeSettings({ "compaction.enabled": false });
		const config = authority(settings);
		await expect(config.settingsWrite({ edits: [{ path: "compaction.enabled", value: true }, { path: "power.sleepPrevention", value: "invalid" }] })).rejects.toThrow("invalid enum");
		expect(settings.get("compaction.enabled")).toBe(false);
	});

	test("rolls back applied edits and reports a stable error when save fails", async () => {
		const settings = fakeSettings({ "compaction.enabled": false });
		let fail = true;
		const set = settings.set!;
		settings.set = (path, value) => { if (path === "power.sleepPrevention") throw new Error("raw path leak"); set(path, value); };
		settings.flush = () => { if (fail) { fail = false; throw new Error("raw save path leak"); } };
		const config = authority(settings);
		await expect(config.settingsWrite({ edits: [{ path: "compaction.enabled", value: true }, { path: "power.sleepPrevention", value: "system" }] })).rejects.toThrow("settings write failed");
	});

	test("enforces typed array and record elements", async () => {
		const config = authority();
		await expect(config.settingsWrite({ path: "enabledModels", value: [42] })).rejects.toThrow("typed");
		await expect(config.settingsWrite({ path: "retry.fallbackChains", value: { fast: [42] } })).rejects.toThrow("typed");
	});

	test("accepts minimal model tags and validates optional fields", async () => {
		const config = authority();
		await expect(config.settingsWrite({ path: "modelTags", value: { review: { name: "Review" } } })).resolves.toMatchObject({ accepted: true });
		await expect(config.settingsWrite({ path: "modelTags", value: { review: { name: "Review", hidden: "yes" } } })).rejects.toThrow("typed");
	});

	test("catalog projects explicit agent, skill, plugin, and MCP adapters", async () => {
		const config = new DesktopConfigAuthority({
			settings: fakeSettings(),
			agentRegistry: { list: () => [{ id: "agent-a", displayName: "Agent A", kind: "sub", status: "idle" }] },
			skillsLoader: async () => ({ skills: [{ name: "skill-a", description: "Skill A", source: "project" }] }),
			pluginManager: { list: () => [{ name: "plugin-a", description: "Plugin A" }] },
			mcpManager: { getConnectedServers: () => ["mcp-a"], getAllServerNames: () => ["mcp-a", "mcp-b"] },
		});
		const frame = await config.catalogGet({});
		expect(decodeCatalog(frame).type).toBe("catalog");
		expect(frame.items.some(item => item.kind === "agent" && item.name === "Agent A")).toBe(true);
		expect(frame.items.some(item => item.kind === "skill" && item.name === "skill-a")).toBe(true);
		expect(frame.items.some(item => item.kind === "provider" && item.name === "plugin-a")).toBe(true);
		expect(frame.items.some(item => item.kind === "provider" && item.name === "mcp-b")).toBe(true);
	});

	test("malformed providers become unsupported catalog items", async () => {
		const config = new DesktopConfigAuthority({ settings: fakeSettings(), skillsLoader: async () => ({ skills: [null] }), pluginProvider: () => { throw new Error("secret provider path"); } });
		const frame = await config.catalogGet({});
		expect(decodeCatalog(frame).type).toBe("catalog");
		expect(frame.items.some(item => item.kind === "skill" && item.supported === false)).toBe(true);
		expect(frame.items.some(item => item.id === "availability:plugins" && item.supported === false)).toBe(true);
		expect(JSON.stringify(frame)).not.toContain("secret provider path");
	});
	test("settings restore preserves exact raw layers and effective value", () => {
		const settings = Settings.isolated();
		settings.set("compaction.enabled", false);
		const snapshot = settings.getDesktopSnapshot("compaction.enabled");
		settings.override("compaction.enabled", true);
		expect(settings.get("compaction.enabled")).toBe(true);
		settings.restoreDesktopSnapshot(snapshot);
		expect(settings.get("compaction.enabled")).toBe(false);
		expect(settings.getDesktopSnapshot("compaction.enabled").override.present).toBe(false);
	});
});
