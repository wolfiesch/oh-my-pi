import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { startAuthBroker } from "@oh-my-pi/pi-ai";
import { getConfigRootDir, isEnoent, VERSION } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { type ApiContext, apiHandler } from "./api";
import { OAuthSessionManager } from "./oauth-sessions";
import { getDashboardToken, openStorage } from "./store";

const CLIENT_DIR = path.join(import.meta.dir, "client");
const STATIC_DIR = path.join(import.meta.dir, "..", "dist", "client");

const DEFAULT_PORT = 3849;
const DEFAULT_BROKER_BIND = "127.0.0.1:8765";
const DASHBOARD_IDLE_TIMEOUT_S = 255;
const CORS_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const CORS_HEADERS = "Authorization, Content-Type";

function sameOriginCorsHeaders(req: Request, url: URL): Record<string, string> | null {
	const origin = req.headers.get("Origin");
	if (!origin) return {};
	if (origin !== url.origin) return null;
	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": CORS_METHODS,
		"Access-Control-Allow-Headers": CORS_HEADERS,
		Vary: "Origin",
	};
}

function rejectCrossOrigin(req: Request, url: URL): Response | null {
	const corsHeaders = sameOriginCorsHeaders(req, url);
	if (corsHeaders === null) {
		return Response.json({ error: "Cross-origin requests are not allowed" }, { status: 403 });
	}
	const fetchSite = req.headers.get("Sec-Fetch-Site");
	if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
		return Response.json({ error: "Cross-site requests are not allowed" }, { status: 403 });
	}
	return null;
}

async function getLatestMtime(dir: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return 0;
		throw err;
	}

	const promises: Array<Promise<number>> = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			promises.push(getLatestMtime(fullPath));
		} else if (entry.isFile()) {
			promises.push(fs.stat(fullPath).then(stats => stats.mtimeMs));
		}
	}

	let latest = 0;
	await Promise.allSettled(promises).then(results => {
		for (const result of results) {
			if (result.status === "fulfilled") {
				latest = Math.max(latest, result.value);
			}
		}
	});
	return latest;
}

/**
 * Build the static client into `dist/client` when it is missing or older than
 * the client sources. Keeps `omp-auther` self-bootstrapping in development.
 */
async function ensureClientBuild(): Promise<void> {
	const indexPath = path.join(STATIC_DIR, "index.html");
	const cssPath = path.join(STATIC_DIR, "styles.css");
	const clientSourceMtime = await getLatestMtime(CLIENT_DIR);
	const tailwindConfigPath = path.join(import.meta.dir, "..", "tailwind.config.js");
	let tailwindConfigMtime = 0;
	try {
		const tailwindConfigStats = await fs.stat(tailwindConfigPath);
		tailwindConfigMtime = tailwindConfigStats.mtimeMs;
	} catch {}
	const sourceMtime = Math.max(clientSourceMtime, tailwindConfigMtime);
	let shouldBuild = true;
	try {
		const [indexStats, cssStats] = await Promise.all([fs.stat(indexPath), fs.stat(cssPath)]);
		if (
			indexStats.isFile() &&
			cssStats.isFile() &&
			indexStats.mtimeMs >= sourceMtime &&
			cssStats.mtimeMs >= sourceMtime
		) {
			shouldBuild = false;
		}
	} catch {
		shouldBuild = true;
	}

	if (!shouldBuild) return;

	await fs.rm(STATIC_DIR, { recursive: true, force: true });

	console.log("Building Auther client...");
	const packageRoot = path.join(import.meta.dir, "..");
	const buildResult = await $`bun run build.ts`.cwd(packageRoot).quiet().nothrow();
	if (buildResult.exitCode !== 0) {
		const output = buildResult.text().trim();
		const details = output ? `\n${output}` : "";
		throw new Error(`Failed to build Auther client (exit ${buildResult.exitCode})${details}`);
	}
}

