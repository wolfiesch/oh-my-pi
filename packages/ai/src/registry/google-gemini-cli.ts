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

export const googleGeminiCliProvider = {
	id: "google-gemini-cli",
	name: "Google Cloud Code Assist (Gemini CLI)",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginGeminiCli } = await import("./oauth/google-gemini-cli");
		return loginGeminiCli(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		if (!credentials.projectId) {
			throw new AIError.ConfigurationError("Google Cloud credentials missing projectId");
		}
		const { refreshGoogleCloudToken } = await import("./oauth/google-gemini-cli");
		return refreshGoogleCloudToken(credentials.refresh, credentials.projectId);
	},
	getApiKey: toCloudCodeAssistKey,
	callbackPort: 8085,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
