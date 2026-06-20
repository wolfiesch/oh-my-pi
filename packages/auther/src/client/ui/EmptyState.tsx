import { Inbox, type LucideIcon } from "lucide-react";
import type React from "react";

export interface EmptyStateProps {
	message?: string;
	icon?: LucideIcon;
	action?: React.ReactNode;
	className?: string;
}

export function EmptyState({
	message = "No data available",
	icon: Icon = Inbox,
	action,
	className = "",
}: EmptyStateProps) {
	return (
		<div className={`home-empty-state ${className}`}>
			<Icon size={24} className="home-empty-state-icon" aria-hidden="true" />
			<p className="home-empty-state-message">{message}</p>
			{action && <div className="auther-empty-state-action">{action}</div>}
		</div>
	);
}
