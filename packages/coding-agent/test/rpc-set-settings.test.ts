import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	isRpcReadable,
	isRpcWritable,
	MAX_RPC_SETTING_VALUE_BYTES,
	SETTINGS_SCHEMA,
	validateRpcSettingValue,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getRpcCapabilityManifest, validateRpcCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-command-registry";
import { dispatchRpcInputFrame, type RpcInputFrameDeps } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { handleSetSettings } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-set-settings";
import type { RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

describe("set_settings", () => {
	it("treats writable as readable and always vetoes credentials", () => {
		expect(isRpcWritable("colorBlindMode")).toBe(true);
		expect(isRpcReadable("colorBlindMode")).toBe(true);
		const credential = SETTINGS_SCHEMA["auth.broker.token"] as { rpcWritable?: true };
		credential.rpcWritable = true;
		try {
			expect(isRpcWritable("auth.broker.token")).toBe(false);
			expect(isRpcReadable("auth.broker.token")).toBe(false);
			expect(validateRpcSettingValue("auth.broker.token", "secret")).toMatchObject({
				ok: false,
				code: "credential_setting",
			});
		} finally {
			delete credential.rpcWritable;
		}
	});

	it("rejects unknown, read-only, wrong-type, invalid enum, null, and oversized values", () => {
		expect(validateRpcSettingValue("not.a.setting", true)).toMatchObject({ ok: false, code: "unknown_path" });
		expect(validateRpcSettingValue("autoResume", true)).toMatchObject({ ok: false, code: "read_only_setting" });
		expect(validateRpcSettingValue("colorBlindMode", "true")).toMatchObject({ ok: false, code: "invalid_type" });
		expect(validateRpcSettingValue("symbolPreset", "unknown")).toMatchObject({ ok: false, code: "invalid_enum" });
		expect(validateRpcSettingValue("symbolPreset", null)).toMatchObject({ ok: false, code: "invalid_value" });

		const stringPath = "auth.broker.url" as const;
		const def = SETTINGS_SCHEMA[stringPath] as { rpcWritable?: true };
		def.rpcWritable = true;
		try {
			expect(validateRpcSettingValue(stringPath, "x".repeat(MAX_RPC_SETTING_VALUE_BYTES + 1))).toMatchObject({
				ok: false,
				code: "value_too_large",
			});
		} finally {
			delete def.rpcWritable;
		}
	});

	it("respects declared numeric UI bounds without coercion", () => {
		const path = "compaction.reserveTokens" as const;
		const def = SETTINGS_SCHEMA[path] as unknown as {
			rpcWritable?: true;
			ui?: { min?: number; max?: number };
		};
		const previousUi = def.ui;
		def.rpcWritable = true;
		def.ui = { min: 100, max: 200 };
		try {
			expect(validateRpcSettingValue(path, 99)).toMatchObject({ ok: false, code: "out_of_range" });
			expect(validateRpcSettingValue(path, 150)).toMatchObject({ ok: true, value: 150 });
		} finally {
			delete def.rpcWritable;
			if (previousUi === undefined) delete def.ui;
			else def.ui = previousUi;
		}
	});

	it("prevalidates duplicates, limits, and every value before mutation", async () => {
		for (const changes of [
			[
				{ path: "colorBlindMode", value: true },
				{ path: "colorBlindMode", value: false },
			],
			Array.from({ length: 101 }, (_, index) => ({ path: `unknown.${index}`, value: true })),
			[
				{ path: "colorBlindMode", value: true },
				{ path: "autoResume", value: true },
			],
		]) {
			const settings = Settings.isolated();
			let mutations = 0;
			const originalSet = settings.set.bind(settings);
			settings.set = ((path: never, value: never) => {
				mutations += 1;
				originalSet(path, value);
			}) as typeof settings.set;
			const response = await handleSetSettings(settings, "batch", changes);
			expect(response.success).toBe(false);
			expect(mutations).toBe(0);
		}
	});

	it("persists a multi-change batch and returns authoritative effective values", async () => {
		const settings = Settings.isolated({ colorBlindMode: false });
		const response = await handleSetSettings(settings, "ok", [
			{ path: "colorBlindMode", value: true },
			{ path: "symbolPreset", value: "ascii" },
		]);
		expect(response).toMatchObject({ id: "ok", command: "set_settings", success: true });
		if (!response.success || response.command !== "set_settings") throw new Error("unexpected response");
		expect(response.data.tabs.map(tab => tab.id)).toEqual(["appearance"]);
		expect(response.data.settings.map(entry => [entry.path, entry.value])).toEqual([
			["symbolPreset", "ascii"],
			["colorBlindMode", false],
		]);
	});

	it("emits settings_update only after a successful flush and response", async () => {
		const run = async (flush: () => Promise<void>) => {
			const settings = Settings.isolated();
			const originalSetPersistedBatch = settings.setPersistedBatch.bind(settings);
			settings.setPersistedBatch = async changes => {
				await flush();
				await originalSetPersistedBatch(changes);
			};
			const frames: object[] = [];
			const deps: RpcInputFrameDeps = {
				handleCommand: command => {
					if (command.type !== "set_settings") throw new Error("unexpected command");
					return handleSetSettings(settings, command.id, command.changes);
				},
				output: frame => frames.push(frame),
				errorResponse: (id, command, error, code): RpcResponse => ({
					id,
					type: "response",
					command,
					success: false,
					error,
					code,
				}),
				pendingExtensionRequests: new Map(),
				onHostToolResult: () => {},
				onHostToolUpdate: () => {},
				onHostUriResult: () => {},
			};
			await dispatchRpcInputFrame(
				{ id: "flush", type: "set_settings", changes: [{ path: "colorBlindMode", value: true }] },
				deps,
			);
			return { frames, value: settings.get("colorBlindMode") };
		};
		expect(await run(async () => {})).toMatchObject({
			frames: [{ command: "set_settings", success: true }, { type: "settings_update" }],
			value: true,
		});
		expect(await run(async () => Promise.reject(new Error("disk full")))).toEqual({
			frames: [expect.objectContaining({ command: "set_settings", success: false, code: "persistence_failed" })],
			value: false,
		});
	});

	it("advertises serial session scheduling and the pull-only event", () => {
		expect(
			validateRpcCommand({ type: "set_settings", changes: [{ path: "colorBlindMode", value: true }] }),
		).toMatchObject({ ok: true, scheduling: "serial" });
		const manifest = getRpcCapabilityManifest();
		expect(manifest.events).toContain("settings_update");
		expect(manifest.commands.find(command => command.name === "set_settings")).toMatchObject({
			scope: "session",
			concurrencyClass: "serial",
		});
	});
});
