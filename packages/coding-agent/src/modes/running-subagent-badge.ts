import { AgentRegistry } from "../registry/agent-registry";
import type { TerminalTitleRunState } from "../utils/title-generator";

export interface TerminalTitleBaseStateInput {
	sessionStreaming: boolean;
	sessionCompacting: boolean;
	viewSessionStreaming: boolean;
	viewSessionCompacting: boolean;
	sessionPostPromptWork: boolean;
	viewSessionPostPromptWork: boolean;
	collabHostStreaming: boolean;
	hasLoadingAnimation: boolean;
	hasCompactionLoader: boolean;
	hasAutoCompactionLoader: boolean;
	hasRetryLoader: boolean;
	runningTitleDepth: number;
	hasInputCallback: boolean;
	runningSubagentCount: number;
}

export function resolveTerminalTitleBaseState(
	input: TerminalTitleBaseStateInput,
): Exclude<TerminalTitleRunState, "needs_attention"> {
	if (
		input.sessionStreaming ||
		input.sessionCompacting ||
		input.viewSessionStreaming ||
		input.viewSessionCompacting ||
		input.sessionPostPromptWork ||
		input.viewSessionPostPromptWork ||
		input.collabHostStreaming ||
		input.hasLoadingAnimation ||
		input.hasCompactionLoader ||
		input.hasAutoCompactionLoader ||
		input.hasRetryLoader ||
		input.runningTitleDepth > 0 ||
		input.runningSubagentCount > 0
	) {
		return "running";
	}
	if (input.hasInputCallback) return "waiting";
	return "idle";
}

export interface RunningSubagentRegistrySource {
	agentRegistry: AgentRegistry;
}

export function getRunningSubagentBadgeRegistry(collabGuest: RunningSubagentRegistrySource | undefined): AgentRegistry {
	return collabGuest?.agentRegistry ?? AgentRegistry.global();
}

export function countRunningSubagentBadgeAgents(registry: AgentRegistry): number {
	return registry.list().filter(ref => ref.kind === "sub" && ref.status === "running").length;
}

export interface RunningSubagentRegistryChangeHandlers {
	syncRunningSubagentBadge(): void;
	refreshTerminalTitle(options?: { sessionName?: string | undefined; cwd?: string | undefined }): void;
	requestRender(): void;
}

export function handleRunningSubagentRegistryChange(handlers: RunningSubagentRegistryChangeHandlers): void {
	handlers.syncRunningSubagentBadge();
	handlers.refreshTerminalTitle();
	handlers.requestRender();
}
