import { describe, expect, test } from "bun:test";
import { type AppserverHandle, BunRpcChildFactory, resolveRpcChildInvocation } from "@oh-my-pi/appserver";
import {
	type AppserverHealth,
	type AppserverServeConfig,
	runAppserverServe,
	runAppserverStatus,
} from "@oh-my-pi/pi-coding-agent/cli/appserver-cli";
import { commands, isSubcommand } from "@oh-my-pi/pi-coding-agent/cli-commands";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";

const health: AppserverHealth = { ok: true, hostId: "host-test", epoch: "epoch-test" };
function immediateHandle(onStart: () => void): AppserverHandle {
	return {
		hostId: "host-test" as never,
		epoch: "epoch-test",
		socketPath: "/tmp/test-appserver.sock",
		start: async () => {
			onStart();
		},
		stop: async () => {},
		snapshot: () => undefined,
		replay: () => [],
		childFor: () => undefined,
	};
}

async function runServeWithSettings(
	settings: Pick<Settings, "get">,
	rawConfig: Parameters<typeof runAppserverServe>[1] = {},
	onConfig?: (config: AppserverServeConfig | undefined) => void,
): Promise<void> {
	let stop: (() => void) | undefined;
	await runAppserverServe(
		{
			settings,
			createAppserver: config => {
				onConfig?.(config);
				return immediateHandle(() => stop?.());
			},
			onSignal: (_signal, handler) => {
				stop = handler;
			},
			removeSignal: () => {},
			registerCleanup: () => () => {},
		},
		rawConfig,
	);
}

describe("appserver CLI routing", () => {
	test("registers appserver lazily as a top-level command", () => {
		expect(isSubcommand("appserver")).toBe(true);
		expect(commands.find(command => command.name === "appserver")?.load).toBeFunction();
	});

	test("status accepts a valid health response", async () => {
		expect(
			await runAppserverStatus({
				socketPath: () => "/tmp/test-appserver.sock",
				readHealth: async () => health,
			}),
		).toEqual({ state: "running", health });
	});

	test("status maps malformed and unavailable health to stopped states", async () => {
		expect(await runAppserverStatus({ readHealth: async () => ({ ok: true, hostId: "", epoch: "epoch" }) })).toEqual({
			state: "stopped",
			reason: "malformed",
		});
		expect(
			await runAppserverStatus({
				readHealth: async () => {
					throw new Error("timed out");
				},
			}),
		).toEqual({
			state: "stopped",
			reason: "unreachable",
		});
	});

	test("serve starts once, stops once, and removes both signal listeners", async () => {
		let starts = 0;
		let stops = 0;
		const handlers = new Map<string, () => void>();
		const registered = Promise.withResolvers<void>();
		const startGate = Promise.withResolvers<void>();
		const removed: string[] = [];
		const promise = runAppserverServe({
			createAppserver: () => ({
				hostId: "host-test" as never,
				epoch: "epoch-test",
				socketPath: "/tmp/test-appserver.sock",
				start: async () => {
					starts += 1;
					await startGate.promise;
				},
				stop: async () => {
					stops += 1;
				},
				snapshot: () => undefined,
				replay: () => [],
				childFor: () => undefined,
			}),
			onSignal: (signal, handler) => {
				handlers.set(signal, handler);
				if (handlers.size === 2) registered.resolve();
			},
			removeSignal: (signal, handler) => {
				if (handlers.get(signal) === handler) handlers.delete(signal);
				removed.push(signal);
			},
		});
		await registered.promise;
		handlers.get("SIGINT")?.();
		handlers.get("SIGTERM")?.();
		startGate.resolve();
		await promise;
		expect(stops).toBe(1);
		expect(removed.sort()).toEqual(["SIGINT", "SIGTERM"]);
	});
});

