import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import embeddedClientArchiveTxt from "./embedded-client.generated.txt";
import { MechanismNormalizer, type MechEvent } from "./normalize";
import { SessionTailer, type TailerRecord } from "./tail";

const DEFAULT_PORT = 3848;
const EMBEDDED_CLIENT_ARCHIVE = decodeEmbeddedClientArchive(embeddedClientArchiveTxt);
const CLIENT_DIR = path.join(import.meta.dir, "client");
const STATIC_DIR = path.join(import.meta.dir, "..", "dist", "client");
const IS_BUN_COMPILED =
	Boolean(process.env.PI_COMPILED || Bun.env.PI_COMPILED) ||
	import.meta.url.includes("$bunfs") ||
	import.meta.url.includes("~BUN") ||
	import.meta.url.includes("%7EBUN");
const IS_PREBUILT = IS_BUN_COMPILED || Boolean(process.env.PI_BUNDLED || Bun.env.PI_BUNDLED);
const USE_EMBEDDED_CLIENT = EMBEDDED_CLIENT_ARCHIVE !== null || IS_PREBUILT;
const EMBEDDED_CLIENT_DIR_ROOT = path.join(os.tmpdir(), "omp-mechanism-client");
const SSE_HEADERS: Record<string, string> = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache, no-transform",
	Connection: "keep-alive",
	"X-Accel-Buffering": "no",
};
const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

interface RuntimeState {
	server: Bun.Server<unknown>;
	tailer: SessionTailer;
	normalizer: MechanismNormalizer;
	unsubscribeStatus: () => void;
	unsubscribeTailer: () => void;
	heartbeat: NodeJS.Timeout;
}

interface SseClient {
	controller: ReadableStreamDefaultController<Uint8Array>;
	closed: boolean;
}

let embeddedClientDirPromise: Promise<string> | null = null;
let runtime: RuntimeState | null = null;
const encoder = new TextEncoder();
const clients = new Set<SseClient>();

function decodeEmbeddedClientArchive(txt: string): Buffer | null {
	const normalized = txt.replaceAll(/\s+/g, "");
	if (!normalized) return null;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
	const archiveBytes = Buffer.from(normalized, "base64");
	if (archiveBytes[0] !== 0x1f || archiveBytes[1] !== 0x8b) return null;
	return archiveBytes;
}

function sanitizeArchivePath(archivePath: string): string | null {
	const normalized = archivePath.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized || normalized === ".") return null;
	if (normalized.includes("..") || path.isAbsolute(normalized)) return null;
	return normalized;
}

async function extractEmbeddedClientArchive(archiveBytes: Buffer, outputDir: string): Promise<void> {
	const archive = new Bun.Archive(archiveBytes);
	const files = await archive.files();
	const extractRoot = path.resolve(outputDir);

	for (const [archivePath, file] of files) {
		const sanitizedPath = sanitizeArchivePath(archivePath);
		if (!sanitizedPath) continue;
		const destinationPath = path.resolve(extractRoot, sanitizedPath);
		if (!destinationPath.startsWith(extractRoot + path.sep)) {
			throw new Error(`Archive entry escapes extraction directory: ${archivePath}`);
		}
		await Bun.write(destinationPath, file);
	}
}

async function getEmbeddedClientDir(): Promise<string> {
	if (!USE_EMBEDDED_CLIENT) return STATIC_DIR;
	if (embeddedClientDirPromise) return embeddedClientDirPromise;
	if (!EMBEDDED_CLIENT_ARCHIVE) {
		throw new Error(
			"Embedded mechanism client bundle missing. Rebuild the omp binary or npm bundle with embedded mechanism assets.",
		);
	}

	embeddedClientDirPromise = (async () => {
		const bundleHash = Bun.hash(EMBEDDED_CLIENT_ARCHIVE).toString(16);
		const outputDir = path.join(EMBEDDED_CLIENT_DIR_ROOT, bundleHash);
		const markerPath = path.join(outputDir, "index.html");
		try {
			const marker = await fs.stat(markerPath);
			if (marker.isFile()) return outputDir;
		} catch {}

		await fs.rm(outputDir, { recursive: true, force: true });
		await fs.mkdir(outputDir, { recursive: true });
		await extractEmbeddedClientArchive(EMBEDDED_CLIENT_ARCHIVE, outputDir);
		return outputDir;
	})();

	return embeddedClientDirPromise;
}

async function getLatestMtime(dir: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return 0;
		throw err;
	}

	const mtimes: Promise<number>[] = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			mtimes.push(getLatestMtime(fullPath));
		} else if (entry.isFile()) {
			mtimes.push(fs.stat(fullPath).then(stats => stats.mtimeMs));
		}
	}

	let latest = 0;
	const results = await Promise.allSettled(mtimes);
	for (const result of results) {
		if (result.status === "fulfilled") latest = Math.max(latest, result.value);
	}
	return latest;
}

