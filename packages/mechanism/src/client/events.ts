// Wire contract the client binds to. This is a transport format produced by the
// server normalizer; the client deliberately keeps its own copy so the browser
// bundle never pulls in any server-side module. Keep in sync with
// `src/normalize.ts` (the package's exported `MechEvent`).

export type AgentStatus = "running" | "idle" | "parked" | "aborted";

export interface MechAgent {
	id: string;
	parentId: string | null;
	model: string;
	family: string;
	status: AgentStatus;
	depth: number;
	label: string;
}

export type MechEvent =
	| { t: "roster"; agents: MechAgent[] }
	| { t: "spawn"; agent: MechAgent }
	| { t: "status"; id: string; status: AgentStatus }
	| { t: "tool"; id: string; tool: string; phase: "start" | "update" | "end" }
	| { t: "irc"; from: string; to: string }
	| { t: "usage"; model: string; costUsd: number; tokensIn: number; tokensOut: number };
