import { describe, expect, test } from "bun:test";
import { decodeCatalog } from "@oh-my-pi/app-wire";
import type { SettingPath } from "../src/config/settings-schema.ts";
import type { SettingsDesktopSnapshot } from "../src/config/settings.ts";
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
		expect(first.settings["auth.broker.token"]).not.toHaveProperty("effective", "do-not-return");
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
});
