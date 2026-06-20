import type { GraphEdge, GraphNode, GraphNodeKind, RoutingGraph } from "../../api-types";

export const NODE_H = 46;
export const LANE_GAP = 120;
export const ROW_GAP = 14;
export const LAYOUT_PADDING = 48;
export const BARYCENTER_SWEEPS = 4;

export const WIDTH_BY_KIND: Record<GraphNodeKind, number> = {
	agent: 196,
	role: 184,
	model: 232,
	provider: 150,
};

export const GRAPH_KIND_ORDER = ["agent", "role", "model", "provider"] as const satisfies readonly GraphNodeKind[];

export interface LayoutOptions {
	laneGap?: number;
	rowGap?: number;
	nodeHeight?: number;
	padding?: number;
	widthByKind?: Partial<Record<GraphNodeKind, number>>;
}

export interface PlacedNode {
	id: string;
	node: GraphNode;
	kind: GraphNodeKind;
	x: number;
	y: number;
	width: number;
	height: number;
	cx: number;
	cy: number;
	tier: number;
	order: number;
}

export interface LayoutResult {
	nodes: PlacedNode[];
	width: number;
	height: number;
}

interface LayoutConfig {
	laneGap: number;
	rowGap: number;
	nodeHeight: number;
	padding: number;
	widthByKind: Record<GraphNodeKind, number>;
}

interface OrderedNode {
	id: string;
	node: GraphNode;
	kind: GraphNodeKind;
}

interface RankedNode {
	entry: OrderedNode;
	previousIndex: number;
	value: number;
	hasReference: boolean;
}

interface CountedEdge {
	leftId: string;
	rightId: string;
	leftTier: number;
	rightTier: number;
	leftOrder: number;
	rightOrder: number;
}

const KIND_TIER: Record<GraphNodeKind, number> = {
	agent: 0,
	role: 1,
	model: 2,
	provider: 3,
};

const SWEEP_DOWN = "down";
const SWEEP_UP = "up";

type SweepDirection = typeof SWEEP_DOWN | typeof SWEEP_UP;

export function layoutTierForKind(kind: GraphNodeKind): number {
	return KIND_TIER[kind];
}

export function layoutRoutingGraph(graph: RoutingGraph, opts: LayoutOptions = {}): LayoutResult {
	const config = resolveLayoutConfig(opts);
	const tiers = buildInitialTierOrders(graph.nodes);
	applyBarycenterSweeps(tiers, graph.edges);

	const columnX = computeColumnX(config.widthByKind, config.laneGap);
	const placedNodes: PlacedNode[] = [];
	let maxTierHeight = 0;

	for (let tier = 0; tier < GRAPH_KIND_ORDER.length; tier++) {
		const tierNodes = tiers[tier] ?? [];
		const tierHeight = tierNodes.length * config.nodeHeight + Math.max(0, tierNodes.length - 1) * config.rowGap;
		maxTierHeight = Math.max(maxTierHeight, tierHeight);
		const startY = -tierHeight / 2;

		for (let order = 0; order < tierNodes.length; order++) {
			const entry = tierNodes[order];
			if (!entry) continue;
			const width = config.widthByKind[entry.kind];
			const x = columnX[tier] ?? 0;
			const y = startY + order * (config.nodeHeight + config.rowGap);
			placedNodes.push({
				id: entry.id,
				node: entry.node,
				kind: entry.kind,
				x,
				y,
				width,
				height: config.nodeHeight,
				cx: x + width / 2,
				cy: y + config.nodeHeight / 2,
				tier,
				order,
			});
		}
	}

	return {
		nodes: placedNodes,
		width: graphContentWidth(config.widthByKind, config.laneGap) + config.padding * 2,
		height: maxTierHeight + config.padding * 2,
	};
}

