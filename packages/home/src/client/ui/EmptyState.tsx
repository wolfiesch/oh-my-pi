import { Inbox, type LucideIcon } from "lucide-react";

export interface EmptyStateProps {
	message?: string;
	icon?: LucideIcon;
	className?: string;
}

export function EmptyState({ message = "No data available", icon: Icon = Inbox, className = "" }: EmptyStateProps) {
	return (
		<div className={`home-empty-state ${className}`}>
			<Icon size={24} className="home-empty-state-icon" aria-hidden="true" />
			<p className="home-empty-state-message">{message}</p>
		</div>
	);
}
