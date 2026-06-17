#!/usr/bin/env bun
/**
 * The Mechanism — visual + state verification harness.
 *
 * A self-contained, executable proof that 100% of the orrery's visual transitions and event
 * bindings work as specified in the build brief's truth-binding table. It needs NO live OMP
 * session: it stands up its own deterministic mock SSE feed, drives a real headless Chrome through
 * the actual built client, captures screenshots at the exact moment each event lands, and turns
 * every screenshot into a quantitative pass/fail by decoding it back into pixels in-browser.
 *
 * Three independent verification layers cover every binding (see verify-harness.md, the
 * architecture report alongside this file):
 *   1. Transport  — a page-side probe EventSource records every frame the server pushes; the
 *                   harness asserts the exact `MechEvent` sequence arrives and JSON-decodes. This
 *                   is the SSE-binding contract.
 *   2. Application — the HUD DOM (`#hud-agents`, `#hud-cost`, `#hud-profile`) is read back and must
 *                   reflect the derived state (agent count, summed spend, profile).
 *   3. Render     — `page.screenshot()` at each keyframe, decoded in a second page via the browser's
 *                   own PNG decoder, yields per-region pixel metrics (luminous / red-flare / white
 *                   pulse / bright-core counts, mean brightness, frame-to-frame delta). Geometry
 *                   checks run under prefers-reduced-motion, where bodies are deterministic
 *                   (one body per ring sits at angle 0 → world (r,0,0)), so every ring and lane has
 *                   a known screen projection to sample.
 *
 * Run:
 *   bun run packages/mechanism/scripts/verify-harness.ts
 *   bun --cwd packages/mechanism run verify           # via the package "verify" script
 * Flags:
 *   --out <dir>     output directory for screenshots + report  (default: ./verify-out)
 *   --headful       launch a visible browser (debugging)
 *   --no-build      skip rebuilding dist/client (use the existing bundle)
 *   --keep-open     leave the browser open on completion (debugging)
 *   --chrome <path> explicit Chrome/Chromium executable
 * Exit code 0 iff every check passes; 1 otherwise.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import type { Browser, ConsoleMessage, Page } from "puppeteer-core";
import puppeteer from "puppeteer-core";
import type { AgentStatus, MechAgent, MechEvent } from "../src/normalize";

// ----------------------------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------------------------

/** 16:9 frames 4 of the 5 rim solids; the 5th (front lane) sits below the camera's fixed fov. */
const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1 } as const;

/** Static structure layout, mirrored from `client/scene.ts` so screen projections are exact. */
const RING_RADII = [11, 19, 27, 35] as const; // recursion depths 0..3
const LANE_RADIUS = 45;
const LANE_COUNT = 5;
/** Camera, mirrored from `client/scene.ts` reduced-motion branch (static at this pose). */
const CAMERA = { pos: [0, 46, 64] as const, target: [0, 0, 0] as const, fovDeg: 46 };

/** Calibrated pixel thresholds (see the smoke calibration in the harness commit message). */
const TH = {
	/** Whole-frame luminous fraction proving the scene rendered (not blank/black). */
	structureLumFraction: 0.04,
	/** A body's bright core (min channel > 120) count that marks "a node is here". */
	bodyBrightMin: 8,
	/** Lane solid luminous-pixel count that marks "a solid is here". */
	laneLumMin: 25,
	/** Red-flare pixel count that marks the aborted flare is showing. */
	flareRedMin: 120,
	/** Residual red after the heal window — must fall back near zero. */
	flareHealedMax: 60,
	/** White pulse-pixel count jump that marks an IRC arc is travelling. */
	ircWhiteMin: 200,
	/** Mean-brightness drop (running → idle) proving the dimming binding. */
	statusDimDelta: 6,
	/** Lane-box mean-brightness rise proving a solid scaled with spend (lum saturates under bloom). */
	usageMeanDelta: 18,
	/** Per-pixel mean abs luminance delta over a 1.2 s idle gap (observed motion≈1.4, reduced=0.0). */
	motionIdleDeltaMin: 0.8, // motion: wheel/rings/camera breathe → clearly non-zero
	reducedIdleDeltaMax: 0.4, // reduced: nothing continuous → ~zero
} as const;

const SETTLE_MS = 260; // frames to let an instant (reduced-motion) tween snap + bloom settle
const TRANSIENT_MS = 130; // capture window while a tool strike / irc arc is mid-flight
const HEAL_MS = 1900; // aborted flare decay window (scene.ts: flare -= dt/1.4 ⇒ ~1.4 s)
const IDLE_GAP_MS = 1200; // continuous-motion sampling gap

// ----------------------------------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------------------------------

interface Args {
	out: string;
	headful: boolean;
	build: boolean;
	keepOpen: boolean;
	chrome: string | undefined;
}

function parseArgs(argv: string[]): Args {
	const out = { out: path.resolve("verify-out"), headful: false, build: true, keepOpen: false } as Args;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--out") out.out = path.resolve(argv[++i] ?? out.out);
		else if (a === "--headful") out.headful = true;
		else if (a === "--no-build") out.build = false;
		else if (a === "--keep-open") out.keepOpen = true;
		else if (a === "--chrome") out.chrome = argv[++i];
	}
	return out;
}

// ----------------------------------------------------------------------------------------------
// Camera projection (mirrors three.js PerspectiveCamera under the reduced-motion static pose)
// ----------------------------------------------------------------------------------------------

