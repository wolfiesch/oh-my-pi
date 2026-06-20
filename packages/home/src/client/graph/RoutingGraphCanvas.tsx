/**
 * RoutingGraphCanvas — full-frame DPR-aware canvas routing graph.
 *
 * Architecture (from GraphInteractionReview):
 * - Transform (scale/offset) in refs with imperative draw() — never useState
 *   at pan/zoom frequency.
 * - Event-driven draws (no always-on rAF); transient rAF only during tweens.
 * - Palette resolved once per theme change (never per-frame getComputedStyle).
 * - Adjacency + connected/path sets precomputed in useMemo (never in draw()).
 * - LOD labels by zoom thresholds (shape-only → primary → sublabel).
 * - Single nodeAlpha/edgeAlpha with selection-first precedence.
 */

import { Maximize, Minus, Plus, RotateCcw, Search, X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	ConfigEdit,
	GraphEdge,
	GraphEdgeRelation,
	GraphNodeKind,
	ModelPreview,
	ResolvedConfig,
	RoutingGraph as RoutingGraphData,
} from "../../api-types";
import { putConfig } from "../data/api";
import { useSystemTheme } from "../useSystemTheme";
import { GRAPH_KIND_ORDER, layoutRoutingGraph, type PlacedNode, WIDTH_BY_KIND } from "./layout";

// ─── Constants (from GraphInteractionReview constants_block) ───────────────

const DPR_CAP = 2;
const MAX_SCALE = 3;
const FIT_MAX_SCALE = 1.5;
const INTERACTIVE_MIN_SCALE = 0.2;
const ZOOM_FACTOR_WHEEL = 1.1;
const ZOOM_STEP_BUTTON = 1.2;
const HIT_MARGIN_SCREEN_PX = 6;
const DRAG_CLICK_THRESHOLD_PX = 6;
const LOD_SHAPE_ONLY_BELOW = 0.45;
const LOD_SUBLABEL_AT = 0.8;
const NODE_RADIUS = 8;
const PAD_X_LABEL = 12;
const FONT_PRIMARY = 13;
const FONT_SUBLABEL = 11;
const AVG_CHAR_PX_FACTOR = 0.56;
const TWEEN_MS = 220;
const MINIMAP_W = 160;
const MINIMAP_H = 120;
const MINIMAP_PAD = 12;
const MINIMAP_SHOW_NODECOUNT = 30;
const MINIMAP_HIDE_BELOW_WIDTH = 767;
const FIT_PAD = 48;
const MOBILE_TOP_INSET = 96;

const ALPHA = {
	baseNode: 1,
	baseEdge: 0.82,
	hoverNeighbor: 0.92,
	hoverOtherNode: 0.22,
	hoverIncidentEdge: 0.85,
	hoverOtherEdge: 0.18,
	selectPathNode: 0.92,
	selectOtherNode: 0.16,
	selectPathEdge: 0.9,
	selectOtherEdge: 0.14,
} as const;

const KIND_PLURAL: Record<GraphNodeKind, string> = {
	agent: "Agents",
	role: "Roles",
	model: "Models",
	provider: "Providers",
};

const VALID_THINKING = new Set(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "inherit"]);

const THINKING_OPTIONS: readonly { value: string; label: string }[] = [
	{ value: "", label: "(inherit)" },
	{ value: "auto", label: "auto" },
	{ value: "off", label: "off" },
	{ value: "minimal", label: "minimal" },
	{ value: "low", label: "low" },
	{ value: "medium", label: "medium" },
	{ value: "high", label: "high" },
	{ value: "xhigh", label: "xhigh" },
];

const CANVAS_KEYSHORTCUTS = "Arrow keys: pan. +/−: zoom. F: fit. Esc: clear selection.";

// ─── Types ─────────────────────────────────────────────────────────────────

interface Palette {
	page: string;
	surface: string;
	surface2: string;
	text: string;
	muted: string;
	dim: string;
	border: string;
	borderStrong: string;
	edge: string;
	isLight: boolean;
	accent: string;
	link: string;
	success: string;
	warning: string;
	danger: string;
}

interface Transform {
	scale: number;
	offsetX: number;
	offsetY: number;
}

interface CanvasSize {
	w: number;
	h: number;
	dpr: number;
}

interface DragState {
	startX: number;
	startY: number;
	startOffsetX: number;
	startOffsetY: number;
	moved: boolean;
}

interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

