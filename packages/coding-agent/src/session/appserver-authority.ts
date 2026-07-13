import { statSync } from "node:fs";
import { type DurableEntry, hostId, type ProjectId, type SessionId } from "@oh-my-pi/app-wire";
import type { LockCheckHook, SessionAuthority, SessionAuthoritySession, SessionRecord } from "@oh-my-pi/appserver";
import {
	type DesktopOperationsAuthority,
	FileSessionDiscovery,
	type OperationContext,
	projectNameFromCwd,
	stableProjectId,
} from "@oh-my-pi/appserver";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { AgentRegistry } from "../registry/agent-registry";
import {
	createDesktopConfigAuthority,
	type DesktopConfigAuthority,
	type DesktopSettingsPort,
} from "./desktop-config-authority";
import {
	CodingAgentDesktopAuthority,
	type DesktopAuthorityContext,
	type DesktopReviewApplyRequest,
	type DesktopReviewReadRequest,
} from "./desktop-operations-authority";
import { inspectSessionLock } from "./session-lock";
import { SessionManager } from "./session-manager";

export interface AppserverRuntimeAuthorities {
	sessionAuthority: SessionAuthority;
	discovery: { list(): Promise<SessionRecord[]> };
	operationsAuthority: DesktopOperationsAuthority;
	projectRootForProject(project: ProjectId): Promise<string>;
	projectRootForSession(session: SessionId): Promise<string>;
	lockCheck: LockCheckHook;
}

export interface AppserverAuthorityOptions {
	settings?: Settings;
	modelRegistry?: Pick<ModelRegistry, "getAll" | "getAvailable">;
	agentRegistry?: Pick<AgentRegistry, "list">;
	skillsLoader?: () => unknown | Promise<unknown>;
	pluginManager?: { list(): unknown[] | Promise<unknown[]> };
	mcpManager?: { getConnectedServers(): string[]; getAllServerNames(): string[] };
	reviewStore?: {
		read(request: DesktopReviewReadRequest, context?: unknown): unknown | Promise<unknown>;
		apply(request: DesktopReviewApplyRequest, context?: unknown): unknown | Promise<unknown>;
	};
	agentAuthority?: { cancel(agentId: string, sessionId: string): Promise<boolean> };
}

function settingsPort(settings: Settings): DesktopSettingsPort {
	return {
		get: path => settings.get(path),
		isConfigured: path => settings.isConfigured(path),
		set: (path, value) => settings.set(path, value as never),
		override: (path, value) => settings.override(path, value as never),
		clearOverride: path => settings.clearOverride(path),
		flush: () => settings.flush(),
		getDesktopSnapshot: path => settings.getDesktopSnapshot(path),
		restoreDesktopSnapshot: snapshot => settings.restoreDesktopSnapshot(snapshot),
		clearGlobal: path => settings.clearGlobal(path),
	};
}

