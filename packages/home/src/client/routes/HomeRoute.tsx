import { Activity, BarChart3, Bot, Boxes, type LucideIcon, Network, Radio } from "lucide-react";
import { useState } from "react";
import type { AgentRosterEntry, ProviderAuthEntry, ResolvedConfig, ToolId, ToolStatus } from "../../api-types";
import { getAgents, getConfig, getProviders, getTools, launchTool, stopTool } from "../data/api";
import { useResource } from "../data/useResource";
import { AsyncBoundary, MetricCluster, Panel, StatusPill } from "../ui";

export interface HomeRouteProps {
	active: boolean;
	profile: string | null;
}

/**
 * Tool iconography — kept as a static lookup so the tile grid never shifts
 * identity between renders. The OMP shared iconography (lucide-react) is the
 * only source; no new dep.
 */
const TOOL_ICON: Record<ToolId, LucideIcon> = {
	stats: BarChart3,
	mechanism: Activity,
	collab: Radio,
	robomp: Bot,
};

/**
 * OMP Home hub: the landing surface for a selected profile.
 *
 * Combines (1) KPIs distilled from config/agents/providers, (2) a launcher
 * tile grid that spawns/opens/stops the other OMP web tools scoped to this
 * profile, and (3) a pointer to the full routing graph.
 *
 * The launcher uses the loopback `/api/tools*` endpoints only. Profile-scoped
 * tools (stats, mechanism) receive the active profile id; profile-agnostic
 * tools (collab, robomp) run on "main" and ignore the selector.
 */
export function HomeRoute({ active, profile }: HomeRouteProps) {
	const enabled = active && !!profile;

	const { data, error, loading, refetch } = useResource<ResolvedConfig>(
		["config", profile ?? ""],
		signal => getConfig(profile!, signal),
		{ enabled },
	);
	const { data: agentsData } = useResource<{ agents: AgentRosterEntry[] }>(
		["agents", profile ?? ""],
		signal => getAgents(profile!, signal),
		{ enabled },
	);
	const { data: providersData } = useResource<{ providers: ProviderAuthEntry[] }>(
		["providers", profile ?? ""],
		signal => getProviders(profile!, signal),
		{ enabled },
	);

	// Launcher status polls while the section is active, even before a profile
	// is picked, so non-scoped tools are launchable from the empty state.
	const { data: toolsData, refetch: refetchTools } = useResource<{ tools: ToolStatus[] }>(
		["tools", profile ?? "main"],
		signal => getTools(profile, signal),
		{ pollMs: 4000, enabled: active },
	);

	const values = data?.values ?? {};
	const modelRoles = (values.modelRoles as Record<string, unknown> | undefined) ?? {};
	const cycleOrder = (values.cycleOrder as unknown[] | undefined) ?? [];
	const fallbackChains = (values["retry.fallbackChains"] as Record<string, unknown> | undefined) ?? {};
	const authedProviders = (providersData?.providers ?? []).filter(
		p => p.originKind !== "none" && p.originKind !== "fallback",
	);

	const cards = [
		{ label: "Roles", value: Object.keys(modelRoles).length },
		{ label: "Cycle Steps", value: cycleOrder.length },
		{ label: "Agents", value: agentsData?.agents.length ?? 0 },
		{ label: "Authed Providers", value: authedProviders.length },
		{ label: "Fallback Chains", value: Object.keys(fallbackChains).length, variant: "secondary" as const },
	];

	return (
		<AsyncBoundary loading={loading} error={error} data={data} onRetry={() => void refetch()}>
			<section className="home-hub">
				<div className="home-hub-context">
					<div className="home-hub-context-label">Profile</div>
					<div className="home-hub-context-value">
						{profile ? (
							<span className="home-hub-context-id">{profile}</span>
						) : (
							<span className="home-hub-context-none">No profile selected</span>
						)}
					</div>
				</div>

				<MetricCluster cards={cards} />

				<Panel
					title="Tools"
					subtitle="Launch OMP web tools scoped to this profile. Profile-scoped tools (stats, mechanism) read this profile's sessions and data; relay tools (collab, robomp) run on main and ignore the selector."
				>
					<div className="home-tile-grid">
						{(toolsData?.tools ?? []).map(tool => (
							<ToolTile
								key={tool.id}
								tool={tool}
								profileId={tool.profileScoped && profile ? profile : null}
								onChanged={() => void refetchTools()}
							/>
						))}
						{(toolsData?.tools ?? []).length === 0 && (
							<div className="home-tile-empty">
								<Network size={20} />
								<span>No tools available in this runtime.</span>
							</div>
						)}
					</div>
				</Panel>

				<Panel
					title="Routing Graph"
					subtitle="The full interactive routing graph lives in its own section — agents, roles, models, and providers as a pannable, zoomable canvas."
				>
					<a
						className="home-button home-button-secondary"
						href={`#/graph${profile ? `?profile=${encodeURIComponent(profile)}` : ""}`}
					>
						Open Graph →
					</a>
				</Panel>
			</section>
		</AsyncBoundary>
	);
}

