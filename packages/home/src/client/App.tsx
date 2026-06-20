import { useRef } from "react";
import { AppLayout } from "./app/AppLayout";
import type { HomeSection } from "./app/routes";
import { useHashRoute } from "./data/useHashRoute";
import { AgentsRoute, GeneralRoute, GraphRoute, HomeRoute, ProfilesRoute, ProvidersRoute, RolesRoute } from "./routes";

export default function App() {
	const { section, setSection, profile, setProfile } = useHashRoute();

	const active = section;

	// Keep every visited section mounted and toggle visibility, so revisits are
	// instant and don't replay entry animations. Only the active route fetches
	// (enabled flag), so hidden routes don't keep hitting the API.
	const mountedRef = useRef<Set<HomeSection>>(new Set());
	mountedRef.current.add(active);

	const renderRoute = (target: HomeSection) => {
		const isActive = target === active;
		switch (target) {
			case "home":
				return <HomeRoute active={isActive} profile={profile} />;
			case "graph":
				return (
					<GraphRoute active={isActive} profile={profile} onNavigateProviders={() => setSection("providers")} />
				);
			case "roles":
				return <RolesRoute active={isActive} profile={profile} />;
			case "agents":
				return <AgentsRoute active={isActive} profile={profile} />;
			case "providers":
				return <ProvidersRoute active={isActive} profile={profile} />;
			case "general":
				return <GeneralRoute active={isActive} profile={profile} />;
			case "profiles":
				return <ProfilesRoute active={isActive} profile={profile} />;
		}
	};

	return (
		<AppLayout activeSection={active} onSectionChange={setSection} profile={profile} onProfileChange={setProfile}>
			{[...mountedRef.current].map(target => (
				<div key={target} hidden={target !== active} data-route={target}>
					{renderRoute(target)}
				</div>
			))}
		</AppLayout>
	);
}
