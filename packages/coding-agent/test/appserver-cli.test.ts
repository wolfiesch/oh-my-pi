import { describe, expect, test } from "bun:test";
import { commands, isSubcommand } from "@oh-my-pi/pi-coding-agent/cli-commands";
import {
	runAppserverServe,
	runAppserverStatus,
	type AppserverHealth,
} from "@oh-my-pi/pi-coding-agent/cli/appserver-cli";
import { BunRpcChildFactory, resolveRpcChildInvocation } from "@oh-my-pi/appserver";

const health: AppserverHealth = { ok: true, hostId: "host-test", epoch: "epoch-test" };

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
		expect(await runAppserverStatus({ readHealth: async () => { throw new Error("timed out"); } })).toEqual({
			state: "stopped",
			reason: "unreachable",
		});
	});

	test("serve starts once, stops once, and removes both signal listeners", async () => {
		let starts = 0;
		let stops = 0;
		const handlers = new Map<string, () => void>();
		const registered = Promise.withResolvers<void>();
		const removed: string[] = [];
		const promise = runAppserverServe({
			createAppserver: () => ({
				hostId: "host-test" as never,
				epoch: "epoch-test",
				socketPath: "/tmp/test-appserver.sock",
				start: async () => { starts += 1; },
				stop: async () => { stops += 1; },
				snapshot: () => undefined,
				replay: () => [],
				command: async () => { throw new Error("unused"); },
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
		await promise;
		expect(starts).toBe(1);
		expect(stops).toBe(1);
		expect(removed.sort()).toEqual(["SIGINT", "SIGTERM"]);
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
		const source = new BunRpcChildFactory(resolveRpcChildInvocation({ compiled: false, executable: "/usr/bin/bun", main: "/repo/src/cli.ts" }));
		const npm = new BunRpcChildFactory(resolveRpcChildInvocation({ compiled: false, executable: "/usr/bin/bun", main: "/opt/omp/dist/cli.js" }));
		expect(source.argv("session")).toEqual(["/usr/bin/bun", "/repo/src/cli.ts", "--mode", "rpc", "--session", "session"]);
		expect(npm.argv("session")).toEqual(["/usr/bin/bun", "/opt/omp/dist/cli.js", "--mode", "rpc", "--session", "session"]);
	});
});
