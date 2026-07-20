import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { hostId } from "@oh-my-pi/app-wire";
import { BunRpcChildFactory, profileSocketPath, resolveRpcChildInvocation } from "@oh-my-pi/appserver";
import {
	type AppserverHealth,
	activeAppserverLocalIdentity,
	activeAppserverSocketPath,
	runAppserverDevices,
	runAppserverDrainIfIdle,
	runAppserverPair,
	runAppserverRevoke,
	runAppserverStatus,
} from "@oh-my-pi/pi-coding-agent/cli/appserver-cli";
import { commands, isSubcommand } from "@oh-my-pi/pi-coding-agent/cli-commands";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getActiveProfile, getAgentDir, setProfile } from "@oh-my-pi/pi-utils/dirs";

const health: AppserverHealth = { ok: true, hostId: "host-test", epoch: "epoch-test" };
const drainHealth = { ok: true as const, hostId: hostId("host-test"), epoch: "epoch-test" };
const drainBusy = {
	connections: 0,
	inflightMessages: 0,
	startingSupervisors: 0,
	lifecycleMutations: 0,
	sessionOperations: 0,
	activePrompts: 0,
	rpcSupervisorsWithPendingCalls: 0,
	busySessions: 0,
	openTerminalSessions: 0,
	pendingConfirmations: 0,
	outboundSends: 0,
};
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

	test("every control action routes to the active named profile", async () => {
		const originalProfile = getActiveProfile();
		const previousExitCode = process.exitCode;
		const write = spyOn(process.stdout, "write").mockImplementation(() => true);
		const requests: Array<{ socketPath: string; path: string; method: "GET" | "POST" }> = [];
		try {
			setProfile(undefined);
			expect(activeAppserverLocalIdentity()).toEqual({ socketPath: profileSocketPath(undefined) });
			setProfile("profile-route-test");
			process.exitCode = 0;
			const expectedSocket = profileSocketPath("profile-route-test");
			expect(activeAppserverSocketPath()).toBe(expectedSocket);
			expect(activeAppserverLocalIdentity()).toEqual({
				socketPath: expectedSocket,
				hostIdPath: join(getAgentDir(), "appserver", "host-id"),
			});
			const adminRequest = async (socketPath: string, path: string, method: "GET" | "POST"): Promise<unknown> => {
				requests.push({ socketPath, path, method });
				if (path === "/admin/drain-if-idle") return { state: "draining", health: drainHealth, busy: drainBusy };
				if (path === "/admin/pair-ticket") return { code: "123456", expiresAt: Date.now() + 60_000 };
				if (path === "/admin/devices") return { devices: [] };
				if (path === "/admin/revoke") return { revoked: true };
				throw new Error(`unexpected admin path ${path}`);
			};
			const deps = { adminRequest };
			expect(
				await runAppserverStatus({
					readHealth: async socketPath => {
						requests.push({ socketPath, path: "/health", method: "GET" });
						return health;
					},
				}),
			).toEqual({ state: "running", health });
			await runAppserverDrainIfIdle(deps, {
				expectedHostId: "host-test",
				expectedEpoch: "epoch-test",
			});
			await runAppserverPair(deps);
			await runAppserverDevices(deps);
			await runAppserverRevoke(deps, "device-test");

			expect(requests).toEqual([
				{ socketPath: expectedSocket, path: "/health", method: "GET" },
				{ socketPath: expectedSocket, path: "/admin/drain-if-idle", method: "POST" },
				{ socketPath: expectedSocket, path: "/admin/pair-ticket", method: "POST" },
				{ socketPath: expectedSocket, path: "/admin/devices", method: "GET" },
				{ socketPath: expectedSocket, path: "/admin/revoke", method: "POST" },
			]);
		} finally {
			setProfile(originalProfile);
			write.mockRestore();
			process.exitCode = previousExitCode ?? 0;
		}
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
});