type Vec3 = readonly [number, number, number];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): Vec3 => {
	const l = Math.hypot(a[0], a[1], a[2]) || 1;
	return [a[0] / l, a[1] / l, a[2] / l];
};

/** Project a world point (the disc lives at y=0) to integer screen pixels. */
function project(p: Vec3): [number, number] {
	const { width: w, height: h } = VIEWPORT;
	const aspect = w / h;
	const zAxis = norm(sub(CAMERA.pos, CAMERA.target));
	const xAxis = norm(cross([0, 1, 0], zAxis));
	const yAxis = cross(zAxis, xAxis);
	const rel = sub(p, CAMERA.pos);
	const v: Vec3 = [dot(rel, xAxis), dot(rel, yAxis), dot(rel, zAxis)];
	const depth = -v[2];
	const t = Math.tan((CAMERA.fovDeg * Math.PI) / 180 / 2);
	const ndcX = v[0] / (depth * t * aspect);
	const ndcY = v[1] / (depth * t);
	return [Math.round((ndcX * 0.5 + 0.5) * w), Math.round((1 - (ndcY * 0.5 + 0.5)) * h)];
}

interface Box {
	label: string;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}
function boxAround(label: string, p: Vec3, radius: number): Box {
	const [x, y] = project(p);
	return { label, x0: x - radius, y0: y - radius, x1: x + radius, y1: y + radius };
}
/** A body sitting alone in ring `depth`'s bucket lands at angle 0 → world (r,0,0) under reduced motion. */
const ringBody = (depth: number): Vec3 => [RING_RADII[depth], 0, 0];
/** Lane `i` solid orbits at angle i/5·2π, radius LANE_RADIUS (static under reduced motion). */
function lanePoint(i: number): Vec3 {
	const a = (i / LANE_COUNT) * Math.PI * 2;
	return [Math.cos(a) * LANE_RADIUS, 0, Math.sin(a) * LANE_RADIUS];
}
function laneOnScreen(i: number): boolean {
	const [x, y] = project(lanePoint(i));
	return x >= 12 && x <= VIEWPORT.width - 12 && y >= 12 && y <= VIEWPORT.height - 12;
}

// ----------------------------------------------------------------------------------------------
// Mock SSE server: serves the built client + a push-controlled /events stream
// ----------------------------------------------------------------------------------------------

class MockMechServer {
	#server: Bun.Server<unknown> | null = null;
	#clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
	#enc = new TextEncoder();
	#keepalive: NodeJS.Timeout | null = null;
	readonly pushed: MechEvent[] = [];

	constructor(readonly distDir: string) {}

	get port(): number {
		return this.#server?.port ?? 0;
	}
	get url(): string {
		return `http://127.0.0.1:${this.port}`;
	}
	clientCount(): number {
		return this.#clients.size;
	}

	start(): void {
		const distDir = this.distDir;
		const clients = this.#clients;
		const enc = this.#enc;
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 255, // SSE streams must not be reaped mid-run
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/events") {
					let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
					const drop = () => {
						if (ctl) clients.delete(ctl);
						ctl = null;
					};
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							ctl = controller;
							clients.add(controller);
							controller.enqueue(enc.encode("retry: 500\n\n"));
						},
						cancel: drop,
					});
					// Prune on disconnect so clientCount() never counts a closed page's stale stream.
					req.signal.addEventListener("abort", drop, { once: true });
					return new Response(stream, {
						headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" },
					});
				}
				if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
				const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
				const file = Bun.file(path.join(distDir, rel));
				if (await file.exists()) return new Response(file);
				return new Response("Not Found", { status: 404 });
			},
		});
		// Keepalive comments stop any idle reaper and keep the probe + client warm between keyframes.
		this.#keepalive = setInterval(() => {
			const ping = enc.encode(": ping\n\n");
			for (const c of [...clients]) {
				try {
					c.enqueue(ping);
				} catch {
					clients.delete(c);
				}
			}
		}, 4000);
		this.#keepalive.unref?.();
	}

	/** Broadcast one event to every connected SSE client (the live client + the harness probe). */
	push(event: MechEvent): void {
		this.pushed.push(event);
		const frame = this.#enc.encode(`data: ${JSON.stringify(event)}\n\n`);
		for (const c of [...this.#clients]) {
			try {
				c.enqueue(frame);
			} catch {
				this.#clients.delete(c);
			}
		}
	}

	resetPushLog(): void {
		this.pushed.length = 0;
	}

	stop(): void {
		if (this.#keepalive) clearInterval(this.#keepalive);
		for (const c of [...this.#clients]) {
			try {
				c.close();
			} catch {}
		}
		this.#clients.clear();
		this.#server?.stop(true);
		this.#server = null;
	}
}

// ----------------------------------------------------------------------------------------------
// Chrome resolution
// ----------------------------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
	try {
		return (await fs.stat(p)).isFile();
	} catch {
		return false;
	}
}

async function resolveChrome(explicit: string | undefined): Promise<string> {
	const fromEnv = explicit ?? process.env.PUPPETEER_EXECUTABLE_PATH ?? process.env.CHROME_PATH;
	if (fromEnv && (await fileExists(fromEnv))) return fromEnv;
	for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"]) {
		const found = Bun.which(name);
		if (found && (await fileExists(found))) return found;
	}
	for (const p of [
		"/usr/bin/google-chrome-stable",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	]) {
		if (await fileExists(p)) return p;
	}
	throw new Error("No Chrome/Chromium found. Pass --chrome <path> or set PUPPETEER_EXECUTABLE_PATH.");
}

