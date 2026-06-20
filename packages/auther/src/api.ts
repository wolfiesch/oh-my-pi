import type { AuthStorage, RefresherSchedule } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai";
import { fetchSpendForEntry, fetchUsage } from "./metering";
import { type OAuthSessionManager, OAuthSessionRequestError } from "./oauth-sessions";
import type { AddApiKeyEntryInput, AutherEntryCategory, AutherSpendKind, UpdateEntryInput } from "./store";
import { addApiKeyEntry, deleteEntry, getSecret, listEntries, updateEntry } from "./store";

export interface ApiContext {
	storage: AuthStorage;
	brokerUrl: string;
	brokerToken: string;
	dashboardToken: string;
	loginSessions: OAuthSessionManager;
}

class BadRequestError extends Error {}

const ENTRY_SECRET_ROUTE = /^\/api\/entries\/(\d+)\/secret$/;
const ENTRY_ROUTE = /^\/api\/entries\/(\d+)$/;
const ENTRY_REFRESH_ROUTE = /^\/api\/entries\/(\d+)\/refresh$/;
const SPEND_ROUTE = /^\/api\/spend\/(\d+)$/;
const LOGIN_SESSION_ROUTE = /^\/api\/oauth\/login\/([^/]+)$/;
const LOGIN_INPUT_ROUTE = /^\/api\/oauth\/login\/([^/]+)\/input$/;
const LOGIN_CANCEL_ROUTE = /^\/api\/oauth\/login\/([^/]+)\/cancel$/;
const JSON_HEADERS = {
	"Cache-Control": "no-store",
};