interface ToolTileProps {
	tool: ToolStatus;
	/** The profile to scope a launch to, or null for main / profile-agnostic tools. */
	profileId: string | null;
	onChanged: () => void;
}

function ToolTile({ tool, profileId, onChanged }: ToolTileProps) {
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	const Icon = TOOL_ICON[tool.id] ?? Boxes;

	async function handleLaunch() {
		setBusy(true);
		setActionError(null);
		try {
			await launchTool(tool.id, profileId);
			onChanged();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	async function handleStop() {
		setBusy(true);
		setActionError(null);
		try {
			await stopTool(tool.id, profileId);
			onChanged();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	function handleOpen() {
		if (tool.url) window.open(tool.url, "_blank", "noopener,noreferrer");
	}

	const running = tool.running;
	const unavailable = !tool.spawnable;

	const statusVariant = running ? "success" : unavailable ? "default" : "warning";
	const statusLabel = running ? "Running" : unavailable ? "Unavailable" : "Stopped";

	return (
		<article className="home-tile" data-state={running ? "running" : unavailable ? "unavailable" : "stopped"}>
			<header className="home-tile-header">
				<span className="home-tile-icon">
					<Icon size={18} />
				</span>
				<div className="home-tile-titles">
					<h4 className="home-tile-title">{tool.label}</h4>
					<p className="home-tile-description">{tool.description}</p>
				</div>
			</header>

			<div className="home-tile-meta">
				<StatusPill variant={statusVariant}>{statusLabel}</StatusPill>
				{!tool.profileScoped && <span className="home-tile-scope-note">runs on main</span>}
				{tool.profileScoped && profileId && <span className="home-tile-scope-note">scope: {profileId}</span>}
				{running && tool.url && <span className="home-tile-url">{tool.url}</span>}
				{running && tool.port !== undefined && <span className="home-tile-port">:{tool.port}</span>}
			</div>

			{!tool.spawnable && tool.launchHint && <code className="home-tile-hint">{tool.launchHint}</code>}

			{actionError && <div className="home-tile-error">{actionError}</div>}

			<div className="home-tile-actions">
				{running ? (
					<>
						<button
							type="button"
							className="home-button home-button-secondary"
							onClick={handleOpen}
							disabled={!tool.url}
						>
							Open
						</button>
						<button
							type="button"
							className="home-button home-button-secondary"
							onClick={() => void handleStop()}
							disabled={busy}
						>
							{busy ? "Stopping…" : "Stop"}
						</button>
					</>
				) : (
					<button
						type="button"
						className="home-button home-button-primary"
						onClick={() => void handleLaunch()}
						disabled={!tool.spawnable || busy}
						title={!tool.spawnable && tool.launchHint ? tool.launchHint : undefined}
					>
						{busy ? "Launching…" : "Launch"}
					</button>
				)}
			</div>
		</article>
	);
}