async function ensureBrokerToken(): Promise<string> {
	const tokenPath = path.join(getConfigRootDir(), "auth-broker.token");
	const parent = path.dirname(tokenPath);
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	await fs.chmod(parent, 0o700).catch(() => undefined);
	try {
		const token = (await Bun.file(tokenPath).text()).trim();
		await fs.chmod(tokenPath, 0o600).catch(() => undefined);
		if (token.length > 0) return token;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const token = createBase64UrlToken();
	await Bun.write(tokenPath, `${token}\n`);
	await fs.chmod(tokenPath, 0o600).catch(() => undefined);
	return token;
}

async function handleStatic(requestPath: string, dashboardToken: string): Promise<Response> {
	const staticRoot = path.resolve(STATIC_DIR);
	const indexPath = path.join(staticRoot, "index.html");
	const relativePath = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath).replace(/^\/+/, "");
	const fullPath = path.resolve(staticRoot, relativePath);

	if (fullPath === staticRoot || fullPath.startsWith(`${staticRoot}${path.sep}`)) {
		const file = Bun.file(fullPath);
		if (await file.exists()) {
			if (fullPath === indexPath) return injectedIndexResponse(await file.text(), dashboardToken);
			return new Response(file);
		}
	}

	const index = Bun.file(indexPath);
	if (await index.exists()) {
		return injectedIndexResponse(await index.text(), dashboardToken);
	}

	return new Response("Not Found", { status: 404 });
}

function injectedIndexResponse(html: string, dashboardToken: string): Response {
	return new Response(injectDashboardToken(html, dashboardToken), {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

function injectDashboardToken(html: string, dashboardToken: string): string {
	const serializedToken = JSON.stringify(dashboardToken).replace(/</g, "\\u003c");
	const script = `<script>window.__AUTHER_TOKEN__ = ${serializedToken};</script>`;
	const moduleScriptMatch = html.match(/<script\b(?=[^>]*\btype=["']module["'])[^>]*>/i);
	if (moduleScriptMatch?.index !== undefined) {
		const index = moduleScriptMatch.index;
		return `${html.slice(0, index)}${script}\n    ${html.slice(index)}`;
	}
	const headCloseIndex = html.search(/<\/head>/i);
	if (headCloseIndex !== -1) {
		return `${html.slice(0, headCloseIndex)}    ${script}\n${html.slice(headCloseIndex)}`;
	}
	return `${html}\n${script}\n`;
}

function withSameOriginCors(response: Response, corsHeaders: Record<string, string>): Response {
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function createBase64UrlToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

export interface StartServerOptions {
	/** Dashboard port (default 3849). */
	port?: number;
	/** Auth-broker bind address (default 127.0.0.1:8765). */
	brokerBind?: string;
}

export interface StartServerResult {
	/** The actual dashboard port the server bound to. */
	port: number;
	/** The bound auth-broker URL. */
	brokerUrl: string;
	/** Stop the dashboard server and auth broker. */
	stop: () => void;
}

/** Start the OMP Auther dashboard and the device-facing auth broker. */
export async function startServer(opts: StartServerOptions = {}): Promise<StartServerResult> {
	const storage = await openStorage();
	const brokerBind = opts.brokerBind ?? DEFAULT_BROKER_BIND;
	const brokerToken = await ensureBrokerToken();
	const broker = startAuthBroker({
		storage,
		bind: brokerBind,
		bearerTokens: [brokerToken],
		version: VERSION,
	});

	let loginSessions: OAuthSessionManager | undefined;
	try {
		const dashboardToken = await getDashboardToken();
		await ensureClientBuild();
		loginSessions = new OAuthSessionManager(storage);
		const apiContext: ApiContext = {
			storage,
			brokerUrl: broker.url,
			brokerToken,
			dashboardToken,
			loginSessions,
		};
		const port = opts.port ?? DEFAULT_PORT;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port,
			idleTimeout: DASHBOARD_IDLE_TIMEOUT_S,
			async fetch(req) {
				const url = new URL(req.url);
				const corsHeaders = sameOriginCorsHeaders(req, url);
				if (corsHeaders === null) {
					return Response.json({ error: "Cross-origin requests are not allowed" }, { status: 403 });
				}
				if (req.method === "OPTIONS") {
					return new Response(null, { status: 204, headers: corsHeaders });
				}
				try {
					if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
						const crossOriginRejection = rejectCrossOrigin(req, url);
						if (crossOriginRejection) return crossOriginRejection;
					}
					const response =
						url.pathname === "/api" || url.pathname.startsWith("/api/")
							? await apiHandler(req, url, apiContext)
							: await handleStatic(url.pathname, dashboardToken);
					return withSameOriginCors(response, corsHeaders);
				} catch (error) {
					return Response.json(
						{ error: error instanceof Error ? error.message : "Unknown error" },
						{ status: 500, headers: corsHeaders },
					);
				}
			},
		});

		return {
			port: server.port ?? port,
			brokerUrl: broker.url,
			stop: () => {
				server.stop();
				void broker.close();
				loginSessions?.close();
			},
		};
	} catch (error) {
		loginSessions?.close();
		await broker.close();
		throw error;
	}
}
