import { capabilitiesArray, controlFree, inputObject } from "./guards.ts";
import { fail } from "./errors.ts";
export const DEVICE_CAPABILITIES = [
	"sessions.read",
	"sessions.prompt",
	"sessions.control",
	"sessions.manage",
	"bash.run",
	"term.open",
	"files.read",
	"agents.control",
	"audit.read",
	"config.write",
] as const;
export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];
export const REMOTE_DEFAULT_CAPABILITIES = [
	"sessions.read",
	"sessions.prompt",
	"sessions.control",
	"sessions.manage",
	"agents.control",
] as const;
export interface Capabilities {
	client: string[];
	server?: string[];
}
export function decodeCapabilities(value: unknown, path = "capabilities"): Capabilities {
	const input = inputObject(value);
	const client = capabilitiesArray(input.client, `${path}.client`);
	const server = input.server === undefined ? undefined : capabilitiesArray(input.server, `${path}.server`);
	for (const [i, capability] of client.entries())
		if (!(DEVICE_CAPABILITIES as readonly string[]).includes(capability))
			fail("INVALID_FRAME", "unknown device capability", `${path}.client[${i}]`);
	if (server)
		for (const [i, capability] of server.entries())
			if (!(DEVICE_CAPABILITIES as readonly string[]).includes(capability))
				fail("INVALID_FRAME", "unknown device capability", `${path}.server[${i}]`);
	return server ? { client, server } : { client };
}
export function decodeFeatureList(value: unknown, path: string): string[] {
	const result = capabilitiesArray(value, path);
	for (const [i, feature] of result.entries()) controlFree(feature, `${path}[${i}]`, 128);
	return result;
}
export function isCapability(value: unknown): value is DeviceCapability {
	return typeof value === "string" && (DEVICE_CAPABILITIES as readonly string[]).includes(value);
}
