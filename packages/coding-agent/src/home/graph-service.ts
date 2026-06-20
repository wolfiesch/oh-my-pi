/**
 * Routing-graph composer for the OMP Home overview centerpiece.
 *
 * Pure transform over the already-built config + agent + provider services:
 * role-nodes with cycle order, model-nodes with selector metadata,
 * provider-nodes with auth provenance, agent-nodes with roster source; edges
 * role→model, model→provider, agent→model, and dashed fallback edges from
 * retry.fallbackChains.
 */

import type { RoutingGraph } from "@oh-my-pi/omp-home";
import { parseConfiguredThinkingLevel } from "../thinking";
import { listAgents } from "./agent-service";
import { listProviders } from "./auth-service";
import { readProfileConfig } from "./config-service";

function asStringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: Record<string, string> = {};
	for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
		if (typeof val === "string") result[key] = val;
	}
	return result;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function asStringArrayRecord(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: Record<string, string[]> = {};
	for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
		if (Array.isArray(val)) result[key] = val.filter((v): v is string => typeof v === "string");
	}
	return result;
}

/** Provider base for a `provider/id` selector (everything before the first `/`). */
function providerOf(selector: string | undefined): string | undefined {
	if (!selector) return undefined;
	const slash = selector.indexOf("/");
	return slash > 0 ? selector.slice(0, slash) : undefined;
}

type GraphNode = RoutingGraph["nodes"][number];
type GraphEdge = RoutingGraph["edges"][number];
type GraphAuthStatus = NonNullable<NonNullable<GraphNode["meta"]>["authStatus"]>;

function thinkingLevelOf(selector: string): string | undefined {
	const colonIdx = selector.lastIndexOf(":");
	if (colonIdx < 0) return undefined;
	return parseConfiguredThinkingLevel(selector.slice(colonIdx + 1));
}

function authStatusFor(originKind: string | undefined): GraphAuthStatus {
	if (originKind === "env") return "env";
	if (!originKind || originKind === "none") return "none";
	return "ok";
}

function modelMetaFor(selector: string): GraphNode["meta"] | undefined {
	const meta: NonNullable<GraphNode["meta"]> = {};
	const modelProvider = providerOf(selector);
	if (modelProvider) meta.modelProvider = modelProvider;
	const thinkingLevel = thinkingLevelOf(selector);
	if (thinkingLevel) meta.thinkingLevel = thinkingLevel;
	return meta.modelProvider || meta.thinkingLevel ? meta : undefined;
}

function modelNodeFor(selector: string): GraphNode {
	const meta = modelMetaFor(selector);
	return meta
		? { id: `model:${selector}`, kind: "model", label: selector, meta }
		: { id: `model:${selector}`, kind: "model", label: selector };
}

/**
 * Build the routing graph for a profile. Phase A returns a minimal but correct
 * node/edge set (roles → models → providers, agents → effective). Phase D adds
 * fallback-chain dashed edges and cycle-membership flags.
 */
export async function buildGraph(profileId: string, cwd: string = process.cwd()): Promise<RoutingGraph> {
	const [config, agents, providers] = await Promise.all([
		readProfileConfig(profileId),
		listAgents(profileId, cwd),
		listProviders(profileId),
	]);

	const modelRoles = asStringRecord(config.values.modelRoles);
	const cycleOrder = asStringArray(config.values.cycleOrder);
	const cycleIndexByRole = new Map<string, number>();
	for (let index = 0; index < cycleOrder.length; index++) {
		const role = cycleOrder[index];
		if (!cycleIndexByRole.has(role)) cycleIndexByRole.set(role, index);
	}
	const chainMap = asStringArrayRecord(config.values["retry.fallbackChains"]);
	const providerAuthById = new Map(providers.map(provider => [provider.provider, provider] as const));

	const nodes: GraphNode[] = [];
	const edges = new Map<string, GraphEdge>();
	const nodeIds = new Set<string>();

	const addNode = (node: GraphNode): void => {
		if (!nodeIds.has(node.id)) {
			nodeIds.add(node.id);
			nodes.push(node);
		}
	};
	const addEdge = (from: string, to: string, kind: GraphEdge["kind"], relation: GraphEdge["relation"]): void => {
		const key = `${from}\u0001${to}\u0001${kind}\u0001${relation}`;
		edges.set(key, { from, to, kind, relation });
	};
	const addRoleNode = (role: string): void => {
		const cycleIndex = cycleIndexByRole.get(role);
		const base: GraphNode = {
			id: `role:${role}`,
			kind: "role",
			label: role,
			inCycle: cycleIndex !== undefined,
		};
		addNode(cycleIndex === undefined ? base : { ...base, cycleIndex });
	};
	const addProviderNode = (provider: string): void => {
		const auth = providerAuthById.get(provider);
		const providerOrigin = auth?.originKind ?? "none";
		addNode({
			id: `provider:${provider}`,
			kind: "provider",
			label: provider,
			originKind: providerOrigin,
			meta: {
				providerOrigin,
				authStatus: authStatusFor(providerOrigin),
			},
		});
	};

	// Roles → models → providers.
	for (const [role, selector] of Object.entries(modelRoles)) {
		addRoleNode(role);
		const modelNodeId = selector ? `model:${selector}` : undefined;
		if (modelNodeId) {
			addNode(modelNodeFor(selector));
			addEdge(`role:${role}`, modelNodeId, "solid", "role-model");
			const provider = providerOf(selector);
			if (provider) {
				const providerNodeId = `provider:${provider}`;
				addProviderNode(provider);
				addEdge(modelNodeId, providerNodeId, "solid", "model-provider");
			}
		}
	}

	// Agents → effective model (override or role).
	for (const agent of agents) {
		addNode({
			id: `agent:${agent.name}`,
			kind: "agent",
			label: agent.name,
			sublabel: agent.source,
			disabled: agent.disabled,
			meta: {
				agentSource: agent.source,
			},
		});
		const selector = agent.effective.selector;
		if (selector) {
			const modelNodeId = `model:${selector}`;
			addNode(modelNodeFor(selector));
			addEdge(`agent:${agent.name}`, modelNodeId, "solid", "agent-model");
		}
	}

	// Fallback chains (dashed).
	for (const [key, models] of Object.entries(chainMap)) {
		const fromSelector = modelRoles[key] ?? key;
		const fromNodeId = `model:${fromSelector}`;
		addNode(modelNodeFor(fromSelector));
		for (const fallback of models) {
			const toNodeId = `model:${fallback}`;
			addNode(modelNodeFor(fallback));
			addEdge(fromNodeId, toNodeId, "dashed", "fallback");
		}
	}

	return { nodes, edges: [...edges.values()] };
}