async function ensureClientBuild(): Promise<void> {
	if (USE_EMBEDDED_CLIENT) return;
	const sourceMtime = Math.max(
		await getLatestMtime(CLIENT_DIR),
		await fs
			.stat(path.join(import.meta.dir, "..", "build.ts"))
			.then(stat => stat.mtimeMs)
			.catch(() => 0),
	);
	const requiredFiles = ["index.html", "main.js", "styles.css"];
	let shouldBuild = true;
	try {
		const stats = await Promise.all(requiredFiles.map(fileName => fs.stat(path.join(STATIC_DIR, fileName))));
		shouldBuild = !stats.every(stat => stat.isFile() && stat.mtimeMs >= sourceMtime);
	} catch {
		shouldBuild = true;
	}
	if (!shouldBuild) return;

	await fs.rm(STATIC_DIR, { recursive: true, force: true });
	const packageRoot = path.join(import.meta.dir, "..");
	const buildResult = await $`bun run build.ts`.cwd(packageRoot).quiet().nothrow();
	if (buildResult.exitCode !== 0) {
		const output = buildResult.text().trim();
		const details = output ? `\n${output}` : "";
		throw new Error(`Failed to build mechanism client (exit ${buildResult.exitCode})${details}`);
	}
}

function sseFrame(event: MechEvent): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

function writeEvent(client: SseClient, event: MechEvent): boolean {
	if (client.closed) return false;
	try {
		client.controller.enqueue(sseFrame(event));
		return true;
	} catch {
		client.closed = true;
		return false;
	}
}

function broadcast(event: MechEvent): void {
	for (const client of Array.from(clients)) {
		if (!writeEvent(client, event)) clients.delete(client);
	}
}

function broadcastAll(events: MechEvent[]): void {
	for (const event of events) broadcast(event);
}

function pingClients(): void {
	const frame = encoder.encode(": hb\n\n");
	for (const client of Array.from(clients)) {
		if (client.closed) {
			clients.delete(client);
			continue;
		}
		try {
			client.controller.enqueue(frame);
		} catch {
			client.closed = true;
			clients.delete(client);
		}
	}
}

function handleTailerRecord(normalizer: MechanismNormalizer, record: TailerRecord): void {
	switch (record.t) {
		case "reset":
			broadcastAll(normalizer.reset());
			break;
		case "agent":
			broadcastAll(normalizer.registerAgentFile(record.source));
			break;
		case "entry":
			broadcastAll(normalizer.processEntry(record.source, record.entry, record.observedAt));
			break;
	}
}

function withCors(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
	return new Response(response.body, { status: response.status, headers });
}

function createEventsResponse(req: Request, normalizer: MechanismNormalizer): Response {
	let client: SseClient | null = null;
	const closeClient = () => {
		if (!client) return;
		client.closed = true;
		clients.delete(client);
		req.signal.removeEventListener("abort", closeClient);
		client = null;
	};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			client = { controller, closed: false };
			clients.add(client);
			controller.enqueue(encoder.encode("retry: 1000\n\n"));
			writeEvent(client, normalizer.snapshotRoster());
			req.signal.addEventListener("abort", closeClient, { once: true });
		},
		cancel() {
			closeClient();
		},
	});
	return new Response(stream, { headers: SSE_HEADERS });
}

function safeStaticPath(requestPath: string): string | null {
	const withoutSlash = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
	const normalized = path.normalize(withoutSlash);
	if (normalized.startsWith("..") || path.isAbsolute(normalized)) return null;
	return normalized;
}

async function handleStatic(requestPath: string): Promise<Response> {
	const staticDir = await getEmbeddedClientDir();
	const safePath = safeStaticPath(requestPath);
	if (!safePath) return new Response("Not Found", { status: 404 });

	const file = Bun.file(path.join(staticDir, safePath));
	if (await file.exists()) return new Response(file);

	const index = Bun.file(path.join(staticDir, "index.html"));
	if (await index.exists()) return new Response(index);
	return new Response("Not Found", { status: 404 });
}

export async function startServer(
	port = DEFAULT_PORT,
	options: { sessionFile?: string } = {},
): Promise<{ port: number; stop: () => void }> {
	if (runtime) closeServer();
	clients.clear();
	await ensureClientBuild();

	const normalizer = new MechanismNormalizer();
	const tailer = new SessionTailer(options.sessionFile ? { mainSessionFile: options.sessionFile } : {});
	const unsubscribeStatus = normalizer.onEvent(broadcast);
	const unsubscribeTailer = tailer.onRecord(record => handleTailerRecord(normalizer, record));
	await tailer.start();
	normalizer.startStatusPolling();
	broadcastAll(await normalizer.checkStatuses());

	const server = Bun.serve({
		port,
		idleTimeout: 255,
		async fetch(req) {
			if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
			const url = new URL(req.url);
			try {
				if (url.pathname === "/events") {
					if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
					return withCors(createEventsResponse(req, normalizer));
				}
				if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
				return withCors(await handleStatic(url.pathname));
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return Response.json({ error: message }, { status: 500, headers: CORS_HEADERS });
			}
		},
	});

	const heartbeat = setInterval(pingClients, 15000);
	heartbeat.unref?.();
	runtime = { server, tailer, normalizer, unsubscribeStatus, unsubscribeTailer, heartbeat };
	return {
		port: server.port ?? port,
		stop: closeServer,
	};
}

export function closeServer(): void {
	if (!runtime) return;
	for (const client of Array.from(clients)) {
		client.closed = true;
		try {
			client.controller.close();
		} catch {}
	}
	clients.clear();
	runtime.unsubscribeTailer();
	runtime.unsubscribeStatus();
	runtime.tailer.stop();
	runtime.normalizer.stop();
	runtime.server.stop();
	clearInterval(runtime.heartbeat);
	runtime = null;
}