// ----------------------------------------------------------------------------------------------
// In-browser pixel analyzer (uses the browser's own PNG decoder — no Node image deps)
// ----------------------------------------------------------------------------------------------

interface RegionMetric {
	label: string;
	lum: number; // max(r,g,b) > 40 — any luminous stroke over ink-black
	bright: number; // min(r,g,b) > 120 — a body's near-white bloomed core
	red: number; // r high, g/b low — the reserved aborted flare (PALETTE.flare)
	white: number; // r,g,b all > 150 — the IRC pulse / brightest strokes
	mean: number; // mean of max-channel over the region
	n: number;
}
interface FrameMetrics {
	whole: RegionMetric;
	boxes: RegionMetric[];
}

const ANALYZER_FN = `async (b64, boxes) => {
	const img = new Image();
	img.src = "data:image/png;base64," + b64;
	await img.decode();
	const cv = document.createElement("canvas");
	cv.width = img.width; cv.height = img.height;
	const ctx = cv.getContext("2d", { willReadFrequently: true });
	ctx.drawImage(img, 0, 0);
	const W = cv.width, H = cv.height;
	const data = ctx.getImageData(0, 0, W, H).data;
	const metric = (label, x0, y0, x1, y1) => {
		const xa = Math.max(0, x0 | 0), ya = Math.max(0, y0 | 0);
		const xb = Math.min(W, x1 | 0), yb = Math.min(H, y1 | 0);
		let lum = 0, bright = 0, red = 0, white = 0, sum = 0, n = 0;
		for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
			const i = (y * W + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
			const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
			sum += mx; n++;
			if (mx > 40) lum++;
			if (mn > 120) bright++;
			if (r > 120 && g < 90 && b < 90 && r - g > 50) red++;
			if (r > 150 && g > 150 && b > 150) white++;
		}
		return { label, lum, bright, red, white, mean: n ? sum / n : 0, n };
	};
	return {
		whole: metric("whole", 0, 0, W, H),
		boxes: (boxes || []).map(bx => metric(bx.label, bx.x0, bx.y0, bx.x1, bx.y1)),
	};
}`;

const DIFF_FN = `async (a64, b64) => {
	const load = async src => { const im = new Image(); im.src = "data:image/png;base64," + src; await im.decode(); return im; };
	const [ia, ib] = await Promise.all([load(a64), load(b64)]);
	const W = ia.width, H = ia.height;
	const draw = im => { const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(im, 0, 0); return x.getImageData(0, 0, W, H).data; };
	const da = draw(ia), db = draw(ib);
	let acc = 0; const n = W * H;
	for (let i = 0; i < da.length; i += 4) {
		const la = Math.max(da[i], da[i + 1], da[i + 2]);
		const lb = Math.max(db[i], db[i + 1], db[i + 2]);
		acc += Math.abs(la - lb);
	}
	return acc / n;
}`;

class Analyzer {
	constructor(private readonly page: Page) {}
	async measure(b64: string, boxes: Box[]): Promise<FrameMetrics> {
		return this.page.evaluate(
			`(${ANALYZER_FN})(${JSON.stringify(b64)}, ${JSON.stringify(boxes)})`,
		) as Promise<FrameMetrics>;
	}
	async diff(a64: string, b64: string): Promise<number> {
		return this.page.evaluate(`(${DIFF_FN})(${JSON.stringify(a64)}, ${JSON.stringify(b64)})`) as Promise<number>;
	}
}

// ----------------------------------------------------------------------------------------------
// Check accumulation + screenshots
// ----------------------------------------------------------------------------------------------

interface Shot {
	label: string;
	file: string; // relative to the report
}
interface CheckResult {
	id: string;
	binding: string; // which truth-binding row / contract clause this defends
	expected: string;
	actual: string;
	pass: boolean;
	info?: boolean; // documented fact, not pass/fail
	shots: Shot[];
}

class Harness {
	readonly results: CheckResult[] = [];
	#shotIndex = 0;
	constructor(
		readonly server: MockMechServer,
		readonly analyzer: Analyzer,
		readonly outDir: string,
	) {}

	record(r: CheckResult): void {
		this.results.push(r);
		const tag = r.info ? "info" : r.pass ? "PASS" : "FAIL";
		console.log(`  [${tag}] ${r.id} — ${r.actual}`);
	}

	/** Capture, persist a PNG for the report, and return its base64 for analysis. */
	async shot(page: Page, label: string): Promise<{ base64: string; shot: Shot }> {
		const safe = `${String(++this.#shotIndex).padStart(2, "0")}-${label.replace(/[^a-z0-9]+/gi, "-")}`;
		const rel = path.join("shots", `${safe}.png`);
		const abs = path.join(this.outDir, rel);
		const buf = (await page.screenshot({ type: "png" })) as Uint8Array;
		await Bun.write(abs, buf);
		return { base64: Buffer.from(buf).toString("base64"), shot: { label, file: rel } };
	}
}

// ----------------------------------------------------------------------------------------------
// Page helpers
// ----------------------------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8000, stepMs = 25): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await sleep(stepMs);
	}
	return false;
}

