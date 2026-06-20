import type { AutherEntry, AutherEntryCategory } from "./api";

export type StatusVariant = "success" | "danger" | "warning" | "info" | "default";

export interface EntryStatus {
	variant: StatusVariant;
	label: string;
}

/** Derive the credential health badge (active / expired / disabled). */
export function entryStatus(entry: AutherEntry): EntryStatus {
	if (entry.disabledCause) return { variant: "danger", label: "Disabled" };
	if (entry.isOAuth && entry.expires !== null && entry.expires <= Date.now()) {
		return { variant: "warning", label: "Re-auth needed" };
	}
	if (!entry.hasSecret) return { variant: "warning", label: "No secret" };
	return { variant: "success", label: "Active" };
}

const CATEGORY_LABEL: Record<AutherEntryCategory, string> = {
	metered: "Metered",
	meterable_unconfigured: "Meterable",
	not_applicable: "No metering",
};

const CATEGORY_VARIANT: Record<AutherEntryCategory, StatusVariant> = {
	metered: "info",
	meterable_unconfigured: "default",
	not_applicable: "default",
};

export function categoryLabel(category: AutherEntryCategory): string {
	return CATEGORY_LABEL[category];
}

export function categoryVariant(category: AutherEntryCategory): StatusVariant {
	return CATEGORY_VARIANT[category];
}

/** Short identity line for multi-account display (email > account > project). */
export function entryIdentity(entry: AutherEntry): string | null {
	return entry.email ?? entry.accountId ?? entry.projectId ?? entry.enterpriseUrl ?? null;
}
