import { useEffect } from "react";
import { getProfiles } from "../data/api";
import { useResource } from "../data/useResource";

export interface ProfileSwitcherProps {
	profile: string | null;
	onProfileChange: (profile: string | null) => void;
}

export function ProfileSwitcher({ profile, onProfileChange }: ProfileSwitcherProps) {
	const { data, error } = useResource(["profiles"], getProfiles, {});

	// Auto-select the first available profile once if none is active yet.
	useEffect(() => {
		if (!profile && data?.profiles && data.profiles.length > 0) {
			onProfileChange(data.profiles[0].id);
		}
	}, [profile, data, onProfileChange]);

	if (error) {
		return (
			<span className="home-profile-switcher home-text-muted" title={error.message}>
				Profiles unavailable
			</span>
		);
	}

	const profiles = data?.profiles ?? [];
	if (profiles.length === 0) {
		return <span className="home-profile-switcher home-text-muted">No profiles registered</span>;
	}

	return (
		<select
			className="home-profile-switcher"
			value={profile ?? ""}
			onChange={e => onProfileChange(e.target.value || null)}
			aria-label="Active profile"
		>
			{profiles.map(p => (
				<option key={p.id} value={p.id}>
					{p.label}
				</option>
			))}
		</select>
	);
}
