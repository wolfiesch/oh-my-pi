/**
 * `get_settings` command handling, kept pure so the response plumbing is
 * testable without a live session or provider credentials. The RPC mode's
 * switch case is then a single call.
 */
import type { Settings } from "../../config/settings";
import { buildSettingsSnapshot, isSettingTab, type SettingsSnapshot } from "../../config/settings-snapshot";
import type { RpcResponse } from "./rpc-types";

export function handleGetSettings(settings: Settings, id: string | undefined, tab: unknown): RpcResponse {
	const respond = (data: SettingsSnapshot): RpcResponse => ({
		id,
		type: "response",
		command: "get_settings",
		success: true,
		data,
	});
	if (tab === undefined) return respond(buildSettingsSnapshot(settings));
	// Input frames are cast from parsed JSON rather than validated, so an
	// unknown tab must fail loudly instead of returning an empty snapshot.
	if (!isSettingTab(tab)) {
		return {
			id,
			type: "response",
			command: "get_settings",
			success: false,
			error: typeof tab === "string" ? `Unknown settings tab: ${tab}` : "Settings tab must be a string",
			code: "invalid_tab",
		};
	}
	return respond(buildSettingsSnapshot(settings, tab));
}
