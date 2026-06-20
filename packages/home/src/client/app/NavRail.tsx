import { type HomeSection, routes } from "./routes";

export interface NavRailProps {
	activeSection: HomeSection;
	onSectionChange: (section: HomeSection) => void;
	className?: string;
}

export function NavRail({ activeSection, onSectionChange, className = "" }: NavRailProps) {
	return (
		<aside className={`home-nav-rail ${className}`}>
			<div className="home-nav-rail-header">
				<div className="home-logo-container">
					<span className="home-logo-text">OH MY PI</span>
					<span className="home-logo-subtext">Home</span>
				</div>
			</div>

			<nav className="home-nav-rail-menu">
				{routes.map(route => {
					const isActive = route.id === activeSection;
					const Icon = route.icon;
					return (
						<button
							key={route.id}
							type="button"
							onClick={() => onSectionChange(route.id)}
							className="home-nav-rail-item"
							data-active={isActive ? "true" : "false"}
							aria-current={isActive ? "page" : undefined}
						>
							<Icon size={16} className="home-nav-rail-item-icon" />
							<span className="home-nav-rail-item-label">{route.label}</span>
						</button>
					);
				})}
			</nav>

			<div className="home-nav-rail-footer">
				<span className="home-version-tag">OMP Home v0.1.0</span>
			</div>
		</aside>
	);
}
