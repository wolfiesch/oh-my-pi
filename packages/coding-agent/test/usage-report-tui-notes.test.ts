/**
 * Regression coverage for the TUI aggregate path in `command-controller.ts`.
 *
 * Three contracts that the CLI `formatUsageBreakdown` test cannot cover,
 * because the bug lives in the TUI cross-account grouping renderer
 * `renderUsageReports`:
 *
 *  1. Provider-wide `UsageReport.notes` render ONCE above the per-account
 *     sections, not once per account/window.
 *  2. Identical per-limit notes from multiple accounts that fall in the same
 *     `label|windowId` group are de-duplicated.
 *  3. Wide terminals preserve organization suffixes that distinguish accounts
 *     sharing an email address.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { OAuthAccountIdentity } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

const HOUR = 3_600_000;

beforeAll(async () => {
	await initTheme();
});

function makeReport(provider: string, email: string, limits: UsageReport["limits"], notes?: string[]): UsageReport {
	return {
		provider,
		fetchedAt: Date.now(),
		limits,
		...(notes ? { notes } : {}),
		metadata: { email },
	};
}

function makeLimit(
	label: string,
	windowId: string,
	durationMs: number,
	frac: number,
	notes?: string[],
): UsageReport["limits"][number] {
	return {
		id: windowId,
		label,
		scope: { provider: "github-copilot", windowId },
		window: { id: windowId, label, durationMs },
		amount: { unit: "percent", usedFraction: frac },
		status: frac >= 0.8 ? "warning" : "ok",
		...(notes ? { notes } : {}),
	};
}

describe("renderUsageReports (#3268 TUI aggregate)", () => {
	it("renders provider-wide UsageReport.notes exactly once for multiple accounts", () => {
		const disclaimer = "OMP-observed spend only; OpenCode usage outside OMP is not included.";
		const reports: UsageReport[] = [
			makeReport(
				"opencode-go",
				"acct-a@example.test",
				[makeLimit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.3)],
				[disclaimer],
			),
			makeReport(
				"opencode-go",
				"acct-b@example.test",
				[makeLimit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.6)],
				[disclaimer],
			),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		const occurrences = text.split(disclaimer).length - 1;
		expect(occurrences).toBe(1);
	});

	it("deduplicates identical per-limit notes when accounts share one window group", () => {
		// Both accounts report the SAME label+windowId, so their limits land in
		// one aggregate group; both carry an identical per-limit note.
		const note = "Overage requests: 5";
		const reports: UsageReport[] = [
			makeReport("github-copilot", "acct-a@example.test", [
				makeLimit("Copilot", "monthly", 30 * 24 * HOUR, 0.8, [note]),
			]),
			makeReport("github-copilot", "acct-b@example.test", [
				makeLimit("Copilot", "monthly", 30 * 24 * HOUR, 0.9, [note]),
			]),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		const occurrences = text.split(note).length - 1;
		// Deduped: appears once on the group note line. Pre-fix `flatMap(...).join`
		// would bullet-join it twice (one per account in the group).
		expect(occurrences).toBe(1);
	});

	it("preserves organization suffixes when wide account columns can fit them", () => {
		const now = Date.now();
		const accountLimit = () => ({
			...makeLimit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.3),
			window: {
				id: "rolling-5h",
				label: "5 Hour limit",
				durationMs: 5 * HOUR,
				resetsAt: now + 2.5 * HOUR,
			},
		});
		const reports: UsageReport[] = [
			{
				...makeReport("anthropic", "rae@example.com", [accountLimit()]),
				metadata: { email: "rae@example.com", orgId: "team-org", orgName: "Team Org" },
			},
			makeReport("anthropic", "rae@example.com", [accountLimit()]),
		];

		const text = stripVTControlCharacters(renderUsageReports(reports, theme, now, 160));

		expect(text).toContain("rae@example.com (Team Org)");
	});
});

describe("renderUsageReports session marker (#5691 org-qualified identity)", () => {
	it("suffixes the active org so same-email multi-org accounts are tellable apart", () => {
		const email = "dev@example.test";
		const reports: UsageReport[] = [
			makeReport("anthropic", email, [makeLimit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.4)]),
		];
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, provider =>
				provider === "anthropic" ? { email, orgId: "uuid-A", orgName: "Team Org" } : undefined,
			),
		);
		const marker = text.split("\n").find(line => line.includes("in use by this session"));
		expect(marker).toContain(`${email} (Team Org)`);
	});

	it("falls back to the bare base when the active identity carries no org", () => {
		const email = "solo@example.test";
		const reports: UsageReport[] = [
			makeReport("anthropic", email, [makeLimit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.4)]),
		];
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, provider =>
				provider === "anthropic" ? { email } : undefined,
			),
		);
		const marker = text.split("\n").find(line => line.includes("in use by this session"));
		expect(marker).toContain(email);
		expect(marker).not.toContain("(");
	});
});

describe("renderUsageReports account columns", () => {
	function active(email: string): OAuthAccountIdentity {
		return { email };
	}

	it("keeps account columns stable across limit groups", () => {
		// acct-a is alphabetically before acct-b and has the higher fraction in
		// the first group. A fraction-based sort would swap columns between
		// groups; stable ordering must keep acct-a first everywhere.
		const reports: UsageReport[] = [
			makeReport("openai-codex", "acct-a@example.test", [
				makeLimit("5 hours", "5h", 5 * HOUR, 0.9),
				makeLimit("7 days", "7d", 7 * 24 * HOUR, 0.2),
			]),
			makeReport("openai-codex", "acct-b@example.test", [
				makeLimit("5 hours", "5h", 5 * HOUR, 0.3),
				makeLimit("7 days", "7d", 7 * 24 * HOUR, 0.8),
			]),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		const headerIndex = text.indexOf("acct-a@example.test");
		expect(headerIndex).toBeGreaterThan(-1);
		expect(text.indexOf("acct-b@example.test")).toBeGreaterThan(headerIndex);
		// Both percentages for each group must appear.
		expect(text).toContain("90.0% used");
		expect(text).toContain("30.0% used");
		expect(text).toContain("20.0% used");
		expect(text).toContain("80.0% used");
	});

	it("keeps project-scoped reports with the same email in separate columns", () => {
		const reports: UsageReport[] = [
			{
				...makeReport("google-antigravity", "o@example.test", [
					{
						...makeLimit("Tokens", "daily", 24 * HOUR, 0.2),
						scope: { provider: "google-antigravity", projectId: "alpha", windowId: "daily" },
					},
				]),
				metadata: { email: "o@example.test", projectId: "alpha" },
			},
			{
				...makeReport("google-antigravity", "o@example.test", [
					{
						...makeLimit("Tokens", "daily", 24 * HOUR, 0.7),
						scope: { provider: "google-antigravity", projectId: "beta", windowId: "daily" },
					},
				]),
				metadata: { email: "o@example.test", projectId: "beta" },
			},
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		expect(text).toContain("o@example.test (alpha)");
		expect(text).toContain("o@example.test (beta)");
		expect(text).toContain("20.0% used");
		expect(text).toContain("70.0% used");
	});

	it("keeps same-email account-id reports in separate columns", () => {
		const reports: UsageReport[] = [
			{
				...makeReport("openai-codex", "shared@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.2)]),
				metadata: { email: "shared@example.test", accountId: "acct-a" },
			},
			{
				...makeReport("openai-codex", "shared@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.7)]),
				metadata: { email: "shared@example.test", accountId: "acct-b" },
			},
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		expect(text).toContain("20.0% used");
		expect(text).toContain("70.0% used");
	});

	it("suffixes colliding same-email headers with the account id, leaving unique labels bare", () => {
		const reports: UsageReport[] = [
			{
				...makeReport("openai-codex", "shared@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.2)]),
				metadata: { email: "shared@example.test", accountId: "acct-a" },
			},
			{
				...makeReport("openai-codex", "shared@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.7)]),
				metadata: { email: "shared@example.test", accountId: "acct-b" },
			},
			makeReport("openai-codex", "unique@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.4)]),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 200));
		const header = text.split("\n").find(line => line.includes("shared@example.test"));
		// Colliding email labels gain their stable account-id suffix…
		expect(header).toContain("shared@example.test (acct-a)");
		expect(header).toContain("shared@example.test (acct-b)");
		// …while the non-colliding label stays bare.
		expect(header).toContain("unique@example.test");
		expect(header).not.toContain("unique@example.test (");
	});

	it("still disambiguates when the shared email contains one account id as a substring", () => {
		// "abc" is a substring of the shared email; a containment guard would
		// skip its suffix and leave two identical headers.
		const email = "abc@example.test";
		const text = stripVTControlCharacters(
			renderUsageReports(makeCollidingPair(email, "abc", "def"), theme, Date.now(), 200),
		);
		const header = text.split("\n").find(line => line.includes("abc@example.test"));
		expect(header).toContain("abc@example.test (abc)");
		expect(header).toContain("abc@example.test (def)");
	});

	it("keeps colliding headers distinct under narrow columns by truncating the base, not the id suffix", () => {
		const email = "verylongsharedmailbox@example.test";
		const reports: UsageReport[] = [
			{
				...makeReport("openai-codex", email, [makeLimit("5 hours", "5h", 5 * HOUR, 0.2)]),
				metadata: { email, accountId: "acct-a" },
			},
			{
				...makeReport("openai-codex", email, [makeLimit("5 hours", "5h", 5 * HOUR, 0.7)]),
				metadata: { email, accountId: "acct-b" },
			},
		];
		// availableWidth 54 with two accounts → 25-wide columns: the raw email
		// alone (34 cols) would end-truncate past the suffix.
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 54, provider =>
				provider === "openai-codex" ? { email, accountId: "acct-b" } : undefined,
			),
		);
		const lines = text.split("\n");
		const header = lines.find(line => line.includes("(acct-"));
		expect(header).toBeDefined();
		// The distinguishing id tails survive truncation on both columns, and
		// the active marker still fits in front of the truncated base.
		expect(header).toContain("(acct-b)");
		expect(header).toContain("(acct-a)");
		expect(header).toContain("●");
		const first = header!.slice(2, 27);
		const second = header!.slice(28, 53);
		expect(first).not.toBe(second);
		expect(first.trimEnd().length).toBeLessThanOrEqual(25);
		// Bar rows stay aligned to the same 25-column grid.
		const barLine = lines.find(line => /[█▒▓░·]/u.test(line));
		expect(barLine).toBeDefined();
		expect(/[█▒▓░·]/u.test(barLine![2])).toBe(true);
		expect(/[█▒▓░·]/u.test(barLine![28])).toBe(true);
		expect(barLine![27]).toBe(" ");
	});

	it("falls back to shortest-unique id fragments when UUID suffixes exceed the column", () => {
		const email = "verylongsharedmailbox@example.test";
		const idA = "11111111-2222-3333-4444-555555555555";
		const idB = "11111111-2222-3333-4444-555555555556";
		const reports: UsageReport[] = [
			{
				...makeReport("openai-codex", email, [makeLimit("5 hours", "5h", 5 * HOUR, 0.2)]),
				metadata: { email, accountId: idA },
			},
			{
				...makeReport("openai-codex", email, [makeLimit("5 hours", "5h", 5 * HOUR, 0.7)]),
				metadata: { email, accountId: idB },
			},
		];
		// 25-wide columns cannot hold a 36-char UUID suffix; the ids differ
		// only in their tails, so the group falls back to tail fragments.
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 54, provider =>
				provider === "openai-codex" ? { email, accountId: idB } : undefined,
			),
		);
		const lines = text.split("\n");
		const header = lines.find(line => line.includes("(…"));
		expect(header).toBeDefined();
		expect(header).toContain("●");
		const first = header!.slice(2, 27);
		const second = header!.slice(28, 53);
		// Both cells keep a distinguishing fragment, stay distinct, and fit.
		expect(first).not.toBe(second);
		expect(first).toContain("(…");
		expect(second).toContain("(…");
		expect(first.trimEnd().length).toBeLessThanOrEqual(25);
		expect(second.trimEnd().length).toBeLessThanOrEqual(25);
		// Bar offsets are unchanged by the fragment fallback.
		const barLine = lines.find(line => /[█▒▓░·]/u.test(line));
		expect(barLine).toBeDefined();
		expect(/[█▒▓░·]/u.test(barLine![2])).toBe(true);
		expect(/[█▒▓░·]/u.test(barLine![28])).toBe(true);
		expect(barLine![27]).toBe(" ");
	});

	function makeCollidingPair(email: string, idA: string, idB: string): UsageReport[] {
		return [
			{
				...makeReport("openai-codex", email, [makeLimit("5 hours", "5h", 5 * HOUR, 0.2)]),
				metadata: { email, accountId: idA },
			},
			{
				...makeReport("openai-codex", email, [makeLimit("5 hours", "5h", 5 * HOUR, 0.7)]),
				metadata: { email, accountId: idB },
			},
		];
	}

	it("renders complete unique fragments directly in 6-column cells", () => {
		const idA = "11111111-2222-3333-4444-555555555555";
		const idB = "11111111-2222-3333-4444-555555555556";
		// availableWidth 15 with two accounts → 6-wide columns; active marker
		// leaves a 4-column budget, so decorations and base are dropped but
		// the distinguishing fragment must survive whole.
		const text = stripVTControlCharacters(
			renderUsageReports(makeCollidingPair("shared@example.test", idA, idB), theme, Date.now(), 15, provider =>
				provider === "openai-codex" ? { email: "shared@example.test", accountId: idB } : undefined,
			),
		);
		const lines = text.split("\n");
		const header = lines.find(line => line.includes("5555") || line.includes("5556"));
		expect(header).toBeDefined();
		const first = header!.slice(2, 8);
		const second = header!.slice(9, 15);
		expect(first).not.toBe(second);
		// The unique final character survives in both cells.
		expect(first).toContain("5556");
		expect(second).toContain("5555");
		expect(header).toContain("●");
		const barLine = lines.find(line => /[█▒▓░·]/u.test(line));
		expect(barLine).toBeDefined();
		expect(/[█▒▓░·]/u.test(barLine![2])).toBe(true);
		expect(/[█▒▓░·]/u.test(barLine![9])).toBe(true);
		expect(barLine![8]).toBe(" ");
	});

	it("keeps astral-tail fragments whole instead of splitting surrogate pairs", () => {
		// The distinguishing emoji sits before a shared "1111" tail, so any
		// code-unit slicer reaches distinctness only by splitting the pair
		// into identical-looking lone surrogates.
		const idA = "11111111-2222-3333-4444-5555😀1111";
		const idB = "11111111-2222-3333-4444-5555😁1111";
		const text = stripVTControlCharacters(
			renderUsageReports(
				makeCollidingPair("verylongsharedmailbox@example.test", idA, idB),
				theme,
				Date.now(),
				54,
				provider =>
					provider === "openai-codex"
						? { email: "verylongsharedmailbox@example.test", accountId: idB }
						: undefined,
			),
		);
		const header = text.split("\n").find(line => line.includes("(…"));
		expect(header).toBeDefined();
		// Emoji clusters render intact — no lone surrogates / replacement chars.
		expect(header).toContain("😀");
		expect(header).toContain("😁");
		expect(header).not.toContain("\uFFFD");
		const surrogates = /[\uD800-\uDFFF]/;
		expect(surrogates.test(header!.replaceAll("😀", "").replaceAll("😁", ""))).toBe(false);
		const first = header!.slice(2, 27);
		const second = header!.slice(28, 53);
		expect(first).not.toBe(second);
	});

	it("fits double-width fragments by visible columns without cutting the unique tail", () => {
		const idA = "acct-stable-一二三四五";
		const idB = "acct-stable-一二三四六";
		// availableWidth 25 → 11-wide columns: the "…二三四五" tail fragment is
		// 9 visible columns, exactly filling the active cell beside its marker.
		const text = stripVTControlCharacters(
			renderUsageReports(makeCollidingPair("shared@example.test", idA, idB), theme, Date.now(), 25, provider =>
				provider === "openai-codex" ? { email: "shared@example.test", accountId: idB } : undefined,
			),
		);
		const lines = text.split("\n");
		const header = lines.find(line => line.includes("二三四"));
		expect(header).toBeDefined();
		// Both distinguishing CJK tails survive whole.
		expect(header).toContain("二三四五");
		expect(header).toContain("二三四六");
		const barLine = lines.find(line => /[█▒▓░·]/u.test(line));
		expect(barLine).toBeDefined();
		expect(/[█▒▓░·]/u.test(barLine![2])).toBe(true);
		expect(/[█▒▓░·]/u.test(barLine![14])).toBe(true);
		expect(barLine![13]).toBe(" ");
	});

	it("does not falsely distinguish ids whose difference renders identically", () => {
		// Same rendered id: composed é vs e + combining acute. NFC-normalized
		// comparison must treat them as one identity rather than emitting two
		// identical-looking "distinct" fragments.
		const idA = "acct-caf\u00e9-11111111-2222-3333-4444-555555555555";
		const idB = "acct-cafe\u0301-11111111-2222-3333-4444-555555555555";
		const text = stripVTControlCharacters(
			renderUsageReports(makeCollidingPair("verylongsharedmailbox@example.test", idA, idB), theme, Date.now(), 54),
		);
		// Single-class groups render a tail-anchored slice of the shared id.
		const header = text.split("\n").find(line => line.includes("555555"));
		expect(header).toBeDefined();
		// Cells contain no spaces in the bare-fragment tier, so token-split is
		// column-safe even though combining marks skew code-unit offsets.
		const [first, second] = header!.trim().split(/\s+/u);
		expect(second).toBeDefined();
		// No pseudo-distinct fragments: the cells render the same.
		expect(first.normalize("NFC")).toBe(second.normalize("NFC"));
	});

	it("trims unellipsized tail fragments from the front in tiny active cells", () => {
		// Tail-distinct ids of unequal length: "abcd" is short enough to carry
		// no ellipsis, yet its distinguishing edge is still the END. A 4-col
		// active cell (2-col budget beside the marker) must trim it to "cd",
		// not end-truncate it into the sibling's "ab".
		const text = stripVTControlCharacters(
			renderUsageReports(makeCollidingPair("shared@example.test", "ab", "abcd"), theme, Date.now(), 11, provider =>
				provider === "openai-codex" ? { email: "shared@example.test", accountId: "abcd" } : undefined,
			),
		);
		const lines = text.split("\n");
		const header = lines.find(line => line.includes("●"));
		expect(header).toBeDefined();
		const first = header!.slice(2, 6).trimEnd();
		const second = header!.slice(7, 11).trimEnd();
		// Active "abcd" column keeps its tail; sibling keeps its whole id.
		expect(first).toBe("● cd");
		expect(second).toBe("ab");
	});

	it("keeps a tail-distinct third id distinguishable beside an NFC-equivalent pair", () => {
		const email = "verylongsharedmailbox@example.test";
		const composed = "acct-caf\u00e9-11111111-2222-3333-4444-555555555555";
		const decomposed = "acct-cafe\u0301-11111111-2222-3333-4444-555555555555";
		const distinct = "acct-caf\u00e9-11111111-2222-3333-4444-555555555556";
		const reports: UsageReport[] = [
			...makeCollidingPair(email, composed, decomposed),
			{
				...makeReport("openai-codex", email, [makeLimit("5 hours", "5h", 5 * HOUR, 0.4)]),
				metadata: { email, accountId: distinct },
			},
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 80));
		const header = text.split("\n").find(line => line.includes("(…"));
		expect(header).toBeDefined();
		// The render-identical pair shares one fragment; the tail-distinct id
		// still gets its own — the pair must not push the group to maxLength.
		expect(header).toContain("(…5555)");
		expect(header).toContain("(…5556)");
		expect(header!.match(/\(…5555\)/gu)?.length).toBe(2);
	});

	it("renders NFC-equivalent ids identically in bare tier regardless of the active marker", () => {
		// Same rendered identity (composed vs decomposed é); 4-col cells where
		// only one column carries the ● marker. Both cells must fit to the
		// group's shared (tightest) budget so the identity text matches —
		// different trims would falsely imply two different accounts.
		const idA = "acct-caf\u00e9-11111111";
		const idB = "acct-cafe\u0301-11111111";
		const text = stripVTControlCharacters(
			renderUsageReports(makeCollidingPair("shared@example.test", idA, idB), theme, Date.now(), 11, provider =>
				provider === "openai-codex" ? { email: "shared@example.test", accountId: idB } : undefined,
			),
		);
		const lines = text.split("\n");
		const header = lines.find(line => line.includes("●"));
		expect(header).toBeDefined();
		const first = header!.slice(2, 6).trimEnd();
		const second = header!.slice(7, 11).trimEnd();
		// Strip the marker: the identity texts must be equal.
		expect(first.startsWith("● ")).toBe(true);
		expect(first.slice(2)).toBe(second);
		// Bars keep equal widths on the same 4-column grid.
		const barLine = lines.find(line => /[█▒▓░·]/u.test(line));
		expect(barLine).toBeDefined();
		expect(/^[█▒▓░·]+$/u.test(barLine!.slice(2, 6))).toBe(true);
		expect(/^[█▒▓░·]+$/u.test(barLine!.slice(7, 11))).toBe(true);
		expect(barLine![6]).toBe(" ");
	});

	it("assigns per-identity prefix/tail edges so mixed ids stay distinct under the bare budget", () => {
		// One group-wide edge collapses these: prefixes give aaaa/aaaa/Zaaa,
		// tails give aaaX/aaaY/aaaX. Augmenting paths settle on the
		// collision-free aaaX/aaaY/Zaaa deterministically.
		const email = "shared@example.test";
		const reports: UsageReport[] = [
			...makeCollidingPair(email, "aaaaX", "aaaaY"),
			{
				...makeReport("openai-codex", email, [makeLimit("5 hours", "5h", 5 * HOUR, 0.4)]),
				metadata: { email, accountId: "ZaaaaX" },
			},
		];
		// availableWidth 16 with three accounts → 4-col cells.
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 16));
		const lines = text.split("\n");
		const header = lines.find(line => line.includes("aaa"));
		expect(header).toBeDefined();
		const cells = [header!.slice(2, 6).trimEnd(), header!.slice(7, 11).trimEnd(), header!.slice(12, 16).trimEnd()];
		// Deterministic collision-free combination.
		expect(new Set(cells).size).toBe(3);
		expect(cells.sort()).toEqual(["Zaaa", "aaaX", "aaaY"]);
	});

	it("finds mixed edges in large collision groups instead of capping out to uniform tails", () => {
		// 14 identity classes: the aaaaX/aaaaY/ZaaaaX trio still requires a
		// mixed prefix/tail assignment, and the sheer class count must not
		// trigger any fallback that reintroduces the tail collision.
		const email = "shared@example.test";
		const ids = [
			"aaaaX",
			"aaaaY",
			"ZaaaaX",
			...Array.from({ length: 11 }, (_, i) => `filler${String(i).padStart(2, "0")}`),
		];
		const reports: UsageReport[] = ids.map((id, i) => ({
			...makeReport("openai-codex", email, [makeLimit("5 hours", "5h", 5 * HOUR, (i + 1) / 20)]),
			metadata: { email, accountId: id },
		}));
		// availableWidth 71 with 14 accounts → 4-col cells.
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 71));
		const header = text.split("\n").find(line => line.includes("aaa"));
		expect(header).toBeDefined();
		const cells = Array.from({ length: 14 }, (_, i) => header!.slice(2 + i * 5, 6 + i * 5).trimEnd());
		expect(new Set(cells).size).toBe(14);
		// The trio's collision-free mixed assignment survives at scale.
		expect(cells).toContain("aaaX");
		expect(cells).toContain("aaaY");
		expect(cells).toContain("Zaaa");
	});

	it("places the active account first and marks it in the header", () => {
		const reports: UsageReport[] = [
			makeReport("openai-codex", "acct-a@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.5)]),
			makeReport("openai-codex", "acct-b@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.6)]),
		];
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, provider =>
				provider === "openai-codex" ? active("acct-a@example.test") : undefined,
			),
		);
		const activeHeader = text.indexOf("● acct-a@example.test");
		expect(activeHeader).toBeGreaterThan(-1);
		expect(text.indexOf("acct-b@example.test")).toBeGreaterThan(activeHeader);
	});

	it("marks only the exact account active when same-email reports differ by account id", () => {
		const reports: UsageReport[] = [
			{
				...makeReport("openai-codex", "shared@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.2)]),
				metadata: { email: "shared@example.test", accountId: "acct-a" },
			},
			{
				...makeReport("openai-codex", "shared@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.7)]),
				metadata: { email: "shared@example.test", accountId: "acct-b" },
			},
		];
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, provider =>
				provider === "openai-codex" ? { email: "shared@example.test", accountId: "acct-b" } : undefined,
			),
		);
		// Exactly one active marker: acct-a shares the email but has a different
		// account id, so it must not be claimed by the active identity.
		expect(text.match(/●/g)?.length).toBe(1);
		// The exact account (acct-b, 70%) sorts first; the sibling follows.
		expect(text.indexOf("70.0% used")).toBeLessThan(text.indexOf("20.0% used"));
	});

	it("matches saved-reset active markers via snake-case alias ids and reset-only reports", () => {
		const reports: UsageReport[] = [
			{
				...makeReport("openai-codex", "shared@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.2)]),
				metadata: { email: "shared@example.test", account_id: "ACC-A" },
				resetCredits: { availableCount: 1 },
			},
			{
				// Reset-only row: no limits, so matching must fall back to report metadata.
				...makeReport("openai-codex", "shared@example.test", []),
				metadata: { email: "shared@example.test", account_id: "ACC-B" },
				resetCredits: { availableCount: 2 },
			},
		];
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, provider =>
				// Lowercase active id: alias (`account_id`) and case normalization must apply.
				provider === "openai-codex" ? { email: "shared@example.test", accountId: "acc-b" } : undefined,
			),
		);
		const resetLines = text.split("\n").filter(line => line.includes("saved reset"));
		expect(resetLines).toHaveLength(2);
		expect(resetLines.find(line => line.includes("2 saved resets"))).toContain("(active)");
		expect(resetLines.find(line => line.includes("1 saved reset"))).not.toContain("(active)");
	});

	it("treats the active project id as decisive for same-account multi-project reports", () => {
		const email = "dev@example.test";
		const reports: UsageReport[] = [
			{
				...makeReport("google-antigravity", email, [
					{
						...makeLimit("Tokens", "daily", 24 * HOUR, 0.2),
						scope: { provider: "google-antigravity", projectId: "proj-alpha", windowId: "daily" },
					},
				]),
				metadata: { email, accountId: "acct-1", projectId: "proj-alpha" },
				resetCredits: { availableCount: 1 },
			},
			{
				...makeReport("google-antigravity", email, [
					{
						...makeLimit("Tokens", "daily", 24 * HOUR, 0.7),
						scope: { provider: "google-antigravity", projectId: "proj-beta", windowId: "daily" },
					},
				]),
				metadata: { email, accountId: "acct-1", projectId: "proj-beta" },
				resetCredits: { availableCount: 2 },
			},
		];
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, provider =>
				// Same email and account id on both reports: only the project id
				// tells the pools apart, so it must be decisive (uppercase to
				// exercise normalization).
				provider === "google-antigravity" ? { email, accountId: "acct-1", projectId: "PROJ-BETA" } : undefined,
			),
		);
		// Unique marker on the exact project's column, which sorts first.
		expect(text.match(/●/g)?.length).toBe(1);
		expect(text.indexOf("70.0% used")).toBeLessThan(text.indexOf("20.0% used"));
		// Saved-reset marker follows the same project-decisive rules.
		const resetLines = text.split("\n").filter(line => line.includes("saved reset"));
		expect(resetLines).toHaveLength(2);
		expect(resetLines.find(line => line.includes("2 saved resets"))).toContain("(active)");
		expect(resetLines.find(line => line.includes("1 saved reset"))).not.toContain("(active)");
	});

	it("leaves a placeholder when an account has no limit in a group", () => {
		const reports: UsageReport[] = [
			makeReport("openai-codex", "acct-a@example.test", [
				makeLimit("5 hours", "5h", 5 * HOUR, 0.5),
				makeLimit("7 days", "7d", 7 * 24 * HOUR, 0.5),
			]),
			makeReport("openai-codex", "acct-b@example.test", [
				makeLimit("5 hours", "5h", 5 * HOUR, 0.6),
				// No 7-day limit for acct-b.
			]),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		// Both account headers are present.
		expect(text).toContain("acct-a@example.test");
		expect(text).toContain("acct-b@example.test");
		// The 7 days group still has two columns; the missing one renders a placeholder.
		const sevenDaysIndex = text.indexOf("7 days");
		expect(sevenDaysIndex).toBeGreaterThan(-1);
		const segment = text.slice(sevenDaysIndex, sevenDaysIndex + 200);
		expect(segment).toContain("50.0% used");
		expect(segment).toContain("—");
	});

	it("shows exact per-meter percentages and reset times instead of one aggregate", () => {
		const nowMs = Date.now();
		const reports: UsageReport[] = [
			makeReport("openai-codex", "acct-a@example.test", [
				{
					...makeLimit("5 hours", "5h", 5 * HOUR, 0.25),
					window: { id: "5h", label: "5 hours", durationMs: 5 * HOUR, resetsAt: nowMs + HOUR },
				},
			]),
			makeReport("openai-codex", "acct-b@example.test", [
				{
					...makeLimit("5 hours", "5h", 5 * HOUR, 0.75),
					window: { id: "5h", label: "5 hours", durationMs: 5 * HOUR, resetsAt: nowMs + 2 * HOUR },
				},
			]),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, nowMs, 120));
		// Each meter reports its own exact percentage; no averaged "free" text.
		expect(text).toContain("25.0% used");
		expect(text).toContain("75.0% used");
		expect(text).not.toMatch(/\d+% free/);
		// Reset times are shown per meter.
		expect(text).toContain("1h");
		expect(text).toContain("2h");
	});

	it("keeps same-email organization reports in separate columns", () => {
		const reports: UsageReport[] = [
			{
				...makeReport("anthropic", "shared@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.2)]),
				metadata: { email: "shared@example.test", accountId: "shared-id", orgId: "org-a", orgName: "Org A" },
			},
			{
				...makeReport("anthropic", "shared@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.7)]),
				metadata: { email: "shared@example.test", accountId: "shared-id", orgId: "org-b", orgName: "Org B" },
			},
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		expect(text).toContain("shared@example.test (Org A)");
		expect(text).toContain("shared@example.test (Org B)");
		expect(text).toContain("20.0% used");
		expect(text).toContain("70.0% used");
	});

	it("uses a stable per-report fallback when account metadata collides", () => {
		const reports: UsageReport[] = [
			makeReport("openai-codex", "shared@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.2)]),
			makeReport("openai-codex", "shared@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.7)]),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		expect(text.match(/shared@example\.test/g)?.length).toBe(2);
		expect(text).toContain("20.0% used");
		expect(text).toContain("70.0% used");
	});

	it("uses real report indexes for deterministic fallback labels", () => {
		const reports: UsageReport[] = [
			makeReport("openai-codex", "", [makeLimit("5 hours", "5h", 5 * HOUR, 0.2)]),
			makeReport("openai-codex", "", [makeLimit("5 hours", "5h", 5 * HOUR, 0.7)]),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		const header = text.split("\n").find(line => line.includes("account 1"));
		expect(header).toContain("account 1");
		expect(header).toContain("account 2");
		expect(text).toContain("20.0% used");
		expect(text).toContain("70.0% used");
	});

	it("caps wide meter bars while keeping them aligned with account columns", () => {
		const reports: UsageReport[] = [
			makeReport("openai-codex", "alpha@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.5)]),
			makeReport("openai-codex", "beta@example.test", [makeLimit("5 hours", "5h", 5 * HOUR, 0.6)]),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 200));
		const lines = text.split("\n");
		const headerLine = lines.find(line => line.includes("alpha@example.test"));
		const barLine = lines.find(line => /[█▒▓░·]/u.test(line));
		if (!headerLine || !barLine) throw new Error("expected usage header and bar lines");
		const barRuns = [...barLine.matchAll(/[█▒▓░·]+/gu)];
		expect(barRuns.map(match => match[0].length)).toEqual([24, 24]);
		expect(barRuns.map(match => match.index)).toEqual([
			headerLine.indexOf("alpha@example.test"),
			headerLine.indexOf("beta@example.test"),
		]);
	});
});
