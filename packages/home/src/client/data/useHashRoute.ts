import { useCallback, useEffect, useState } from "react";
import type { HomeSection } from "../app/routes";

const VALID_SECTIONS: HomeSection[] = ["home", "graph", "roles", "agents", "providers", "general", "profiles"];

function parseHash(hash: string): { section: HomeSection; profile: string | null } {
	const cleanHash = hash.replace(/^#\/?/, "");
	const [pathPart, queryPart] = cleanHash.split("?");

	const section: HomeSection = (VALID_SECTIONS as string[]).includes(pathPart) ? (pathPart as HomeSection) : "home";

	let profile: string | null = null;
	if (queryPart) {
		const params = new URLSearchParams(queryPart);
		const profileParam = params.get("profile");
		if (profileParam) {
			profile = profileParam;
		}
	}

	return { section, profile };
}

export function useHashRoute() {
	const [route, setRouteState] = useState(() => parseHash(window.location.hash));

	useEffect(() => {
		const handleHashChange = () => {
			setRouteState(parseHash(window.location.hash));
		};

		window.addEventListener("hashchange", handleHashChange);
		return () => {
			window.removeEventListener("hashchange", handleHashChange);
		};
	}, []);

	const writeHash = useCallback((section: HomeSection, profile: string | null) => {
		const query = profile ? `?profile=${encodeURIComponent(profile)}` : "";
		window.location.hash = `/${section}${query}`;
	}, []);

	const setSection = useCallback(
		(newSection: HomeSection) => {
			writeHash(newSection, route.profile);
		},
		[route.profile, writeHash],
	);

	const setProfile = useCallback(
		(newProfile: string | null) => {
			writeHash(route.section, newProfile);
		},
		[route.section, writeHash],
	);

	// Normalize the hash on mount so it always reflects a valid route shape.
	useEffect(() => {
		const currentHash = window.location.hash;
		const parsed = parseHash(currentHash);
		const expectedHash = `#/${parsed.section}${parsed.profile ? `?profile=${encodeURIComponent(parsed.profile)}` : ""}`;
		if (currentHash !== expectedHash) {
			window.location.hash = `/${parsed.section}${parsed.profile ? `?profile=${encodeURIComponent(parsed.profile)}` : ""}`;
		}
	}, []);

	return {
		section: route.section,
		setSection,
		profile: route.profile,
		setProfile,
	};
}
