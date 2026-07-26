import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decodeCatalog, decodeCommandResult, hostId } from "@oh-my-pi/app-wire";
import { YAML } from "bun";
import { Settings, type SettingsDesktopSnapshot } from "../src/config/settings.ts";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema.ts";
import { SENSITIVE_SETTINGS } from "../src/session/desktop-config-authority/authority.ts";
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
		setProject(path, value) {
			values.set(path, value);
			configured.add(path);
			source.set(path, "project");
		},
		clearProject(path) {
			values.delete(path);
			configured.delete(path);
			source.delete(path);
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

function desktopPort(settings: Settings): DesktopSettingsPort {
	return {
		get: path => settings.get(path),
		isConfigured: path => settings.isConfigured(path),
		set: (path, value) => settings.set(path, value as never),
		setProject: (path, value) => settings.setProject(path, value as never),
		clearProject: path => settings.clearProject(path),
		override: (path, value) => settings.override(path, value as never),
		clearOverride: path => settings.clearOverride(path),
		flush: () => settings.flush(),
		getDesktopSnapshot: path => settings.getDesktopSnapshot(path),
		restoreDesktopSnapshot: snapshot => settings.restoreDesktopSnapshot(snapshot),
		clearGlobal: path => settings.clearGlobal(path),
	};
}

describe("DesktopConfigAuthority", () => {
	test("keeps the declared sensitive setting allow-list synchronized with the schema", () => {
		const expected = [
			"auth.broker.token",
			"dev.autoqaPush.token",
			"hindsight.apiToken",
			"mnemopi.embeddingApiKey",
			"mnemopi.llmApiKey",
			"searxng.basicPassword",
			"searxng.token",
		];
		expect([...SENSITIVE_SETTINGS]).toEqual(expected);
		for (const path of SENSITIVE_SETTINGS) expect(Object.hasOwn(SETTINGS_SCHEMA, path)).toBe(true);
	});

	test("reads and writes token-named settings that are not sensitive", async () => {
		const settings = fakeSettings({
			"display.showTokenUsage": true,
			"compaction.thresholdTokens": 25_000,
		});
		const config = authority(settings);
		const frame = config.settingsRead({
			paths: ["display.showTokenUsage", "compaction.thresholdTokens"],
		});
		expect(frame.settings["display.showTokenUsage"]).toMatchObject({
			default: false,
			effective: true,
			sensitive: false,
		});
		expect(frame.settings["compaction.thresholdTokens"]).toMatchObject({
			default: -1,
			effective: 25_000,
			sensitive: false,
		});

		await expect(
			config.settingsWrite({
				edits: [
					{ path: "display.showTokenUsage", value: false },
					{ path: "compaction.thresholdTokens", value: 50_000 },
				],
			}),
		).resolves.toMatchObject({ accepted: true });
		expect(settings.get("display.showTokenUsage")).toBe(false);
		expect(settings.get("compaction.thresholdTokens")).toBe(50_000);
	});

	test("still redacts and rejects declared sensitive settings", async () => {
		const config = authority(fakeSettings({ "hindsight.apiToken": "do-not-return" }));
		const frame = config.settingsRead({ path: "hindsight.apiToken" });
		expect(frame.settings["hindsight.apiToken"]).toMatchObject({ sensitive: true, configured: true });
		expect(frame.settings["hindsight.apiToken"]).not.toHaveProperty("effective");
		expect(frame.settings["hindsight.apiToken"]).not.toHaveProperty("default");
		expect(JSON.stringify(frame)).not.toContain("do-not-return");
		await expect(config.settingsWrite({ path: "hindsight.apiToken", value: "replacement" })).rejects.toThrow(
			"sensitive setting values cannot be written",
		);
	});

	test("forwards schema UI metadata used by desktop controls", async () => {
		const frame = await authority().catalogGet({ kind: "setting" });
		expect(frame.items.find(item => item.name === "mnemopi.autoRecall")?.metadata).toMatchObject({
			condition: "mnemopiActive",
		});
		expect(frame.items.find(item => item.name === "advisor.subagents")?.metadata).toMatchObject({
			condition: "advisorEnabled",
		});
		// Asserted through `catalogGet`, not against `controlMetadata` directly: a
		// synthetic call stays green if `#settingItems` stops forwarding these,
		// which is the desktop behavior worth guarding. This branch's real schema
		// declares neither flag, so a synthetic schema supplies them.
		const probe = new DesktopConfigAuthority({
			settings: fakeSettings(),
			hostId: "test-host",
			platform: "linux",
			schema: {
				"probe.ordered": { type: "array", default: [], ui: { label: "Ordered", ordered: true } },
				"probe.secret": { type: "string", default: "", ui: { label: "Secret", secret: true } },
			},
		});
		const probed = await probe.catalogGet({ kind: "setting" });
		expect(probed.items.find(item => item.name === "probe.ordered")?.metadata).toMatchObject({ ordered: true });
		// `ui.secret` maps onto the canonical `sensitive` field: `boundedMetadata`
		// rejects a bare `secret` metadata key, and `sensitive` is what carries the
		// decoder's redaction invariant. Assert the redaction, not just the flag.
		const secretItem = probed.items.find(item => item.name === "probe.secret");
		expect(secretItem?.metadata?.sensitive).toBe(true);
		expect(secretItem?.metadata).not.toHaveProperty("secret");
		expect(secretItem?.metadata?.default).toBeUndefined();
		expect(secretItem?.metadata?.effective).toBeUndefined();
	});

	test("advertises project scope only for non-host-local settings and refuses host-local writes", async () => {
		const frame = await authority().catalogGet({ kind: "setting" });
		expect(frame.items.find(item => item.name === "appserver.remoteAddress")?.metadata?.scopes).toEqual([
			"global",
			"session",
		]);
		expect(frame.items.find(item => item.name === "compaction.enabled")?.metadata?.scopes).toContain("project");
		await expect(
			authority().settingsWrite({
				path: "appserver.remoteAddress",
				value: "127.0.0.1",
				scope: "project",
			}),
		).rejects.toThrow("host-local setting cannot be written to project scope");
	});

	test("persists project writes without disturbing sibling native settings", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "desktop-project-settings-"));
		const projectDir = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		const initial = {
			compaction: { enabled: false },
			untouched: { nested: "keep" },
		};
		await fs.promises.mkdir(projectDir, { recursive: true });
		await fs.promises.mkdir(agentDir, { recursive: true });
		await Bun.write(projectConfigPath, YAML.stringify(initial, null, 2));
		try {
			const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			const result = await authority(desktopPort(settings)).settingsWrite({
				path: "compaction.enabled",
				value: true,
				scope: "project",
			});
			expect(JSON.stringify(result)).not.toContain(projectDir);

			expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({
				compaction: { enabled: true },
				untouched: { nested: "keep" },
			});
			expect(await Bun.file(path.join(agentDir, "config.yml")).exists()).toBe(false);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("preserves an external edit made while a project write is pending", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "desktop-project-external-"));
		const projectDir = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		await fs.promises.mkdir(projectDir, { recursive: true });
		await fs.promises.mkdir(agentDir, { recursive: true });
		await Bun.write(projectConfigPath, YAML.stringify({ untouched: { nested: "keep" } }, null, 2));
		try {
			const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			// Queue our edit, then let another process append to the same file
			// before the debounced saver runs. The saver re-reads under the lock and
			// patches only its own paths, so the foreign key must survive.
			settings.setProject("compaction.enabled", true);
			await Bun.write(
				projectConfigPath,
				YAML.stringify({ untouched: { nested: "keep" }, addedByAnotherProcess: true }, null, 2),
			);
			await settings.flush();

			expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({
				untouched: { nested: "keep" },
				addedByAnotherProcess: true,
				compaction: { enabled: true },
			});
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("a cwd switch drains pending project writes to the old root, never the new one", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "desktop-project-cwd-"));
		const projectA = path.join(root, "a");
		const projectB = path.join(root, "b");
		const agentDir = path.join(root, "agent");
		const configA = path.join(projectA, ".omp", "config.yml");
		const configB = path.join(projectB, ".omp", "config.yml");
		for (const dir of [projectA, projectB, agentDir]) await fs.promises.mkdir(dir, { recursive: true });
		await Bun.write(configA, YAML.stringify({ marker: "a" }, null, 2));
		await Bun.write(configB, YAML.stringify({ marker: "b" }, null, 2));
		try {
			const settings = await Settings.loadIsolated({ cwd: projectA, agentDir });
			// Queue against A and switch without flushing ourselves. Two mechanisms
			// must combine to keep A's edit out of B: `reloadForCwd` drains pending
			// writes before moving, and the save queue is keyed by the root bound
			// when the edit was accepted. Dropping either one sends A's change to B.
			settings.setProject("compaction.enabled", true);
			await settings.reloadForCwd(projectB);

			expect(YAML.parse(await Bun.file(configA).text())).toEqual({
				marker: "a",
				compaction: { enabled: true },
			});
			expect(YAML.parse(await Bun.file(configB).text())).toEqual({ marker: "b" });

			// And the switch really did land: a later edit belongs to B alone.
			settings.setProject("compaction.enabled", false);
			await settings.flush();
			expect(YAML.parse(await Bun.file(configB).text())).toEqual({
				marker: "b",
				compaction: { enabled: false },
			});
			expect(YAML.parse(await Bun.file(configA).text())).toEqual({
				marker: "a",
				compaction: { enabled: true },
			});
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("persists rollback when a later project edit fails", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "desktop-project-rollback-"));
		const projectDir = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		const initial = { untouched: { nested: "keep" } };
		await fs.promises.mkdir(projectDir, { recursive: true });
		await fs.promises.mkdir(agentDir, { recursive: true });
		await Bun.write(projectConfigPath, YAML.stringify(initial, null, 2));
		try {
			const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			const port = desktopPort(settings);
			const setProject = port.setProject;
			port.setProject = (settingPath, value) => {
				if (settingPath === "display.showTokenUsage") throw new Error("simulated second edit failure");
				setProject(settingPath, value);
			};
			await expect(
				authority(port).settingsWrite({
					edits: [
						{ path: "compaction.enabled", value: false, scope: "project" },
						{ path: "display.showTokenUsage", value: true, scope: "project" },
					],
				}),
			).rejects.toThrow("settings write failed");

			expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual(initial);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

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
			["broker.status", "broker.read"],
			["usage.read", "usage.read"],
		] as const;
		expect(
			frame.items
				.filter(item => item.kind === "command" && expectedCommands.some(([name]) => name === item.name))
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
