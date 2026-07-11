import * as http from "node:http";
import { defaultSocketPath } from "@oh-my-pi/appserver";
import type { AppserverHandle } from "@oh-my-pi/appserver";
import { postmortem } from "@oh-my-pi/pi-utils";

export type AppserverAction = "serve" | "status";

export interface AppserverCommandArgs {
	action: AppserverAction;
	flags: { json?: boolean };
}

export interface AppserverHealth {
	ok: true;
	hostId: string;
	epoch: string;
}

export type AppserverStatus =
	| { state: "running"; health: AppserverHealth }
	| { state: "stopped"; reason: "unreachable" | "malformed" | "failed" };

export interface AppserverRunnerDeps {
	createAppserver?: () => AppserverHandle | Promise<AppserverHandle>;
	readHealth?: (socketPath: string, timeoutMs: number) => Promise<unknown>;
	socketPath?: () => string;
	timeoutMs?: number;
	onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
	removeSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
	registerCleanup?: (id: string, callback: (reason: unknown) => void | Promise<void>) => () => void;
}

const MAX_HEALTH_BYTES = 16 * 1024;
const MAX_ID_BYTES = 1024;
const STATUS_TIMEOUT_MS = 1_500;

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function validIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
	value.length > 0 &&
	byteLength(value) <= MAX_ID_BYTES &&
	[...value].every(char => {
		const code = char.codePointAt(0) ?? 0;
		return code >= 0x20 && code !== 0x7f;
	})
	);
}

function parseHealth(value: unknown): AppserverHealth {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(value as Record<string, unknown>).ok !== true ||
		!validIdentifier((value as Record<string, unknown>).hostId) ||
		!validIdentifier((value as Record<string, unknown>).epoch)
	) {
		throw new Error("malformed appserver health response");
	}
	return {
		ok: true,
		hostId: (value as Record<string, unknown>).hostId as string,
		epoch: (value as Record<string, unknown>).epoch as string,
	};
}

async function readUnixHealth(socketPath: string, timeoutMs: number): Promise<unknown> {
	const gate = Promise.withResolvers<unknown>();
	let settled = false;
	const settle = (fn: () => void): void => {
		if (settled) return;
		settled = true;
		fn();
	};
	const request = http.request({ socketPath, path: "/health", method: "GET" }, response => {
		const chunks: Buffer[] = [];
		let total = 0;
		response.on("data", chunk => {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += bytes.byteLength;
			if (total > MAX_HEALTH_BYTES) {
				request.destroy(new Error("appserver health response is too large"));
				return;
			}
			chunks.push(bytes);
		});
		response.once("end", () => {
			if (response.statusCode !== 200) {
				settle(() => gate.reject(new Error(`appserver health returned HTTP ${response.statusCode ?? 0}`)));
				return;
			}
			try {
				settle(() => gate.resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
			} catch {
				settle(() => gate.reject(new Error("malformed appserver health response")));
			}
		});
		response.once("error", error => settle(() => gate.reject(error)));
	});
	request.once("error", error => settle(() => gate.reject(error)));
	request.setTimeout(timeoutMs, () => {
		request.destroy(new Error("appserver health request timed out"));
	});
	request.end();
	return gate.promise;
}

// Keep the private appserver graph out of unrelated CLI commands; the command
// loader is intentionally the runtime-selected boundary for this package.
async function defaultCreateAppserver(): Promise<AppserverHandle> {
  const [{ createAppserver }, { createAppserverAuthority, appserverLockCheck }] = await Promise.all([import("@oh-my-pi/appserver"), import("../session/appserver-authority")]);
  const authority = createAppserverAuthority();
  return createAppserver({ sessionAuthority: authority, discovery: authority, lockCheck: appserverLockCheck });
}

function defaultOnSignal(signal: NodeJS.Signals, handler: () => void): void {
	process.on(signal, handler);
}

function defaultRemoveSignal(signal: NodeJS.Signals, handler: () => void): void {
	process.off(signal, handler);
}

export async function runAppserverServe(deps: AppserverRunnerDeps = {}): Promise<void> {
  const create = deps.createAppserver ?? defaultCreateAppserver;
  const registerCleanup = deps.registerCleanup ?? ((id: string, callback: (reason: unknown) => void | Promise<void>) => postmortem.register(id, callback));
  const stopped = Promise.withResolvers<void>();
  let appserver: AppserverHandle | undefined;
  let stopRequested = false;
  let stopStarted = false;
  let cleanupRequested = false;
  const stopOnce = (): void => {
    if (stopStarted || !appserver) return;
    stopStarted = true;
    void appserver.stop().then(stopped.resolve, stopped.reject);
  };
  const shutdown = (): void => { cleanupRequested = true; stopRequested = true; stopOnce(); };
  const unregister = registerCleanup("omp-appserver", async reason => {
    if (reason !== "sigint" && reason !== "sigterm") return;
    shutdown();
    if (appserver) await stopped.promise;
  });
  if (deps.onSignal) {
    deps.onSignal("SIGINT", shutdown);
    deps.onSignal("SIGTERM", shutdown);
  }
  try {
    appserver = await create();
    try {
      await appserver.start();
    } catch (error) {
      if (cleanupRequested) { stopOnce(); if (stopStarted) await stopped.promise; return; }
      throw error;
    }
    if (stopRequested) stopOnce();
    await stopped.promise;
  } finally {
    if (deps.removeSignal && deps.onSignal) {
      deps.removeSignal("SIGINT", shutdown);
      deps.removeSignal("SIGTERM", shutdown);
    }
    unregister();
  }
}

export async function runAppserverStatus(deps: AppserverRunnerDeps = {}): Promise<AppserverStatus> {
	const readHealth = deps.readHealth ?? readUnixHealth;
	const socketPath = (deps.socketPath ?? defaultSocketPath)();
	try {
		const health = parseHealth(await readHealth(socketPath, deps.timeoutMs ?? STATUS_TIMEOUT_MS));
		return { state: "running", health };
	} catch (error) {
		const reason = error instanceof Error && error.message.includes("malformed") ? "malformed" : "unreachable";
		return { state: "stopped", reason };
	}
}

function writeStatus(status: AppserverStatus, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(status)}\n`);
	} else if (status.state === "running") {
		process.stdout.write(`appserver running (host ${status.health.hostId}, epoch ${status.health.epoch})\n`);
	} else {
		process.stderr.write(`appserver stopped (${status.reason})\n`);
	}
	if (status.state === "stopped") process.exitCode = 1;
}

export async function runAppserverCommand(cmd: AppserverCommandArgs, deps: AppserverRunnerDeps = {}): Promise<void> {
	if (cmd.action === "serve") {
		await runAppserverServe(deps);
		return;
	}
	const status = await runAppserverStatus(deps);
	writeStatus(status, cmd.flags.json === true);
}
