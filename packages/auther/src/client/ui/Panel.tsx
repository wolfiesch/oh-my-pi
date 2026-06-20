import type React from "react";

export interface PanelProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
	title?: React.ReactNode;
	subtitle?: React.ReactNode;
	actions?: React.ReactNode;
}

export function Panel({ title, subtitle, actions, children, className = "", ...props }: PanelProps) {
	return (
		<div className={`home-panel ${className}`} {...props}>
			{(title || subtitle || actions) && (
				<div className="home-panel-header">
					<div className="home-panel-header-titles">
						{title && <h3 className="home-panel-title">{title}</h3>}
						{subtitle && <p className="home-panel-subtitle">{subtitle}</p>}
					</div>
					{actions && <div className="home-panel-actions">{actions}</div>}
				</div>
			)}
			<div className="home-panel-body">{children}</div>
		</div>
	);
}
