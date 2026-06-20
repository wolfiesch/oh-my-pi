/**
 * OMP Home API router (`/api/*` handler injected into the omp-home server
 * chassis).
 *
 * to: 400 (validation / bad profile path), 404 (unknown profile/route), 409
 * (already-running launcher), 5xx (spawn/runtime failures wrapped by the
 * chassis). The launcher service owns child-process state; other routes are
 * stateless apart from the injected cwd used for project-agent discovery.
 */

import type { ApiHandler, ModelPreview } from "@oh-my-pi/omp-home";
import { DEFAULT_MODEL_PER_PROVIDER, getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog";
import type { ConfigEdit } from "../config/config-writer";
import { listAgents } from "./agent-service";
import { addApiKeyCredential, deleteCredential, listProviders, testProvider } from "./auth-service";
import { ConfigValidationError, readProfileConfig, writeProfileConfig } from "./config-service";
import { buildGraph } from "./graph-service";
import {
	getRunningToolResult,
	isToolId,
	LauncherError,
	launchTool,
	listToolStatus,
	stopTool,
	TOOL_DESCRIPTORS,
	toolStateKey,
} from "./launcher-service";
import type { ProfileEntry } from "./profiles";
import {
	addProfile,
	InvalidProfilePathError,
	listProfiles,
	ProfileNotFoundError,
	removeProfile,
	resolveProfile,
} from "./profiles";

/** Theme colors valid for `modelTags.*.color` (mirrors the ThemeColor enum). */
const THEME_COLORS: readonly string[] = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
	"pythonMode",
	"statusLineSep",
	"statusLineModel",
	"statusLinePath",
	"statusLineGitClean",
	"statusLineGitDirty",
	"statusLineContext",
	"statusLineSpend",
	"statusLineStaged",
	"statusLineDirty",
	"statusLineUntracked",
	"statusLineOutput",
	"statusLineCost",
	"statusLineSubagents",
];

export interface RouterOptions {
	/** Project dir for project-scoped agent discovery. Defaults to process.cwd(). */
	cwd?: string;
}

type ResolvedProfile = ProfileEntry & { configPath: string; dbPath: string };

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function badRequest(message: string): Response {
	return json({ error: message }, 400);
}

function notFound(message: string): Response {
	return json({ error: message }, 404);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
	try {
		const text = await req.text();
		if (!text) return {};
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("JSON body must be an object");
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parseConfigEdits(value: unknown): ConfigEdit[] {
	if (!Array.isArray(value)) throw new ConfigValidationError("`edits` array is required");
	return value.map((edit, index) => {
		if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
			throw new ConfigValidationError(`edits[${index}] must be an object`);
		}
		const record = edit as Record<string, unknown>;
		if (typeof record.path !== "string" || !record.path.trim()) {
			throw new ConfigValidationError(`edits[${index}].path is required`);
		}
		return Object.hasOwn(record, "value")
			? { path: record.path, value: record.value }
			: { path: record.path, value: undefined };
	});
}

/** Build the catalog model picker list (enabled + bundled model ids). */
function getCatalogModels(): ModelPreview[] {
	const models: ModelPreview[] = [];
	const seen = new Set<string>();
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider as Parameters<typeof getBundledModels>[0])) {
			const fullId = `${model.provider}/${model.id}`;
			if (seen.has(fullId)) continue;
			seen.add(fullId);
			models.push({ id: fullId, provider: model.provider, name: model.name ?? model.id });
		}
	}
	models.sort((a, b) => a.id.localeCompare(b.id));
	return models;
}

/** Resolve a profile id, mapping unknown/missing to a 404 Response (never throws). */
async function ensureProfileResponse(profileId: string): Promise<Response | null> {
	try {
		await resolveProfile(profileId);
		return null;
	} catch (error) {
		if (error instanceof ProfileNotFoundError) return notFound(error.message);
		// Unexpected — rethrow so the chassis wraps it as 500.
		throw error;
	}
}

/**
 * Build the OMP Home API handler. `opts.cwd` seeds project-agent discovery.
 */
