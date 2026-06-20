import { KeyRound, Plus, Radio, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type AutherEntry,
	type AutherEntryCategory,
	deleteEntry as deleteEntryApi,
	getBroker,
	getEntries,
	getUsage,
	refreshEntry,
} from "./api";
import { AddEditEntryModal } from "./components/AddEditEntryModal";
import { CredentialCard } from "./components/CredentialCard";
import { CredentialDrawer } from "./components/CredentialDrawer";
import { DevicesPopover } from "./components/DevicesPopover";
import { OAuthLoginFlow } from "./components/OAuthLoginFlow";
import { ThemeToggle } from "./components/ThemeToggle";
import { AsyncBoundary, EmptyState, SegmentedControl, Skeleton } from "./ui";
import { useBrokerStream, useNowTick } from "./useBrokerStream";
import { useResource } from "./useResource";

type CategoryFilter = "all" | AutherEntryCategory;

const CATEGORY_OPTIONS: Array<{ value: CategoryFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "metered", label: "Metered" },
	{ value: "meterable_unconfigured", label: "Meterable" },
	{ value: "not_applicable", label: "No metering" },
];

const PULSE_WINDOW_MS = 1_600;

interface EditState {
	mode: "add" | "edit";
	entry?: AutherEntry;
}

export default function App() {
	const entriesRes = useResource<AutherEntry[]>(["entries"], getEntries, { pollMs: 15_000 });
	const usageRes = useResource(["usage"], getUsage, { pollMs: 60_000 });
	const brokerRes = useResource(["broker"], getBroker, { pollMs: 60_000 });
	const stream = useBrokerStream();
	const now = useNowTick();

	const [category, setCategory] = useState<CategoryFilter>("all");
	const [providerFilter, setProviderFilter] = useState("all");
	const [tagFilter, setTagFilter] = useState("all");
	const [search, setSearch] = useState("");
	const [edit, setEdit] = useState<EditState | null>(null);
	const [oauthProvider, setOauthProvider] = useState<string | null>(null);
	const [oauthOpen, setOauthOpen] = useState(false);
	const [drawerId, setDrawerId] = useState<number | null>(null);
	const [devicesOpen, setDevicesOpen] = useState(false);
	const [refreshingIds, setRefreshingIds] = useState<ReadonlySet<number>>(new Set());

	const searchRef = useRef<HTMLInputElement>(null);

	const entries = useMemo(() => entriesRes.data ?? [], [entriesRes.data]);
	const reports = usageRes.data?.reports ?? [];

	const providers = useMemo(() => {
		const set = new Set<string>();
		for (const entry of entries) set.add(entry.provider);
		return [...set].sort();
	}, [entries]);

	const tags = useMemo(() => {
		const set = new Set<string>();
		for (const entry of entries) for (const tag of entry.tags) set.add(tag);
		return [...set].sort();
	}, [entries]);

	const filtered = useMemo(() => {
		const query = search.trim().toLowerCase();
		return entries.filter(entry => {
			if (category !== "all" && entry.category !== category) return false;
			if (providerFilter !== "all" && entry.provider !== providerFilter) return false;
			if (tagFilter !== "all" && !entry.tags.includes(tagFilter)) return false;
			if (query) {
				const haystack =
					`${entry.displayName} ${entry.provider} ${entry.email ?? ""} ${entry.tags.join(" ")}`.toLowerCase();
				if (!haystack.includes(query)) return false;
			}
			return true;
		});
	}, [entries, category, providerFilter, tagFilter, search]);

	const anyOverlay = edit !== null || oauthOpen || drawerId !== null;

	// `/` focuses search; Esc clears search when no overlay owns the key.
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			const target = event.target as HTMLElement | null;
			const typing = target ? /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) : false;
			if (event.key === "/" && !typing && !anyOverlay) {
				event.preventDefault();
				searchRef.current?.focus();
			} else if (event.key === "Escape" && !anyOverlay && !devicesOpen && search) {
				setSearch("");
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [anyOverlay, devicesOpen, search]);

	const reloadEntries = useCallback(() => {
		void entriesRes.refetch();
		void usageRes.refetch();
	}, [entriesRes, usageRes]);

	const setRefreshing = useCallback((id: number, active: boolean) => {
		setRefreshingIds(prev => {
			const next = new Set(prev);
			if (active) next.add(id);
			else next.delete(id);
			return next;
		});
	}, []);

	const handleRefresh = useCallback(
		async (entry: AutherEntry) => {
			setRefreshing(entry.id, true);
			try {
				const result = await refreshEntry(entry.id);
				if (result.status === "reauth_required") {
					setOauthProvider(entry.provider);
					setOauthOpen(true);
				}
			} finally {
				setRefreshing(entry.id, false);
				reloadEntries();
			}
		},
		[reloadEntries, setRefreshing],
	);

	const handleReauth = useCallback((entry: AutherEntry) => {
		setOauthProvider(entry.provider);
		setOauthOpen(true);
	}, []);

	const handleDelete = useCallback(
		async (entry: AutherEntry) => {
			await deleteEntryApi(entry.id);
			setDrawerId(null);
			reloadEntries();
		},
		[reloadEntries],
	);

	const drawerEntry = drawerId === null ? null : (entries.find(entry => entry.id === drawerId) ?? null);

	return (
		<div className="auther-shell">
			<header className="auther-header">
				<div className="home-logo-container">
					<span className="home-logo-text">OH MY PI</span>
					<span className="home-logo-subtext">Auther</span>
				</div>
				<div className="auther-header-actions">
					<span className="auther-stream-status" data-connected={stream.connected}>
						<Radio size={13} />
						{stream.connected ? "Live" : "Polling"}
					</span>
					<div className="auther-devices-wrap">
						<button
							type="button"
							className="home-button home-button-secondary"
							onClick={() => setDevicesOpen(open => !open)}
							aria-expanded={devicesOpen}
						>
							<ShieldCheck size={14} /> Devices
						</button>
						{devicesOpen && <DevicesPopover broker={brokerRes.data} onClose={() => setDevicesOpen(false)} />}
					</div>
					<button
						type="button"
						className="home-button home-button-primary"
						onClick={() => setEdit({ mode: "add" })}
					>
						<Plus size={14} /> Add credential
					</button>
					<ThemeToggle />
				</div>
			</header>

			<div className="auther-filters">
				<SegmentedControl options={CATEGORY_OPTIONS} value={category} onChange={setCategory} />
				<div className="auther-filter-controls">
					<select
						className="auther-input auther-filter-select"
						value={providerFilter}
						onChange={event => setProviderFilter(event.target.value)}
						aria-label="Filter by provider"
					>
						<option value="all">All providers</option>
						{providers.map(provider => (
							<option key={provider} value={provider}>
								{provider}
							</option>
						))}
					</select>
					{tags.length > 0 && (
						<select
							className="auther-input auther-filter-select"
							value={tagFilter}
							onChange={event => setTagFilter(event.target.value)}
							aria-label="Filter by tag"
						>
							<option value="all">All tags</option>
							{tags.map(tag => (
								<option key={tag} value={tag}>
									{tag}
								</option>
							))}
						</select>
					)}
					<input
						ref={searchRef}
						className="auther-input auther-search"
						value={search}
						placeholder="Search  ( / )"
						onChange={event => setSearch(event.target.value)}
						aria-label="Search credentials"
					/>
				</div>
			</div>

			<main className="auther-main">
				<AsyncBoundary
					loading={entriesRes.loading}
					error={entriesRes.error}
					data={entriesRes.data}
					empty={entries.length === 0}
					onRetry={() => void entriesRes.refetch()}
					fallback={
						<div className="auther-grid">
							{[0, 1, 2, 3].map(index => (
								<Skeleton key={index} variant="rect" width="100%" height={220} />
							))}
						</div>
					}
					emptyText="No credentials yet. Add one to get started."
				>
					{filtered.length === 0 ? (
						<EmptyState icon={KeyRound} message="No credentials match the current filters." />
					) : (
						<div className="auther-grid">
							{filtered.map(entry => (
								<CredentialCard
									key={entry.id}
									entry={entry}
									reports={reports}
									rotation={stream.rotations.get(entry.id)}
									pulse={stream.lastChangedId === entry.id && now - stream.lastChangedAt < PULSE_WINDOW_MS}
									now={now}
									refreshing={refreshingIds.has(entry.id)}
									onActivate={target => setDrawerId(target.id)}
									onRefresh={handleRefresh}
									onReauth={handleReauth}
								/>
							))}
						</div>
					)}
				</AsyncBoundary>
			</main>

			{drawerEntry && (
				<CredentialDrawer
					entry={drawerEntry}
					refreshing={refreshingIds.has(drawerEntry.id)}
					onClose={() => setDrawerId(null)}
					onRefresh={handleRefresh}
					onDelete={handleDelete}
					onEdit={target => {
						setDrawerId(null);
						setEdit({ mode: "edit", entry: target });
					}}
					onReauth={handleReauth}
				/>
			)}

			{edit && (
				<AddEditEntryModal
					entry={edit.mode === "edit" ? edit.entry : undefined}
					onClose={() => setEdit(null)}
					onSaved={() => {
						setEdit(null);
						reloadEntries();
					}}
					onSwitchToOAuth={() => {
						setEdit(null);
						setOauthProvider(null);
						setOauthOpen(true);
					}}
				/>
			)}

			{oauthOpen && (
				<OAuthLoginFlow
					initialProvider={oauthProvider ?? undefined}
					onClose={() => setOauthOpen(false)}
					onCompleted={reloadEntries}
				/>
			)}
		</div>
	);
}
