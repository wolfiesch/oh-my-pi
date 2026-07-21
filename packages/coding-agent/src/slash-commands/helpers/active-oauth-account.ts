import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import type { OAuthAccountIdentity } from "../../session/auth-storage";

function normalizeIdentityValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

/**
 * Session marker label for an active OAuth identity: the base identifier
 * (email → accountId → projectId) suffixed with the organization when present
 * and distinct. Same-email Anthropic multi-org accounts share the base, so the
 * org suffix is the only field that tells the session's quota pool apart —
 * mirrors the account-list rows (`formatUsageReportAccount`) and login success.
 * Returns `undefined` when no identifier is recoverable.
 */
export function formatActiveAccountLabel(identity: OAuthAccountIdentity | undefined): string | undefined {
	if (!identity) return undefined;
	const base = identity.email || identity.accountId || identity.projectId;
	if (!base) return undefined;
	const org = identity.orgName || identity.orgId;
	return org && org !== base ? `${base} (${org})` : base;
}

/**
 * True when a single usage-limit column belongs to the given OAuth identity.
 *
 * Single definition of the matching rules for both `/usage` renderers:
 * - `orgId`     ↔ report metadata `orgId` — a GATE that QUALIFIES the base
 *   identity, never a replacement for it. Mismatched org presence or
 *   different orgs never match: two subscriptions (orgs) can share one
 *   email, so an org-scoped identity matches only its own org's reports and
 *   an org-less legacy identity never claims an org-attributed report via
 *   the shared email. A SHARED org still requires the base-identity match
 *   below — Anthropic Team seats have per-user pools yet share the org id
 *   in report metadata. Only an org-only identity (no base identifiers
 *   recovered at all) matches on the org alone. When neither side carries
 *   an org, the base fallback applies unchanged (providers without orgs
 *   keep their former behavior).
 * - `projectId` ↔ report metadata `projectId` or `limit.scope.projectId`
 *   (Google-style providers key usage on the GCP project, not an account id).
 *   DECISIVE when both sides expose one, and checked BEFORE account/email:
 *   one account spans many projects with per-project pools, so a report
 *   attributed to a different project never matches via the shared
 *   account id or email.
 * - `accountId` ↔ report metadata `accountId`/`account_id` or `limit.scope.accountId`.
 *   DECISIVE when both sides expose one: a report that carries a different
 *   account id is a sibling workspace's pool, so it never falls through to
 *   the shared-email check (same email ≠ same quota pool).
 * - `email`     ↔ report metadata `email`
 *
 * `limit` is absent for report-level checks (e.g. reset-credit-only rows),
 * in which case only report metadata participates.
 */
export function limitMatchesActiveAccount(
	report: UsageReport,
	limit: UsageLimit | undefined,
	identity: OAuthAccountIdentity | undefined,
): boolean {
	if (!identity) return false;
	const metadata = report.metadata ?? {};
	const activeAccountId = normalizeIdentityValue(identity.accountId);
	const activeEmail = normalizeIdentityValue(identity.email);
	const activeProjectId = normalizeIdentityValue(identity.projectId);
	const activeOrgId = normalizeIdentityValue(identity.orgId);
	const reportOrgId = normalizeIdentityValue(metadata.orgId);
	// Org gate (see doc comment above): different/mismatched-presence orgs
	// never match; a shared org falls through to the base checks unless the
	// identity is org-only.
	if (activeOrgId || reportOrgId) {
		if (activeOrgId !== reportOrgId) return false;
		if (!activeAccountId && !activeEmail && !activeProjectId) return true;
	}
	if (activeProjectId) {
		const reportProjectIds = [
			normalizeIdentityValue(metadata.projectId),
			normalizeIdentityValue(limit?.scope.projectId),
		].filter((value): value is string => value !== undefined);
		if (reportProjectIds.length > 0) return reportProjectIds.includes(activeProjectId);
	}
	if (activeAccountId) {
		const reportAccountIds = [
			normalizeIdentityValue(metadata.accountId),
			normalizeIdentityValue(metadata.account_id),
			normalizeIdentityValue(limit?.scope.accountId),
		].filter((value): value is string => value !== undefined);
		if (reportAccountIds.length > 0) return reportAccountIds.includes(activeAccountId);
	}
	if (activeEmail && normalizeIdentityValue(metadata.email) === activeEmail) return true;
	return false;
}

/** True when any limit column in `report` belongs to the given OAuth identity. */
export function reportMatchesActiveAccount(report: UsageReport, identity: OAuthAccountIdentity | undefined): boolean {
	if (!identity) return false;
	return report.limits.some(limit => limitMatchesActiveAccount(report, limit, identity));
}
