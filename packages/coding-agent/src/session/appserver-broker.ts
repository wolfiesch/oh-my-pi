import type { BrokerStatusResult } from "@oh-my-pi/app-wire";
import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import { resolveAuthBrokerConfig } from "./auth-broker-config";
import type { AuthStorage } from "./auth-storage";

const MAX_GENERATION = 2_147_483_647;
const MAX_ENDPOINT_BYTES = 2048;

function generation(authStorage: AuthStorage | undefined): number {
	if (!authStorage) return 0;
	const value = authStorage.getGeneration();
	return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, MAX_GENERATION) : 0;
}

function safeEndpoint(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		const endpoint = url.toString();
		return endpoint.length <= MAX_ENDPOINT_BYTES ? endpoint : undefined;
	} catch {
		return undefined;
	}
}

export interface AppserverBrokerStatusOptions {
	authStorage?: AuthStorage;
	configuredUrl?: unknown;
	resolveConfig?: () => Promise<{ url: string; token: string } | null>;
	clientFactory?: (config: { url: string; token: string }) => Pick<AuthBrokerClient, "fetchSnapshot">;
}

export function createAppserverBrokerStatus(options: AppserverBrokerStatusOptions = {}) {
	return async (signal: AbortSignal): Promise<BrokerStatusResult> => {
		signal.throwIfAborted();
		const currentGeneration = generation(options.authStorage);
		let config: { url: string; token: string } | null;
		try {
			config = await (options.resolveConfig ?? resolveAuthBrokerConfig)();
			signal.throwIfAborted();
		} catch {
			if (signal.aborted) signal.throwIfAborted();
			const endpoint = safeEndpoint(process.env.OMP_AUTH_BROKER_URL ?? options.configuredUrl);
			return {
				state: "missing-token",
				...(endpoint ? { endpoint } : {}),
				generation: currentGeneration,
			};
		}
		if (!config) return { state: "local", generation: currentGeneration };
		const endpoint = safeEndpoint(config.url);
		if (!endpoint) throw new Error("broker endpoint unavailable");
		try {
			const client =
				options.clientFactory?.(config) ?? new AuthBrokerClient({ url: config.url, token: config.token });
			const result = await client.fetchSnapshot({ signal });
			if (result.status === 200 || result.status === 304)
				return { state: "connected", endpoint, generation: currentGeneration };
			return { state: "unreachable", endpoint, generation: currentGeneration };
		} catch {
			if (signal.aborted) signal.throwIfAborted();
			return { state: "unreachable", endpoint, generation: currentGeneration };
		}
	};
}
