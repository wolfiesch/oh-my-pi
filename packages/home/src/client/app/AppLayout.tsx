import { X } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { NavRail } from "./NavRail";
import type { HomeSection } from "./routes";
import { TopBar } from "./TopBar";

export interface AppLayoutProps {
	activeSection: HomeSection;
	onSectionChange: (section: HomeSection) => void;
	profile: string | null;
	onProfileChange: (profile: string | null) => void;
	children: React.ReactNode;
}

export function AppLayout({ activeSection, onSectionChange, profile, onProfileChange, children }: AppLayoutProps) {
	const [menuOpen, setMenuOpen] = useState(false);

	const handleSectionChange = (section: HomeSection) => {
		onSectionChange(section);
		setMenuOpen(false);
	};

	return (
		<div className="home-app-container">
			{/* Desktop Rail */}
			<NavRail activeSection={activeSection} onSectionChange={handleSectionChange} className="home-desktop-nav" />

			{/* Mobile Nav Drawer */}
			{menuOpen && (
				<div className="home-mobile-drawer-overlay" onClick={() => setMenuOpen(false)} role="presentation">
					<div
						className="home-mobile-drawer"
						onClick={e => e.stopPropagation()}
						role="dialog"
						aria-modal="true"
						aria-label="Navigation menu"
					>
						<div className="home-mobile-drawer-header">
							<div className="home-logo-container">
								<span className="home-logo-text">OH MY PI</span>
								<span className="home-logo-subtext">Home</span>
							</div>
							<button
								type="button"
								onClick={() => setMenuOpen(false)}
								className="home-theme-toggle"
								aria-label="Close navigation menu"
							>
								<X size={18} />
							</button>
						</div>
						<NavRail
							activeSection={activeSection}
							onSectionChange={handleSectionChange}
							className="home-mobile-nav"
						/>
					</div>
				</div>
			)}

			{/* Main Layout Pane */}
			<div className="home-main-pane">
				<TopBar
					activeSection={activeSection}
					profile={profile}
					onProfileChange={onProfileChange}
					onMenuToggle={() => setMenuOpen(true)}
				/>

				<main className="home-content-area">
					<div className="home-content-inner">{children}</div>
				</main>
			</div>
		</div>
	);
}