describe("appserver drain CLI", () => {
	test("runtime help proves the drain capability and the action enforces its identity fence", async () => {
		const cli = join(import.meta.dir, "../src/cli.ts");
		const help = Bun.spawn([process.execPath, cli, "appserver", "drain-if-idle", "--help"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [helpStatus, helpStdout, helpStderr] = await Promise.all([
			help.exited,
			new Response(help.stdout).text(),
			new Response(help.stderr).text(),
		]);
		expect(helpStatus).toBe(0);
		expect(helpStderr).toBe("");
		expect(helpStdout).toContain("ACTION   Appserver action (status|drain-if-idle|pair|devices|revoke)");
		expect(helpStdout).toContain("omp appserver drain-if-idle --expected-host-id HOST --expected-epoch EPOCH --json");

		const probe = Bun.spawn([process.execPath, cli, "appserver", "drain-if-idle"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [probeStatus, probeStdout, probeStderr] = await Promise.all([
			probe.exited,
			new Response(probe.stdout).text(),
			new Response(probe.stderr).text(),
		]);
		expect(probeStatus).toBe(1);
		expect(probeStdout).toBe("");
		expect(probeStderr).toBe("appserver usage/error: --expected-host-id is required\n");
	});

	test("posts the exact expected identity and emits the validated draining result", async () => {
		let request:
			| {
					socketPath: string;
					path: string;
					method: "GET" | "POST";
					body?: Record<string, unknown>;
			  }
			| undefined;
		let output = "";
		const write = spyOn(process.stdout, "write").mockImplementation(chunk => {
			output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		try {
			const expected = { state: "draining" as const, health: drainHealth, busy: drainBusy };
			const result = await runAppserverDrainIfIdle(
				{
					socketPath: () => "/tmp/test-appserver.sock",
					adminRequest: async (socketPath, path, method, body) => {
						request = { socketPath, path, method, body };
						return expected;
					},
				},
				{ json: true, expectedHostId: "host-test", expectedEpoch: "epoch-test" },
			);

			expect(request).toEqual({
				socketPath: "/tmp/test-appserver.sock",
				path: "/admin/drain-if-idle",
				method: "POST",
				body: { expectedHostId: "host-test", expectedEpoch: "epoch-test" },
			});
			expect(result).toEqual(expected);
			expect(output).toBe(`${JSON.stringify(expected)}\n`);
			expect(process.exitCode).toBe(0);
		} finally {
			write.mockRestore();
			process.exitCode = previousExitCode ?? 0;
		}
	});

	test("maps busy and identity mismatch results to the temporary-failure exit code", async () => {
		const write = spyOn(process.stdout, "write").mockImplementation(() => true);
		const previousExitCode = process.exitCode;
		try {
			for (const state of ["busy", "identity_mismatch"] as const) {
				process.exitCode = 0;
				const expected =
					state === "busy"
						? { state, health: drainHealth, busy: { ...drainBusy, connections: 1 } }
						: {
								state,
								health: { ...drainHealth, hostId: hostId("another-host") },
								busy: drainBusy,
							};
				expect(
					await runAppserverDrainIfIdle(
						{ adminRequest: async () => expected },
						{ json: true, expectedHostId: "host-test", expectedEpoch: "epoch-test" },
					),
				).toEqual(expected);
				expect(process.exitCode).toBe(75);
			}
		} finally {
			write.mockRestore();
			process.exitCode = previousExitCode ?? 0;
		}
	});

	test("rejects responses that violate the required drain safety schema", async () => {
		const malformed: unknown[] = [
			{ state: "running", health: drainHealth, busy: drainBusy },
			{ state: "draining", health: { ...drainHealth, ok: false }, busy: drainBusy },
			{ state: "draining", health: { ...drainHealth, epoch: "another-epoch" }, busy: drainBusy },
			{
				state: "busy",
				health: { ...drainHealth, hostId: hostId("another-host") },
				busy: { ...drainBusy, connections: 1 },
			},
			{ state: "identity_mismatch", health: drainHealth, busy: drainBusy },
			{ state: "draining", health: drainHealth, busy: { ...drainBusy, connections: 1 } },
			{ state: "busy", health: drainHealth, busy: drainBusy },
			{ state: "draining", health: drainHealth, busy: { ...drainBusy, outboundSends: -1 } },
			{ state: "draining", health: drainHealth, busy: { ...drainBusy, outboundSends: 0.5 } },
			{
				state: "draining",
				health: drainHealth,
				busy: {
					connections: 0,
					inflightMessages: 0,
					startingSupervisors: 0,
					lifecycleMutations: 0,
					sessionOperations: 0,
					activePrompts: 0,
					rpcSupervisorsWithPendingCalls: 0,
					busySessions: 0,
					openTerminalSessions: 0,
					pendingConfirmations: 0,
				},
			},
		];
		const write = spyOn(process.stdout, "write").mockImplementation(() => true);
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		try {
			for (const response of malformed) {
				await expect(
					runAppserverDrainIfIdle(
						{ adminRequest: async () => response },
						{ json: true, expectedHostId: "host-test", expectedEpoch: "epoch-test" },
					),
				).rejects.toThrow("malformed appserver drain response");
			}
			expect(write).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(0);
		} finally {
			write.mockRestore();
			process.exitCode = previousExitCode ?? 0;
		}
	});

	test("accepts additive diagnostics while returning only the known safety contract", async () => {
		const write = spyOn(process.stdout, "write").mockImplementation(() => true);
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		try {
			const result = await runAppserverDrainIfIdle(
				{
					adminRequest: async () => ({
						state: "draining",
						health: { ...drainHealth, draining: true },
						busy: { ...drainBusy, futureWork: 0 },
						diagnostics: { generation: 2 },
					}),
				},
				{ json: true, expectedHostId: "host-test", expectedEpoch: "epoch-test" },
			);

			expect(result).toEqual({ state: "draining", health: drainHealth, busy: drainBusy });
			expect(process.exitCode).toBe(0);
		} finally {
			write.mockRestore();
			process.exitCode = previousExitCode ?? 0;
		}
	});
});

describe("appserver settings catalog", () => {
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