export async function apiHandler(req: Request, url: URL, ctx: ApiContext): Promise<Response> {
	const pathname = url.pathname;
	if (req.method === "OPTIONS") return empty(204);
	if (req.method === "GET" && pathname === "/api/health") {
		return json(200, { ok: true });
	}
	if (!isAuthorized(req, ctx.dashboardToken)) {
		return json(401, { error: "unauthorized" });
	}

	try {
		if (req.method === "GET" && pathname === "/api/entries") {
			return json(200, await listEntries(ctx.storage));
		}
		if (req.method === "POST" && pathname === "/api/entries") {
			const body = await readJsonObject(req);
			const entry = await addApiKeyEntry(parseAddApiKeyEntryInput(body), ctx.storage);
			return json(201, { entry });
		}

		const secretMatch = req.method === "GET" ? pathname.match(ENTRY_SECRET_ROUTE) : null;
		if (secretMatch) {
			const id = parseRouteId(secretMatch[1]);
			const secret = await getSecret(id, ctx.storage);
			if (!secret) return json(404, { error: `No entry with id=${id}` });
			return json(200, secret);
		}

		const entryMatch = pathname.match(ENTRY_ROUTE);
		if (entryMatch && req.method === "PUT") {
			const id = parseRouteId(entryMatch[1]);
			const body = await readJsonObject(req);
			const entry = await updateEntry(id, parseUpdateEntryInput(body), ctx.storage);
			if (!entry) return json(404, { error: `No entry with id=${id}` });
			return json(200, { entry });
		}
		if (entryMatch && req.method === "DELETE") {
			const id = parseRouteId(entryMatch[1]);
			const deleted = await deleteEntry(id, ctx.storage);
			if (!deleted) return json(404, { error: `No entry with id=${id}` });
			return json(200, { ok: true });
		}

		const refreshMatch = req.method === "POST" ? pathname.match(ENTRY_REFRESH_ROUTE) : null;
		if (refreshMatch) {
			const id = parseRouteId(refreshMatch[1]);
			try {
				await ctx.storage.refreshCredentialById(id, req.signal);
				await ctx.storage.reload();
				const entry = (await listEntries(ctx.storage)).find(candidate => candidate.id === id);
				if (!entry) return json(404, { error: `No entry with id=${id}` });
				return json(200, { status: "ok", entry });
			} catch (error) {
				return json(200, { status: "reauth_required", error: describeError(error) });
			}
		}

		if (req.method === "GET" && pathname === "/api/usage") {
			return json(200, await fetchUsage(ctx.storage));
		}

		const spendMatch = req.method === "GET" ? pathname.match(SPEND_ROUTE) : null;
		if (spendMatch) {
			const id = parseRouteId(spendMatch[1]);
			const entries = await listEntries(ctx.storage);
			const entry = entries.find(candidate => candidate.id === id);
			if (!entry) return json(404, { error: `No entry with id=${id}` });
			const secret = await getSecret(id, ctx.storage);
			const spend = await fetchSpendForEntry(entry, secret);
			if (!spend) {
				return json(200, { status: "unavailable", error: "Spend metering is not configured for this entry" });
			}
			return json(200, spend);
		}

		if (req.method === "GET" && pathname === "/api/oauth/providers") {
			return json(200, getOAuthProviders());
		}
		if (req.method === "POST" && pathname === "/api/oauth/login/start") {
			const body = await readJsonObject(req);
			const session = await ctx.loginSessions.startLogin(readRequiredString(body, "provider"));
			return json(200, session);
		}

		const loginSessionMatch = req.method === "GET" ? pathname.match(LOGIN_SESSION_ROUTE) : null;
		if (loginSessionMatch) {
			const session = ctx.loginSessions.getSession(decodeURIComponent(loginSessionMatch[1]));
			if (!session) return json(404, { error: "Login session not found" });
			return json(200, session);
		}

		const inputMatch = req.method === "POST" ? pathname.match(LOGIN_INPUT_ROUTE) : null;
		if (inputMatch) {
			const body = await readJsonObject(req);
			const session = ctx.loginSessions.submitInput(
				decodeURIComponent(inputMatch[1]),
				readRequiredString(body, "value"),
			);
			if (!session) return json(404, { error: "Login session not found" });
			return json(200, session);
		}

		const cancelMatch = req.method === "POST" ? pathname.match(LOGIN_CANCEL_ROUTE) : null;
		if (cancelMatch) {
			const session = ctx.loginSessions.cancelLogin(decodeURIComponent(cancelMatch[1]));
			if (!session) return json(404, { error: "Login session not found" });
			return json(200, session);
		}

		if (req.method === "GET" && pathname === "/api/broker/stream") {
			return proxyBrokerStream(ctx, req.signal);
		}

		if (req.method === "GET" && pathname === "/api/broker") {
			return json(200, {
				url: ctx.brokerUrl,
				tokenPresent: ctx.brokerToken.length > 0,
				token: ctx.brokerToken,
				refresher: await fetchBrokerRefresher(ctx),
			});
		}

		return json(404, { error: `No route: ${req.method} ${pathname}` });
	} catch (error) {
		if (error instanceof BadRequestError) {
			return json(400, { error: error.message });
		}
		if (error instanceof OAuthSessionRequestError) {
			return json(error.status, { error: error.message });
		}
		return json(500, { error: describeError(error) });
	}
}

function json(status: number, body: unknown): Response {
	return Response.json(body, { status, headers: JSON_HEADERS });
}

function empty(status: number): Response {
	return new Response(null, { status, headers: JSON_HEADERS });
}

function isAuthorized(req: Request, dashboardToken: string): boolean {
	const header = req.headers.get("authorization");
	if (!header) return false;
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match ? match[1].trim() === dashboardToken : false;
}

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
	let raw: string;
	try {
		raw = await req.text();
	} catch (error) {
		throw new BadRequestError(`Invalid request body: ${describeError(error)}`);
	}
	if (raw.trim().length === 0) {
		throw new BadRequestError("Request body required");
	}
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch (error) {
		throw new BadRequestError(`Invalid JSON body: ${describeError(error)}`);
	}
	if (!isRecord(body)) throw new BadRequestError("Request body must be a JSON object");
	return body;
}

function parseAddApiKeyEntryInput(body: Record<string, unknown>): AddApiKeyEntryInput {
	const input: AddApiKeyEntryInput = {
		provider: readRequiredString(body, "provider"),
		displayName: readRequiredString(body, "displayName"),
		key: readRequiredString(body, "key"),
	};
	const brandId = readOptionalString(body, "brandId");
	if (brandId !== undefined) input.brandId = brandId;
	const tags = readOptionalTags(body, "tags");
	if (tags !== undefined) input.tags = tags;
	const category = readOptionalCategory(body, "category");
	if (category !== undefined) input.category = category;
	const spendKind = readOptionalSpendKind(body, "spendKind");
	if (spendKind !== undefined) input.spendKind = spendKind;
	const notes = readOptionalNullableString(body, "notes");
	if (notes !== undefined) input.notes = notes;
	return input;
}