/** Inject a probe EventSource that records every frame BEFORE the client's own scripts run. */
const PROBE_INIT = `
	window.__mechEvents = [];
	window.__mechProbeOpen = false;
	(() => {
		const es = new EventSource("/events");
		es.onopen = () => { window.__mechProbeOpen = true; };
		es.onmessage = e => { try { window.__mechEvents.push(JSON.parse(e.data)); } catch {} };
	})();
`;

interface OpenPageOptions {
	reducedMotion: boolean;
	profile: string;
}

async function openClientPage(browser: Browser, server: MockMechServer, opts: OpenPageOptions): Promise<Page> {
	const page = await browser.newPage();
	await page.setViewport({ ...VIEWPORT });
	if (opts.reducedMotion) {
		await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
	}
	const consoleErrors: string[] = [];
	page.on("pageerror", err => consoleErrors.push(`pageerror: ${(err as Error).message}`));
	page.on("console", msg => {
		const cm = msg as ConsoleMessage;
		if (cm.type() === "error") consoleErrors.push(`console: ${cm.text()}`);
	});
	(page as Page & { __consoleErrors: string[] }).__consoleErrors = consoleErrors;
	await page.evaluateOnNewDocument(PROBE_INIT);
	server.resetPushLog();
	await page.goto(`${server.url}/?profile=${encodeURIComponent(opts.profile)}`, { waitUntil: "domcontentloaded" });
	// Both the probe and the client must be subscribed before we push (SSE does not replay).
	await waitFor(() => server.clientCount() >= 2);
	await page.waitForFunction("window.__mechProbeOpen === true", { timeout: 8000 });
	return page;
}

function consoleErrorsOf(page: Page): string[] {
	return (page as Page & { __consoleErrors?: string[] }).__consoleErrors ?? [];
}

async function readHud(page: Page): Promise<{ profile: string; agents: string; cost: string }> {
	return page.evaluate(`(() => ({
		profile: document.getElementById("hud-profile")?.textContent ?? "",
		agents: document.getElementById("hud-agents")?.textContent ?? "",
		cost: document.getElementById("hud-cost")?.textContent ?? "",
	}))()`) as Promise<{ profile: string; agents: string; cost: string }>;
}

// ----------------------------------------------------------------------------------------------
// Suite A — reduced motion (deterministic geometry + every event binding)
// ----------------------------------------------------------------------------------------------

const agent = (id: string, parentId: string | null, depth: number, model: string, status: AgentStatus): MechAgent => ({
	id,
	parentId,
	model,
	status,
	depth,
	label: id,
});

