import { describe, expect, test } from "bun:test";
import { decodeCatalog, decodeCommandResult, hostId } from "@oh-my-pi/app-wire";
import { Settings, type SettingsDesktopSnapshot } from "../src/config/settings.ts";
import { DesktopConfigAuthority, type DesktopSettingsPort } from "../src/session/desktop-config-authority/index.ts";

function fakeSettings(initial: Record<string, unknown> = {}): DesktopSettingsPort {
	const values = new Map(Object.entries(initial));
	const configured = new Set(Object.keys(initial));
	const source = new Map<string, string>();
	for (const key of Object.keys(initial)) source.set(key, "global");
	return {
		get(path) {
			return (
				values.get(path) ??
				(path === "compaction.enabled"
					? false
					: path === "power.sleepPrevention"
						? "idle"
						: path === "auth.broker.token"
							? undefined
							: "")
			);
		},
		isConfigured(path) {
			return configured.has(path);
		},
		set(path, value) {
			values.set(path, value);
			configured.add(path);
			source.set(path, "global");
		},
		override(path, value) {
			values.set(path, value);
			configured.add(path);
			source.set(path, "session");
		},
		clearOverride(path) {
			values.delete(path);
			configured.delete(path);
			source.delete(path);
		},
		clearGlobal(path) {
			values.delete(path);
			configured.delete(path);
			source.delete(path);
		},
		getDesktopSnapshot(path): SettingsDesktopSnapshot {
			const present = values.has(path);
			return {
				path,
				global: { present, value: values.get(path) },
				project: { present: false },
				configOverlay: { present: false },
				override: { present: source.get(path) === "session", value: values.get(path) },
				effective: values.get(path),
				source: (source.get(path) as SettingsDesktopSnapshot["source"]) ?? "default",
			};
		},
		restoreDesktopSnapshot(snapshot) {
			if (snapshot.global.present) values.set(snapshot.path, snapshot.global.value);
			else values.delete(snapshot.path);
		},
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
		expect(() => decodeCommandResult("settings.read", first)).not.toThrow();
	});

	test("validates writes, session override, reset, and revision conflicts", async () => {
		const settings = fakeSettings({ "compaction.enabled": false });
		const config = authority(settings);
		const revision = config.settingsRead({ paths: ["compaction.enabled"] }).revision;
		await config.settingsWrite({ path: "compaction.enabled", value: true, scope: "session" }, revision);
		expect(settings.get("compaction.enabled")).toBe(true);
		await config.settingsWrite({ path: "compaction.enabled", reset: true, scope: "session" });
		expect(settings.get("compaction.enabled")).toBe(false);
		await expect(
			config.settingsWrite({ path: "compaction.enabled", value: true, expectedRevision: "stale" }),
		).rejects.toThrow("revision conflict");
		await expect(
			config.settingsWrite({ path: "compaction.enabled", value: "bad", controlType: "boolean" }),
		).rejects.toThrow("invalid boolean");
	});

	test("catalog is app-wire valid, sorted, and reports unavailable providers", async () => {
		const config = new DesktopConfigAuthority({
			settings: fakeSettings(),
			modelRegistry: {
				getAvailable: () => [
					{ id: "model-a", name: "Model A", provider: "provider-a", apiKey: "super-secret-value" },
				],
			},
		});
		const frame = await config.catalogGet({});
		expect(decodeCatalog(frame).type).toBe("catalog");
		expect(frame.items.some(item => item.id === "availability:skills" && item.supported === false)).toBe(true);
		expect(frame.items.some(item => item.id === "model:provider-a/model-a")).toBe(true);
		const expectedCommands = [
			["session.create", "sessions.manage"],
			["session.close", "sessions.manage"],
			["session.rename", "sessions.manage"],
			["session.archive", "sessions.manage"],
			["session.restore", "sessions.manage"],
			["session.delete", "sessions.manage"],
			["session.cancel", "sessions.control"],
			["session.model.set", "sessions.manage"],
			["session.thinking.set", "sessions.manage"],
			["session.fast.set", "sessions.manage"],
		] as const;
		expect(
			frame.items
				.filter(item => item.kind === "command" && item.name.startsWith("session."))
				.map(item => item.name)
				.sort(),
		).toEqual(expectedCommands.map(([name]) => name).sort());
		for (const [name, capability] of expectedCommands) {
			const command = frame.items.find(item => item.kind === "command" && item.name === name);
			expect(command?.supported).toBe(true);
			expect(command?.capabilities).toEqual([capability]);
		}
		expect(JSON.stringify(frame)).not.toContain("super-secret-value");
	});
	test("preserves the operation context host id in settings and catalog frames", async () => {
		const config = authority();
		expect(config.settingsRead({}, { hostId: hostId("real-host") }).hostId).toBe(hostId("real-host"));
		expect((await config.catalogGet({}, { hostId: hostId("real-host") })).hostId).toBe(hostId("real-host"));
	});
	test("prevalidates batches and uses context CAS", async () => {
		const settings = fakeSettings({ "compaction.enabled": false, "power.sleepPrevention": "idle" });
		const config = authority(settings);
		const revision = config.settingsRead().revision;
		await expect(
			config.settingsWrite({
				edits: [
					{ path: "compaction.enabled", value: true },
					{ path: "power.sleepPrevention", value: "bad" },
				],
				expectedRevision: revision,
			}),
		).rejects.toThrow("invalid enum");
		expect(settings.get("compaction.enabled")).toBe(false);
		await expect(
			config.settingsWrite({ path: "compaction.enabled", value: true }, { expectedRevision: "stale" }),
		).rejects.toThrow("revision conflict");
	});

	test("rejects nested secrets and oversized values", async () => {
		const config = authority();
		await expect(config.settingsWrite({ path: "modelRoles", value: { password: "x" } })).rejects.toThrow(
			"secret-like",
		);
		await expect(config.settingsWrite({ path: "modelRoles", value: { role: "x".repeat(9000) } })).rejects.toThrow(
			"string exceeds",
		);
	});
	test("revision is always the full settings frame even for a path projection", () => {
		const config = authority(fakeSettings({ "compaction.enabled": false, "power.sleepPrevention": "idle" }));
		expect(config.settingsRead({ paths: ["compaction.enabled"] }).revision).toBe(config.settingsRead().revision);
	});

	test("rejects a subset hash and accepts the current full revision", async () => {
		const config = authority(fakeSettings({ "compaction.enabled": false, "power.sleepPrevention": "system" }));
		const subset = authority(
			fakeSettings({ "compaction.enabled": false, "power.sleepPrevention": "idle" }),
		).settingsRead({ paths: ["compaction.enabled"] }).revision;
		await expect(
			config.settingsWrite({ path: "compaction.enabled", value: true, expectedRevision: subset }),
		).rejects.toThrow("revision conflict");
		const full = config.settingsRead().revision;
		await expect(
			config.settingsWrite({ path: "compaction.enabled", value: true, expectedRevision: full }),
		).resolves.toMatchObject({ accepted: true });
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
		await expect(
			config.settingsWrite({
				edits: [
					{ path: "compaction.enabled", value: true },
					{ path: "power.sleepPrevention", value: "invalid" },
				],
			}),
		).rejects.toThrow("invalid enum");
		expect(settings.get("compaction.enabled")).toBe(false);
	});

	test("rolls back applied edits and reports a stable error when save fails", async () => {
		const settings = fakeSettings({ "compaction.enabled": false });
		let fail = true;
		const set = settings.set!;
		settings.set = (path, value) => {
			if (path === "power.sleepPrevention") throw new Error("raw path leak");
			set(path, value);
		};
		settings.flush = () => {
			if (fail) {
				fail = false;
				throw new Error("raw save path leak");
			}
		};
		const config = authority(settings);
		await expect(
			config.settingsWrite({
				edits: [
					{ path: "compaction.enabled", value: true },
					{ path: "power.sleepPrevention", value: "system" },
				],
			}),
		).rejects.toThrow("settings write failed");
	});

	test("enforces typed array and record elements", async () => {
		const config = authority();
		await expect(config.settingsWrite({ path: "enabledModels", value: [42] })).rejects.toThrow("typed");
		await expect(config.settingsWrite({ path: "retry.fallbackChains", value: { fast: [42] } })).rejects.toThrow(
			"typed",
		);
	});

	test("accepts minimal model tags and validates optional fields", async () => {
		const config = authority();
		await expect(
			config.settingsWrite({ path: "modelTags", value: { review: { name: "Review" } } }),
		).resolves.toMatchObject({ accepted: true });
		await expect(
			config.settingsWrite({ path: "modelTags", value: { review: { name: "Review", hidden: "yes" } } }),
		).rejects.toThrow("typed");
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
		const config = new DesktopConfigAuthority({
			settings: fakeSettings(),
			skillsLoader: async () => ({ skills: [null] }),
			pluginProvider: () => {
				throw new Error("secret provider path");
			},
		});
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
	test("covers roles, agents, cycle order, overrides, and secret absence", async () => {
		const settings = fakeSettings({
			cycleOrder: ["slow", "custom-role"],
			modelRoles: {
				"custom-role": "my-custom-model",
				"another-role": "another-model",
			},
			modelTags: {
				"custom-role": { name: "Custom Display Role", tag: "CUSTOM" },
				"tagged-role": { name: "Tagged Role", tag: "TAGGED" },
			},
			"task.disabledAgents": ["scout"],
			"task.agentModelOverrides": {
				task: "claude-3-5-sonnet,gpt-4o",
				designer: "gemini-flash",
			},
		});

		const registry = {
			getAvailable: () => [{ id: "model-a", name: "Model A", provider: "provider-a", apiKey: "secret-key-1" }],
		};

		const config = new DesktopConfigAuthority({
			settings,
			modelRegistry: registry,
		});

		const frame = await config.catalogGet({}, { hostId: hostId("real-host") });
		expect(frame.hostId).toBe(hostId("real-host"));

		const modes = frame.items.filter(item => item.kind === "mode");
		expect(modes.length).toBeGreaterThan(0);

		const slowMode = modes.find(m => m.name === "slow");
		expect(slowMode).toBeDefined();
		expect(slowMode!.metadata).toMatchObject({
			role: "slow",
			tag: "SLOW",
			cycle: true,
			cycleIndex: 0,
		});

		const customMode = modes.find(m => m.name === "custom-role");
		expect(customMode).toBeDefined();
		expect(customMode!.metadata).toMatchObject({
			role: "custom-role",
			modelId: "my-custom-model",
			cycle: true,
			cycleIndex: 1,
		});

		const anotherMode = modes.find(m => m.name === "another-role");
		expect(anotherMode).toBeDefined();
		expect(anotherMode!.metadata).toMatchObject({
			role: "another-role",
			modelId: "another-model",
			cycle: false,
		});

		const taggedMode = modes.find(m => m.name === "tagged-role");
		expect(taggedMode).toBeDefined();
		expect(taggedMode!.metadata).toMatchObject({
			role: "tagged-role",
			cycle: false,
		});

		const agents = frame.items.filter(item => item.kind === "agent");
		expect(agents.length).toBeGreaterThan(0);

		const scoutAgent = agents.find(a => a.name === "scout" || a.id.endsWith(":scout") || a.id.endsWith("scout"));
		expect(scoutAgent).toBeDefined();
		expect(scoutAgent!.metadata!.enabled).toBe(false);

		const taskAgent = agents.find(a => a.name === "task" || a.id.endsWith(":task") || a.id.endsWith("task"));
		expect(taskAgent).toBeDefined();
		expect(taskAgent!.metadata!.enabled).toBe(true);
		expect(taskAgent!.metadata!.overrides).toEqual(["claude-3-5-sonnet", "gpt-4o"]);

		const designerAgent = agents.find(
			a => a.name === "designer" || a.id.endsWith(":designer") || a.id.endsWith("designer"),
		);
		expect(designerAgent).toBeDefined();
		expect(designerAgent!.metadata!.enabled).toBe(true);
		expect(designerAgent!.metadata!.overrides).toEqual(["gemini-flash"]);

		const modelItems = frame.items.filter(item => item.kind === "model");
		expect(modelItems.some(item => item.id.includes("model-a"))).toBe(true);
		expect(JSON.stringify(frame)).not.toContain("secret-key-1");
		for (const a of agents) {
			expect(a.metadata).not.toHaveProperty("systemPrompt");
			expect(a.metadata).not.toHaveProperty("system");
		}
	});
});