export function countCrossings(graph: RoutingGraph, placedNodes: readonly PlacedNode[]): number {
	const placedById = new Map<string, PlacedNode>();
	for (const node of placedNodes) placedById.set(node.id, node);

	const countedEdges: CountedEdge[] = [];
	for (const edge of [...graph.edges].sort(compareEdges)) {
		const counted = normalizeEdgeForCounting(edge, placedById);
		if (counted) countedEdges.push(counted);
	}

	let crossings = 0;
	for (let i = 0; i < countedEdges.length; i++) {
		const a = countedEdges[i];
		if (!a) continue;
		for (let j = i + 1; j < countedEdges.length; j++) {
			const b = countedEdges[j];
			if (!b) continue;
			if (a.leftTier !== b.leftTier || a.rightTier !== b.rightTier) continue;
			if (a.leftId === b.leftId || a.leftId === b.rightId || a.rightId === b.leftId || a.rightId === b.rightId) {
				continue;
			}
			const leftDelta = a.leftOrder - b.leftOrder;
			const rightDelta = a.rightOrder - b.rightOrder;
			if (leftDelta * rightDelta < 0) crossings++;
		}
	}

	return crossings;
}

function resolveLayoutConfig(opts: LayoutOptions): LayoutConfig {
	return {
		laneGap: opts.laneGap ?? LANE_GAP,
		rowGap: opts.rowGap ?? ROW_GAP,
		nodeHeight: opts.nodeHeight ?? NODE_H,
		padding: opts.padding ?? LAYOUT_PADDING,
		widthByKind: {
			agent: opts.widthByKind?.agent ?? WIDTH_BY_KIND.agent,
			role: opts.widthByKind?.role ?? WIDTH_BY_KIND.role,
			model: opts.widthByKind?.model ?? WIDTH_BY_KIND.model,
			provider: opts.widthByKind?.provider ?? WIDTH_BY_KIND.provider,
		},
	};
}

function buildInitialTierOrders(nodes: readonly GraphNode[]): OrderedNode[][] {
	const tiers: OrderedNode[][] = GRAPH_KIND_ORDER.map(() => []);
	for (const node of [...nodes].sort((a, b) => compareIds(a.id, b.id))) {
		const tier = layoutTierForKind(node.kind);
		const tierNodes = tiers[tier];
		if (!tierNodes) continue;
		tierNodes.push({ id: node.id, node, kind: node.kind });
	}
	return tiers;
}

function applyBarycenterSweeps(tiers: OrderedNode[][], edges: readonly GraphEdge[]): void {
	const nodeTierById = buildNodeTierLookup(tiers);
	const adjacency = buildAdjacency(edges, nodeTierById);

	for (let sweep = 0; sweep < BARYCENTER_SWEEPS; sweep++) {
		const direction: SweepDirection = sweep % 2 === 0 ? SWEEP_DOWN : SWEEP_UP;
		const tierOrder = direction === SWEEP_DOWN ? [0, 1, 2, 3] : [3, 2, 1, 0];
		for (const tier of tierOrder) {
			const tierNodes = tiers[tier];
			if (!tierNodes || tierNodes.length < 2) continue;
			const ranks = buildNormalizedRanks(tiers);
			tiers[tier] = sortTierByBarycenter(tierNodes, tier, direction, ranks, nodeTierById, adjacency);
		}
	}
}

function buildNodeTierLookup(tiers: readonly OrderedNode[][]): Map<string, number> {
	const nodeTierById = new Map<string, number>();
	for (let tier = 0; tier < tiers.length; tier++) {
		const tierNodes = tiers[tier] ?? [];
		for (const entry of tierNodes) nodeTierById.set(entry.id, tier);
	}
	return nodeTierById;
}

function buildAdjacency(edges: readonly GraphEdge[], nodeTierById: ReadonlyMap<string, number>): Map<string, string[]> {
	const adjacency = new Map<string, string[]>();
	for (const id of [...nodeTierById.keys()].sort(compareIds)) adjacency.set(id, []);

	for (const edge of [...edges].sort(compareEdges)) {
		if (!nodeTierById.has(edge.from) || !nodeTierById.has(edge.to)) continue;
		adjacency.get(edge.from)?.push(edge.to);
		adjacency.get(edge.to)?.push(edge.from);
	}

	for (const id of [...adjacency.keys()].sort(compareIds)) adjacency.get(id)?.sort(compareIds);
	return adjacency;
}