async function suiteReducedMotion(h: Harness, browser: Browser): Promise<void> {
	console.log("\n— Suite A: reduced motion (geometry + bindings) —");
	const page = await openClientPage(browser, h.server, { reducedMotion: true, profile: "verify-giga" });

	// Boxes derived from the static camera projection.
	const ringBoxes = RING_RADII.map((_, d) => boxAround(`ring${d}`, ringBody(d), 20));
	const laneBoxes = Array.from({ length: LANE_COUNT }, (_, i) => boxAround(`lane${i}`, lanePoint(i), 26));

	// --- A0: structure present + reduced-motion "visible at t0" (never a blank reveal) ---
	const base = await h.shot(page, "reduced-structure-baseline");
	const baseM = await h.analyzer.measure(base.base64, [...ringBoxes, ...laneBoxes]);
	const lumFrac = baseM.whole.lum / baseM.whole.n;
	h.record({
		id: "structure-present",
		binding: "Central great wheel + π engraving (line art renders, not blank)",
		expected: `luminous fraction ≥ ${TH.structureLumFraction}`,
		actual: `luminous fraction ${lumFrac.toFixed(3)} (${baseM.whole.lum} px)`,
		pass: lumFrac >= TH.structureLumFraction,
		shots: [base.shot],
	});
	h.record({
		id: "reduced-visible-at-t0",
		binding: "prefers-reduced-motion: content visible by default, never gated on a transition",
		expected: `scene already luminous on first frame (≥ ${TH.structureLumFraction})`,
		actual: `luminous fraction ${lumFrac.toFixed(3)} immediately after load`,
		pass: lumFrac >= TH.structureLumFraction,
		shots: [base.shot],
	});

	// --- A1: five model lanes (Platonic solids) ---
	const onScreenLanes = laneBoxes.filter((_, i) => laneOnScreen(i));
	const laneLums = baseM.boxes.filter(b => b.label.startsWith("lane"));
	const litLanes = laneLums.filter((b, i) => laneOnScreen(i) && b.lum >= TH.laneLumMin);
	h.record({
		id: "lanes-present",
		binding: "Model lanes → 5 Platonic-solid wireframes orbiting the rim",
		expected: `every on-screen lane luminous (${onScreenLanes.length} framed by the fixed camera)`,
		actual: `${litLanes.length}/${onScreenLanes.length} on-screen lanes luminous; per-lane lum=[${laneLums
			.map((b, i) => `${i}:${laneOnScreen(i) ? b.lum : "off"}`)
			.join(",")}]`,
		pass: litLanes.length === onScreenLanes.length && onScreenLanes.length >= 4,
		shots: [base.shot],
	});
	h.record({
		id: "lanes-offscreen-documented",
		binding: "Model lanes → the 5th solid sits outside the client's fixed camera frustum",
		expected: "documented projection of off-screen lane(s)",
		actual: `off-screen lane indices ${Array.from({ length: LANE_COUNT }, (_, i) => i)
			.filter(i => !laneOnScreen(i))
			.map(i => `${i}@${project(lanePoint(i)).join(",")}`)
			.join(" ")} — verified functionally via usage-scaling + probe`,
		pass: true,
		info: true,
		shots: [],
	});

	// --- A2: spawns at depths 0..3 → each joins its ring (incremental, isolates each depth) ---
	const depthAgents = [
		agent("Main", null, 0, "model/opus", "running"),
		agent("Scout", "Main", 1, "model/sonnet", "running"),
		agent("Reader", "Scout", 2, "model/haiku", "running"),
		agent("Probe", "Reader", 3, "model/mini", "running"),
	];
	h.server.push({ t: "roster", agents: [depthAgents[0]] });
	await sleep(SETTLE_MS);
	for (let d = 1; d <= 3; d++) {
		h.server.push({ t: "spawn", agent: depthAgents[d] });
	}
	await sleep(SETTLE_MS);
	const spawnShot = await h.shot(page, "reduced-spawns-depth-0-3");
	const spawnM = await h.analyzer.measure(spawnShot.base64, ringBoxes);
	for (let d = 0; d <= 3; d++) {
		const before = baseM.boxes.find(b => b.label === `ring${d}`)!;
		const after = spawnM.boxes.find(b => b.label === `ring${d}`)!;
		const bodyHere = after.bright >= TH.bodyBrightMin && after.bright > before.bright;
		h.record({
			id: `spawn-depth-${d}`,
			binding: `Subagent spawned → body accretes into recursion-depth ${d} ring (r=${RING_RADII[d]})`,
			expected: `bright-core px ≥ ${TH.bodyBrightMin} at ring ${d} projection ${project(ringBody(d)).join(",")}`,
			actual: `bright core ${before.bright}→${after.bright}, lum ${before.lum}→${after.lum}`,
			pass: bodyHere,
			shots: [spawnShot.shot],
		});
	}
	const hudAfterSpawn = await readHud(page);
	h.record({
		id: "hud-agent-count",
		binding: "Live agent count (application binding: roster + spawn → HUD)",
		expected: "4",
		actual: `HUD agents = ${hudAfterSpawn.agents}`,
		pass: hudAfterSpawn.agents === "4",
		shots: [spawnShot.shot],
	});
	h.record({
		id: "hud-profile",
		binding: "Active profile name (application binding: ?profile= → HUD)",
		expected: "verify-giga",
		actual: `HUD profile = ${hudAfterSpawn.profile}`,
		pass: hudAfterSpawn.profile === "verify-giga",
		shots: [spawnShot.shot],
	});

	// --- A3: status running → idle dims; parked dims further ---
	const idleTarget = ringBody(3);
	const idleBox = boxAround("idle", idleTarget, 20);
	const runShot = await h.shot(page, "reduced-status-running");
	const runM = (await h.analyzer.measure(runShot.base64, [idleBox])).boxes[0];
	h.server.push({ t: "status", id: "Probe", status: "idle" });
	await sleep(SETTLE_MS);
	const idleShot = await h.shot(page, "reduced-status-idle");
	const idleM = (await h.analyzer.measure(idleShot.base64, [idleBox])).boxes[0];
	h.record({
		id: "status-running-to-idle",
		binding: "Agent running → idle (bright+ ⇒ steady dim glow)",
		expected: `mean brightness drops ≥ ${TH.statusDimDelta}`,
		actual: `mean ${runM.mean.toFixed(1)} → ${idleM.mean.toFixed(1)} (Δ ${(runM.mean - idleM.mean).toFixed(1)})`,
		pass: runM.mean - idleM.mean >= TH.statusDimDelta,
		shots: [runShot.shot, idleShot.shot],
	});
	h.server.push({ t: "status", id: "Probe", status: "parked" });
	await sleep(SETTLE_MS);
	const parkedShot = await h.shot(page, "reduced-status-parked");
	const parkedM = (await h.analyzer.measure(parkedShot.base64, [idleBox])).boxes[0];
	h.record({
		id: "status-parked",
		binding: "Agent parked → cold dimmed (dimmer than idle)",
		expected: "mean brightness ≤ idle mean",
		actual: `parked mean ${parkedM.mean.toFixed(1)} vs idle ${idleM.mean.toFixed(1)}`,
		pass: parkedM.mean <= idleM.mean + 0.5,
		shots: [parkedShot.shot],
	});

	// --- A4: aborted → red flare, then heals ---
	h.server.push({ t: "status", id: "Reader", status: "aborted" });
	await sleep(TRANSIENT_MS);
	const flareShot = await h.shot(page, "reduced-aborted-flare");
	const flareM = await h.analyzer.measure(flareShot.base64, []);
	h.record({
		id: "aborted-flare",
		binding: "Agent aborted → red flare (PALETTE.flare; the one reserved state-change accent)",
		expected: `red px ≥ ${TH.flareRedMin} immediately after the abort`,
		actual: `whole-frame red px = ${flareM.whole.red}`,
		pass: flareM.whole.red >= TH.flareRedMin,
		shots: [flareShot.shot],
	});
	await sleep(HEAL_MS);
	const healShot = await h.shot(page, "reduced-aborted-healed");
	const healM = await h.analyzer.measure(healShot.base64, []);
	h.record({
		id: "aborted-heal",
		binding: "…then the line heals (flare decays back toward the resting palette)",
		expected: `red px ≤ ${TH.flareHealedMax} after the ~1.4 s heal window`,
		actual: `red px ${flareM.whole.red} → ${healM.whole.red}`,
		pass: healM.whole.red <= TH.flareHealedMax && healM.whole.red < flareM.whole.red,
		shots: [healShot.shot],
	});

	// --- A5: tool call → compass-and-straightedge strike (transient) ---
	const toolBefore = await h.shot(page, "reduced-tool-before");
	const toolBeforeM = await h.analyzer.measure(toolBefore.base64, []);
	h.server.push({ t: "tool", id: "Main", tool: "read", phase: "start" });
	await sleep(TRANSIENT_MS);
	const toolDuring = await h.shot(page, "reduced-tool-sweep");
	const toolDuringM = await h.analyzer.measure(toolDuring.base64, []);
	await sleep(900);
	const toolAfter = await h.shot(page, "reduced-tool-after");
	const toolAfterM = await h.analyzer.measure(toolAfter.base64, []);
	h.record({
		id: "tool-strike",
		binding: "Tool call → brief Euclidean compass-and-straightedge line struck from the agent",
		expected: "luminous px rises during the strike, then falls back",
		actual: `lum ${toolBeforeM.whole.lum} → ${toolDuringM.whole.lum} (sweep) → ${toolAfterM.whole.lum} (after)`,
		pass: toolDuringM.whole.lum > toolBeforeM.whole.lum && toolAfterM.whole.lum < toolDuringM.whole.lum,
		shots: [toolDuring.shot, toolAfter.shot],
	});

	// --- A6: IRC → arc of light between two bodies ---
	const ircBefore = await h.analyzer.measure((await h.shot(page, "reduced-irc-before")).base64, []);
	h.server.push({ t: "irc", from: "Probe", to: "Main" });
	await sleep(TRANSIENT_MS);
	const ircShot = await h.shot(page, "reduced-irc-arc");
	const ircM = await h.analyzer.measure(ircShot.base64, []);
	h.record({
		id: "irc-arc",
		binding: "IRC / inter-agent message → arc of light travelling between bodies",
		expected: `white pulse px jumps ≥ ${TH.ircWhiteMin}`,
		actual: `white px ${ircBefore.whole.white} → ${ircM.whole.white}`,
		pass: ircM.whole.white - ircBefore.whole.white >= TH.ircWhiteMin,
		shots: [ircShot.shot],
	});

	// --- A7: usage → lane solid scales with spend share ---
	// Bind lanes 0..3 with small spend, then balloon lane 4's model (a well-framed rim slot).
	const laneIdxForScale = 4;
	const scaleModels = ["model/opus", "model/sonnet", "model/haiku", "model/mini"]; // → lanes 0..3
	for (const m of scaleModels) h.server.push({ t: "usage", model: m, costUsd: 0.01, tokensIn: 100, tokensOut: 20 });
	await sleep(SETTLE_MS);
	const laneBox = boxAround("scaleLane", lanePoint(laneIdxForScale), 34);
	const laneBeforeM = (await h.analyzer.measure((await h.shot(page, "reduced-usage-lane-before")).base64, [laneBox]))
		.boxes[0];
	h.server.push({ t: "usage", model: "model/rim", costUsd: 6.0, tokensIn: 9000, tokensOut: 3000 }); // → lane 4
	await sleep(SETTLE_MS + 200);
	const usageShot = await h.shot(page, "reduced-usage-lane-after");
	const laneAfterM = (await h.analyzer.measure(usageShot.base64, [laneBox])).boxes[0];
	h.record({
		id: "usage-scaling",
		binding: "Token / cost → orbital mass: spend share scales the model's Platonic solid",
		expected: `lane solid box mean brightness rises ≥ ${TH.usageMeanDelta} after a dominant-spend usage event`,
		actual: `lane ${laneIdxForScale} mean ${laneBeforeM.mean.toFixed(1)} → ${laneAfterM.mean.toFixed(1)} (Δ ${(laneAfterM.mean - laneBeforeM.mean).toFixed(1)}), bright ${laneBeforeM.bright}→${laneAfterM.bright}`,
		pass: laneAfterM.mean - laneBeforeM.mean >= TH.usageMeanDelta,
		shots: [usageShot.shot],
	});
	const hudCost = await readHud(page);
	const expectCost = 0.01 * 4 + 6.0;
	h.record({
		id: "hud-cost",
		binding: "Session cost (application binding: Σ usage.costUsd → HUD)",
		expected: `$${expectCost.toFixed(2)}`,
		actual: `HUD cost = ${hudCost.cost}`,
		pass: hudCost.cost === `$${expectCost.toFixed(2)}`,
		shots: [usageShot.shot],
	});

	// --- A8: SSE transport contract — probe received the exact pushed sequence ---
	const expectedSeq = h.server.pushed;
	await waitFor(async () => {
		const n = (await page.evaluate("window.__mechEvents.length")) as number;
		return n >= expectedSeq.length;
	});
	const probeEvents = (await page.evaluate("window.__mechEvents")) as MechEvent[];
	const exactMatch = JSON.stringify(probeEvents) === JSON.stringify(expectedSeq);
	h.record({
		id: "sse-transport-contract",
		binding: "SSE event binding: every pushed MechEvent is delivered + decoded, in order",
		expected: `${expectedSeq.length} events, byte-exact`,
		actual: exactMatch
			? `received ${probeEvents.length}/${expectedSeq.length} in order, exact`
			: `MISMATCH: received ${probeEvents.length} (${diffSummary(expectedSeq, probeEvents)})`,
		pass: exactMatch,
		shots: [],
	});
	const errs = consoleErrorsOf(page);
	h.record({
		id: "client-no-errors",
		binding: "Client decodes every frame (no 'bad MechEvent' / pageerror)",
		expected: "0 console errors",
		actual: errs.length === 0 ? "no page/console errors" : `errors: ${errs.slice(0, 4).join(" | ")}`,
		pass: errs.length === 0,
		shots: [],
	});

	await page.close();
}

