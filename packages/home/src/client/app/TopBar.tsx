import { Menu } from "lucide-react";
import { ProfileSwitcher } from "./ProfileSwitcher";
import type { HomeSection } from "./routes";
import { routes } from "./routes";
import { ThemeToggle } from "./ThemeToggle";

export interface TopBarProps {
	activeSection: HomeSection;
	profile: string | null;
	onProfileChange: (profile: string | null) => void;
	onMenuToggle?: () => void;
	className?: string;
}

export function TopBar({ activeSection, profile, onProfileChange, onMenuToggle, className = "" }: TopBarProps) {
	const currentRoute = routes.find(r => r.id === activeSection);
	const title = currentRoute?.label || "Home";

	return (
		<header className={`home-top-bar ${className}`}>
			<div className="home-top-bar-left">
				{onMenuToggle && (
					<button
						type="button"
						onClick={onMenuToggle}
						className="home-mobile-menu-btn"
						aria-label="Open navigation menu"
					>
						<Menu size={20} />
					</button>
				)}
				<h1 className="home-page-title">{title}</h1>
			</div>

			<div className="home-top-bar-right">
				<span
					className="home-top-bar-note"
					title="Edits persist to the selected profile's config; the running agent picks them up on next launch."
				>
					Changes apply on next launch
				</span>
				<ProfileSwitcher profile={profile} onProfileChange={onProfileChange} />
				<ThemeToggle />
			</div>
		</header>
	);
}
