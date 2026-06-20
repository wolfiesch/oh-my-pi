import { describe, expect, it } from "bun:test";
import type { GraphNode, GraphNodeKind, RoutingGraph } from "@oh-my-pi/omp-home/api-types";
import type { PlacedNode } from "../../home/src/client/graph/layout";
import {
	countCrossings,
	GRAPH_KIND_ORDER,
	LANE_GAP,
	LAYOUT_PADDING,
	layoutRoutingGraph,
	layoutTierForKind,
	NODE_H,
	ROW_GAP,
	WIDTH_BY_KIND,
} from "../../home/src/client/graph/layout";

describe("home graph layered layout", () => {
	it("returns deterministic placements independent of input array order", () => {
		const graph: RoutingGraph = {
			nodes: [
				{ id: "provider:openai", kind: "provider", label: "OpenAI" },
				{ id: "agent:reviewer", kind: "agent", label: "Reviewer" },
				{ id: "model:gpt", kind: "model", label: "gpt-5.5", sublabel: "openai" },
				{ id: "role:default", kind: "role", label: "default", inCycle: true, cycleIndex: 0 },
				{ id: "model:fallback", kind: "model", label: "fallback", sublabel: "openrouter" },
			],
			edges: [
				{ from: "role:default", to: "model:gpt", kind: "solid", relation: "role-model" },
				{ from: "model:gpt", to: "provider:openai", kind: "solid", relation: "model-provider" },
				{ from: "agent:reviewer", to: "model:gpt", kind: "solid", relation: "agent-model" },
				{ from: "model:gpt", to: "model:fallback", kind: "dashed", relation: "fallback" },
			],
		};

		const first = layoutRoutingGraph(graph);
		const reordered = layoutRoutingGraph({
			nodes: [...graph.nodes].reverse(),
			edges: [...graph.edges].reverse(),
		});

		const firstPlacements = first.nodes.map(({ node: _node, ...placement }) => placement);
		const reorderedPlacements = reordered.nodes.map(({ node: _node, ...placement }) => placement);
		expect(first.width).toBe(reordered.width);
		expect(first.height).toBe(reordered.height);
		expect(firstPlacements).toEqual(reorderedPlacements);
	});

	it("assigns fixed tiers and column geometry by node kind", () => {
		const graph: RoutingGraph = {
			nodes: [
				{ id: "agent:scout", kind: "agent", label: "Scout" },
				{ id: "role:default", kind: "role", label: "default" },
				{ id: "model:opus", kind: "model", label: "claude-opus" },
				{ id: "provider:anthropic", kind: "provider", label: "Anthropic" },
			],
			edges: [
				{ from: "agent:scout", to: "model:opus", kind: "solid", relation: "agent-model" },
				{ from: "role:default", to: "model:opus", kind: "solid", relation: "role-model" },
				{ from: "model:opus", to: "provider:anthropic", kind: "solid", relation: "model-provider" },
			],
		};

		const result = layoutRoutingGraph(graph);
		const placedById = new Map<string, PlacedNode>();
		for (const node of result.nodes) placedById.set(node.id, node);
		const roleX = WIDTH_BY_KIND.agent + LANE_GAP;
		const modelX = roleX + WIDTH_BY_KIND.role + LANE_GAP;
		const providerX = modelX + WIDTH_BY_KIND.model + LANE_GAP;

		expect(layoutTierForKind("agent")).toBe(0);
		expect(layoutTierForKind("role")).toBe(1);
		expect(layoutTierForKind("model")).toBe(2);
		expect(layoutTierForKind("provider")).toBe(3);
		expect(placedById.get("agent:scout")).toMatchObject({
			tier: 0,
			order: 0,
			x: 0,
			y: -NODE_H / 2,
			width: WIDTH_BY_KIND.agent,
			height: NODE_H,
			cx: WIDTH_BY_KIND.agent / 2,
			cy: 0,
		});
		expect(placedById.get("role:default")).toMatchObject({
			tier: 1,
			x: roleX,
			width: WIDTH_BY_KIND.role,
		});
		expect(placedById.get("model:opus")).toMatchObject({
			tier: 2,
			x: modelX,
			width: WIDTH_BY_KIND.model,
		});
		expect(placedById.get("provider:anthropic")).toMatchObject({
			tier: 3,
			x: providerX,
			width: WIDTH_BY_KIND.provider,
		});
		expect(result.width).toBe(providerX + WIDTH_BY_KIND.provider + LAYOUT_PADDING * 2);
		expect(result.height).toBe(NODE_H + LAYOUT_PADDING * 2);
	});

	it("reduces crossings against an id-sorted naive role-to-model fixture", () => {
		const graph: RoutingGraph = {
			nodes: [
				{ id: "role:a", kind: "role", label: "A" },
				{ id: "role:b", kind: "role", label: "B" },
				{ id: "model:a", kind: "model", label: "A model" },
				{ id: "model:b", kind: "model", label: "B model" },
			],
			edges: [
				{ from: "role:a", to: "model:b", kind: "solid", relation: "role-model" },
				{ from: "role:b", to: "model:a", kind: "solid", relation: "role-model" },
			],
		};

		const naiveCrossings = countCrossings(graph, placeNodesById(graph));
		const optimized = layoutRoutingGraph(graph);
		const optimizedCrossings = countCrossings(graph, optimized.nodes);

		expect(naiveCrossings).toBe(1);
		expect(optimizedCrossings).toBe(0);
		expect(optimizedCrossings).toBeLessThan(naiveCrossings);
		const optimizedModelIds = optimized.nodes.filter(node => node.kind === "model").map(node => node.id);
		expect(optimizedModelIds).toEqual(["model:b", "model:a"]);
	});
});

function placeNodesById(graph: RoutingGraph): PlacedNode[] {
	const tiers: Record<GraphNodeKind, GraphNode[]> = {
		agent: [],
		role: [],
		model: [],
		provider: [],
	};
	for (const node of graph.nodes) tiers[node.kind].push(node);
	for (const kind of GRAPH_KIND_ORDER) tiers[kind].sort((a, b) => compareIds(a.id, b.id));

	const placedNodes: PlacedNode[] = [];
	let x = 0;
	for (const kind of GRAPH_KIND_ORDER) {
		const nodes = tiers[kind];
		const tier = layoutTierForKind(kind);
		const tierHeight = nodes.length * NODE_H + Math.max(0, nodes.length - 1) * ROW_GAP;
		const startY = -tierHeight / 2;

		for (let order = 0; order < nodes.length; order++) {
			const node = nodes[order];
			if (!node) continue;
			const width = WIDTH_BY_KIND[kind];
			const y = startY + order * (NODE_H + ROW_GAP);
			placedNodes.push({
				id: node.id,
				node,
				kind,
				x,
				y,
				width,
				height: NODE_H,
				cx: x + width / 2,
				cy: y + NODE_H / 2,
				tier,
				order,
			});
		}

		x += WIDTH_BY_KIND[kind] + LANE_GAP;
	}
	return placedNodes;
}

function compareIds(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}
