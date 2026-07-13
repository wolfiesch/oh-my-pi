import { VERSION } from "@oh-my-pi/pi-utils/dirs";

export type CodingAgentAppserverBuild = "compiled" | "bundled" | "source";

export interface CodingAgentAppserverIdentity {
	ompVersion: string;
	ompBuild: CodingAgentAppserverBuild;
	appserverBuild: CodingAgentAppserverBuild;
}

/**
 * Describe the distribution that owns the embedded appserver. Keep the build
 * markers as direct environment reads so the binary and npm bundle builders
 * can constant-fold them.
 */
export function getCodingAgentAppserverIdentity(
	markers: { PI_COMPILED?: string; PI_BUNDLED?: string } = {
		PI_COMPILED: process.env.PI_COMPILED,
		PI_BUNDLED: process.env.PI_BUNDLED,
	},
): CodingAgentAppserverIdentity {
	const build: CodingAgentAppserverBuild =
		markers.PI_COMPILED === "true" ? "compiled" : markers.PI_BUNDLED === "true" ? "bundled" : "source";
	return { ompVersion: VERSION, ompBuild: build, appserverBuild: build };
}