describe("appserver remote settings", () => {
	test("defaults to local-only when persisted settings select local mode", async () => {
		let observed: AppserverServeConfig | undefined;
		await runServeWithSettings(Settings.isolated(), {}, config => {
			observed = config;
		});
		expect(observed).toEqual({});
	});

	test("loads persisted direct mode before validation", async () => {
		let observed: AppserverServeConfig | undefined;
		await runServeWithSettings(
			Settings.isolated({
				"appserver.remoteMode": "direct",
				"appserver.remoteAddress": "100.64.0.10",
				"appserver.remotePort": 9876,
				"appserver.remoteOrigins": ["https://omp.example"],
			}),
			{},
			config => {
				observed = config;
			},
		);
		expect(observed?.remoteMode).toBe("direct");
		expect(observed?.remoteAddress).toBe("100.64.0.10");
		expect(observed?.remotePort).toBe(9876);
		expect(observed?.remoteOrigins).toEqual(["https://omp.example"]);
		expect(observed?.remoteStateDir).toBeString();
	});

	test("explicit CLI remote flags skip persisted settings and win completely", async () => {
		let loaded = 0;
		let stop: (() => void) | undefined;
		let observed: AppserverServeConfig | undefined;
		await runAppserverServe(
			{
				loadSettings: async () => {
					loaded += 1;
					throw new Error("settings must not load for explicit flags");
				},
				createAppserver: config => {
					observed = config;
					return immediateHandle(() => stop?.());
				},
				onSignal: (_signal, handler) => {
					stop = handler;
				},
				removeSignal: () => {},
				registerCleanup: () => () => {},
			},
			{ remoteMode: "direct", remoteAddress: "100.64.0.20", remotePort: 8788, remoteOrigins: [] },
		);
		expect(loaded).toBe(0);
		expect(observed).toMatchObject({
			remoteMode: "direct",
			remoteAddress: "100.64.0.20",
			remotePort: 8788,
			remoteOrigins: [],
		});
	});

	test("rejects wildcard and empty persisted direct addresses", async () => {
		for (const address of ["", "0.0.0.0", "::", "::0"]) {
			await expect(
				runServeWithSettings(
					Settings.isolated({ "appserver.remoteMode": "direct", "appserver.remoteAddress": address }),
				),
			).rejects.toThrow("concrete non-wildcard IP address");
		}
	});

	test("rejects persisted port and browser Origin values outside bounds", async () => {
		await expect(
			runServeWithSettings(
				Settings.isolated({
					"appserver.remoteMode": "direct",
					"appserver.remoteAddress": "100.64.0.10",
					"appserver.remotePort": 0,
				}),
			),
		).rejects.toThrow("between 1 and 65535");
		await expect(
			runServeWithSettings(
				Settings.isolated({
					"appserver.remoteMode": "direct",
					"appserver.remoteAddress": "100.64.0.10",
					"appserver.remoteOrigins": ["x".repeat(1025)],
				}),
			),
		).rejects.toThrow("invalid origin");
	});

	test("publishes restart-required Appserver / Remote access catalog metadata", () => {
		const definitions = [
			SETTINGS_SCHEMA["appserver.remoteMode"],
			SETTINGS_SCHEMA["appserver.remoteAddress"],
			SETTINGS_SCHEMA["appserver.remotePort"],
			SETTINGS_SCHEMA["appserver.remoteOrigins"],
		];
		for (const definition of definitions) {
			expect(definition.restartRequired).toBe(true);
			expect(definition.ui?.tab).toBe("tools");
			expect(definition.ui?.group).toBe("Appserver / Remote access");
		}
		expect(SETTINGS_SCHEMA["appserver.remoteMode"].default).toBe("local");
		expect(SETTINGS_SCHEMA["appserver.remotePort"].min).toBe(1);
		expect(SETTINGS_SCHEMA["appserver.remotePort"].max).toBe(65_535);
		expect(SETTINGS_SCHEMA["appserver.remoteOrigins"].maxItems).toBe(64);
	});

	test("status stays lazy and does not load settings", async () => {
		let loaded = 0;
		const result = await runAppserverStatus({
			loadSettings: async () => {
				loaded += 1;
				throw new Error("status must not load settings");
			},
			readHealth: async () => health,
		});
		expect(result).toEqual({ state: "running", health });
		expect(loaded).toBe(0);
	});
});

describe("same-install RPC child invocation", () => {
	test("compiled binaries execute themselves without a script prefix", () => {
		const invocation = resolveRpcChildInvocation({ compiled: true, executable: "/opt/omp" });
		expect(new BunRpcChildFactory(invocation).argv("/tmp/session.jsonl")).toEqual([
			"/opt/omp",
			"--mode",
			"rpc",
			"--session",
			"/tmp/session.jsonl",
		]);
	});

	test("source and npm invocations preserve their exact Bun script prefix", () => {
		const source = new BunRpcChildFactory(
			resolveRpcChildInvocation({ compiled: false, executable: "/usr/bin/bun", main: "/repo/src/cli.ts" }),
		);
		const npm = new BunRpcChildFactory(
			resolveRpcChildInvocation({ compiled: false, executable: "/usr/bin/bun", main: "/opt/omp/dist/cli.js" }),
		);
		expect(source.argv("session")).toEqual([
			"/usr/bin/bun",
			"/repo/src/cli.ts",
			"--mode",
			"rpc",
			"--session",
			"session",
		]);
		expect(npm.argv("session")).toEqual([
			"/usr/bin/bun",
			"/opt/omp/dist/cli.js",
			"--mode",
			"rpc",
			"--session",
			"session",
		]);
	});
});
