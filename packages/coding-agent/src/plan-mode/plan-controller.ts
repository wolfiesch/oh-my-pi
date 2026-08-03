import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { CompactionCancelledError, type CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { ResolvedModelRoleValue } from "../config/model-resolver";
import { resolveLocalUrlToPath } from "../internal-urls";
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../prompts/system/plan-mode-compact-instructions.md" with {
	type: "text",
};
import type { AgentSession, ResolvedRoleModel } from "../session/agent-session";
import type { SessionContext } from "../session/session-context";
import type { ConfiguredThinkingLevel } from "../thinking";
import { humanizePlanTitle, type PlanApprovalDetails } from "./approved-plan";
import { resolvePlanModelTransition } from "./model-transition";
import { listPlanFiles, readPlanFile } from "./plan-files";
import type { PlanModeState, PlanWorkflow, SessionPlanMode } from "./state";

export interface PendingPlanApproval {
	approvalId: string;
	title: string;
	planFilePath: string;
	planContent: string;
}

export interface PlanStateProjection {
	mode: SessionPlanMode;
	planFilePath?: string;
	workflow?: PlanWorkflow;
	reentry?: boolean;
	awaitingApproval?: Omit<PendingPlanApproval, "planContent">;
	planExists?: boolean;
	availablePlanFiles?: string[];
	content?: string;
}

export type PlanDecision =
	| {
			kind: "approve";
			preserveContext: boolean;
			compactBeforeExecute: boolean;
			executionModelRole?: string;
			editedContent?: string;
	  }
	| { kind: "refine"; feedback?: string }
	| { kind: "reject"; feedback?: string };

export interface PlanApprovalResult {
	approvalId: string;
	decision: PlanDecision["kind"];
	executionDispatched: boolean;
	planFilePath: string;
	compaction?: CompactionOutcome;
}

export interface PlanApprovalExecutionPort {
	/** TUI supplies its hooked clear path; headless callers use the controller's shared clear. */
	clearSession?: () => Promise<void>;
	/** TUI supplies its rendered compaction path; headless callers use AgentSession.compact. */
	compact?: (
		internalGuidance: string,
		beforeFlush: (outcome: CompactionOutcome) => Promise<void>,
	) => Promise<CompactionOutcome>;
	beforeDispatch?: () => void | Promise<void>;
	warning?: (message: string) => void;
}

type ModelState = { model: Model; thinkingLevel?: ConfiguredThinkingLevel };
type StateListener = (state: PlanStateProjection) => void;
type ApprovalListener = (approval: PendingPlanApproval) => void;
type SettlementListener = (result: PlanApprovalResult) => void;

/**
 * Surface-independent owner of plan mode state and transitions.
 *
 * TUI, ACP, print, and RPC may choose how an approval is displayed, but they do
 * not own tool/model snapshots or mutate AgentSession plan state directly.
 */
export class PlanModeController {
	readonly #session: AgentSession;
	#previousTools: string[] | undefined;
	#previousModelState: ModelState | undefined;
	#deferredModelState: ModelState | undefined;
	#deferredPlanModel = false;
	#hasEntered = false;
	#pausedState: PlanModeState | undefined;
	#pendingApproval: PendingPlanApproval | undefined;
	readonly #stateListeners = new Set<StateListener>();
	readonly #approvalListeners = new Set<ApprovalListener>();
	readonly #settlementListeners = new Set<SettlementListener>();

	constructor(session: AgentSession) {
		this.#session = session;
	}

