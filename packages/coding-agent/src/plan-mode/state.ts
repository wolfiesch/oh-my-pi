export type SessionPlanMode = "none" | "plan" | "plan_paused";
export type PlanWorkflow = "parallel" | "iterative";

export interface PlanModeState {
	enabled: boolean;
	paused?: boolean;
	planFilePath: string;
	workflow?: PlanWorkflow;
	reentry?: boolean;
}
