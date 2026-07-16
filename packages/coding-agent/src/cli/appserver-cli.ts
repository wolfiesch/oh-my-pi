import * as http from "node:http";
import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import type { AppserverDrainBusy, AppserverDrainResult, AppserverHandle } from "@oh-my-pi/appserver";
import { createRemoteAppserver, profileSocketPath } from "@oh-my-pi/appserver";
import { getActiveProfile, getAgentDir, getBlobsDir, getProfileRootDir, postmortem } from "@oh-my-pi/pi-utils";
import type { Settings as SettingsType } from "../config/settings";
import { getCodingAgentAppserverIdentity } from "./appserver-identity";

export type AppserverAction = "serve" | "status" | "drain-if-idle" | "pair" | "devices" | "revoke";
export type RemoteMode = "direct" | "serve";

export interface AppserverServeConfig {
	remoteMode?: RemoteMode;
	remoteAddress?: string;
	remotePort?: number;
	remoteOrigins?: readonly string[];
	remoteStateDir?: string;
	trustedServeProxy?: boolean;
}

export interface AppserverCommandArgs {
	action: AppserverAction;
	flags: {
		json?: boolean;
		serve?: AppserverServeConfig;
		capabilities?: readonly string[];
		ttlSeconds?: number;
		expectedNodeId?: string;
		expectedHostId?: string;
		expectedEpoch?: string;
		deviceId?: string;
	};
}

export interface AppserverHealth {
	ok: true;
	hostId: string;
	epoch: string;
}

export interface ActiveAppserverLocalIdentity {
	socketPath: string;
	hostIdPath?: string;
}

export interface AppserverDeviceSummary {
	deviceId: string;
	label: string;
	platform?: string;
	capabilities: readonly string[];
	createdAt: number;
	lastSeenAt: number | null;
	revokedAt: number | null;
}

export type AppserverStatus =
	| { state: "running"; health: AppserverHealth }
	| { state: "stopped"; reason: "unreachable" | "malformed" | "failed" };