	get mode(): SessionPlanMode {
		if (this.#session.getPlanModeState()?.enabled) return "plan";
		return this.#pausedState ? "plan_paused" : "none";
	}

	get active(): boolean {
		return this.mode === "plan";
	}

	get paused(): boolean {
		return this.mode === "plan_paused";
	}

	get previousModelState(): ModelState | undefined {
		return this.#previousModelState;
	}

	get pendingApproval(): PendingPlanApproval | undefined {
		return this.#pendingApproval;
	}

	onStateChange(listener: StateListener): () => void {
		this.#stateListeners.add(listener);
		return () => this.#stateListeners.delete(listener);
	}

	onApprovalRequest(listener: ApprovalListener): () => void {
		this.#approvalListeners.add(listener);
		return () => this.#approvalListeners.delete(listener);
	}

	onApprovalSettled(listener: SettlementListener): () => void {
		this.#settlementListeners.add(listener);
		return () => this.#settlementListeners.delete(listener);
	}

	async project(options?: {
		includeContent?: boolean;
		includeAvailableFiles?: boolean;
	}): Promise<PlanStateProjection> {
		const state = this.#session.getPlanModeState() ?? this.#pausedState;
		const mode = this.mode;
		if (!state || mode === "none") return { mode: "none" };
		const content = state.planFilePath ? await this.#readPlan(state.planFilePath) : null;
		return {
			mode,
			planFilePath: state.planFilePath,
			workflow: state.workflow ?? "parallel",
			reentry: state.reentry,
			awaitingApproval: this.#pendingApproval
				? {
						approvalId: this.#pendingApproval.approvalId,
						title: this.#pendingApproval.title,
						planFilePath: this.#pendingApproval.planFilePath,
					}
				: undefined,
			planExists: content !== null,
			...(options?.includeContent ? { content: content ?? undefined } : {}),
			...(options?.includeAvailableFiles ? { availablePlanFiles: await this.#listPlans() } : {}),
		};
	}

	async enter(options?: {
		planFilePath?: string;
		workflow?: PlanWorkflow;
		preserveRestoredModel?: boolean;
		persist?: boolean;
	}): Promise<void> {
		if (this.active) return;
		if (!this.#session.settings.get("plan.enabled")) throw new Error("Plan mode is disabled.");
		if (this.#session.getGoalModeState()?.enabled) throw new Error("Exit goal mode first.");
		if (this.#session.getVibeModeState()?.enabled) throw new Error("Exit vibe mode first.");

		const planFilePath = options?.planFilePath ?? this.#session.getPlanReferencePath() ?? "local://PLAN.md";
		const workflow = options?.workflow ?? "parallel";
		const previousTools = this.#session.getEnabledToolNames();
		const planTools = this.#session.hasBuiltInTool("write")
			? [...new Set([...previousTools, "write"])]
			: previousTools;
		const previousState = this.#session.getPlanModeState();
		const previousPausedState = this.#pausedState;
		const previousHasEntered = this.#hasEntered;
		const previousMountedTools = this.#session.getMountedXdevToolNames();
		const previousModel = this.#session.model
			? { model: this.#session.model, thinkingLevel: this.#session.configuredThinkingLevel() }
			: undefined;

		this.#previousTools = previousTools;
		try {
			await this.#session.setActiveToolsByName(planTools);
			this.#session.setPlanModeState({
				enabled: true,
				paused: false,
				planFilePath,
				workflow,
				reentry: this.#hasEntered || previousState !== undefined,
			});
			this.#session.setPlanProposalHandler(title => this.#prepareApproval(title));
			if (this.#session.isStreaming) await this.#session.sendPlanModeContext({ deliverAs: "steer" });
			this.#hasEntered = true;
			if (!options?.preserveRestoredModel) await this.#applyPlanModeModel();
			this.#pausedState = undefined;
			if (options?.persist !== false) this.#persist("plan", planFilePath, workflow);
			await this.#emitState();
		} catch (error) {
			this.#session.setPlanProposalHandler(null);
			this.#session.setPlanModeState(previousState);
			if (
				previousModel &&
				(!modelsAreEqual(this.#session.model, previousModel.model) ||
					this.#session.configuredThinkingLevel() !== previousModel.thinkingLevel)
			) {
				try {
					await this.#restoreModel(previousModel);
				} catch (rollbackError) {
					logger.warn("Failed to restore model after plan entry failure", { error: String(rollbackError) });
				}
			}
			const enabledTools = this.#session.getEnabledToolNames();
			const mountedTools = this.#session.getMountedXdevToolNames();
			if (
				enabledTools.length !== previousTools.length ||
				enabledTools.some((name, index) => name !== previousTools[index]) ||
				mountedTools.length !== previousMountedTools.length ||
				mountedTools.some((name, index) => name !== previousMountedTools[index])
			) {
				try {
					await this.#session.setActiveToolPresentation(previousTools, previousMountedTools);
				} catch (rollbackError) {
					logger.warn("Failed to restore tools after plan entry failure", { error: String(rollbackError) });
				}
			}
			this.#previousTools = undefined;
			this.#previousModelState = undefined;
			this.#deferredModelState = undefined;
			this.#deferredPlanModel = false;
			this.#pausedState = previousPausedState;
			this.#hasEntered = previousHasEntered;
			throw error;
		}
	}

	async pause(): Promise<void> {
		if (!this.active) return;
		const state = this.#session.getPlanModeState();
		if (!state) return;
		await this.#exit({ paused: true });
		this.#pausedState = { ...state, enabled: false, paused: true };
		this.#persist("plan_paused", state.planFilePath, state.workflow ?? "parallel");
		await this.#emitState();
	}

	async disable(): Promise<void> {
		const wasActive = this.active;
		if (wasActive) await this.#exit({ paused: false });
		const pendingApproval = this.#pendingApproval;
		if (pendingApproval) {
			this.#pendingApproval = undefined;
			await this.#settle({
				approvalId: pendingApproval.approvalId,
				decision: "reject",
				executionDispatched: false,
				planFilePath: pendingApproval.planFilePath,
			});
		}
		this.#session.setPlanProposalHandler(null);
		this.#session.setPlanModeState(undefined);
		this.#pausedState = undefined;
		this.#pendingApproval = undefined;
		this.#hasEntered = false;
		if (!wasActive) this.#session.sessionManager.appendModeChange("none");
		await this.#emitState();
	}

	async reconcileFromSession(
		context: SessionContext = this.#session.sessionManager.buildSessionContext(),
	): Promise<void> {
		await this.clearTransientState({ restoreTools: false });
		if (!this.#session.settings.get("plan.enabled")) {
			if (context.mode === "plan" || context.mode === "plan_paused") {
				this.#session.sessionManager.appendModeChange("none");
			}
			await this.#emitState();
			return;
		}
		if (context.mode === "plan") {
			await this.enter({
				planFilePath:
					typeof context.modeData?.planFilePath === "string" ? context.modeData.planFilePath : undefined,
				workflow: context.modeData?.workflow === "iterative" ? "iterative" : "parallel",
				preserveRestoredModel: true,
				persist: false,
			});
			return;
		}
		if (context.mode === "plan_paused") {
			const planFilePath =
				typeof context.modeData?.planFilePath === "string" ? context.modeData.planFilePath : "local://PLAN.md";
			this.#pausedState = {
				enabled: false,
				paused: true,
				planFilePath,
				workflow: context.modeData?.workflow === "iterative" ? "iterative" : "parallel",
				reentry: true,
			};
			this.#hasEntered = true;
		}
		await this.#emitState();
	}

	async clearTransientState(options?: { restoreTools?: boolean }): Promise<void> {
		const pendingApproval = this.#pendingApproval;
		if (pendingApproval) {
			this.#pendingApproval = undefined;
			await this.#settle({
				approvalId: pendingApproval.approvalId,
				decision: "reject",
				executionDispatched: false,
				planFilePath: pendingApproval.planFilePath,
			});
		}
		const shouldRestore = options?.restoreTools !== false && this.active && this.#previousTools !== undefined;
		this.#session.setPlanProposalHandler(null);
		this.#session.setPlanModeState(undefined);
		this.#pausedState = undefined;

		try {
			if (shouldRestore && this.#previousTools) await this.#session.setActiveToolsByName(this.#previousTools);
		} finally {
			this.#previousTools = undefined;
			this.#previousModelState = undefined;
			this.#deferredModelState = undefined;
			this.#deferredPlanModel = false;
			this.#hasEntered = false;
		}
	}

	async reapplyPlanModel(): Promise<void> {
		if (!this.active) return;
		const resolved = this.#session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) {
			this.#clearDeferredPlanModel();
			return;
		}
		await this.#applyPlanModelTransition(this.#session.model, resolved);
	}

	async flushDeferredModelTransition(): Promise<void> {
		const pending = this.#deferredModelState;
		this.#deferredModelState = undefined;
		this.#deferredPlanModel = false;
		if (!pending) return;
		await this.#session.setModelTemporary(pending.model, pending.thinkingLevel);
	}

	async promoteReviewedPlan(details: PlanApprovalDetails): Promise<PendingPlanApproval> {
		const state = this.#session.getPlanModeState();
		if (!state?.enabled) throw new Error("Plan mode is not active.");
		const planFilePath = details.planFilePath || state.planFilePath;
		const planContent = await this.#readPlan(planFilePath);
		if (!planContent) throw new Error(`Plan file not found at ${planFilePath}`);
		if (state.planFilePath !== planFilePath) {
			this.#session.setPlanModeState({ ...state, planFilePath });
			this.#persist("plan", planFilePath, state.workflow ?? "parallel");
		}
		const existing = this.#pendingApproval;
		const approval =
			existing?.planFilePath === planFilePath
				? { ...existing, title: details.title, planContent }
				: {
						approvalId: Snowflake.next() as string,
						title: details.title,
						planFilePath,
						planContent,
					};
		this.#pendingApproval = approval;
		await this.#emitState();
		return approval;
	}

	async resolveApproval(
		approvalId: string,
		decision: PlanDecision,
		port: PlanApprovalExecutionPort = {},
	): Promise<PlanApprovalResult> {
		const approval = this.#pendingApproval;
		if (!approval || approval.approvalId !== approvalId) throw new Error("Unknown plan approval.");
		if (!this.active) throw new Error("Plan mode is not active.");

		if (decision.kind !== "approve") {
			this.#pendingApproval = undefined;
			if (decision.feedback?.trim()) await this.#session.prompt(decision.feedback.trim());
			const result: PlanApprovalResult = {
				approvalId,
				decision: decision.kind,
				executionDispatched: false,
				planFilePath: approval.planFilePath,
			};
			await this.#settle(result);
			return result;
		}

		let planContent = decision.editedContent ?? approval.planContent;
		if (!planContent.trim()) throw new Error("Approved plan is empty.");
		if (decision.editedContent !== undefined) {
			await Bun.write(this.#resolvePlanPath(approval.planFilePath), decision.editedContent);
			planContent = decision.editedContent;
		}
		const executionModel = this.#resolveExecutionModel(decision.executionModelRole);
		const previousTools = this.#previousTools ?? this.#session.getEnabledToolNames();
		if (decision.compactBeforeExecute) this.#session.markPlanInternalAbortPending();
		let compaction: CompactionOutcome | undefined;
		try {
			await this.#exit({ deferModelRestore: decision.compactBeforeExecute });
			if (!decision.preserveContext) {
				const oldRoot = this.#localRoot();
				if (port.clearSession) await port.clearSession();
				else if (!(await this.#session.newSession())) throw new Error("Session clear was cancelled.");
				const newRoot = this.#localRoot();
				await this.#copyLocalArtifacts(oldRoot, newRoot);
				await Bun.write(this.#resolvePlanPath(approval.planFilePath), planContent);
			} else if (decision.compactBeforeExecute) {
				this.#session.setPlanReferencePath(approval.planFilePath);
				const guidance = prompt.render(planModeCompactInstructionsPrompt, { planFilePath: approval.planFilePath });
				const beforeFlush = (outcome: CompactionOutcome) => this.#applyDeferredModel(outcome, executionModel);
				if (port.compact) {
					compaction = await port.compact(guidance, beforeFlush);
				} else {
					try {
						await this.#session.compact(undefined, { internalGuidance: guidance });
						compaction = "ok";
					} catch (error) {
						if (error instanceof CompactionCancelledError) compaction = "cancelled";
						else throw error;
					}
					await beforeFlush(compaction);
				}
			}
		} finally {
			this.#session.clearPlanInternalAbortPending();
		}

		const executionTools = previousTools.includes("read") ? previousTools : [...previousTools, "read"];
		await this.#session.setActiveToolsByName(executionTools);
		this.#session.setPlanReferencePath(approval.planFilePath);
		if (decision.compactBeforeExecute) await this.#applyDeferredModel(compaction, executionModel);
		else await this.#applyExecutionModel(executionModel);

		if (compaction === "cancelled") {
			port.warning?.(
				"Plan approved, but compaction was cancelled — execution not dispatched. Submit a turn to continue.",
			);
			this.#pendingApproval = undefined;
			const result: PlanApprovalResult = {
				approvalId,
				decision: "approve",
				executionDispatched: false,
				planFilePath: approval.planFilePath,
				compaction,
			};
			await this.#settle(result);
			return result;
		}

		const seededName = humanizePlanTitle(approval.title);
		if (seededName && !this.#session.sessionManager.getSessionName()) {
			await this.#session.sessionManager.setSessionName(seededName, "auto");
		}
		const executionPrompt = prompt.render(planModeApprovedPrompt, {
			planFilePath: approval.planFilePath,
			contextPreserved: decision.preserveContext,
		});
		await port.beforeDispatch?.();
		this.#session.markPlanReferenceSent();
		if (this.#session.isStreaming) {
			await this.#session.followUp(executionPrompt, undefined, { synthetic: true });
		} else {
			try {
				await this.#session.prompt(executionPrompt, { synthetic: true });
			} catch (error) {
				if (!(error instanceof AgentBusyError)) throw error;
				await this.#session.followUp(executionPrompt, undefined, { synthetic: true });
			}
		}
		this.#pendingApproval = undefined;
		const result: PlanApprovalResult = {
			approvalId,
			decision: "approve",
			executionDispatched: true,
			planFilePath: approval.planFilePath,
			compaction,
		};
		await this.#settle(result);
		return result;
	}

	/** Default-deny settlement used for disconnect, timeout, and cancellation. */
	async abandonPendingApproval(feedback?: string): Promise<PlanApprovalResult | undefined> {
		const pending = this.#pendingApproval;
		if (!pending) return undefined;
		return this.resolveApproval(pending.approvalId, { kind: "refine", feedback });
	}

	async #prepareApproval(title: string) {
		const result = await this.#session.preparePlanForReview(title);
		if (!result.details) return result;
		const approval = await this.promoteReviewedPlan(result.details);
		for (const listener of this.#approvalListeners) listener(approval);
		return result;
	}

	async #exit(options?: { paused?: boolean; deferModelRestore?: boolean }): Promise<void> {
		if (!this.active) return;
		const state = this.#session.getPlanModeState();
		const planTools = this.#session.getEnabledToolNames();
		const mountedTools = this.#session.getMountedXdevToolNames();
		const planModel = this.#session.model
			? { model: this.#session.model, thinkingLevel: this.#session.configuredThinkingLevel() }
			: undefined;
		this.#session.setPlanModeState(undefined);
		try {
			if (this.#previousTools) await this.#session.setActiveToolsByName(this.#previousTools);
			if (this.#previousModelState && !options?.deferModelRestore) {
				await this.#restoreModel(this.#previousModelState);
			}
			if (this.#previousModelState) this.#clearDeferredPlanModel();
		} catch (error) {
			this.#session.setPlanModeState(state);
			if (
				planModel &&
				(!modelsAreEqual(this.#session.model, planModel.model) ||
					this.#session.configuredThinkingLevel() !== planModel.thinkingLevel)
			) {
				try {
					await this.#restoreModel(planModel);
				} catch (rollbackError) {
					logger.warn("Failed to restore plan model after plan exit failure", { error: String(rollbackError) });
				}
			}
			const enabledTools = this.#session.getEnabledToolNames();
			const currentMountedTools = this.#session.getMountedXdevToolNames();
			if (
				enabledTools.length !== planTools.length ||
				enabledTools.some((name, index) => name !== planTools[index]) ||
				currentMountedTools.length !== mountedTools.length ||
				currentMountedTools.some((name, index) => name !== mountedTools[index])
			) {
				try {
					await this.#session.setActiveToolPresentation(planTools, mountedTools);
				} catch (rollbackError) {
					logger.warn("Failed to restore plan tools after plan exit failure", { error: String(rollbackError) });
				}
			}
			throw error;
		}
		this.#session.setPlanProposalHandler(null);
		this.#previousTools = undefined;
		if (!options?.deferModelRestore) this.#previousModelState = undefined;
		if (!options?.paused) this.#session.sessionManager.appendModeChange("none");
		await this.#emitState();
	}

	async #applyPlanModeModel(): Promise<void> {
		const resolved = this.#session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) return;
		this.#previousModelState = this.#session.model
			? { model: this.#session.model, thinkingLevel: this.#session.configuredThinkingLevel() }
			: undefined;
		await this.#applyPlanModelTransition(this.#session.model, resolved);
	}

	async #applyPlanModelTransition(currentModel: Model | undefined, resolved: ResolvedModelRoleValue): Promise<void> {
		const transition = resolvePlanModelTransition(currentModel, resolved, this.#session.isStreaming);
		if (transition.kind !== "apply" || !transition.deferred) this.#clearDeferredPlanModel();
		if (transition.kind === "thinking") {
			this.#session.setThinkingLevel(transition.thinkingLevel);
		} else if (transition.kind === "apply") {
			if (transition.deferred) {
				this.#deferredModelState = { model: transition.model, thinkingLevel: transition.thinkingLevel };
				this.#deferredPlanModel = true;
			} else {
				await this.#session.setModelTemporary(transition.model, transition.thinkingLevel);
			}
		}
	}

	#clearDeferredPlanModel(): void {
		if (!this.#deferredPlanModel) return;
		this.#deferredModelState = undefined;
		this.#deferredPlanModel = false;
	}

	async #restoreModel(state: ModelState): Promise<void> {
		if (modelsAreEqual(this.#session.model, state.model)) {
			this.#session.setThinkingLevel(state.thinkingLevel);
		} else if (this.#session.isStreaming) {
			this.#deferredModelState = state;
			this.#deferredPlanModel = false;
		} else {
			await this.#session.setModelTemporary(state.model, state.thinkingLevel);
		}
	}

	async #applyDeferredModel(outcome: CompactionOutcome | undefined, executionModel: ResolvedRoleModel | undefined) {
		const previous = this.#previousModelState;
		if (!previous || outcome === "failed") return;
		this.#previousModelState = undefined;
		if (executionModel) await this.#applyExecutionModel(executionModel);
		else await this.#restoreModel(previous);
	}

	async #applyExecutionModel(model: ResolvedRoleModel | undefined): Promise<void> {
		if (model) await this.#session.applyRoleModel(model);
	}

	#resolveExecutionModel(role: string | undefined): ResolvedRoleModel | undefined {
		if (!role) return undefined;
		return this.#session
			.getRoleModelCycle(this.#session.settings.get("cycleOrder"))
			?.models.find(entry => entry.role === role);
	}

	#persist(mode: "plan" | "plan_paused", planFilePath: string, workflow: PlanWorkflow): void {
		this.#session.sessionManager.appendModeChange(mode, { planFilePath, workflow });
	}

	async #emitState(): Promise<void> {
		const projection = await this.project();
		for (const listener of this.#stateListeners) listener(projection);
	}

	async #settle(result: PlanApprovalResult): Promise<void> {
		await this.#emitState();
		for (const listener of this.#settlementListeners) listener(result);
	}

	#localOptions() {
		return {
			getArtifactsDir: () => this.#session.sessionManager.getArtifactsDir(),
			getSessionId: () => this.#session.sessionManager.getSessionId(),
		};
	}

	#localRoot(): string {
		return resolveLocalUrlToPath("local://", this.#localOptions());
	}

	#resolvePlanPath(planFilePath: string): string {
		return planFilePath.startsWith("local:")
			? resolveLocalUrlToPath(planFilePath, this.#localOptions())
			: path.resolve(this.#session.sessionManager.getCwd(), planFilePath);
	}

	#readPlan(planFilePath: string): Promise<string | null> {
		return readPlanFile(planFilePath, {
			localProtocolOptions: this.#localOptions(),
			cwd: this.#session.sessionManager.getCwd(),
		});
	}

	#listPlans(): Promise<string[]> {
		return listPlanFiles({ localProtocolOptions: this.#localOptions() });
	}

	async #copyLocalArtifacts(sourceRoot: string, destinationRoot: string): Promise<void> {
		if (sourceRoot === destinationRoot) return;
		let entries: Dirent[];
		try {
			entries = await fs.readdir(sourceRoot, { withFileTypes: true });
		} catch {
			return;
		}
		await fs.mkdir(destinationRoot, { recursive: true });
		for (const entry of entries) {
			const source = path.join(sourceRoot, entry.name);
			const destination = path.join(destinationRoot, entry.name);
			if (entry.isDirectory()) await fs.cp(source, destination, { recursive: true });
			else if (entry.isFile()) await fs.copyFile(source, destination);
		}
	}
}
