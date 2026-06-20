import type { ModelPreview, ResolvedConfig, RoutingGraph as RoutingGraphData } from "../../api-types";
import { getCatalogModels, getConfig, getGraph } from "../data/api";
import { useResource } from "../data/useResource";
import { RoutingGraphCanvas } from "../graph/RoutingGraphCanvas";

export interface GraphRouteProps {
	active: boolean;
	profile: string | null;
	onNavigateProviders: () => void;
}

export function GraphRoute({ active, profile, onNavigateProviders }: GraphRouteProps) {
	const graphEnabled = active && !!profile;
	const configEnabled = !!profile;

	const {
		data: graphData,
		error,
		loading,
		refetch,
	} = useResource<RoutingGraphData>(["graph", profile ?? ""], signal => getGraph(profile!, signal), {
		enabled: graphEnabled,
	});
	const { data: config } = useResource<ResolvedConfig>(
		["config", profile ?? ""],
		signal => getConfig(profile!, signal),
		{ enabled: configEnabled },
	);
	const { data: catalog } = useResource<{ models: ModelPreview[]; defaultModelPerProvider: Record<string, string> }>(
		["catalog-models"],
		signal => getCatalogModels(signal),
		{ enabled: configEnabled },
	);

	if (loading && !graphData) {
		return <div className="home-graph-canvas-loading">Loading routing graph…</div>;
	}
	if (error && !graphData) {
		return <div className="home-graph-canvas-error">Failed to load graph: {error.message}</div>;
	}
	if (!graphData || !profile) {
		return <div className="home-graph-canvas-loading">Select a profile to view the routing graph.</div>;
	}
	if (graphData.nodes.length === 0) {
		return (
			<div className="home-graph-canvas-loading">
				No routing nodes for this profile. Configure modelRoles to populate the graph.
			</div>
		);
	}

	return (
		<RoutingGraphCanvas
			graph={graphData}
			profile={profile}
			active={active}
			config={config ?? null}
			catalogModels={catalog?.models ?? []}
			onApplied={async () => {
				await refetch();
			}}
			onNavigateProviders={onNavigateProviders}
		/>
	);
}
