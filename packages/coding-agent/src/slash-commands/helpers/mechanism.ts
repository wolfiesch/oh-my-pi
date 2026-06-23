import type {
	MechanismRuntimeController,
	MechFileEntry,
	RuntimeAgentEvent,
	RuntimeAgentSource,
} from "@oh-my-pi/omp-mechanism";
import type { AgentRef } from "../../registry/agent-registry";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { openPath } from "../../utils/open";

export const DEFAULT_MECHANISM_PORT = 3848;

interface ActiveMechanismState {
	sessionId: string;
	port: number;
	controller: MechanismRuntimeController;
	cleanup: Array<() => void>;
}

let activeState: ActiveMechanismState | undefined;

export interface MechanismLaunchResult {
	url: string;
	message: string;
}

export type MechanismAction = "on" | "off";

export interface MechanismArgs {
	action: MechanismAction;
	port: number;
}

const MECHANISM_USAGE = "Usage: /mechanism [on|off]";

function parsePort(value: string | undefined): number | string {
	if (!value) return `Missing port. ${MECHANISM_USAGE}`;
	if (!/^\d+$/.test(value)) return `Invalid port: ${value}`;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) return `Invalid port: ${value}`;
	return port;
}

export function parseMechanismArgs(args: string): MechanismArgs | { error: string } {
	const tokens = args.split(/\s+/).filter(Boolean);
	let action: MechanismAction = "on";
	let sawAction = false;
	let port = DEFAULT_MECHANISM_PORT;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "on" || token === "start") {
			if (sawAction) return { error: `Multiple mechanism actions provided. ${MECHANISM_USAGE}` };
			action = "on";
			sawAction = true;
			continue;
		}
		if (token === "off" || token === "stop") {
			if (sawAction) return { error: `Multiple mechanism actions provided. ${MECHANISM_USAGE}` };
			action = "off";
			sawAction = true;
			continue;
		}
		if (token === "--port" || token === "-p") {
			const parsed = parsePort(tokens[++i]);
			if (typeof parsed === "string") return { error: parsed };
			port = parsed;
			continue;
		}
		if (token.startsWith("--port=")) {
			const parsed = parsePort(token.slice("--port=".length));
			if (typeof parsed === "string") return { error: parsed };
			port = parsed;
			continue;
		}
		return { error: `Unknown option: ${token}. ${MECHANISM_USAGE}` };
	}

	return { action, port };
}

function getAgentDepth(ref: AgentRef, registry: AgentRegistry): number {
	let depth = 0;
	let current = ref;
	while (current.parentId) {
		const parent = registry.get(current.parentId);
		if (!parent) break;
		depth++;
		current = parent;
	}
	return depth;
}

function mapAgentRefToSource(ref: AgentRef, registry: AgentRegistry): RuntimeAgentSource {
	return {
		id: ref.id,
		agentId: ref.id,
		parentId: ref.parentId ?? null,
		status: ref.status,
		depth: getAgentDepth(ref, registry),
		label: ref.displayName || ref.id,
		model: ref.session?.model ? `${ref.session.model.provider}/${ref.session.model.id}` : undefined,
		isMain: ref.id === "Main",
		kind: ref.kind,
	};
}

