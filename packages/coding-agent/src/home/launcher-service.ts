import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LaunchResult, ToolDescriptor, ToolId, ToolStatus } from "@oh-my-pi/omp-home";
import { $which, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import type { ProfileEntry } from "./profiles";

const LAUNCH_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;
const FETCH_TIMEOUT_MS = 300;
const OUTPUT_CAPTURE_LIMIT = 4_096;
const LOOPBACK_HOST = "127.0.0.1";

export const TOOL_DESCRIPTORS: Record<ToolId, ToolDescriptor> = {
	stats: {
		id: "stats",
		label: "AI usage dashboard",
		description: "Inspect token, model, cost, and session usage for the selected OMP profile.",
		profileScoped: true,
		defaultPort: 3847,
	},
	mechanism: {
		id: "mechanism",
		label: "Mechanism",
		description: "View live session mechanism traces and event flow for the selected OMP profile.",
		profileScoped: true,
		defaultPort: 3848,
	},
	collab: {
		id: "collab",
		label: "Collab relay",
		description: "Start the local encrypted collaboration relay. Runs once for the machine, not per profile.",
		profileScoped: false,
		defaultPort: 7466,
	},
	robomp: {
		id: "robomp",
		label: "Robomp",
		description: "Run the local Robomp FastAPI service. Runs once for the machine, not per profile.",
		profileScoped: false,
		defaultPort: 8080,
	},
};

export interface OmpExec {
	cmd: string;
	argvPrefix: string[];
}

export interface ToolLaunchSpec {
	cmd: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
}

interface OutputCapture {
	text: string;
	truncated: boolean;
}

interface ProcessExitState {
	exited: boolean;
	exitCode: number | null;
	signalCode: number | null;
}

type ToolSubprocess = Subprocess<"ignore", "pipe", "pipe">;

interface RunningTool {
	child: ToolSubprocess;
	port: number;
	url: string;
	profileId: string | null;
}

export class LauncherError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const runningTools = new Map<string, RunningTool>();

function emptyCapture(): OutputCapture {
	return { text: "", truncated: false };
}

function appendCapture(capture: OutputCapture, chunk: string): void {
	if (!chunk) return;
	const remaining = OUTPUT_CAPTURE_LIMIT - capture.text.length;
	if (remaining <= 0) {
		capture.truncated = true;
		return;
	}
	if (chunk.length > remaining) {
		capture.text += chunk.slice(0, remaining);
		capture.truncated = true;
		return;
	}
	capture.text += chunk;
}

async function captureStream(stream: ReadableStream<Uint8Array>, capture: OutputCapture): Promise<void> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			appendCapture(capture, decoder.decode(chunk.value, { stream: true }));
		}
		appendCapture(capture, decoder.decode());
	} catch {
		// Output capture is best-effort only; the process lifecycle owns failures.
	}
}

