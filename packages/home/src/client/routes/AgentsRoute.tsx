import type { AgentRosterEntry } from "../../api-types";
import { getAgents } from "../data/api";
import { useResource } from "../data/useResource";
import { AsyncBoundary, DataTable, type DataTableColumn, Panel, StatusPill } from "../ui";

export interface AgentsRouteProps {
	active: boolean;
	profile: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
	bundled: "Bundled",
	user: "User",
	project: "Project",
};

export function AgentsRoute({ active, profile }: AgentsRouteProps) {
	const enabled = active && !!profile;
	const { data, error, loading, refetch } = useResource(
		["agents", profile ?? ""],
		signal => getAgents(profile!, signal),
		{ enabled },
	);

	const agents = data?.agents ?? [];

	const columns: DataTableColumn<AgentRosterEntry>[] = [
		{ key: "name", header: "Name" },
		{
			key: "source",
			header: "Source",
			render: a => SOURCE_LABEL[a.source] ?? a.source,
		},
		{
			key: "frontmatterModel",
			header: "Frontmatter Model",
			render: a =>
				a.frontmatterModel ? (
					<code className="home-text-xs">{a.frontmatterModel}</code>
				) : (
					<span className="home-text-muted">—</span>
				),
		},
		{
			key: "override",
			header: "Override",
			render: a =>
				a.override ? (
					<code className="home-text-xs">{a.override}</code>
				) : (
					<span className="home-text-muted">—</span>
				),
		},
		{
			key: "effective",
			header: "Effective",
			render: a =>
				a.effective.selector ? (
					<code className="home-text-xs">{a.effective.selector}</code>
				) : (
					<span className="home-text-muted">(unresolved)</span>
				),
		},
		{
			key: "status",
			header: "Status",
			render: a =>
				a.disabled ? (
					<StatusPill variant="danger">Disabled</StatusPill>
				) : (
					<StatusPill variant="success">Enabled</StatusPill>
				),
		},
	];

	return (
		<AsyncBoundary loading={loading} error={error} data={data} onRetry={() => void refetch()}>
			<Panel
				title="Task Agents"
				subtitle="Discovered task agents for this profile with their resolved effective model selector."
			>
				<DataTable columns={columns} data={agents} keyExtractor={a => a.name} emptyText="No agents discovered" />
			</Panel>
		</AsyncBoundary>
	);
}
