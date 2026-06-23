/**
 * Shared OMP Home API types.
 *
 * Consumed by both the server API router (coding-agent `home/api-router`)
 * and the React client (`@oh-my-pi/omp-home/client`). Kept in this package
 * so the client — which has no coding-agent/catalog dependency — can type its
 * fetches against a single, dependency-free contract.
 */

/** A registered profile. */
export interface ProfileSummary {
	id: string;
	label: string;
	agentDir: string;
}

export type ToolId = "stats" | "collab" | "robomp";

export interface ToolDescriptor {
	id: ToolId;
	label: string;
	description: string;
	profileScoped: boolean;
	defaultPort: number;
}

export interface ToolStatus extends ToolDescriptor {
	running: boolean;
	spawnable: boolean;
	port?: number;
	pid?: number;
	url?: string;
	scopedProfileId?: string | null;
	launchHint?: string;
}

export interface LaunchResult {
	url: string;
	port: number;
	pid: number;
	scopedProfileId: string | null;
}

/** One UI-facing schema metadata row. */
export interface SchemaMeta {
	path: string;
	type: string;
	enumValues?: readonly string[];
	default: unknown;
	description: string;
	label: string;
	tab?: string;
	group?: string;
}

/** Resolved config (file value ?? schema default) + raw + schema. */
export interface ResolvedConfig {
	values: Record<string, unknown>;
	raw: Record<string, unknown>;
	schema: SchemaMeta[];
}

/** A model-picker list entry. */
export interface ModelPreview {
	id: string;
	provider: string;
	name: string;
}

/** Auth origin kind for a provider. */
export type AuthOriginKind = "runtime" | "config" | "oauth" | "api_key" | "env" | "fallback" | "none";

/** A masked credential row (no secret bytes). */
export interface MaskedCredential {
	id: number;
	type: "api_key" | "oauth";
	masked?: string;
	email?: string;
	accountId?: string;
	projectId?: string;
	disabledCause?: string | null;
}

/** Per-provider auth summary. */
export interface ProviderAuthEntry {
	provider: string;
	defaultModel: string;
	originKind: AuthOriginKind;
	envVar?: string;
	credentialCount: number;
	accounts: MaskedCredential[];
}

/** Effective-selector source label for an agent. */
export type EffectiveSource = "override" | "frontmatter" | "role" | "default" | "none";

/** One agent roster row. */
export interface AgentRosterEntry {
	name: string;
	description: string;
	source: "bundled" | "user" | "project";
	filePath?: string;
	frontmatterModel?: string;
	override?: string;
	disabled: boolean;
	effective: { selector: string | undefined; source: EffectiveSource; disabled: boolean };
}

/** A single config edit (`value === undefined` deletes the key). */
export interface ConfigEdit {
	path: string;
	value: unknown;
}

/** Routing-graph node/edge shapes (Phase D centerpiece). */
export type GraphNodeKind = "role" | "model" | "provider" | "agent";

export type GraphAuthStatus = "ok" | "env" | "none";

export interface GraphNodeMeta {
	thinkingLevel?: string;
	providerOrigin?: string;
	authStatus?: GraphAuthStatus;
	agentSource?: "user" | "project" | "bundled";
	modelProvider?: string;
}

export interface GraphNode {
	id: string;
	kind: GraphNodeKind;
	label: string;
	sublabel?: string;
	originKind?: AuthOriginKind;
	disabled?: boolean;
	inCycle?: boolean;
	cycleIndex?: number;
	meta?: GraphNodeMeta;
}

export type GraphEdgeRelation = "role-model" | "model-provider" | "agent-model" | "fallback";

export interface GraphEdge {
	from: string;
	to: string;
	/** `solid` for primary routing, `dashed` for fallback chains. */
	kind: "solid" | "dashed";
	relation: GraphEdgeRelation;
}

export interface RoutingGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

/** Result row from a provider credential health-check (`POST .../test`). */
export interface ProviderTestResult {
	id: number;
	ok: boolean | null;
	reason?: string;
	email?: string;
	accountId?: string;
}