function statIsFile(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function statIsDirectory(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

function isInsideOrEqual(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function captureSummary(capture: OutputCapture): string {
	const trimmed = capture.text.trim();
	if (!trimmed) return "";
	return capture.truncated ? `${trimmed}\n…` : trimmed;
}

function processEnvWith(overrides: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	for (const [key, value] of Object.entries(overrides)) env[key] = value;
	return env;
}

function formatExitState(exitState: ProcessExitState): string {
	if (!exitState.exited) return "did not accept connections before the startup timeout";
	if (exitState.exitCode !== null) return `exited with code ${exitState.exitCode}`;
	return `exited with signal ${exitState.signalCode ?? "unknown"}`;
}

function formatLaunchFailure(
	tool: ToolId,
	exitState: ProcessExitState,
	stdout: OutputCapture,
	stderr: OutputCapture,
): string {
	const detail = captureSummary(stderr) || captureSummary(stdout);
	const base = `Failed to launch ${TOOL_DESCRIPTORS[tool].label}: ${formatExitState(exitState)}`;
	return detail ? `${base}\n${detail}` : base;
}

function launchHint(tool: ToolId, port: number): string {
	if (tool === "stats" || tool === "mechanism") {
		const exec = resolveOmpExec();
		return [exec.cmd, ...exec.argvPrefix, tool, "--port", String(port)].join(" ");
	}
	if (tool === "collab") {
		return `bun packages/collab-web/scripts/local-relay.ts --port ${port}`;
	}
	return `ROBOMP_BIND_PORT=${port} python3 -m robomp serve`;
}

function scopedProfileIdForTool(tool: ToolId, profileId: string | null): string | null {
	return TOOL_DESCRIPTORS[tool].profileScoped ? profileId : null;
}

function runningResult(entry: RunningTool): LaunchResult {
	return {
		url: entry.url,
		port: entry.port,
		pid: entry.child.pid,
		scopedProfileId: entry.profileId,
	};
}

function isHttpReachable(port: number): Promise<boolean> {
	return fetch(`http://${LOOPBACK_HOST}:${port}/`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
		.then(async response => {
			await response.body?.cancel();
			return true;
		})
		.catch(() => false);
}

async function waitForPort(port: number, exitState: ProcessExitState): Promise<boolean> {
	const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (exitState.exited) return false;
		if (await isHttpReachable(port)) return true;
		await Bun.sleep(POLL_INTERVAL_MS);
	}
	return false;
}

async function terminateEntry(entry: RunningTool): Promise<void> {
	entry.child.kill("SIGTERM");
	const exitedAfterTerm = await Promise.race([entry.child.exited.then(() => true), Bun.sleep(500).then(() => false)]);
	if (exitedAfterTerm) return;
	entry.child.kill("SIGKILL");
	await Promise.race([entry.child.exited.then(() => true), Bun.sleep(500).then(() => false)]);
}

export function isToolId(value: string): value is ToolId {
	return Object.hasOwn(TOOL_DESCRIPTORS, value);
}

export function toolStateKey(tool: ToolId, profileId: string | null): string {
	return `${tool}:${profileId ?? "main"}`;
}

export function resolveProfileLaunchEnv(profile: Pick<ProfileEntry, "agentDir">): Record<string, string> {
	const homeDir = path.resolve(os.homedir());
	const agentDir = path.resolve(profile.agentDir);
	const configRoot = path.dirname(agentDir);
	const env: Record<string, string> = { PI_CODING_AGENT_DIR: agentDir };

	const namedProfilesRoot = path.join(homeDir, ".omp", "profiles");
	const namedProfileRoot = path.dirname(configRoot);
	if (path.basename(agentDir) === "agent" && path.resolve(namedProfileRoot) === namedProfilesRoot) {
		env.OMP_PROFILE = path.basename(configRoot);
		return env;
	}

	if (isInsideOrEqual(homeDir, configRoot)) {
		const configDir = path.relative(homeDir, configRoot);
		if (configDir) env.PI_CONFIG_DIR = configDir;
	}
	return env;
}

export function resolveOmpExec(): OmpExec {
	const hostEntry = workerHostEntry();
	if (hostEntry) return { cmd: process.execPath, argvPrefix: [hostEntry] };
	const argvEntry = process.argv[1];
	return { cmd: process.execPath, argvPrefix: argvEntry ? [argvEntry] : [] };
}

export function resolveRepoRoot(): string | null {
	let current = import.meta.dir;
	for (;;) {
		if (statIsFile(path.join(current, "bun.lock")) && statIsDirectory(path.join(current, "packages"))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function resolveToolLaunch(tool: ToolId, port: number, env: Record<string, string>): ToolLaunchSpec | null {
	if (tool === "stats" || tool === "mechanism") {
		const exec = resolveOmpExec();
		return { cmd: exec.cmd, args: [...exec.argvPrefix, tool, "--port", String(port)], env: { ...env } };
	}

	const repoRoot = resolveRepoRoot();
	if (!repoRoot) return null;

	if (tool === "collab") {
		const scriptPath = path.join(repoRoot, "packages", "collab-web", "scripts", "local-relay.ts");
		if (!statIsFile(scriptPath)) return null;
		return { cmd: "bun", args: [scriptPath, "--port", String(port)], env: {} };
	}

	const robompCwd = path.join(repoRoot, "python", "robomp");
	const robompSrc = path.join(robompCwd, "src");
	const rpcSrc = path.join(repoRoot, "python", "omp-rpc", "src");
	const robompPython = path.join(repoRoot, ".venv-robomp", "bin", "python");
	const python = statIsFile(robompPython) ? robompPython : "python3";
	if (!statIsDirectory(robompCwd) || !statIsDirectory(robompSrc) || (!statIsFile(robompPython) && !$which("python3")))
		return null;
	return {
		cmd: python,
		args: ["-m", "robomp", "serve"],
		env: {
			GITHUB_TOKEN: "",
			ROBOMP_GH_PROXY_URL: process.env.ROBOMP_GH_PROXY_URL || "http://127.0.0.1:1",
			ROBOMP_GH_PROXY_HMAC_KEY: process.env.ROBOMP_GH_PROXY_HMAC_KEY || "local-dev-hmac-key",
			GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET || "local-dev-webhook-secret",
			ROBOMP_BIND_PORT: String(port),
			ROBOMP_BOT_LOGIN: process.env.ROBOMP_BOT_LOGIN || "robomp-local",
			ROBOMP_GIT_AUTHOR_NAME: process.env.ROBOMP_GIT_AUTHOR_NAME || "robomp-local",
			ROBOMP_GIT_AUTHOR_EMAIL: process.env.ROBOMP_GIT_AUTHOR_EMAIL || "robomp-local@example.invalid",
			ROBOMP_NATIVES_CACHE_ROOT:
				process.env.ROBOMP_NATIVES_CACHE_ROOT || path.join(robompCwd, "data", "cache", "pi-natives"),
			ROBOMP_REPO_ALLOWLIST: process.env.ROBOMP_REPO_ALLOWLIST || "can1357/oh-my-pi",
			PYTHONPATH: [robompSrc, rpcSrc].join(path.delimiter),
		},
		cwd: robompCwd,
	};
}

export async function allocatePort(preferred: number): Promise<number> {
	if (Number.isInteger(preferred) && preferred > 0 && preferred <= 65_535) {
		try {
			const server = Bun.serve({
				hostname: LOOPBACK_HOST,
				port: preferred,
				fetch() {
					return new Response("ok");
				},
			});
			const port = server.port ?? preferred;
			await server.stop(true);
			return port;
		} catch {
			// Preferred port is unavailable; fall through to an ephemeral loopback bind.
		}
	}

	const server = Bun.serve({
		hostname: LOOPBACK_HOST,
		port: 0,
		fetch() {
			return new Response("ok");
		},
	});
	const port = server.port;
	await server.stop(true);
	if (!port) throw new LauncherError(503, "Could not allocate a loopback port");
	return port;
}

export function getRunningToolResult(tool: ToolId, profileId: string | null): LaunchResult | null {
	const scopedProfileId = scopedProfileIdForTool(tool, profileId);
	const entry = runningTools.get(toolStateKey(tool, scopedProfileId));
	return entry ? runningResult(entry) : null;
}

export async function launchTool(tool: ToolId, profile: ProfileEntry | null): Promise<LaunchResult> {
	const descriptor = TOOL_DESCRIPTORS[tool];
	const scopedProfileId = descriptor.profileScoped ? (profile?.id ?? null) : null;
	if (descriptor.profileScoped && !profile) {
		throw new LauncherError(400, `\`profileId\` is required to launch ${descriptor.label}`);
	}

	const key = toolStateKey(tool, scopedProfileId);
	const existing = runningTools.get(key);
	if (existing) return runningResult(existing);

	const env = profile && descriptor.profileScoped ? resolveProfileLaunchEnv(profile) : {};
	const port = await allocatePort(descriptor.defaultPort);
	const spec = resolveToolLaunch(tool, port, env);
	if (!spec) {
		throw new LauncherError(
			503,
			`${descriptor.label} cannot be spawned in this runtime. Run manually: ${launchHint(tool, descriptor.defaultPort)}`,
		);
	}

	const stdout = emptyCapture();
	const stderr = emptyCapture();
	const exitState: ProcessExitState = { exited: false, exitCode: null, signalCode: null };
	let child: ToolSubprocess;
	try {
		child = Bun.spawn({
			cmd: [spec.cmd, ...spec.args],
			cwd: spec.cwd,
			env: processEnvWith(spec.env),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
			onExit(proc, exitCode, signalCode) {
				exitState.exited = true;
				exitState.exitCode = exitCode;
				exitState.signalCode = signalCode;
				const entry = runningTools.get(key);
				if (entry?.child === proc) runningTools.delete(key);
			},
		});
	} catch (error) {
		throw new LauncherError(
			502,
			`Failed to spawn ${descriptor.label}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	void captureStream(child.stdout, stdout);
	void captureStream(child.stderr, stderr);
	if (!(await waitForPort(port, exitState))) {
		child.kill("SIGTERM");
		throw new LauncherError(502, formatLaunchFailure(tool, exitState, stdout, stderr));
	}
	if (exitState.exited) {
		throw new LauncherError(502, formatLaunchFailure(tool, exitState, stdout, stderr));
	}

	const entry: RunningTool = {
		child,
		port,
		url: `http://${LOOPBACK_HOST}:${port}`,
		profileId: scopedProfileId,
	};
	runningTools.set(key, entry);
	return runningResult(entry);
}

export async function stopTool(key: string): Promise<boolean> {
	const entry = runningTools.get(key);
	if (!entry) return false;
	runningTools.delete(key);
	await terminateEntry(entry);
	return true;
}

export function listToolStatus(profileId: string | null): ToolStatus[] {
	return Object.values(TOOL_DESCRIPTORS).map(descriptor => {
		const scopedProfileId = descriptor.profileScoped ? profileId : null;
		const entry = runningTools.get(toolStateKey(descriptor.id, scopedProfileId));
		const spec = resolveToolLaunch(descriptor.id, descriptor.defaultPort, {});
		const status: ToolStatus = {
			...descriptor,
			running: !!entry,
			spawnable: spec !== null,
			scopedProfileId,
		};
		if (entry) {
			status.port = entry.port;
			status.pid = entry.child.pid;
			status.url = entry.url;
			status.scopedProfileId = entry.profileId;
		}
		if (!status.spawnable) status.launchHint = launchHint(descriptor.id, descriptor.defaultPort);
		return status;
	});
}

export async function disposeAll(): Promise<void> {
	const entries = [...runningTools.values()];
	runningTools.clear();
	await Promise.allSettled(entries.map(entry => terminateEntry(entry)));
}
