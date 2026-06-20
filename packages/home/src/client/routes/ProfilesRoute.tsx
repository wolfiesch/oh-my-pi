import type { ProfileSummary } from "../../api-types";
import { getProfiles } from "../data/api";
import { useResource } from "../data/useResource";
import { AsyncBoundary, DataTable, type DataTableColumn, Panel } from "../ui";

export interface ProfilesRouteProps {
	active: boolean;
	profile: string | null;
}

export function ProfilesRoute({ active }: ProfilesRouteProps) {
	// The profiles list is global (not profile-scoped), so we only gate on active.
	const { data, error, loading, refetch } = useResource(["profiles"], signal => getProfiles(signal), {
		enabled: active,
	});

	const profiles = data?.profiles ?? [];

	const columns: DataTableColumn<ProfileSummary>[] = [
		{ key: "label", header: "Label" },
		{ key: "id", header: "ID", render: p => <code className="home-text-xs home-text-muted">{p.id}</code> },
		{
			key: "agentDir",
			header: "Agent Dir",
			render: p => <code className="home-text-xs home-text-muted">{p.agentDir}</code>,
		},
	];

	return (
		<AsyncBoundary loading={loading} error={error} data={data} onRetry={() => void refetch()}>
			<Panel
				title="Registered Profiles"
				subtitle="Profiles discovered on this machine. Select one in the top bar to scope the other sections to its config and agents."
			>
				<DataTable columns={columns} data={profiles} keyExtractor={p => p.id} emptyText="No profiles registered" />
			</Panel>
		</AsyncBoundary>
	);
}