function buildNormalizedRanks(tiers: readonly OrderedNode[][]): Map<string, number> {
	const ranks = new Map<string, number>();
	for (const tierNodes of tiers) {
		const denominator = Math.max(1, tierNodes.length - 1);
		for (let index = 0; index < tierNodes.length; index++) {
			const entry = tierNodes[index];
			if (!entry) continue;
			ranks.set(entry.id, index / denominator);
		}
	}
	return ranks;
}

function sortTierByBarycenter(
	tierNodes: readonly OrderedNode[],
	tier: number,
	direction: SweepDirection,
	ranks: ReadonlyMap<string, number>,
	nodeTierById: ReadonlyMap<string, number>,
	adjacency: ReadonlyMap<string, readonly string[]>,
): OrderedNode[] {
	const denominator = Math.max(1, tierNodes.length - 1);
	const rankedNodes: RankedNode[] = tierNodes.map((entry, previousIndex) => {
		const barycenter = calculateBarycenter(entry.id, tier, direction, ranks, nodeTierById, adjacency);
		return {
			entry,
			previousIndex,
			value: barycenter ?? previousIndex / denominator,
			hasReference: barycenter !== null,
		};
	});

	rankedNodes.sort(compareRankedNodes);
	return rankedNodes.map(item => item.entry);
}

function calculateBarycenter(
	id: string,
	tier: number,
	direction: SweepDirection,
	ranks: ReadonlyMap<string, number>,
	nodeTierById: ReadonlyMap<string, number>,
	adjacency: ReadonlyMap<string, readonly string[]>,
): number | null {
	const neighbors = adjacency.get(id);
	if (!neighbors || neighbors.length === 0) return null;

	let total = 0;
	let count = 0;
	for (const neighborId of neighbors) {
		const neighborTier = nodeTierById.get(neighborId);
		if (neighborTier === undefined) continue;
		const inReferenceDirection = direction === SWEEP_DOWN ? neighborTier < tier : neighborTier > tier;
		if (!inReferenceDirection) continue;
		const rank = ranks.get(neighborId);
		if (rank === undefined) continue;
		total += rank;
		count++;
	}

	return count === 0 ? null : total / count;
}

function compareRankedNodes(a: RankedNode, b: RankedNode): number {
	if (a.value !== b.value) return a.value < b.value ? -1 : 1;
	if (a.hasReference || b.hasReference) return compareIds(a.entry.id, b.entry.id);
	return a.previousIndex - b.previousIndex || compareIds(a.entry.id, b.entry.id);
}

function computeColumnX(widthByKind: Record<GraphNodeKind, number>, laneGap: number): number[] {
	const columnX: number[] = [];
	let x = 0;
	for (const kind of GRAPH_KIND_ORDER) {
		columnX.push(x);
		x += widthByKind[kind] + laneGap;
	}
	return columnX;
}

function graphContentWidth(widthByKind: Record<GraphNodeKind, number>, laneGap: number): number {
	let width = 0;
	for (let index = 0; index < GRAPH_KIND_ORDER.length; index++) {
		const kind = GRAPH_KIND_ORDER[index];
		if (!kind) continue;
		width += widthByKind[kind];
		if (index < GRAPH_KIND_ORDER.length - 1) width += laneGap;
	}
	return width;
}

function normalizeEdgeForCounting(edge: GraphEdge, placedById: ReadonlyMap<string, PlacedNode>): CountedEdge | null {
	const from = placedById.get(edge.from);
	const to = placedById.get(edge.to);
	if (!from || !to || from.tier === to.tier) return null;

	if (from.tier < to.tier) {
		return {
			leftId: from.id,
			rightId: to.id,
			leftTier: from.tier,
			rightTier: to.tier,
			leftOrder: from.order,
			rightOrder: to.order,
		};
	}

	return {
		leftId: to.id,
		rightId: from.id,
		leftTier: to.tier,
		rightTier: from.tier,
		leftOrder: to.order,
		rightOrder: from.order,
	};
}

function compareEdges(a: GraphEdge, b: GraphEdge): number {
	return (
		compareIds(a.from, b.from) ||
		compareIds(a.to, b.to) ||
		compareIds(a.relation, b.relation) ||
		compareIds(a.kind, b.kind)
	);
}

function compareIds(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}
