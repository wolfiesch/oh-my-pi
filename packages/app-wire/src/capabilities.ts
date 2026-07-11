import { capabilitiesArray, object } from "./guards.ts";

export const CLIENT_CAPABILITIES = ["sessions.read", "session.command", "terminal.read", "files.read", "review.read", "pairing.confirm"] as const;
export const SERVER_CAPABILITIES = ["sessions", "snapshot", "events", "agents", "terminals", "files", "review", "audit", "pairing"] as const;
export type ClientCapability = (typeof CLIENT_CAPABILITIES)[number] | (string & {});
export type ServerCapability = (typeof SERVER_CAPABILITIES)[number] | (string & {});
export interface Capabilities { client: string[]; server?: string[] }
export function decodeCapabilities(value: unknown, path = "capabilities"): Capabilities {
  const input = object(value, path);
  const client = capabilitiesArray(input.client, `${path}.client`);
  const server = input.server === undefined ? undefined : capabilitiesArray(input.server, `${path}.server`);
  return server ? { client, server } : { client };
}
export function isCapability(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
