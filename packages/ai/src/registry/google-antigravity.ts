import * as AIError from "../error";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

function toCloudCodeAssistKey(credentials: OAuthCredentials): string {
	return JSON.stringify({
		token: credentials.access,
		projectId: credentials.projectId,
		refreshToken: credentials.refresh,
		expiresAt: credentials.expires,
		email: credentials.email,
	});
}

export const googleAntigravityProvider = {
	id: "google-antigravity",
	name: "Antigravity (Gemini 3, Claude, GPT-OSS)",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginAntigravity } = await import("./oauth/google-antigravity");
		return loginAntigravity(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		if (!credentials.projectId) {
			throw new AIError.ConfigurationError("Antigravity credentials missing projectId");
		}
		const { refreshAntigravityToken } = await import("./oauth/google-antigravity");
		return refreshAntigravityToken(credentials.refresh, credentials.projectId);
	},
	getApiKey: toCloudCodeAssistKey,
	callbackPort: 51121,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
