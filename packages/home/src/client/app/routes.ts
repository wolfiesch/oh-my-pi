import { Boxes, Cpu, GitBranch, KeyRound, LayoutDashboard, Settings, Users } from "lucide-react";
import type React from "react";

export type HomeSection = "home" | "graph" | "roles" | "agents" | "providers" | "general" | "profiles";

export interface HomeRouteEntry {
	id: HomeSection;
	label: string;
	shortLabel?: string;
	icon: React.ComponentType<{ size?: number; className?: string }>;
}

export const routes: HomeRouteEntry[] = [
	{
		id: "home",
		label: "Home",
		icon: LayoutDashboard,
	},
	{
		id: "graph",
		label: "Graph",
		icon: GitBranch,
	},
	{
		id: "roles",
		label: "Roles & Cycle",
		icon: Cpu,
	},
	{
		id: "agents",
		label: "Agents",
		icon: Users,
	},
	{
		id: "providers",
		label: "Providers",
		icon: KeyRound,
	},
	{
		id: "general",
		label: "General",
		icon: Settings,
	},
	{
		id: "profiles",
		label: "Profiles",
		icon: Boxes,
	},
];