interface LatestState {
	hoveredId: string | null;
	selectedId: string | null;
	selectPath: Set<string>;
	hoverConnected: Set<string>;
	hiddenKinds: Set<GraphNodeKind>;
	layoutNodes: readonly PlacedNode[];
	placedById: ReadonlyMap<string, PlacedNode>;
	graphBBox: BBox | null;
	graphEdges: readonly GraphEdge[];
	columnCenters: ReadonlyMap<number, number>;
	counts: Record<GraphNodeKind, number>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const EMPTY_SET: Set<string> = new Set();

function resolvePalette(): Palette {
	const root = document.documentElement;
	const s = getComputedStyle(root);
	const v = (name: string): string => s.getPropertyValue(name).trim() || "oklch(0.5 0 0)";
	const isLight = root.dataset.theme === "light";
	const dim = v("--dim");
	return {
		page: v("--page"),
		surface: v("--surface"),
		surface2: v("--surface-2"),
		text: v("--text"),
		muted: v("--muted"),
		dim,
		border: v("--border"),
		borderStrong: v("--border-strong"),
		edge: isLight ? dim : v("--muted"),
		isLight,
		accent: v("--accent"),
		link: v("--link"),
		success: v("--success"),
		warning: v("--warning"),
		danger: v("--danger"),
	};
}

type PaletteColorKey = Exclude<keyof Palette, "isLight">;

const KIND_COLOR_KEY: Record<GraphNodeKind, PaletteColorKey> = {
	role: "accent",
	model: "link",
	provider: "success",
	agent: "warning",
};

function computeMaxChars(kind: GraphNodeKind): number {
	const w = WIDTH_BY_KIND[kind];
	return Math.floor((w - 2 * PAD_X_LABEL) / (FONT_PRIMARY * AVG_CHAR_PX_FACTOR));
}

const MAX_CHARS_BY_KIND: Record<GraphNodeKind, number> = {
	agent: computeMaxChars("agent"),
	role: computeMaxChars("role"),
	model: computeMaxChars("model"),
	provider: computeMaxChars("provider"),
};

function truncateLabel(label: string, maxChars: number): string {
	if (label.length <= maxChars) return label;
	if (maxChars <= 3) return label.slice(0, maxChars);
	return `${label.slice(0, maxChars - 1)}…`;
}

function buildAdjacency(edges: readonly GraphEdge[]): ReadonlyMap<string, readonly string[]> {
	const map = new Map<string, string[]>();
	for (const e of edges) {
		if (!map.has(e.from)) map.set(e.from, []);
		if (!map.has(e.to)) map.set(e.to, []);
		map.get(e.from)!.push(e.to);
		map.get(e.to)!.push(e.from);
	}
	return map;
}

function computeReachable(start: string, adjacency: ReadonlyMap<string, readonly string[]>): Set<string> {
	const result = new Set<string>();
	const queue = [start];
	while (queue.length > 0) {
		const id = queue.shift()!;
		if (result.has(id)) continue;
		result.add(id);
		const neighbors = adjacency.get(id);
		if (neighbors) {
			for (const n of neighbors) {
				if (!result.has(n)) queue.push(n);
			}
		}
	}
	return result;
}

function computeNeighbors(start: string, adjacency: ReadonlyMap<string, readonly string[]>): Set<string> {
	const result = new Set<string>([start]);
	const neighbors = adjacency.get(start);
	if (neighbors) {
		for (const n of neighbors) result.add(n);
	}
	return result;
}

function computeBBox(nodes: readonly PlacedNode[]): BBox | null {
	if (nodes.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const n of nodes) {
		minX = Math.min(minX, n.x);
		minY = Math.min(minY, n.y);
		maxX = Math.max(maxX, n.x + n.width);
		maxY = Math.max(maxY, n.y + n.height);
	}
	return { minX, minY, maxX, maxY };
}

function parseSelector(selector: string): { base: string; thinking: string } {
	const colonIdx = selector.lastIndexOf(":");
	if (colonIdx < 0) return { base: selector, thinking: "" };
	const suffix = selector.slice(colonIdx + 1);
	if (VALID_THINKING.has(suffix)) {
		return { base: selector.slice(0, colonIdx), thinking: suffix };
	}
	return { base: selector, thinking: "" };
}

function formatSelector(base: string, thinking: string): string {
	if (!thinking || thinking === "inherit") return base;
	return `${base}:${thinking}`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	const rr = Math.min(r, w / 2, h / 2);
	ctx.beginPath();
	ctx.moveTo(x + rr, y);
	ctx.lineTo(x + w - rr, y);
	ctx.arcTo(x + w, y, x + w, y + rr, rr);
	ctx.lineTo(x + w, y + h - rr);
	ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
	ctx.lineTo(x + rr, y + h);
	ctx.arcTo(x, y + h, x, y + h - rr, rr);
	ctx.lineTo(x, y + rr);
	ctx.arcTo(x, y, x + rr, y, rr);
	ctx.closePath();
}

function easeOutCubic(t: number): number {
	return 1 - (1 - t) ** 3;
}

// ─── Component types ───────────────────────────────────────────────────────

export interface RoutingGraphCanvasProps {
	graph: RoutingGraphData;
	profile: string;
	active: boolean;
	config: ResolvedConfig | null;
	catalogModels: readonly ModelPreview[];
	onApplied: () => Promise<void>;
	onNavigateProviders: () => void;
}

// ─── Main component ────────────────────────────────────────────────────────

export function RoutingGraphCanvas({
	graph,
	profile,
	active,
	config,
	catalogModels,
	onApplied,
	onNavigateProviders,
}: RoutingGraphCanvasProps) {
	// React state (low-frequency: changes at node-boundary, not per-frame)
	const [hoveredId, setHoveredIdState] = useState<string | null>(null);
	const [selectedId, setSelectedIdState] = useState<string | null>(null);
	const [zoomPct, setZoomPct] = useState(100);
	const [searchQuery, setSearchQuery] = useState("");
	const [hiddenKinds, setHiddenKinds] = useState<Set<GraphNodeKind>>(EMPTY_SET as Set<GraphNodeKind>);
	const [inspectorTick, setInspectorTick] = useState(0);

	// Refs (high-frequency or imperative)
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const transformRef = useRef<Transform>({ scale: 1, offsetX: 0, offsetY: 0 });
	const sizeRef = useRef<CanvasSize>({ w: 0, h: 0, dpr: 1 });
	const minScaleRef = useRef(INTERACTIVE_MIN_SCALE);
	const hasFittedRef = useRef(false);
	const paletteRef = useRef<Palette>(resolvePalette());
	const reducedMotionRef = useRef(false);
	const rafRef = useRef<number | null>(null);
	const dragStateRef = useRef<DragState | null>(null);
	const minimapDragRef = useRef<boolean>(false);
	const hoveredIdRef = useRef<string | null>(null);
	const selectedIdRef = useRef<string | null>(null);

	// Theme
	const theme = useSystemTheme();

	// Layout (pure, memoized)
	const layout = useMemo(() => layoutRoutingGraph(graph), [graph]);
	const placedById = useMemo(() => {
		const m = new Map<string, PlacedNode>();
		for (const n of layout.nodes) m.set(n.id, n);
		return m;
	}, [layout.nodes]);

	// Adjacency (precomputed once per graph)
	const adjacency = useMemo(() => buildAdjacency(graph.edges), [graph.edges]);

	// Connected sets (precomputed per interaction state)
	const selectPath = useMemo(
		() => (selectedId ? computeReachable(selectedId, adjacency) : EMPTY_SET),
		[selectedId, adjacency],
	);
	const hoverConnected = useMemo(
		() => (hoveredId ? computeNeighbors(hoveredId, adjacency) : EMPTY_SET),
		[hoveredId, adjacency],
	);

	// Graph bbox for fit + minimap
	const graphBBox = useMemo(() => computeBBox(layout.nodes), [layout.nodes]);

	// Column centers (world x of first node per tier)
	const columnCenters = useMemo(() => {
		const m = new Map<number, number>();
		for (const n of layout.nodes) {
			if (!m.has(n.tier)) m.set(n.tier, n.cx);
		}
		return m;
	}, [layout.nodes]);

	// Counts per kind
	const counts = useMemo(() => {
		const c: Record<GraphNodeKind, number> = { agent: 0, role: 0, model: 0, provider: 0 };
		for (const n of graph.nodes) c[n.kind]++;
		return c;
	}, [graph.nodes]);

	const totalNodes = graph.nodes.length;
	const visibleNodeCount = useMemo(() => {
		if (hiddenKinds.size === 0) return totalNodes;
		return graph.nodes.reduce((acc, n) => acc + (hiddenKinds.has(n.kind) ? 0 : 1), 0);
	}, [graph.nodes, hiddenKinds, totalNodes]);

	// ── Latest-state ref (for draw + event handlers to read synchronously) ──
	const latestRef = useRef<LatestState>({
		hoveredId: null,
		selectedId: null,
		selectPath: EMPTY_SET,
		hoverConnected: EMPTY_SET,
		hiddenKinds: EMPTY_SET as Set<GraphNodeKind>,
		layoutNodes: layout.nodes,
		placedById,
		graphBBox,
		graphEdges: graph.edges,
		columnCenters,
		counts,
	});
	latestRef.current = {
		hoveredId,
		selectedId,
		selectPath,
		hoverConnected,
		hiddenKinds,
		layoutNodes: layout.nodes,
		placedById,
		graphBBox,
		graphEdges: graph.edges,
		columnCenters,
		counts,
	};

	// Sync hovered/selected refs
	hoveredIdRef.current = hoveredId;
	selectedIdRef.current = selectedId;

	// ── Reduced motion ──────────────────────────────────────────────────────
	useEffect(() => {
		const media = window.matchMedia("(prefers-reduced-motion: reduce)");
		reducedMotionRef.current = media.matches;
		const handler = () => {
			reducedMotionRef.current = media.matches;
		};
		media.addEventListener("change", handler);
		return () => media.removeEventListener("change", handler);
	}, []);

	// ── Palette recompute on theme change ───────────────────────────────────
	useEffect(() => {
		const refreshPalette = () => {
			paletteRef.current = resolvePalette();
			requestDraw();
		};
		refreshPalette();
		const observer = new MutationObserver(refreshPalette);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [theme]);

	// ── State setters that also trigger redraw ──────────────────────────────
	const setHoveredId = useCallback(
		(id: string | null) => {
			if (hoveredIdRef.current === id) return;
			hoveredIdRef.current = id;
			latestRef.current = {
				...latestRef.current,
				hoveredId: id,
				hoverConnected: id ? computeNeighbors(id, adjacency) : EMPTY_SET,
			};
			setHoveredIdState(id);
			requestDraw();
		},
		[adjacency],
	);

	const setSelectedId = useCallback(
		(id: string | null) => {
			if (selectedIdRef.current === id) return;
			selectedIdRef.current = id;
			latestRef.current = {
				...latestRef.current,
				selectedId: id,
				selectPath: id ? computeReachable(id, adjacency) : EMPTY_SET,
			};
			setSelectedIdState(id);
			requestDraw();
		},
		[adjacency],
	);

	// ── Clear selection if it no longer exists in the graph ─────────────────
	useEffect(() => {
		if (selectedId && !placedById.has(selectedId)) {
			setSelectedId(null);
		}
	}, [selectedId, placedById, setSelectedId]);

	// ── Screen ↔ World projection ───────────────────────────────────────────
	function screenToWorld(px: number, py: number): { x: number; y: number } {
		const { scale, offsetX, offsetY } = transformRef.current;
		const { w, h } = sizeRef.current;
		return {
			x: (px - w / 2 - offsetX) / scale,
			y: (py - h / 2 - offsetY) / scale,
		};
	}

	// ── Hit test ────────────────────────────────────────────────────────────
	function hitTest(px: number, py: number): string | null {
		const { scale } = transformRef.current;
		const wp = screenToWorld(px, py);
		const margin = HIT_MARGIN_SCREEN_PX / scale;
		const vis = latestRef.current;
		let bestId: string | null = null;
		let bestDist = Infinity;
		for (const node of vis.layoutNodes) {
			if (vis.hiddenKinds.size > 0 && vis.hiddenKinds.has(node.kind)) continue;
			if (
				wp.x >= node.x - margin &&
				wp.x <= node.x + node.width + margin &&
				wp.y >= node.y - margin &&
				wp.y <= node.y + node.height + margin
			) {
				const dx = wp.x - node.cx;
				const dy = wp.y - node.cy;
				const dist = dx * dx + dy * dy;
				if (dist < bestDist) {
					bestDist = dist;
					bestId = node.id;
				}
			}
		}
		return bestId;
	}

	// ── Fit computation ─────────────────────────────────────────────────────
	function computeFit(): Transform | null {
		const bbox = latestRef.current.graphBBox;
		const { w, h } = sizeRef.current;
		if (!bbox || w === 0 || h === 0) return null;
		const vis = latestRef.current;
		// If filters active, compute bbox of visible nodes only
		let b = bbox;
		if (vis.hiddenKinds.size > 0) {
			const visNodes = vis.layoutNodes.filter(n => !vis.hiddenKinds.has(n.kind));
			b = computeBBox(visNodes) ?? bbox;
		}
		const gw = Math.max(1, b.maxX - b.minX);
		const gh = Math.max(1, b.maxY - b.minY);
		const topInset = w <= 767 ? MOBILE_TOP_INSET : 0;
		const fitScale = Math.min((w - 2 * FIT_PAD) / gw, Math.max(1, h - topInset - 2 * FIT_PAD) / gh);
		const ms = Math.min(INTERACTIVE_MIN_SCALE, fitScale * 0.9);
		const target = Math.max(ms, Math.min(FIT_MAX_SCALE, fitScale));
		const cx = (b.minX + b.maxX) / 2;
		const cy = (b.minY + b.maxY) / 2;
		return { scale: target, offsetX: -cx * target, offsetY: -cy * target + topInset / 2 };
	}

	function doFit(): void {
		const fit = computeFit();
		if (!fit) return;
		minScaleRef.current = Math.min(INTERACTIVE_MIN_SCALE, fit.scale * 0.9);
		transformRef.current = { ...fit };
		setZoomPct(Math.round(fit.scale * 100));
		requestDraw();
	}

	function doReset(): void {
		minScaleRef.current = INTERACTIVE_MIN_SCALE;
		transformRef.current = { scale: 1, offsetX: 0, offsetY: 0 };
		setZoomPct(100);
		requestDraw();
	}

	// ── Zoom helpers ────────────────────────────────────────────────────────
	function zoomAtPoint(factor: number, px: number, py: number): void {
		const { scale } = transformRef.current;
		const wp = screenToWorld(px, py);
		const nextScale = Math.max(minScaleRef.current, Math.min(MAX_SCALE, scale * factor));
		const { w, h } = sizeRef.current;
		transformRef.current.scale = nextScale;
		transformRef.current.offsetX = px - w / 2 - wp.x * nextScale;
		transformRef.current.offsetY = py - h / 2 - wp.y * nextScale;
		setZoomPct(Math.round(nextScale * 100));
		requestDraw();
	}

	function zoomCenter(factor: number): void {
		const { scale } = transformRef.current;
		const nextScale = Math.max(minScaleRef.current, Math.min(MAX_SCALE, scale * factor));
		const actual = nextScale / scale;
		transformRef.current.scale = nextScale;
		transformRef.current.offsetX *= actual;
		transformRef.current.offsetY *= actual;
		setZoomPct(Math.round(nextScale * 100));
		requestDraw();
	}

	// ── Tween ───────────────────────────────────────────────────────────────
	function tweenTo(targetScale: number, targetOffX: number, targetOffY: number): void {
		if (reducedMotionRef.current) {
			transformRef.current = { scale: targetScale, offsetX: targetOffX, offsetY: targetOffY };
			setZoomPct(Math.round(targetScale * 100));
			requestDraw();
			return;
		}
		const start = { ...transformRef.current };
		const startTime = performance.now();
		if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
		const animate = (now: number): void => {
			const t = Math.min(1, (now - startTime) / TWEEN_MS);
			const e = easeOutCubic(t);
			transformRef.current.scale = start.scale + (targetScale - start.scale) * e;
			transformRef.current.offsetX = start.offsetX + (targetOffX - start.offsetX) * e;
			transformRef.current.offsetY = start.offsetY + (targetOffY - start.offsetY) * e;
			setZoomPct(Math.round(transformRef.current.scale * 100));
			drawNow();
			if (t < 1) {
				rafRef.current = requestAnimationFrame(animate);
			} else {
				rafRef.current = null;
			}
		};
		rafRef.current = requestAnimationFrame(animate);
	}

	function centerOnNode(node: PlacedNode): void {
		const targetScale = Math.max(transformRef.current.scale, 1.0);
		tweenTo(targetScale, -node.cx * targetScale, -node.cy * targetScale);
	}

	function selectAndCenter(id: string): void {
		const node = placedById.get(id);
		if (!node) return;
		setSelectedId(id);
		centerOnNode(node);
	}

	// ── Draw scheduling ─────────────────────────────────────────────────────
	function requestDraw(): void {
		if (rafRef.current !== null) return;
		if (document.hidden) return;
		rafRef.current = requestAnimationFrame(() => {
			rafRef.current = null;
			drawNow();
		});
	}

	// ── Core draw ───────────────────────────────────────────────────────────
	function drawNow(): void {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const { w, h, dpr } = sizeRef.current;
		if (w === 0 || h === 0) return;

		const pal = paletteRef.current;
		const { scale, offsetX, offsetY } = transformRef.current;
		const st = latestRef.current;

		// Reset + clear
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = pal.page;
		ctx.fillRect(0, 0, w, h);

		if (st.layoutNodes.length === 0) return;

		// World transform
		ctx.translate(w / 2 + offsetX, h / 2 + offsetY);
		ctx.scale(scale, scale);

		// ── Edges ──
		const shapeOnly = scale < LOD_SHAPE_ONLY_BELOW;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";

		for (const edge of st.graphEdges) {
			const from = st.placedById.get(edge.from);
			const to = st.placedById.get(edge.to);
			if (!from || !to) continue;
			if (st.hiddenKinds.size > 0 && (st.hiddenKinds.has(from.kind) || st.hiddenKinds.has(to.kind))) continue;

			// Alpha precedence: selection > hover > base
			let alpha: number;
			if (st.selectedId) {
				const inPath = (id: string): boolean => id === st.selectedId || st.selectPath.has(id);
				alpha = inPath(edge.from) && inPath(edge.to) ? ALPHA.selectPathEdge : ALPHA.selectOtherEdge;
			} else if (st.hoveredId) {
				const touches = edge.from === st.hoveredId || edge.to === st.hoveredId;
				alpha = touches ? ALPHA.hoverIncidentEdge : ALPHA.hoverOtherEdge;
			} else {
				alpha = ALPHA.baseEdge;
			}
			if (alpha < 0.02) continue;

			const isFallback = edge.relation === "fallback";
			ctx.globalAlpha = pal.isLight && !st.selectedId && !st.hoveredId ? Math.max(alpha, 0.9) : alpha;
			// Heavier strokes when zoomed out so edges stay crisp; thinner at shape-only LOD.
			ctx.lineWidth = shapeOnly ? (pal.isLight ? 1.5 : 1.2) : isFallback ? 1.8 : 2.2;

			// Color by relation
			if (isFallback) {
				ctx.strokeStyle = pal.dim;
				ctx.setLineDash([4, 3]);
			} else if (edge.relation === "agent-model") {
				ctx.strokeStyle = pal.link;
				ctx.setLineDash([]);
			} else {
				ctx.strokeStyle = pal.edge;
				ctx.setLineDash([]);
			}

			drawEdgePath(ctx, from, to, edge.relation);
			ctx.stroke();
		}
		ctx.setLineDash([]);
		ctx.globalAlpha = 1;

		// ── Nodes ──
		const showPrimary = scale >= LOD_SHAPE_ONLY_BELOW;
		const showSublabel = scale >= LOD_SUBLABEL_AT;

		for (const node of st.layoutNodes) {
			if (st.hiddenKinds.size > 0 && st.hiddenKinds.has(node.kind)) continue;

			// Alpha precedence
			let alpha: number;
			if (st.selectedId) {
				alpha =
					node.id === st.selectedId
						? 1
						: st.selectPath.has(node.id)
							? ALPHA.selectPathNode
							: ALPHA.selectOtherNode;
			} else if (st.hoveredId) {
				alpha =
					node.id === st.hoveredId
						? 1
						: st.hoverConnected.has(node.id)
							? ALPHA.hoverNeighbor
							: ALPHA.hoverOtherNode;
			} else {
				alpha = ALPHA.baseNode;
			}
			if (alpha < 0.02) continue;

			ctx.globalAlpha = alpha;
			const kindColor = pal[KIND_COLOR_KEY[node.kind]];

			// Base fill (opaque surface so edges behind are occluded)
			ctx.fillStyle = pal.surface2;
			roundRect(ctx, node.x, node.y, node.width, node.height, NODE_RADIUS);
			ctx.fill();

			// Kind tint
			ctx.globalAlpha = alpha * 0.16;
			ctx.fillStyle = kindColor;
			roundRect(ctx, node.x, node.y, node.width, node.height, NODE_RADIUS);
			ctx.fill();

			// Border
			ctx.globalAlpha = alpha;
			ctx.strokeStyle = kindColor;
			ctx.lineWidth = node.node.inCycle ? 2 : 1;
			if (node.node.disabled) ctx.setLineDash([3, 3]);
			roundRect(ctx, node.x, node.y, node.width, node.height, NODE_RADIUS);
			ctx.stroke();
			ctx.setLineDash([]);

			// Selected/hovered ring
			if (node.id === st.selectedId) {
				ctx.strokeStyle = pal.accent;
				ctx.lineWidth = 2.5 / scale;
				roundRect(
					ctx,
					node.x - 3 / scale,
					node.y - 3 / scale,
					node.width + 6 / scale,
					node.height + 6 / scale,
					NODE_RADIUS + 2 / scale,
				);
				ctx.stroke();
			} else if (st.hoveredId && node.id === st.hoveredId && !st.selectedId) {
				ctx.strokeStyle = pal.link;
				ctx.lineWidth = 2 / scale;
				roundRect(
					ctx,
					node.x - 2.5 / scale,
					node.y - 2.5 / scale,
					node.width + 5 / scale,
					node.height + 5 / scale,
					NODE_RADIUS + 1.5 / scale,
				);
				ctx.stroke();
			}

			// Labels
			if (showPrimary) {
				ctx.fillStyle = pal.text;
				ctx.font = `600 ${FONT_PRIMARY}px ui-sans-serif, system-ui, sans-serif`;
				ctx.textBaseline = "top";
				ctx.textAlign = "left";
				const label = truncateLabel(node.node.label, MAX_CHARS_BY_KIND[node.kind]);
				ctx.fillText(label, node.x + PAD_X_LABEL, node.y + 6);

				if (showSublabel && node.node.sublabel) {
					ctx.fillStyle = pal.muted;
					ctx.font = `500 ${FONT_SUBLABEL}px ui-sans-serif, system-ui, sans-serif`;
					const sub = truncateLabel(node.node.sublabel, MAX_CHARS_BY_KIND[node.kind] + 6);
					ctx.fillText(sub, node.x + PAD_X_LABEL, node.y + 6 + FONT_PRIMARY + 2);
				}

				// Cycle index badge
				if (node.node.inCycle && node.node.cycleIndex !== undefined) {
					const badgeX = node.x + node.width - 18;
					const badgeY = node.y + 6;
					ctx.fillStyle = pal.accent;
					ctx.beginPath();
					ctx.arc(badgeX, badgeY + 6, 8, 0, Math.PI * 2);
					ctx.fill();
					ctx.fillStyle = pal.page;
					ctx.font = `700 10px ui-sans-serif, system-ui, sans-serif`;
					ctx.textAlign = "center";
					ctx.fillText(String(node.node.cycleIndex + 1), badgeX, badgeY + 1);
				}

				// Disabled marker
				if (node.node.disabled) {
					ctx.fillStyle = pal.dim;
					ctx.font = `500 9px ui-sans-serif, system-ui, sans-serif`;
					ctx.textAlign = "right";
					ctx.fillText("off", node.x + node.width - 6, node.y + 6);
				}
			}
		}
		ctx.globalAlpha = 1;

		// ── Restore to screen space ──
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		// ── Column headers ──
		if (scale >= LOD_SHAPE_ONLY_BELOW * 0.7) {
			ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
			ctx.fillStyle = pal.muted;
			ctx.textBaseline = "top";
			for (let tier = 0; tier < GRAPH_KIND_ORDER.length; tier++) {
				const kind = GRAPH_KIND_ORDER[tier];
				if (st.hiddenKinds.size > 0 && st.hiddenKinds.has(kind)) continue;
				const worldCx = st.columnCenters.get(tier);
				if (worldCx === undefined) continue;
				const screenX = w / 2 + offsetX + worldCx * scale;
				const clampedX = Math.max(50, Math.min(w - 50, screenX));
				const label = `${KIND_PLURAL[kind]} (${st.counts[kind]})`;
				ctx.textAlign = "center";
				ctx.fillText(label, clampedX, w <= 767 ? MOBILE_TOP_INSET - 18 : 8);
			}
		}

		// ── Minimap ──
		drawMinimap(ctx, w, h, pal);
	}

	function drawMinimap(ctx: CanvasRenderingContext2D, w: number, h: number, pal: Palette): void {
		const st = latestRef.current;
		if (st.layoutNodes.length < MINIMAP_SHOW_NODECOUNT) return;
		if (w <= MINIMAP_HIDE_BELOW_WIDTH) return; // hide on narrow

		const mmW = MINIMAP_W;
		const mmH = MINIMAP_H;
		const mmX = w - mmW - MINIMAP_PAD;
		const mmY = h - mmH - MINIMAP_PAD;

		const bbox = st.graphBBox;
		if (!bbox) return;

		// Background
		ctx.fillStyle = pal.surface;
		ctx.strokeStyle = pal.borderStrong;
		ctx.lineWidth = 1;
		ctx.fillRect(mmX, mmY, mmW, mmH);
		ctx.strokeRect(mmX, mmY, mmW, mmH);

		const gw = Math.max(1, bbox.maxX - bbox.minX);
		const gh = Math.max(1, bbox.maxY - bbox.minY);
		const mmScale = Math.min((mmW - 8) / gw, (mmH - 8) / gh);
		const mmOffX = mmX + 4 + (mmW - 8 - gw * mmScale) / 2;
		const mmOffY = mmY + 4 + (mmH - 8 - gh * mmScale) / 2;

		// Nodes as dots
		for (const node of st.layoutNodes) {
			if (st.hiddenKinds.size > 0 && st.hiddenKinds.has(node.kind)) continue;
			const dx = mmOffX + (node.cx - bbox.minX) * mmScale;
			const dy = mmOffY + (node.cy - bbox.minY) * mmScale;
			ctx.fillStyle = pal[KIND_COLOR_KEY[node.kind]];
			const sel = node.id === st.selectedId;
			const sz = sel ? 2.5 : 1.5;
			ctx.fillRect(dx - sz, dy - sz, sz * 2, sz * 2);
		}

		// Viewport rect
		const tl = screenToWorld(0, 0);
		const br = screenToWorld(w, h);
		const vpX1 = mmOffX + (tl.x - bbox.minX) * mmScale;
		const vpY1 = mmOffY + (tl.y - bbox.minY) * mmScale;
		const vpX2 = mmOffX + (br.x - bbox.minX) * mmScale;
		const vpY2 = mmOffY + (br.y - bbox.minY) * mmScale;
		ctx.strokeStyle = pal.accent;
		ctx.lineWidth = 1;
		ctx.strokeRect(vpX1, vpY1, vpX2 - vpX1, Math.max(1, vpY2 - vpY1));
	}

	// Draw edge bezier path (does not stroke)
	function drawEdgePath(
		ctx: CanvasRenderingContext2D,
		from: PlacedNode,
		to: PlacedNode,
		relation: GraphEdgeRelation,
	): void {
		const x1 = from.x + from.width;
		const y1 = from.cy;
		const x2 = to.x;
		const y2 = to.cy;

		if (from.tier < to.tier) {
			const tierDiff = to.tier - from.tier;
			if (tierDiff > 1) {
				// Skip edge (agent→model): smooth through midpoint
				const cx = (x2 - x1) / 2;
				const midY = (y1 + y2) / 2;
				ctx.beginPath();
				ctx.moveTo(x1, y1);
				ctx.bezierCurveTo(x1 + cx, midY, x2 - cx, midY, x2, y2);
			} else {
				// Adjacent edge: standard S-curve
				const cx = (x2 - x1) * 0.5;
				ctx.beginPath();
				ctx.moveTo(x1, y1);
				ctx.bezierCurveTo(x1 + cx, y1, x2 - cx, y2, x2, y2);
			}
			return;
		}

		if (from.tier > to.tier) {
			// Reverse: swap roles
			drawEdgePath(ctx, to, from, relation);
			return;
		}

		// Same tier (fallback model→model): arc to the right
		const fx = from.x + from.width;
		const fy = from.cy;
		const tx = to.x + to.width;
		const ty = to.cy;
		const bow = Math.max(40, Math.abs(fy - ty) * 0.2 + 30);
		ctx.beginPath();
		ctx.moveTo(fx, fy);
		ctx.bezierCurveTo(fx + bow, fy, tx + bow, ty, tx, ty);
	}

	// ── Canvas sizing ───────────────────────────────────────────────────────
	function configureCanvas(cssW: number, cssH: number): void {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
		canvas.width = Math.round(cssW * dpr);
		canvas.height = Math.round(cssH * dpr);
		canvas.style.width = `${cssW}px`;
		canvas.style.height = `${cssH}px`;
		sizeRef.current = { w: cssW, h: cssH, dpr };
	}

	// ── Resize observer + initial fit ───────────────────────────────────────
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const ro = new ResizeObserver(entries => {
			const entry = entries[0];
			if (!entry) return;
			const { width, height } = entry.contentRect;
			if (width === 0 || height === 0) return;
			configureCanvas(width, height);
			if (active) {
				doFit();
				hasFittedRef.current = true;
			} else {
				requestDraw();
			}
		});
		ro.observe(container);
		return () => ro.disconnect();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	// ── Re-fit when becoming active (R2 fix for hidden shell) ───────────────
	useEffect(() => {
		if (active && !hasFittedRef.current) {
			const container = containerRef.current;
			if (container && container.clientWidth > 0 && container.clientHeight > 0) {
				configureCanvas(container.clientWidth, container.clientHeight);
				doFit();
				hasFittedRef.current = true;
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	// ── Redraw when graph data changes ──────────────────────────────────────
	useEffect(() => {
		if (hasFittedRef.current) {
			// Update min scale for new graph
			const fit = computeFit();
			if (fit) minScaleRef.current = Math.min(INTERACTIVE_MIN_SCALE, fit.scale * 0.9);
			requestDraw();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [graph]);

	// ── Wheel handler (non-passive for preventDefault) ──────────────────────
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const handler = (e: WheelEvent): void => {
			e.preventDefault();
			const rect = canvas.getBoundingClientRect();
			const px = e.clientX - rect.left;
			const py = e.clientY - rect.top;
			const f = e.deltaY > 0 ? 1 / ZOOM_FACTOR_WHEEL : ZOOM_FACTOR_WHEEL;
			zoomAtPoint(f, px, py);
		};
		canvas.addEventListener("wheel", handler, { passive: false });
		return () => canvas.removeEventListener("wheel", handler);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── Minimap helpers ─────────────────────────────────────────────────────
	function isInMinimap(px: number, py: number): boolean {
		const { w } = sizeRef.current;
		if (w <= MINIMAP_HIDE_BELOW_WIDTH) return false;
		const st = latestRef.current;
		if (st.layoutNodes.length < MINIMAP_SHOW_NODECOUNT) return false;
		const mmX = w - MINIMAP_W - MINIMAP_PAD;
		const mmY = sizeRef.current.h - MINIMAP_H - MINIMAP_PAD;
		return px >= mmX && px <= mmX + MINIMAP_W && py >= mmY && py <= mmY + MINIMAP_H;
	}

	function minimapRecenter(px: number, py: number): void {
		const st = latestRef.current;
		const bbox = st.graphBBox;
		if (!bbox) return;
		const { w } = sizeRef.current;
		const mmX = w - MINIMAP_W - MINIMAP_PAD;
		const mmY = sizeRef.current.h - MINIMAP_H - MINIMAP_PAD;
		const gw = Math.max(1, bbox.maxX - bbox.minX);
		const gh = Math.max(1, bbox.maxY - bbox.minY);
		const mmScale = Math.min((MINIMAP_W - 8) / gw, (MINIMAP_H - 8) / gh);
		const mmOffX = mmX + 4 + (MINIMAP_W - 8 - gw * mmScale) / 2;
		const mmOffY = mmY + 4 + (MINIMAP_H - 8 - gh * mmScale) / 2;
		const worldX = (px - mmOffX) / mmScale + bbox.minX;
		const worldY = (py - mmOffY) / mmScale + bbox.minY;
		const { scale } = transformRef.current;
		transformRef.current.offsetX = -worldX * scale;
		transformRef.current.offsetY = -worldY * scale;
		requestDraw();
	}

	function getCanvasPos(e: { clientX: number; clientY: number }): { x: number; y: number } {
		const canvas = canvasRef.current;
		if (!canvas) return { x: 0, y: 0 };
		const rect = canvas.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	// ── Pointer handlers ────────────────────────────────────────────────────
	function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>): void {
		const { x, y } = getCanvasPos(e);

		if (isInMinimap(x, y)) {
			minimapDragRef.current = true;
			canvasRef.current?.setPointerCapture(e.pointerId);
			minimapRecenter(x, y);
			return;
		}

		canvasRef.current?.setPointerCapture(e.pointerId);
		dragStateRef.current = {
			startX: x,
			startY: y,
			startOffsetX: transformRef.current.offsetX,
			startOffsetY: transformRef.current.offsetY,
			moved: false,
		};
	}

	function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>): void {
		const { x, y } = getCanvasPos(e);

		if (minimapDragRef.current) {
			minimapRecenter(x, y);
			return;
		}

		const drag = dragStateRef.current;
		if (drag) {
			const dx = x - drag.startX;
			const dy = y - drag.startY;
			if (Math.abs(dx) > DRAG_CLICK_THRESHOLD_PX || Math.abs(dy) > DRAG_CLICK_THRESHOLD_PX) {
				drag.moved = true;
			}
			transformRef.current.offsetX = drag.startOffsetX + dx;
			transformRef.current.offsetY = drag.startOffsetY + dy;
			requestDraw();
		} else {
			const id = hitTest(x, y);
			setHoveredId(id);
		}
	}

	function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>): void {
		const { x, y } = getCanvasPos(e);
		canvasRef.current?.releasePointerCapture(e.pointerId);

		if (minimapDragRef.current) {
			minimapDragRef.current = false;
			dragStateRef.current = null;
			return;
		}

		const drag = dragStateRef.current;
		dragStateRef.current = null;

		if (drag && !drag.moved) {
			const id = hitTest(x, y);
			setSelectedId(id);
		}
	}

	function onPointerLeave(): void {
		if (!minimapDragRef.current && !dragStateRef.current) {
			setHoveredId(null);
		}
	}

	// ── Keyboard handler ────────────────────────────────────────────────────
	function onKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>): void {
		const step = e.shiftKey ? 120 : 60;
		switch (e.key) {
			case "ArrowLeft":
				transformRef.current.offsetX += step;
				requestDraw();
				e.preventDefault();
				break;
			case "ArrowRight":
				transformRef.current.offsetX -= step;
				requestDraw();
				e.preventDefault();
				break;
			case "ArrowUp":
				transformRef.current.offsetY += step;
				requestDraw();
				e.preventDefault();
				break;
			case "ArrowDown":
				transformRef.current.offsetY -= step;
				requestDraw();
				e.preventDefault();
				break;
			case "+":
			case "=":
				zoomCenter(ZOOM_STEP_BUTTON);
				e.preventDefault();
				break;
			case "-":
			case "_":
				zoomCenter(1 / ZOOM_STEP_BUTTON);
				e.preventDefault();
				break;
			case "f":
			case "F":
			case "0":
				doFit();
				e.preventDefault();
				break;
			case "Escape":
				setSelectedId(null);
				setHoveredId(null);
				e.preventDefault();
				break;
		}
	}

	// ── Kind filter toggle ──────────────────────────────────────────────────
	function toggleKind(kind: GraphNodeKind): void {
		setHiddenKinds(prev => {
			const next = new Set(prev);
			if (next.has(kind)) next.delete(kind);
			else next.add(kind);
			return next;
		});
		// Re-fit after filter change
		setTimeout(() => doFit(), 0);
	}

	// ── Cleanup ─────────────────────────────────────────────────────────────
	useEffect(() => {
		return () => {
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
		};
	}, []);

	// ── Selected node for inspector ─────────────────────────────────────────
	const selectedNode = selectedId ? (placedById.get(selectedId) ?? null) : null;

	// ── Search filter ───────────────────────────────────────────────────────
	const searchLower = searchQuery.trim().toLowerCase();
	const filteredNodes = useMemo(() => {
		if (!searchLower) return graph.nodes;
		return graph.nodes.filter(
			n => n.label.toLowerCase().includes(searchLower) || (n.sublabel?.toLowerCase().includes(searchLower) ?? false),
		);
	}, [graph.nodes, searchLower]);

	// ── Aria label ──────────────────────────────────────────────────────────
	const ariaLabel = `Routing graph for profile ${profile}: ${counts.agent} agents, ${counts.role} roles, ${counts.model} models, ${counts.provider} providers`;

	const filtersHidden = hiddenKinds.size > 0;

	return (
		<div
			className="home-graph-canvas-container"
			ref={containerRef}
			role="figure"
			aria-label={ariaLabel}
			style={{ "--live-zoom": `${zoomPct}%` } as React.CSSProperties}
		>
			<canvas
				ref={canvasRef}
				className="home-graph-canvas"
				aria-hidden="true"
				tabIndex={0}
				role="img"
				aria-label="Routing graph canvas. Use arrow keys to pan, plus/minus to zoom, F to fit, Escape to clear."
				aria-keyshortcuts="ArrowKeys + - f Escape"
				title={CANVAS_KEYSHORTCUTS}
				style={{ touchAction: "none", cursor: dragStateRef.current ? "grabbing" : "grab" }}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerLeave={onPointerLeave}
				onPointerCancel={onPointerUp}
				onKeyDown={onKeyDown}
			/>

			{/* Controls overlay — top bar */}
			<div className="home-graph-controls-top">
				<div className="home-graph-search">
					<Search size={13} />
					<input
						type="search"
						className="home-input home-graph-search-input"
						placeholder="Search nodes…"
						value={searchQuery}
						onChange={e => setSearchQuery(e.target.value)}
						aria-label="Search graph nodes"
					/>
				</div>
				<div className="home-graph-kind-filters" role="group" aria-label="Filter node kinds">
					{GRAPH_KIND_ORDER.map(kind => {
						const isHidden = hiddenKinds.has(kind);
						return (
							<button
								key={kind}
								type="button"
								className="home-graph-kind-toggle"
								data-kind={kind}
								data-active={!isHidden}
								onClick={() => toggleKind(kind)}
								aria-pressed={!isHidden}
								title={
									isHidden
										? `Show ${KIND_PLURAL[kind].toLowerCase()}`
										: `Hide ${KIND_PLURAL[kind].toLowerCase()}`
								}
							>
								<span className="home-graph-kind-toggle-label">{KIND_PLURAL[kind]}</span>
								<span className="home-graph-kind-toggle-count">{counts[kind]}</span>
							</button>
						);
					})}
				</div>
			</div>

			{/* Node-count badge */}
			<div className="home-graph-nodecount" aria-hidden="true" data-filtered={filtersHidden}>
				<span className="home-graph-nodecount-value">{visibleNodeCount}</span>
				<span className="home-graph-nodecount-label">{visibleNodeCount === 1 ? "node" : "nodes"}</span>
			</div>

			{/* Controls overlay — zoom bar */}
			<div className="home-graph-controls-zoom">
				<button
					type="button"
					className="home-icon-btn"
					onClick={() => zoomCenter(1 / ZOOM_STEP_BUTTON)}
					aria-label="Zoom out"
					title="Zoom out (−)"
				>
					<Minus size={14} />
				</button>
				<span className="home-graph-zoom-readout" aria-live="off">
					{zoomPct}%
				</span>
				<button
					type="button"
					className="home-icon-btn"
					onClick={() => zoomCenter(ZOOM_STEP_BUTTON)}
					aria-label="Zoom in"
					title="Zoom in (+)"
				>
					<Plus size={14} />
				</button>
				<button
					type="button"
					className="home-icon-btn"
					onClick={doFit}
					aria-label="Fit to view"
					title="Fit to view (F)"
				>
					<Maximize size={14} />
				</button>
				<button
					type="button"
					className="home-icon-btn"
					onClick={doReset}
					aria-label="Reset view"
					title="Reset to 100%"
				>
					<RotateCcw size={14} />
				</button>
			</div>

			{/* Legend */}
			<div className="home-graph-canvas-legend" aria-hidden="true">
				{GRAPH_KIND_ORDER.map(kind => (
					<span key={kind} className="home-graph-legend-item">
						<span className="home-graph-legend-dot" data-kind={kind} />
						{KIND_PLURAL[kind]}
					</span>
				))}
				<span className="home-graph-legend-item">
					<span className="home-graph-legend-line home-graph-legend-line-solid" />
					Route
				</span>
				<span className="home-graph-legend-item">
					<span className="home-graph-legend-line home-graph-legend-line-dashed" />
					Fallback
				</span>
			</div>

			{/* Node list / a11y fallback */}
			<details className="home-graph-nodelist">
				<summary className="home-graph-nodelist-summary">Nodes ({graph.nodes.length})</summary>
				<div className="home-graph-nodelist-body">
					{GRAPH_KIND_ORDER.map(kind => {
						const nodes = filteredNodes.filter(n => n.kind === kind);
						if (nodes.length === 0) return null;
						return (
							<div key={kind} className="home-graph-nodelist-group" role="group" aria-label={KIND_PLURAL[kind]}>
								<div className="home-graph-nodelist-group-label">
									{KIND_PLURAL[kind]} ({nodes.length})
								</div>
								{nodes.map(node => {
									const neighbors = adjacency.get(node.id) ?? [];
									const neighborLabels = neighbors
										.slice(0, 5)
										.map(id => placedById.get(id)?.node.label ?? id)
										.join(", ");
									return (
										<button
											key={node.id}
											type="button"
											className="home-graph-nodelist-item"
											data-selected={node.id === selectedId}
											onClick={() => selectAndCenter(node.id)}
											aria-label={`${kind}: ${node.label}.${node.sublabel ? ` ${node.sublabel}.` : ""}${neighborLabels ? ` Connected to: ${neighborLabels}.` : ""}`}
										>
											<span className="home-graph-nodelist-item-label">{node.label}</span>
											{node.sublabel && (
												<span className="home-graph-nodelist-item-sub">{node.sublabel}</span>
											)}
										</button>
									);
								})}
							</div>
						);
					})}
					{filteredNodes.length === 0 && (
						<div className="home-graph-nodelist-empty">No nodes match "{searchQuery}".</div>
					)}
				</div>
			</details>

			{/* Inspector */}
			{selectedNode && (
				<GraphInspector
					key={`${selectedNode.id}-${inspectorTick}`}
					node={selectedNode}
					profile={profile}
					config={config}
					catalogModels={catalogModels}
					onApplied={async () => {
						await onApplied();
						setInspectorTick(t => t + 1);
					}}
					onNavigateProviders={onNavigateProviders}
					onClose={() => setSelectedId(null)}
				/>
			)}
		</div>
	);
}

// ─── Inspector ──────────────────────────────────────────────────────────────

interface InspectorProps {
	node: PlacedNode;
	profile: string;
	config: ResolvedConfig | null;
	catalogModels: readonly ModelPreview[];
	onApplied: () => Promise<void>;
	onNavigateProviders: () => void;
	onClose: () => void;
}

function GraphInspector({
	node,
	profile,
	config,
	catalogModels,
	onApplied,
	onNavigateProviders,
	onClose,
}: InspectorProps) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const gn = node.node;
	const roleName = node.kind === "role" ? node.id.slice(5) : "";
	const modelRoles = useMemo(() => {
		const r = config?.values.modelRoles;
		return r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, string>) : {};
	}, [config]);

	// Role editing state
	const roleSelector = roleName ? (modelRoles[roleName] ?? "") : "";
	const parsed = useMemo(() => parseSelector(roleSelector), [roleSelector]);
	const [modelBase, setModelBase] = useState(parsed.base);
	const [thinkingLevel, setThinkingLevel] = useState(parsed.thinking);

	useEffect(() => {
		const p = parseSelector(roleSelector);
		setModelBase(p.base);
		setThinkingLevel(p.thinking);
		setError(null);
	}, [roleSelector, node.id]);
	// Agent editing state
	const agentName = node.kind === "agent" ? node.id.slice(6) : "";
	const overrides = useMemo(() => {
		const r = config?.values["task.agentModelOverrides"];
		return r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, string>) : {};
	}, [config]);
	const disabledAgents = useMemo(() => {
		const r = config?.values["task.disabledAgents"];
		return Array.isArray(r) ? (r.filter(v => typeof v === "string") as string[]) : [];
	}, [config]);
	const currentOverride = overrides[agentName] ?? "";
	const [overrideValue, setOverrideValue] = useState(currentOverride);
	useEffect(() => {
		setOverrideValue(currentOverride);
	}, [currentOverride]);

	const isAgentDisabled = disabledAgents.includes(agentName);

	async function applyRoleEdit(): Promise<void> {
		if (!profile || !roleName) return;
		setBusy(true);
		setError(null);
		try {
			const newSelector = formatSelector(modelBase.trim(), thinkingLevel);
			const edits: ConfigEdit[] = [{ path: `modelRoles.${roleName}`, value: newSelector }];
			await putConfig(profile, edits);
			await onApplied();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	async function applyAgentOverride(): Promise<void> {
		if (!profile || !agentName) return;
		setBusy(true);
		setError(null);
		try {
			const value = overrideValue.trim() || undefined;
			const edits: ConfigEdit[] = [{ path: `task.agentModelOverrides.${agentName}`, value }];
			await putConfig(profile, edits);
			await onApplied();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	async function toggleAgentDisabled(): Promise<void> {
		if (!profile || !agentName) return;
		setBusy(true);
		setError(null);
		try {
			const next = isAgentDisabled
				? disabledAgents.filter(n => n !== agentName)
				: [...new Set([...disabledAgents, agentName])];
			const edits: ConfigEdit[] = [{ path: "task.disabledAgents", value: next }];
			await putConfig(profile, edits);
			await onApplied();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	const modelDatalistId = "home-graph-model-list";

	return (
		<aside
			className="home-graph-inspector"
			role="complementary"
			aria-label={`Inspector: ${gn.label}`}
			aria-live="polite"
		>
			<div className="home-graph-inspector-header">
				<div className="home-graph-inspector-title-row">
					<span className="home-graph-inspector-kind-badge" data-kind={node.kind}>
						{node.kind}
					</span>
					<h3 className="home-graph-inspector-title">{gn.label}</h3>
					<button type="button" className="home-icon-btn" onClick={onClose} aria-label="Close inspector">
						<X size={14} />
					</button>
				</div>
				{gn.sublabel && <p className="home-graph-inspector-subtitle">{gn.sublabel}</p>}
			</div>

			{error && <div className="home-graph-inspector-error">{error}</div>}

			<div className="home-graph-inspector-body">
				{/* Role node */}
				{node.kind === "role" && (
					<>
						<div className="home-graph-inspector-meta">
							{gn.inCycle && gn.cycleIndex !== undefined && (
								<span className="home-graph-inspector-pill">Cycle step {gn.cycleIndex + 1}</span>
							)}
							{!gn.inCycle && (
								<span className="home-graph-inspector-pill home-graph-inspector-pill-muted">Not in cycle</span>
							)}
						</div>
						<div className="home-graph-inspector-field">
							<label className="home-graph-inspector-label" htmlFor="home-gi-model">
								Model selector
							</label>
							<input
								id="home-gi-model"
								className="home-input"
								value={modelBase}
								onChange={e => setModelBase(e.target.value)}
								placeholder="provider/model"
								list={modelDatalistId}
								disabled={busy}
							/>
							<datalist id={modelDatalistId}>
								{catalogModels.map((m, i) => (
									<option key={`${m.provider}/${m.id}/${i}`} value={`${m.provider}/${m.id}`}>
										{m.name}
									</option>
								))}
							</datalist>
						</div>
						<div className="home-graph-inspector-field">
							<label className="home-graph-inspector-label" htmlFor="home-gi-thinking">
								Thinking level
							</label>
							<select
								id="home-gi-thinking"
								className="home-input home-input-select"
								value={thinkingLevel}
								onChange={e => setThinkingLevel(e.target.value)}
								disabled={busy}
							>
								{THINKING_OPTIONS.map(opt => (
									<option key={opt.value || "inherit"} value={opt.value}>
										{opt.label}
									</option>
								))}
							</select>
						</div>
						<div className="home-graph-inspector-preview">
							<span className="home-text-muted home-text-xs">Result: </span>
							<code>{formatSelector(modelBase.trim() || "(empty)", thinkingLevel)}</code>
						</div>
						<button
							type="button"
							className="home-button home-button-primary"
							onClick={() => void applyRoleEdit()}
							disabled={busy}
						>
							{busy ? "Saving…" : "Apply"}
						</button>
					</>
				)}

				{/* Agent node */}
				{node.kind === "agent" && (
					<>
						<div className="home-graph-inspector-meta">
							<span className="home-graph-inspector-pill">Source: {gn.meta?.agentSource ?? "unknown"}</span>
							<span
								className={`home-graph-inspector-pill ${gn.disabled ? "home-graph-inspector-pill-danger" : "home-graph-inspector-pill-success"}`}
							>
								{gn.disabled ? "Disabled" : "Enabled"}
							</span>
						</div>
						<div className="home-graph-inspector-field">
							<label className="home-graph-inspector-label" htmlFor="home-gi-override">
								Model override
							</label>
							<input
								id="home-gi-override"
								className="home-input"
								value={overrideValue}
								onChange={e => setOverrideValue(e.target.value)}
								placeholder="(inherit from role)"
								list={modelDatalistId}
								disabled={busy}
							/>
							<datalist id={modelDatalistId}>
								{catalogModels.map((m, i) => (
									<option key={`${m.provider}/${m.id}/${i}`} value={`${m.provider}/${m.id}`}>
										{m.name}
									</option>
								))}
							</datalist>
						</div>
						<div className="home-graph-inspector-actions">
							<button
								type="button"
								className="home-button home-button-primary"
								onClick={() => void applyAgentOverride()}
								disabled={busy}
							>
								{busy ? "Saving…" : "Apply override"}
							</button>
							<button
								type="button"
								className={`home-button ${isAgentDisabled ? "home-button-primary" : "home-button-secondary"}`}
								data-danger={!isAgentDisabled}
								onClick={() => void toggleAgentDisabled()}
								disabled={busy}
							>
								{isAgentDisabled ? "Enable" : "Disable"}
							</button>
						</div>
					</>
				)}

				{/* Model node */}
				{node.kind === "model" && (
					<>
						<div className="home-graph-inspector-meta">
							{gn.meta?.modelProvider && (
								<span className="home-graph-inspector-pill">Provider: {gn.meta.modelProvider}</span>
							)}
							{gn.meta?.thinkingLevel && (
								<span className="home-graph-inspector-pill">Thinking: {gn.meta.thinkingLevel}</span>
							)}
						</div>
						<div className="home-graph-inspector-info">
							<p className="home-text-muted home-text-xs">
								Model nodes are read-only. Edit the role or agent that references this model to change its
								selector.
							</p>
						</div>
						<button type="button" className="home-button home-button-secondary" onClick={onNavigateProviders}>
							Open Providers
						</button>
					</>
				)}

				{/* Provider node */}
				{node.kind === "provider" && (
					<>
						<div className="home-graph-inspector-meta">
							{gn.originKind && <span className="home-graph-inspector-pill">Auth: {gn.originKind}</span>}
							{gn.meta?.authStatus && (
								<span
									className={`home-graph-inspector-pill ${gn.meta.authStatus === "ok" ? "home-graph-inspector-pill-success" : gn.meta.authStatus === "env" ? "home-graph-inspector-pill-warning" : "home-graph-inspector-pill-danger"}`}
								>
									{gn.meta.authStatus === "ok" ? "Authed" : gn.meta.authStatus === "env" ? "Env" : "No auth"}
								</span>
							)}
						</div>
						<button type="button" className="home-button home-button-secondary" onClick={onNavigateProviders}>
							Open Providers
						</button>
					</>
				)}
			</div>
		</aside>
	);
}