export interface AppserverRunnerDeps {
	createAppserver?: (config?: AppserverServeConfig) => AppserverHandle | Promise<AppserverHandle>;
	/** Optional serve-only settings source. Status/admin actions never consult it. */
	settings?: Pick<SettingsType, "get">;
	loadSettings?: () => Promise<Pick<SettingsType, "get">>;
	readHealth?: (socketPath: string, timeoutMs: number) => Promise<unknown>;
	socketPath?: () => string;
	timeoutMs?: number;
	adminRequest?: (
		socketPath: string,
		path: string,
		method: "GET" | "POST",
		body?: Record<string, unknown>,
	) => Promise<unknown>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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
	if (!isRecord(value) || value.ok !== true || !validIdentifier(value.hostId) || !validIdentifier(value.epoch)) {
		throw new Error("malformed appserver health response");
	}
	return {
		ok: true,
		hostId: value.hostId,
		epoch: value.epoch,
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
async function readUnixAdmin(
	socketPath: string,
	path: string,
	method: "GET" | "POST",
	body?: Record<string, unknown>,
): Promise<unknown> {
	const gate = Promise.withResolvers<unknown>();
	const payload = body === undefined ? undefined : JSON.stringify(body);
	const request = http.request(
		{
			socketPath,
			path,
			method,
			headers:
				payload === undefined
					? undefined
					: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
		},
		response => {
			const chunks: Buffer[] = [];
			let total = 0;
			response.on("data", chunk => {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				total += bytes.byteLength;
				if (total > 16_384) request.destroy(new Error("admin response too large"));
				else chunks.push(bytes);
			});
			response.once("end", () => {
				if (response.statusCode !== 200) {
					gate.reject(new Error("admin request failed"));
					return;
				}
				try {
					gate.resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch {
					gate.reject(new Error("malformed admin response"));
				}
			});
			response.once("error", error => gate.reject(error));
		},
	);
	request.once("error", error => gate.reject(error));
	request.setTimeout(1_500, () => request.destroy(new Error("admin request timed out")));
	if (payload !== undefined) request.write(payload);
	request.end();
	return gate.promise;
}

const MAX_REMOTE_ORIGINS = 64;
const MAX_REMOTE_ORIGIN_LENGTH = 1024;

function hasRemoteFlags(config: AppserverServeConfig): boolean {
	return (
		config.remoteMode !== undefined ||
		config.remoteAddress !== undefined ||
		config.remotePort !== undefined ||
		config.remoteOrigins !== undefined ||
		config.remoteStateDir !== undefined ||
		config.trustedServeProxy !== undefined
	);
}

function validateOrigins(origins: unknown, errorMessage: string, enforceCount = false): readonly string[] | undefined {
	if (origins === undefined) return undefined;
	if (!Array.isArray(origins) || (enforceCount && origins.length > MAX_REMOTE_ORIGINS)) throw new Error(errorMessage);
	for (const origin of origins) {
		if (typeof origin !== "string" || origin.length === 0 || origin.length > MAX_REMOTE_ORIGIN_LENGTH)
			throw new Error(errorMessage);
	}
	return origins;
}

function isAllZeroIpv6(address: string): boolean {
	if (isIP(address) !== 6) return false;
	return address.split(":").every(group => group.length === 0 || /^0+$/u.test(group));
}

function validatePersistedAddress(address: unknown): string {
	if (
		typeof address !== "string" ||
		address.length === 0 ||
		isIP(address) === 0 ||
		address === "0.0.0.0" ||
		address === "::" ||
		isAllZeroIpv6(address)
	)
		throw new Error("appserver.remoteAddress must be a concrete non-wildcard IP address");
	return address;
}

function persistedServeConfig(settings: Pick<SettingsType, "get">): AppserverServeConfig {
	const mode = settings.get("appserver.remoteMode");
	if (mode === "local") return {};
	if (mode !== "direct") throw new Error("appserver.remoteMode must be local or direct");
	const address = validatePersistedAddress(settings.get("appserver.remoteAddress"));
	const port = settings.get("appserver.remotePort");
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
		throw new Error("appserver.remotePort must be between 1 and 65535");
	const origins =
		validateOrigins(
			settings.get("appserver.remoteOrigins"),
			"appserver.remoteOrigins contains an invalid origin",
			true,
		) ?? [];
	return { remoteMode: "direct", remoteAddress: address, remotePort: port, remoteOrigins: origins };
}

// Deliberately lazy: status and admin actions must not load Settings or the runtime graph.
async function defaultLoadAppserverSettings(): Promise<SettingsType> {
	const { Settings } = await import("../config/settings");
	return Settings.init({ cwd: process.cwd() });
}

// This is intentionally a lazy boundary: `status`, `pair`, `devices`, and `revoke` must not load the native PTY graph.
async function defaultCreateAppserver(
	config?: AppserverServeConfig,
	settingsOverride?: SettingsType,
): Promise<AppserverHandle> {
	const [
		{ createAppserver },
		{ createAppserverRuntime },
		{ Settings },
		sdk,
		modelModule,
		registryModule,
		pluginModule,
	] = await Promise.all([
		import("@oh-my-pi/appserver"),
		import("../session/appserver-authority"),
		import("../config/settings"),
		import("../sdk"),
		import("../config/model-registry"),
		import("../registry/agent-registry"),
		import("../extensibility/plugins/manager"),
	]);
	const cwd = process.cwd();
	let settings: SettingsType | undefined = settingsOverride;
	if (!settings) {
		try {
			settings = await Settings.init({ cwd });
		} catch {}
	}
	const runtimeOptions: Parameters<typeof createAppserverRuntime>[0] = {};
	if (settings) runtimeOptions.settings = settings;
	try {
		const authStorage = await sdk.discoverAuthStorage();
		runtimeOptions.authStorage = authStorage;
		const modelRegistry = new modelModule.ModelRegistry(authStorage);
		runtimeOptions.modelRegistry = modelRegistry;
		if (settings) {
			try {
				await sdk.loadCliExtensionProviders(modelRegistry, settings, cwd);
			} catch {}
		}
	} catch {}
	try {
		runtimeOptions.agentRegistry = registryModule.AgentRegistry.global();
	} catch {}
	runtimeOptions.skillsLoader = async () => {
		try {
			return (await sdk.discoverSkills(cwd)).skills;
		} catch {
			return [];
		}
	};
	try {
		runtimeOptions.pluginManager = new pluginModule.PluginManager(cwd);
	} catch {}
	const runtime = createAppserverRuntime(runtimeOptions);
	const base = {
		...getCodingAgentAppserverIdentity(),
		...activeAppserverLocalIdentity(),
		sessionAuthority: runtime.sessionAuthority,
		discovery: runtime.discovery,
		operationsAuthority: runtime.operationsAuthority,
		projectRootForProject: runtime.projectRootForProject,
		usageAuthority: runtime.usageAuthority,
		lockCheck: runtime.lockCheck,
		transcriptImageRoot: getBlobsDir(),
	};
	if (!config?.remoteMode) return createAppserver(base);
	if (!config.remoteAddress || !config.remoteStateDir)
		throw new Error("remote mode requires address and state directory");
	const endpoint = {
		address: config.remoteAddress,
		port: config.remotePort ?? 8787,
		originAllowlist: config.remoteOrigins,
		serveProxy: config.remoteMode === "serve",
		trustedServeProxy: config.trustedServeProxy,
	};
	return createRemoteAppserver({ stateDir: config.remoteStateDir, remoteEndpoint: endpoint, appserver: base });
}
export function activeAppserverLocalIdentity(): ActiveAppserverLocalIdentity {
	const profile = getActiveProfile();
	return {
		socketPath: profileSocketPath(profile),
		...(profile ? { hostIdPath: join(getAgentDir(), "appserver", "host-id") } : {}),
	};
}
export function activeAppserverSocketPath(): string {
	return activeAppserverLocalIdentity().socketPath;
}
function defaultRemoteStateDir(): string {
	return join(getProfileRootDir(getActiveProfile()), "appserver");
}
export function validateAppserverServeConfig(config: AppserverServeConfig = {}): AppserverServeConfig {
	const remoteFlags = hasRemoteFlags(config);
	if (!config.remoteMode) {
		if (remoteFlags) throw new Error("remote-only flags require --remote-mode");
		return {};
	}
	if (config.remoteMode !== "direct" && config.remoteMode !== "serve") throw new Error("remote mode is invalid");
	if (!config.remoteAddress || typeof config.remoteAddress !== "string")
		throw new Error("remote mode requires --remote-address");
	if (
		!Number.isSafeInteger(config.remotePort ?? 8787) ||
		(config.remotePort ?? 8787) < 1 ||
		(config.remotePort ?? 8787) > 65_535
	)
		throw new Error("--remote-port is invalid");
	if (!config.remoteStateDir) config.remoteStateDir = defaultRemoteStateDir();
	if (!isAbsolute(config.remoteStateDir)) throw new Error("--remote-state-dir must be absolute");
	validateOrigins(config.remoteOrigins, "--remote-origin is invalid");
	if (config.remoteMode === "serve") {
		if (config.remoteAddress !== "127.0.0.1" && config.remoteAddress !== "::1")
			throw new Error("Serve remote address must be loopback");
		if (config.trustedServeProxy !== true) throw new Error("Serve mode requires --trusted-serve-proxy");
	} else if (config.trustedServeProxy === true) {
		throw new Error("--trusted-serve-proxy is only valid with Serve mode");
	}
	return config;
}

export async function runAppserverServe(
	deps: AppserverRunnerDeps = {},
	rawConfig: AppserverServeConfig = {},
): Promise<void> {
	let loadedSettings: SettingsType | undefined;
	let config: AppserverServeConfig;
	if (hasRemoteFlags(rawConfig)) {
		// Any explicit remote flag is authoritative, including intentionally
		// invalid combinations that validation should report to the caller.
		config = validateAppserverServeConfig({ ...rawConfig });
	} else {
		let settings = deps.settings;
		if (!settings) {
			if (deps.loadSettings) settings = await deps.loadSettings();
			else {
				loadedSettings = await defaultLoadAppserverSettings();
				settings = loadedSettings;
			}
		}
		config = validateAppserverServeConfig(persistedServeConfig(settings));
	}
	const create = deps.createAppserver ?? (value => defaultCreateAppserver(value, loadedSettings));
	const registerCleanup =
		deps.registerCleanup ??
		((id: string, callback: (reason: unknown) => void | Promise<void>) => postmortem.register(id, callback));
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
	const shutdown = (): void => {
		cleanupRequested = true;
		stopRequested = true;
		stopOnce();
	};
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
		appserver = await create(config);
		try {
			await appserver.start();
		} catch (error) {
			if (cleanupRequested) {
				stopOnce();
				if (stopStarted) await stopped.promise;
				return;
			}
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
	const socketPath = (deps.socketPath ?? activeAppserverSocketPath)();
	try {
		const health = parseHealth(await readHealth(socketPath, deps.timeoutMs ?? STATUS_TIMEOUT_MS));
		return { state: "running", health };
	} catch (error) {
		const reason = error instanceof Error && error.message.includes("malformed") ? "malformed" : "unreachable";
		return { state: "stopped", reason };
	}
}
function writeStatus(status: AppserverStatus, json: boolean): void {
	if (json) process.stdout.write(`${JSON.stringify(status)}\n`);
	else if (status.state === "running")
		process.stdout.write(`appserver running (host ${status.health.hostId}, epoch ${status.health.epoch})\n`);
	else process.stderr.write(`appserver stopped (${status.reason})\n`);
	if (status.state === "stopped") process.exitCode = 1;
}
function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
const DRAIN_BUSY_KEYS = [
	"connections",
	"inflightMessages",
	"startingSupervisors",
	"lifecycleMutations",
	"sessionOperations",
	"activePrompts",
	"rpcSupervisorsWithPendingCalls",
	"busySessions",
	"openTerminalSessions",
	"pendingConfirmations",
	"outboundSends",
] as const satisfies readonly (keyof AppserverDrainBusy)[];
function parseDrainResult(value: unknown): AppserverDrainResult {
	if (!isRecord(value) || !["draining", "busy", "identity_mismatch"].includes(String(value.state)))
		throw new Error("malformed appserver drain response");
	let health: AppserverHealth;
	try {
		health = parseHealth(value.health);
	} catch {
		throw new Error("malformed appserver drain response");
	}
	if (!isRecord(value.busy)) throw new Error("malformed appserver drain response");
	const busy = {} as Record<(typeof DRAIN_BUSY_KEYS)[number], number>;
	for (const key of DRAIN_BUSY_KEYS) {
		const count = value.busy[key];
		if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error("malformed appserver drain response");
		busy[key] = count as number;
	}
	const counts = Object.values(busy);
	if (value.state === "draining" && counts.some(count => count !== 0))
		throw new Error("malformed appserver drain response");
	if (value.state === "busy" && counts.every(count => count === 0))
		throw new Error("malformed appserver drain response");
	return { state: value.state, health, busy } as AppserverDrainResult;
}
export async function runAppserverDrainIfIdle(
	deps: AppserverRunnerDeps = {},
	flags: AppserverCommandArgs["flags"] = {},
): Promise<AppserverDrainResult> {
	if (!validIdentifier(flags.expectedHostId)) throw new Error("--expected-host-id is required");
	if (!validIdentifier(flags.expectedEpoch)) throw new Error("--expected-epoch is required");
	const socketPath = (deps.socketPath ?? activeAppserverSocketPath)();
	const request = deps.adminRequest ?? readUnixAdmin;
	const result = parseDrainResult(
		await request(socketPath, "/admin/drain-if-idle", "POST", {
			expectedHostId: flags.expectedHostId,
			expectedEpoch: flags.expectedEpoch,
		}),
	);
	const identityMatches = result.health.hostId === flags.expectedHostId && result.health.epoch === flags.expectedEpoch;
	if ((result.state === "identity_mismatch") === identityMatches)
		throw new Error("malformed appserver drain response");
	if (flags.json) writeJson(result);
	else if (result.state === "draining")
		process.stdout.write(`appserver draining (host ${result.health.hostId}, epoch ${result.health.epoch})\n`);
	else process.stderr.write(`appserver drain deferred (${result.state})\n`);
	if (result.state !== "draining") process.exitCode = 75;
	return result;
}
function parseTicket(value: unknown): { code: string; expiresAt: number } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed pair ticket response");
	const body = value as Record<string, unknown>;
	if (
		typeof body.code !== "string" ||
		!/^\d{6}$/u.test(body.code) ||
		typeof body.expiresAt !== "number" ||
		!Number.isFinite(body.expiresAt)
	)
		throw new Error("malformed pair ticket response");
	return { code: body.code, expiresAt: body.expiresAt };
}
export async function runAppserverPair(
	deps: AppserverRunnerDeps = {},
	flags: AppserverCommandArgs["flags"] = {},
): Promise<void> {
	const capabilities = flags.capabilities?.length ? [...flags.capabilities] : ["sessions.read"];
	if (capabilities.length > 32 || capabilities.some(capability => capability.length === 0 || capability.length > 128))
		throw new Error("--capability is invalid");
	const ttlSeconds = flags.ttlSeconds ?? 120;
	if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 120)
		throw new Error("--ttl-seconds must be between 1 and 120");
	if (flags.expectedNodeId !== undefined && (flags.expectedNodeId.length === 0 || flags.expectedNodeId.length > 512))
		throw new Error("--expected-node-id is invalid");
	const socketPath = (deps.socketPath ?? activeAppserverSocketPath)();
	const request = deps.adminRequest ?? readUnixAdmin;
	const ticket = parseTicket(
		await request(socketPath, "/admin/pair-ticket", "POST", {
			capabilities,
			ttlMs: ttlSeconds * 1000,
			...(flags.expectedNodeId ? { expectedNodeId: flags.expectedNodeId } : {}),
		}),
	);
	if (flags.json) writeJson(ticket);
	else process.stdout.write(`pair code ${ticket.code} expires ${new Date(ticket.expiresAt).toISOString()}\n`);
}
export async function runAppserverDevices(deps: AppserverRunnerDeps = {}, json = false): Promise<void> {
	const socketPath = (deps.socketPath ?? activeAppserverSocketPath)();
	const request = deps.adminRequest ?? readUnixAdmin;
	const result = await request(socketPath, "/admin/devices", "GET");
	if (!isRecord(result)) throw new Error("malformed devices response");
	if (json) writeJson(result);
	else {
		const devices = result.devices;
		if (!Array.isArray(devices)) throw new Error("malformed devices response");
		for (const device of devices) {
			if (!isRecord(device)) throw new Error("malformed devices response");
			process.stdout.write(`${String(device.deviceId)} ${String(device.label)}\n`);
		}
	}
}
export async function runAppserverRevoke(
	deps: AppserverRunnerDeps = {},
	deviceId?: string,
	json = false,
): Promise<void> {
	if (!deviceId || deviceId.length > 512) throw new Error("--device-id is required");
	const socketPath = (deps.socketPath ?? activeAppserverSocketPath)();
	const request = deps.adminRequest ?? readUnixAdmin;
	const result = await request(socketPath, "/admin/revoke", "POST", { deviceId });
	if (!isRecord(result) || result.revoked !== true) throw new Error("malformed revoke response");
	if (json) writeJson(result);
	else process.stdout.write(`revoked ${deviceId}\n`);
}
export async function runAppserverCommand(cmd: AppserverCommandArgs, deps: AppserverRunnerDeps = {}): Promise<void> {
	if (cmd.action === "serve") {
		await runAppserverServe(deps, cmd.flags.serve);
		return;
	}
	if (cmd.action === "pair") {
		await runAppserverPair(deps, cmd.flags);
		return;
	}
	if (cmd.action === "devices") {
		await runAppserverDevices(deps, cmd.flags.json === true);
		return;
	}
	if (cmd.action === "revoke") {
		await runAppserverRevoke(deps, cmd.flags.deviceId, cmd.flags.json === true);
		return;
	}
	if (cmd.action === "drain-if-idle") {
		await runAppserverDrainIfIdle(deps, cmd.flags);
		return;
	}
	const status = await runAppserverStatus(deps);
	writeStatus(status, cmd.flags.json === true);
}