export function createAppserverRuntime(options: AppserverAuthorityOptions = {}): AppserverRuntimeAuthorities {
	const records = new Map<SessionId, SessionRecord>();
	const baseDiscovery = new FileSessionDiscovery(getSessionsDir(), undefined, hostId("appserver-authority"));
	const refresh = async (): Promise<SessionRecord[]> => {
		const discovered = await baseDiscovery.list();
		records.clear();
		for (const record of discovered) records.set(record.sessionId, record);
		return [...records.values()];
	};
	const sessionAuthority: SessionAuthority = {
		async create(cwd, title): Promise<SessionAuthoritySession> {
			const manager = SessionManager.create(cwd);
			try {
				if (title !== undefined) await manager.setSessionName(title, "user");
				await manager.ensureOnDisk();
				const path = manager.getSessionFile();
				if (!path) throw new Error("session file was not created");
				const created = {
					sessionId: manager.getSessionId() as SessionAuthoritySession["sessionId"],
					path,
					cwd: manager.getCwd(),
					title: manager.getSessionName(),
					entries: manager.getEntries() as unknown as DurableEntry[],
				};
				records.set(created.sessionId, {
					...created,
					projectId: stableProjectId(created.cwd),
					projectName: projectNameFromCwd(created.cwd),
					title: created.title ?? "Session",
					updatedAt: new Date().toISOString(),
					status: "idle",
					entries: created.entries,
				});
				return created;
			} finally {
				await manager.dispose();
			}
		},
		async list(): Promise<SessionRecord[]> {
			return refresh();
		},
	};
	const discovery = { list: () => sessionAuthority.list() };
	const projectRootForSessionSync = (session: string): string => {
		const record = records.get(session as SessionId);
		if (!record) throw new Error("unknown session");
		return record.cwd;
	};
	const projectRootForSession = async (session: SessionId): Promise<string> => {
		await discovery.list();
		return projectRootForSessionSync(session);
	};
	const projectRootForProject = async (project: ProjectId): Promise<string> => {
		const matches = (await discovery.list()).filter(record => record.projectId === project);
		const roots = [...new Set(matches.map(record => record.cwd))];
		if (roots.length === 0) throw new Error("unknown project");
		if (roots.length !== 1) throw new Error("ambiguous project");
		return roots[0];
	};
	const firstSession = (): SessionRecord => {
		const record = [...records.values()][0];
		if (!record) throw new Error("no session is available");
		return record;
	};
	const sessionManager = { getSessionId: () => firstSession().sessionId, getCwd: () => firstSession().cwd };
	const codingContext: DesktopAuthorityContext = {
		sessionManager,
		projectRootForSession: projectRootForSessionSync,
		...(options.reviewStore ? { reviewStore: options.reviewStore } : {}),
		...(options.agentAuthority ? { agentAuthority: options.agentAuthority } : {}),
	};
	const coding = new CodingAgentDesktopAuthority(codingContext);
	const operations: DesktopOperationsAuthority = {
		filesRead: (args, context) =>
			coding.filesRead(args as unknown as Parameters<typeof coding.filesRead>[0], context) as unknown as Promise<
				Record<string, unknown>
			>,
		filesList: (args, context) =>
			coding.filesList(args as unknown as Parameters<typeof coding.filesList>[0], context) as unknown as Promise<
				Record<string, unknown>
			>,
		filesDiff: (args, context) =>
			coding.filesDiff(args as unknown as Parameters<typeof coding.filesDiff>[0], context) as unknown as Promise<
				Record<string, unknown>
			>,
		filesWrite: (args, context) =>
			coding.filesWrite(args as unknown as Parameters<typeof coding.filesWrite>[0], context) as unknown as Promise<
				Record<string, unknown>
			>,
		filesPatch: (args, context) =>
			coding.filesPatch(args as unknown as Parameters<typeof coding.filesPatch>[0], context) as unknown as Promise<
				Record<string, unknown>
			>,
		bashRun: (args, context) =>
			coding.runBash(args as unknown as Parameters<typeof coding.runBash>[0], context) as unknown as Promise<
				Record<string, unknown>
			>,
		termOpen: async (args, context) => {
			let terminalId: string | undefined;
			let sequence = 0;
			let active = true;
			let flushed = false;
			type PendingTerminalEvent =
				| { type: "terminal.output"; stream: "stdout" | "stderr"; data: string }
				| { type: "terminal.exit"; exitCode: number };
			const pending: PendingTerminalEvent[] = [];
			const emit = (event: PendingTerminalEvent): void => {
				if (!active) return;
				if (!terminalId) {
					pending.push(event);
					return;
				}
				context.emitTerminalOutput?.({
					v: "omp-app/1",
					type: event.type,
					hostId: context.hostId,
					sessionId: context.sessionId,
					terminalId,
					cursor: { epoch: "terminal", seq: ++sequence },
					...(event.type === "terminal.output"
						? { stream: event.stream, data: event.data }
						: { exitCode: event.exitCode }),
				});
			};
			const flush = (): void => {
				if (flushed || !terminalId || !active) return;
				flushed = true;
				for (const event of pending.splice(0)) emit(event);
			};
			const onAbort = (): void => {
				active = false;
				pending.length = 0;
			};
			context.abortSignal.addEventListener("abort", onAbort, { once: true });
			try {
				const result = await coding.openTerminal(
					{
						...(args as unknown as Parameters<typeof coding.openTerminal>[0]),
						onOutput: (stream, data) => emit({ type: "terminal.output", stream, data }),
						onExit: exit => emit({ type: "terminal.exit", exitCode: exit.exitCode ?? -1 }),
					},
					context,
				);
				terminalId = result.terminalId;
				flush();
				return result as Record<string, unknown>;
			} finally {
				context.abortSignal.removeEventListener("abort", onAbort);
			}
		},
		...(options.reviewStore
			? {
					reviewRead: (args: Record<string, unknown>, context: OperationContext) =>
						coding.reviewRead(args as unknown as Parameters<typeof coding.reviewRead>[0], context),
					reviewApply: (args: Record<string, unknown>, context: OperationContext) =>
						coding.reviewApply(args as unknown as Parameters<typeof coding.reviewApply>[0], context),
				}
			: {}),
		...(options.agentAuthority
			? {
					agentCancel: async (args: Record<string, unknown>, context: OperationContext) =>
						coding.cancelAgent(String(args.agentId), context),
				}
			: {}),
		terminalInput: async (frame, context) => {
			if (context.abortSignal.aborted)
				throw Object.assign(new Error("operation was cancelled"), { code: "ABORTED" });
			coding.inputTerminal(String(frame.terminalId), String(frame.data));
		},
		terminalResize: async (frame, context) => {
			if (context.abortSignal.aborted)
				throw Object.assign(new Error("operation was cancelled"), { code: "ABORTED" });
			coding.resizeTerminal(String(frame.terminalId), Number(frame.cols), Number(frame.rows));
		},
		terminalClose: async frame => {
			coding.closeTerminal(String(frame.terminalId));
		},
	};
	if (options.settings) {
		const config: DesktopConfigAuthority = createDesktopConfigAuthority({
			settings: settingsPort(options.settings),
			modelRegistry: options.modelRegistry,
			agentRegistry: options.agentRegistry,
			skillsLoader: options.skillsLoader,
			pluginManager: options.pluginManager,
			mcpManager: options.mcpManager,
		});
		operations.catalogGet = (args, context) => config.catalogGet(args, context);
		operations.settingsRead = async (args, context) =>
			config.settingsRead(args, context) as unknown as Record<string, unknown>;
		operations.settingsWrite = (args, context) => config.settingsWrite(args, context);
		operations.configWrite = args => config.configWrite(args);
	}
	return {
		sessionAuthority,
		discovery,
		operationsAuthority: operations,
		projectRootForProject,
		projectRootForSession,
		lockCheck: appserverLockCheck,
	};
}

export function createAppserverAuthority(): SessionAuthority {
	return createAppserverRuntime().sessionAuthority;
}

export const appserverLockCheck: LockCheckHook = session => {
	const inspection = inspectSessionLock(session.path);
	if (inspection.status === "live" || inspection.status === "suspect" || inspection.status === "malformed")
		throw new Error(`session lock is ${inspection.status}`);
};

export function sessionFileExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