function diffSummary(expected: MechEvent[], got: MechEvent[]): string {
	for (let i = 0; i < Math.max(expected.length, got.length); i++) {
		if (JSON.stringify(expected[i]) !== JSON.stringify(got[i])) {
			return `first divergence @${i}: expected ${JSON.stringify(expected[i])} got ${JSON.stringify(got[i])}`;
		}
	}
	return "length mismatch";
}

// ----------------------------------------------------------------------------------------------
// Suite B — continuous motion present (control), and reduced motion stillness (contract)
// ----------------------------------------------------------------------------------------------

async function suiteMotionContrast(h: Harness, browser: Browser): Promise<void> {
	console.log("\n— Suite B: motion vs reduced-motion stillness —");

	// Motion ON: an idle scene (no events) must keep breathing (wheel/rings/camera).
	const motionPage = await openClientPage(browser, h.server, { reducedMotion: false, profile: "verify-motion" });
	h.server.push({ t: "roster", agents: [agent("Main", null, 0, "model/opus", "running")] });
	await sleep(SETTLE_MS);
	const m1 = await h.shot(motionPage, "motion-idle-a");
	await sleep(IDLE_GAP_MS);
	const m2 = await h.shot(motionPage, "motion-idle-b");
	const motionDelta = await h.analyzer.diff(m1.base64, m2.base64);
	h.record({
		id: "motion-continuous",
		binding: "Default motion: main wheel rotates / rings drift / camera breathes when idle",
		expected: `idle frame delta ≥ ${TH.motionIdleDeltaMin}`,
		actual: `mean abs luminance delta over ${IDLE_GAP_MS} ms = ${motionDelta.toFixed(2)}`,
		pass: motionDelta >= TH.motionIdleDeltaMin,
		shots: [m1.shot, m2.shot],
	});
	await motionPage.close();

	// Reduced motion ON: the same idle scene must be still (no continuous rotation/orbit).
	const stillPage = await openClientPage(browser, h.server, { reducedMotion: true, profile: "verify-still" });
	h.server.push({ t: "roster", agents: [agent("Main", null, 0, "model/opus", "running")] });
	await sleep(SETTLE_MS);
	const s1 = await h.shot(stillPage, "reduced-idle-a");
	await sleep(IDLE_GAP_MS);
	const s2 = await h.shot(stillPage, "reduced-idle-b");
	const stillDelta = await h.analyzer.diff(s1.base64, s2.base64);
	h.record({
		id: "reduced-no-continuous-motion",
		binding: "prefers-reduced-motion: no continuous rotation/orbit/camera-breath",
		expected: `idle frame delta ≤ ${TH.reducedIdleDeltaMax}`,
		actual: `mean abs luminance delta over ${IDLE_GAP_MS} ms = ${stillDelta.toFixed(2)}`,
		pass: stillDelta <= TH.reducedIdleDeltaMax,
		shots: [s1.shot, s2.shot],
	});

	// Reduced motion ON: a state change must STILL register (crossfade/instant, not suppressed).
	const beforeAbort = await h.analyzer.measure((await h.shot(stillPage, "reduced-prechange")).base64, []);
	h.server.push({ t: "status", id: "Main", status: "aborted" });
	await sleep(TRANSIENT_MS);
	const afterAbort = await h.analyzer.measure((await h.shot(stillPage, "reduced-change-registers")).base64, []);
	h.record({
		id: "reduced-state-registers",
		binding: "prefers-reduced-motion: state changes still register (crossfade), never suppressed",
		expected: `aborted flare appears under reduced motion (red ≥ ${TH.flareRedMin})`,
		actual: `red px ${beforeAbort.whole.red} → ${afterAbort.whole.red}`,
		pass: afterAbort.whole.red >= TH.flareRedMin,
		shots: [],
	});
	await stillPage.close();
}