export function createHomeApiHandler(opts: RouterOptions = {}): ApiHandler {
	const cwd = opts.cwd ?? process.cwd();

	return async (req, url) => {
		const requestPath = url.pathname;
		const method = req.method;

		// ── Health ───────────────────────────────────────────────────────
		if (requestPath === "/api/health" && method === "GET") {
			return json({ ok: true });
		}

		// ── Catalog + theme-colors (profile-independent) ─────────────────
		if (requestPath === "/api/catalog/models" && method === "GET") {
			return json({ models: getCatalogModels(), defaultModelPerProvider: DEFAULT_MODEL_PER_PROVIDER });
		}
		if (requestPath === "/api/theme-colors" && method === "GET") {
			return json({ colors: THEME_COLORS });
		}

		// ── Profiles collection ─────────────────────────────────────────
		if (requestPath === "/api/profiles" && method === "GET") {
			return json({ profiles: await listProfiles() });
		}
		if (requestPath === "/api/profiles" && method === "POST") {
			let body: Record<string, unknown>;
			try {
				body = await readJsonBody(req);
			} catch (error) {
				return badRequest(error instanceof Error ? error.message : String(error));
			}
			const absPath = typeof body.path === "string" ? body.path : "";
			const label = typeof body.label === "string" ? body.label : undefined;
			if (!absPath) return badRequest("`path` is required");
			try {
				const entry = await addProfile(absPath, label);
				return json({ profile: entry }, 201);
			} catch (error) {
				if (error instanceof InvalidProfilePathError) return badRequest(error.message);
				throw error;
			}
		}

		// ── Launcher tools ───────────────────────────────────────────────
		if (requestPath === "/api/tools" && method === "GET") {
			const rawProfileId = url.searchParams.get("profile");
			const profileId = rawProfileId?.trim() || null;
			if (profileId) {
				const profile404 = await ensureProfileResponse(profileId);
				if (profile404) return profile404;
			}
			return json({ tools: listToolStatus(profileId) });
		}

		const toolActionMatch = requestPath.match(/^\/api\/tools\/([^/]+)\/(launch|stop)$/);
		if (toolActionMatch && method === "POST") {
			const toolRaw = decodeURIComponent(toolActionMatch[1] as string);
			if (!isToolId(toolRaw)) return badRequest(`Unknown tool id: ${toolRaw}`);
			const tool = toolRaw;
			const action = toolActionMatch[2] as "launch" | "stop";
			const descriptor = TOOL_DESCRIPTORS[tool];

			let body: Record<string, unknown>;
			try {
				body = await readJsonBody(req);
			} catch (error) {
				return badRequest(error instanceof Error ? error.message : String(error));
			}

			let profileId: string | null = null;
			if (Object.hasOwn(body, "profileId")) {
				if (body.profileId !== undefined && body.profileId !== null && typeof body.profileId !== "string") {
					return badRequest("`profileId` must be a string");
				}
				profileId = typeof body.profileId === "string" ? body.profileId.trim() || null : null;
			}

			let profile: ResolvedProfile | null = null;
			if (profileId) {
				try {
					profile = await resolveProfile(profileId);
				} catch (error) {
					if (error instanceof ProfileNotFoundError) return notFound(error.message);
					throw error;
				}
			}
			if (descriptor.profileScoped && !profile) {
				return badRequest(`\`profileId\` is required for ${descriptor.label}`);
			}

			const scopedProfileId = descriptor.profileScoped ? (profile?.id ?? null) : null;
			if (action === "launch") {
				const existing = getRunningToolResult(tool, scopedProfileId);
				if (existing) return json({ error: "Tool already running", ...existing }, 409);
				try {
					return json(await launchTool(tool, profile), 201);
				} catch (error) {
					if (error instanceof LauncherError) return json({ error: error.message }, error.status);
					throw error;
				}
			}

			return json({ stopped: await stopTool(toolStateKey(tool, scopedProfileId)) });
		}
		// ── Profile-scoped routes (/api/profiles/:id/...) ───────────────
		const profileMatch = requestPath.match(/^\/api\/profiles\/([^/]+)(\/.*)?$/);
		if (profileMatch) {
			const profileId = decodeURIComponent(profileMatch[1] as string);
			const sub = (profileMatch[2] ?? "") as string;

			const profile404 = await ensureProfileResponse(profileId);
			if (profile404) return profile404;

			// DELETE /api/profiles/:id — registry-only removal.
			if (sub === "" && method === "DELETE") {
				try {
					await removeProfile(profileId);
					return json({ ok: true });
				} catch (error) {
					if (error instanceof ProfileNotFoundError) return notFound(error.message);
					throw error;
				}
			}

			if (sub === "/config" && method === "GET") {
				return json(await readProfileConfig(profileId));
			}

			if (sub === "/config" && method === "PUT") {
				let body: Record<string, unknown>;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					return badRequest(error instanceof Error ? error.message : String(error));
				}
				let edits: ConfigEdit[];
				try {
					edits = parseConfigEdits(body.edits);
				} catch (error) {
					if (error instanceof ConfigValidationError) return badRequest(error.message);
					throw error;
				}
				try {
					return json(await writeProfileConfig(profileId, edits));
				} catch (error) {
					if (error instanceof ConfigValidationError) return badRequest(error.message);
					if (error instanceof ProfileNotFoundError) return notFound(error.message);
					throw error;
				}
			}

			if (sub === "/agents" && method === "GET") {
				return json({ agents: await listAgents(profileId, cwd) });
			}

			if (sub === "/providers" && method === "GET") {
				return json({ providers: await listProviders(profileId) });
			}

			if (sub === "/graph" && method === "GET") {
				return json(await buildGraph(profileId, cwd));
			}

			// Provider credential mutations: /api/profiles/:id/providers/:provider/...
			const providerMatch = sub.match(/^\/providers\/([^/]+)(\/.*)?$/);
			if (providerMatch) {
				const provider = decodeURIComponent(providerMatch[1] as string);
				const action = (providerMatch[2] ?? "") as string;

				if (action === "/credentials" && method === "POST") {
					let body: Record<string, unknown>;
					try {
						body = await readJsonBody(req);
					} catch (error) {
						return badRequest(error instanceof Error ? error.message : String(error));
					}
					if (body.type !== "api_key" || typeof body.key !== "string") {
						return badRequest('`{ type: "api_key", key }` body is required');
					}
					return json({ accounts: await addApiKeyCredential(profileId, provider, body.key) }, 201);
				}

				const credMatch = action.match(/^\/credentials\/([^/]+)$/);
				if (credMatch && method === "DELETE") {
					const credIdRaw = credMatch[1] as string;
					if (!/^[0-9]+$/.test(credIdRaw)) return badRequest("credential id must be a number");
					const credId = Number.parseInt(credIdRaw, 10);
					return json({ accounts: await deleteCredential(profileId, provider, credId) });
				}

				if (action === "/test" && method === "POST") {
					return json({ results: await testProvider(profileId, provider) });
				}
			}
		}

		return notFound(`No route for ${method} ${requestPath}`);
	};
}