function parseUpdateEntryInput(body: Record<string, unknown>): UpdateEntryInput {
	const input: UpdateEntryInput = {};
	const displayName = readOptionalNonEmptyString(body, "displayName");
	if (displayName !== undefined) input.displayName = displayName;
	const brandId = readOptionalNonEmptyString(body, "brandId");
	if (brandId !== undefined) input.brandId = brandId;
	const tags = readOptionalTags(body, "tags");
	if (tags !== undefined) input.tags = tags;
	const category = readOptionalCategory(body, "category");
	if (category !== undefined) input.category = category;
	const spendKind = readOptionalSpendKind(body, "spendKind");
	if (spendKind !== undefined) input.spendKind = spendKind;
	const notes = readOptionalNullableString(body, "notes");
	if (notes !== undefined) input.notes = notes;
	return input;
}

function parseRouteId(raw: string | undefined): number {
	const id = Number(raw);
	if (!Number.isSafeInteger(id) || id <= 0) {
		throw new BadRequestError("Route id must be a positive integer");
	}
	return id;
}

function readRequiredString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string") throw new BadRequestError(`${key} must be a string`);
	const trimmed = value.trim();
	if (!trimmed) throw new BadRequestError(`${key} is required`);
	return trimmed;
}

function readOptionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new BadRequestError(`${key} must be a string`);
	return value;
}

function readOptionalNonEmptyString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new BadRequestError(`${key} must be a string`);
	const trimmed = value.trim();
	if (!trimmed) throw new BadRequestError(`${key} is required`);
	return trimmed;
}

function readOptionalNullableString(body: Record<string, unknown>, key: string): string | null | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string") throw new BadRequestError(`${key} must be a string or null`);
	return value;
}

function readOptionalTags(body: Record<string, unknown>, key: string): string[] | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new BadRequestError(`${key} must be an array of strings`);
	const tags: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") throw new BadRequestError(`${key} must be an array of strings`);
		tags.push(item);
	}
	return tags;
}

function readOptionalCategory(body: Record<string, unknown>, key: string): AutherEntryCategory | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (value === "metered" || value === "meterable_unconfigured" || value === "not_applicable") return value;
	throw new BadRequestError(`${key} must be metered, meterable_unconfigured, or not_applicable`);
}

function readOptionalSpendKind(body: Record<string, unknown>, key: string): AutherSpendKind | null | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (value === "openrouter" || value === "openai") return value;
	throw new BadRequestError(`${key} must be openrouter, openai, or null`);
}

async function proxyBrokerStream(ctx: ApiContext, signal: AbortSignal): Promise<Response> {
	const streamUrl = new URL("/v1/snapshot/stream", ctx.brokerUrl);
	const response = await fetch(streamUrl, {
		headers: { Authorization: `Bearer ${ctx.brokerToken}`, Accept: "text/event-stream" },
		signal,
	});
	if (!response.ok || !response.body) {
		return json(response.status, { error: `Broker stream HTTP ${response.status}` });
	}
	return new Response(response.body, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

async function fetchBrokerRefresher(ctx: ApiContext): Promise<RefresherSchedule | undefined> {
	try {
		const snapshotUrl = new URL("/v1/snapshot", ctx.brokerUrl);
		const response = await fetch(snapshotUrl, {
			headers: { Authorization: `Bearer ${ctx.brokerToken}` },
			signal: AbortSignal.timeout(2_000),
		});
		if (!response.ok) return undefined;
		const body: unknown = await response.json();
		if (!isRecord(body)) return undefined;
		const refresher = body.refresher;
		if (!isRecord(refresher)) return undefined;
		if (
			typeof refresher.enabled === "boolean" &&
			typeof refresher.intervalMs === "number" &&
			typeof refresher.skewMs === "number" &&
			typeof refresher.nextSweepInMs === "number"
		) {
			return {
				enabled: refresher.enabled,
				intervalMs: refresher.intervalMs,
				skewMs: refresher.skewMs,
				nextSweepInMs: refresher.nextSweepInMs,
			};
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	return "Unknown error";
}