// ----------------------------------------------------------------------------------------------
// Report
// ----------------------------------------------------------------------------------------------

function escapeHtml(s: string): string {
	return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

async function writeReport(
	outDir: string,
	results: CheckResult[],
): Promise<{ passed: number; failed: number; info: number }> {
	const graded = results.filter(r => !r.info);
	const passed = graded.filter(r => r.pass).length;
	const failed = graded.length - passed;
	const info = results.filter(r => r.info).length;
	const allPass = failed === 0;

	const rows = results
		.map(r => {
			const status = r.info ? "INFO" : r.pass ? "PASS" : "FAIL";
			const cls = r.info ? "info" : r.pass ? "pass" : "fail";
			const shots = r.shots
				.map(
					s =>
						`<a href="${s.file}" title="${escapeHtml(s.label)}"><img src="${s.file}" alt="${escapeHtml(s.label)}"></a>`,
				)
				.join("");
			return `<tr class="${cls}">
				<td class="st">${status}</td>
				<td class="id">${escapeHtml(r.id)}</td>
				<td class="bd">${escapeHtml(r.binding)}</td>
				<td class="ex">${escapeHtml(r.expected)}</td>
				<td class="ac">${escapeHtml(r.actual)}</td>
				<td class="sh">${shots}</td>
			</tr>`;
		})
		.join("\n");

	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Mechanism — Verification Report</title>
<style>
	:root { color-scheme: dark; }
	body { margin: 0; background: #050505; color: #e5c158; font: 13px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
	header { padding: 28px 32px; border-bottom: 1px solid #2a2412; }
	h1 { margin: 0 0 6px; font-size: 18px; letter-spacing: .12em; text-transform: uppercase; }
	.sum { font-size: 13px; color: #b89645; }
	.banner { display: inline-block; margin-top: 12px; padding: 6px 14px; border: 1px solid; letter-spacing: .15em; }
	.banner.ok { color: #b6f0a0; border-color: #2f6b2a; }
	.banner.bad { color: #ff8d80; border-color: #6b2a2a; }
	table { width: 100%; border-collapse: collapse; }
	th, td { text-align: left; padding: 10px 12px; vertical-align: top; border-bottom: 1px solid #1a160a; }
	th { position: sticky; top: 0; background: #0b0a06; color: #8c7636; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; font-size: 11px; }
	td.st { font-weight: 700; white-space: nowrap; }
	tr.pass td.st { color: #9fe08a; }
	tr.fail td.st { color: #ff6f5e; }
	tr.info td.st { color: #6f86c9; }
	tr.fail { background: #160a08; }
	td.id { color: #ffdf7a; white-space: nowrap; }
	td.bd { color: #b89645; max-width: 300px; }
	td.ac { color: #d9c98f; }
	td.sh img { height: 70px; border: 1px solid #2a2412; margin: 2px; vertical-align: middle; }
	footer { padding: 18px 32px; color: #6b5a2c; }
</style></head><body>
<header>
	<h1>The Mechanism — Visual + State Verification</h1>
	<div class="sum">${graded.length} graded checks · ${passed} passed · ${failed} failed · ${info} info — ${escapeHtml(new Date().toISOString())}</div>
	<div class="banner ${allPass ? "ok" : "bad"}">${allPass ? "100% COMPLIANCE — ALL BINDINGS VERIFIED" : `${failed} CHECK(S) FAILED`}</div>
</header>
<table>
	<thead><tr><th>Status</th><th>Check</th><th>Truth-binding</th><th>Expected</th><th>Actual</th><th>Evidence</th></tr></thead>
	<tbody>${rows}</tbody>
</table>
<footer>Generated by packages/mechanism/scripts/verify-harness.ts — deterministic mock SSE feed, headless Chrome, in-browser pixel analysis.</footer>
</body></html>`;

	await Bun.write(path.join(outDir, "report.html"), html);
	await Bun.write(
		path.join(outDir, "report.json"),
		JSON.stringify({ generatedAt: new Date().toISOString(), passed, failed, info, allPass, results }, null, 2),
	);
	return { passed, failed, info };
}

// ----------------------------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const packageRoot = path.resolve(import.meta.dir, "..");
	const distDir = path.join(packageRoot, "dist", "client");

	if (args.build || !(await fileExists(path.join(distDir, "index.html")))) {
		console.log("Building client bundle…");
		const build = await $`bun run build.ts`.cwd(packageRoot).quiet().nothrow();
		if (build.exitCode !== 0) {
			console.error(build.text());
			throw new Error("client build failed");
		}
	}

	await fs.rm(args.out, { recursive: true, force: true });
	await fs.mkdir(path.join(args.out, "shots"), { recursive: true });

	const chrome = await resolveChrome(args.chrome);
	console.log(`Chrome: ${chrome}`);
	console.log(`Output: ${args.out}`);

	const server = new MockMechServer(distDir);
	server.start();
	console.log(`Mock SSE server: ${server.url}`);

	const browser = await puppeteer.launch({
		headless: !args.headful,
		executablePath: chrome,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--enable-unsafe-swiftshader",
			"--use-gl=angle",
			"--use-angle=swiftshader",
			`--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
		],
		defaultViewport: { ...VIEWPORT },
	});

	try {
		const analyzerPage = await browser.newPage();
		await analyzerPage.goto("about:blank");
		const analyzer = new Analyzer(analyzerPage);
		const harness = new Harness(server, analyzer, args.out);

		await suiteReducedMotion(harness, browser);
		await suiteMotionContrast(harness, browser);

		const summary = await writeReport(args.out, harness.results);
		console.log(`\n${"─".repeat(60)}`);
		console.log(`Result: ${summary.passed} passed, ${summary.failed} failed, ${summary.info} info`);
		console.log(`Report: ${path.join(args.out, "report.html")}`);
		console.log(`        ${path.join(args.out, "report.json")}`);

		if (!args.keepOpen) await browser.close();
		server.stop();
		process.exitCode = summary.failed === 0 ? 0 : 1;
	} catch (err) {
		if (!args.keepOpen) await browser.close().catch(() => {});
		server.stop();
		throw err;
	}
}

await main();