export async function launchMechanismServer(session: AgentSession, port: number): Promise<MechanismLaunchResult> {
	const mechanismSessionId = session.sessionManager.getSessionId();
	if (activeState) {
		if (activeState.sessionId === mechanismSessionId) {
			if (activeState.port === port) {
				const url = `http://localhost:${activeState.port}`;
				openPath(url);
				return {
					url,
					message: `Mechanism live visualization already running for this session at: ${url}`,
				};
			}
			stopMechanismServer();
		} else {
			stopMechanismServer();
		}
	}

	// Exception: Dynamic import of mechanism module is required to avoid loading heavy 3D client and bun server assets during startup of the main CLI.
	const { startRuntimeServer } = await import("@oh-my-pi/omp-mechanism");

	const registry = AgentRegistry.global();
	const initialAgents = registry.list().map(ref => mapAgentRefToSource(ref, registry));

	const controller = await startRuntimeServer(port, { agents: initialAgents });

	const cleanupCallbacks: Array<() => void> = [];
	const sessionSubscriptions = new Map<string, { unsubSession: () => void; unsubManager: () => void }>();

	const syncAgentSubscriptions = () => {
		const refs = registry.list();
		for (const ref of refs) {
			if (ref.session) {
				if (!sessionSubscriptions.has(ref.id)) {
					const agentSource = mapAgentRefToSource(ref, registry);

					// Replay only the last 50 entries per agent to avoid materializing
					// the full transcript array when mechanism launches mid-session.
					const entries = ref.session.sessionManager.getRecentEntries(50);
					for (const entry of entries) {
						try {
							// Structurally compatible session entries cast to MechFileEntry
							const mechEntry = entry as unknown as MechFileEntry;
							controller.pushEntry(agentSource, mechEntry);
						} catch {}
					}

					// Subscribe to new session events and entry appends
					const unsubSession = ref.session.subscribe(event => {
						if (
							event.type === "agent_start" ||
							event.type === "agent_end" ||
							event.type === "tool_execution_start" ||
							event.type === "tool_execution_update" ||
							event.type === "tool_execution_end"
						) {
							try {
								// Structurally compatible session events cast to RuntimeAgentEvent
								const runtimeEvent = event as unknown as RuntimeAgentEvent;
								controller.pushAgentEvent(ref.id, runtimeEvent);
							} catch {}
						}
						if (event.type === "auto_compaction_start" || event.type === "auto_compaction_end") {
							try {
								const phase = event.type === "auto_compaction_start" ? "start" : "end";
								controller.pushCompaction(ref.id, phase);
							} catch {}
						}
						if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
							try {
								const phase = event.type === "auto_retry_start" ? "start" : "end";
								const attempt = event.type === "auto_retry_start" ? (event as any).attempt : undefined;
								controller.pushRetry(ref.id, phase, attempt);
							} catch {}
						}
						if (event.type === "retry_fallback_applied") {
							try {
								const e = event as any;
								if (e.from && e.to) controller.pushFallback(ref.id, e.from, e.to);
							} catch {}
						}
						if (event.type === "thinking_level_changed") {
							try {
								const e = event as any;
								const level = e.resolved ?? e.thinkingLevel ?? "unknown";
								controller.pushThinking(ref.id, level);
							} catch {}
						}
						if (event.type === "notice") {
							try {
								const e = event as any;
								if (e.level === "info" || e.level === "warning" || e.level === "error") {
									controller.pushNotice(ref.id, e.level);
								}
							} catch {}
						}
					});

					const unsubManager = ref.session.sessionManager.subscribeEntryAppended(entry => {
						try {
							// Structurally compatible session entries cast to MechFileEntry
							const mechEntry = entry as unknown as MechFileEntry;
							controller.pushEntry(agentSource, mechEntry);
						} catch {}
					});

					sessionSubscriptions.set(ref.id, { unsubSession, unsubManager });
				}
			} else {
				// No session (parked/aborted), clean up subscriptions
				const subs = sessionSubscriptions.get(ref.id);
				if (subs) {
					subs.unsubSession();
					subs.unsubManager();
					sessionSubscriptions.delete(ref.id);
				}
			}
		}
	};

	// Perform initial sync
	syncAgentSubscriptions();

	// Subscribe to ALL IRC deliveries (including Main↔agent) for mechanism arcs
	const { IrcBus } = await import("../../irc/bus");
	const unsubIrc = IrcBus.global().onDelivered((from, to) => {
		try {
			controller.pushIrc(from, to);
		} catch {}
	});
	cleanupCallbacks.push(unsubIrc);

	// Watch registry changes
	const unsubRegistry = registry.onChange(event => {
		try {
			if (event.type === "registered") {
				controller.pushAgent(mapAgentRefToSource(event.ref, registry));
			} else if (event.type === "status_changed") {
				controller.pushStatus(event.ref.id, event.ref.status);
			} else if (event.type === "removed") {
				controller.removeAgent(event.ref.id);
				const subs = sessionSubscriptions.get(event.ref.id);
				if (subs) {
					subs.unsubSession();
					subs.unsubManager();
					sessionSubscriptions.delete(event.ref.id);
				}
			}
		} catch {}
		syncAgentSubscriptions();
	});

	cleanupCallbacks.push(() => {
		unsubRegistry();
		for (const subs of sessionSubscriptions.values()) {
			subs.unsubSession();
			subs.unsubManager();
		}
		sessionSubscriptions.clear();
	});

	// Assign activeState BEFORE registering the dispose listener so that if
	// disposal wins the race, stopMechanismServer() finds the state to tear down.
	activeState = {
		sessionId: mechanismSessionId,
		port: controller.port,
		controller,
		cleanup: cleanupCallbacks,
	};

	// Tie mechanism lifecycle to the host session: when dispose() fires
	// (process exit, /drop, session switch), tear down the visualization
	// server automatically so orphan HTTP servers don't leak.
	const unsubDispose = session.onDispose(() => stopMechanismServer());
	cleanupCallbacks.push(unsubDispose);

	const url = `http://localhost:${controller.port}`;
	openPath(url);

	return {
		url,
		message: `Mechanism live visualization server started at: ${url}`,
	};
}

export function stopMechanismServer(): boolean {
	if (!activeState) return false;
	const state = activeState;
	activeState = undefined;

	try {
		state.controller.stop();
	} catch {}

	for (const cleanup of state.cleanup) {
		try {
			cleanup();
		} catch {}
	}
	return true;
}
