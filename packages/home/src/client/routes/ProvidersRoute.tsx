import { useState } from "react";
import type { AuthOriginKind, MaskedCredential, ProviderAuthEntry, ProviderTestResult } from "../../api-types";
import { addProviderCredential, deleteProviderCredential, getProviders, testProviderEndpoint } from "../data/api";
import { useResource } from "../data/useResource";
import { AsyncBoundary, Panel, StatusPill } from "../ui";

export interface ProvidersRouteProps {
	active: boolean;
	profile: string | null;
}

const ORIGIN_VARIANT: Record<AuthOriginKind, "success" | "warning" | "default"> = {
	oauth: "success",
	api_key: "success",
	config: "success",
	runtime: "success",
	env: "warning",
	fallback: "default",
	none: "default",
};

const ORIGIN_LABEL: Record<AuthOriginKind, string> = {
	oauth: "OAuth",
	api_key: "API Key",
	config: "Config",
	runtime: "Runtime",
	env: "Env",
	fallback: "Fallback",
	none: "None",
};

function ProviderCard({
	provider,
	profileId,
	onMutated,
}: {
	provider: ProviderAuthEntry;
	profileId: string;
	onMutated: () => void;
}) {
	const [newKey, setNewKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [testResults, setTestResults] = useState<ProviderTestResult[] | null>(null);
	const [testing, setTesting] = useState(false);

	async function handleAdd() {
		const key = newKey.trim();
		if (!key) return;
		setBusy(true);
		setError(null);
		try {
			await addProviderCredential(profileId, provider.provider, key);
			setNewKey("");
			onMutated();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	async function handleDelete(credId: number) {
		setBusy(true);
		setError(null);
		try {
			await deleteProviderCredential(profileId, provider.provider, credId);
			onMutated();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	async function handleTest() {
		setTesting(true);
		setError(null);
		setTestResults(null);
		try {
			const { results } = await testProviderEndpoint(profileId, provider.provider);
			setTestResults(results);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setTesting(false);
		}
	}

	return (
		<div className="home-provider-card">
			<div className="home-provider-card-header">
				<div className="home-provider-card-title">
					<span className="home-provider-name">{provider.provider}</span>
					<StatusPill variant={ORIGIN_VARIANT[provider.originKind]}>
						{ORIGIN_LABEL[provider.originKind]}
					</StatusPill>
				</div>
				<div className="home-provider-card-meta">
					<span className="home-text-muted home-text-xs">{provider.defaultModel || "—"}</span>
					{provider.envVar && (
						<code className="home-provider-env home-text-xs home-text-muted">{provider.envVar}</code>
					)}
				</div>
			</div>

			{error && <div className="home-provider-error">{error}</div>}

			<div className="home-provider-credentials">
				<div className="home-provider-credentials-label">Credentials ({provider.accounts.length})</div>
				{provider.accounts.length === 0 ? (
					<div className="home-provider-no-creds home-text-muted home-text-xs">No stored credentials.</div>
				) : (
					<div className="home-provider-cred-list">
						{provider.accounts.map((cred: MaskedCredential) => (
							<div key={cred.id} className="home-provider-cred-row">
								<div className="home-provider-cred-info">
									<StatusPill variant={cred.type === "oauth" ? "info" : "default"}>
										{cred.type === "oauth" ? "OAuth" : "API Key"}
									</StatusPill>
									<span className="home-provider-cred-id home-text-xs">
										{cred.email ?? cred.masked ?? cred.accountId ?? `#${cred.id}`}
									</span>
									{cred.disabledCause && (
										<span className="home-provider-cred-disabled home-text-xs">{cred.disabledCause}</span>
									)}
									{testResults && <TestPill result={testResults.find(r => r.id === cred.id)} />}
								</div>
								<button
									type="button"
									className="home-icon-btn"
									onClick={() => handleDelete(cred.id)}
									disabled={busy}
									aria-label={`Delete credential ${cred.id}`}
									title="Delete credential"
								>
									×
								</button>
							</div>
						))}
					</div>
				)}
			</div>

			<div className="home-provider-actions">
				<div className="home-provider-add-key">
					<input
						className="home-input"
						type="password"
						value={newKey}
						onChange={e => setNewKey(e.target.value)}
						placeholder="API key"
						disabled={busy}
					/>
					<button
						type="button"
						className="home-button home-button-secondary"
						onClick={() => void handleAdd()}
						disabled={busy || !newKey.trim()}
					>
						Add API key
					</button>
				</div>
				<button
					type="button"
					className="home-button home-button-secondary"
					onClick={() => void handleTest()}
					disabled={testing || provider.accounts.length === 0}
				>
					{testing ? "Testing…" : "Test"}
				</button>
			</div>

			{provider.originKind === "none" && (
				<div className="home-provider-hint home-text-xs home-text-muted">
					No auth configured. Add an API key above, or run <code>omp</code> then{" "}
					<code>/login {provider.provider}</code> for OAuth.
				</div>
			)}
		</div>
	);
}

function TestPill({ result }: { result: ProviderTestResult | undefined }) {
	if (!result) return null;
	if (result.ok === null) {
		return <StatusPill variant="default">Testing…</StatusPill>;
	}
	return (
		<span title={result.reason ?? undefined}>
			<StatusPill variant={result.ok ? "success" : "danger"}>{result.ok ? "OK" : "Failed"}</StatusPill>
		</span>
	);
}

export function ProvidersRoute({ active, profile }: ProvidersRouteProps) {
	const enabled = active && !!profile;
	const { data, error, loading, refetch } = useResource(
		["providers", profile ?? ""],
		signal => getProviders(profile!, signal),
		{ enabled },
	);

	const providers = data?.providers ?? [];

	return (
		<AsyncBoundary loading={loading} error={error} data={data} onRetry={() => void refetch()}>
			<Panel
				title="Providers & Auth"
				subtitle="Per-provider auth source, stored credentials (masked), and health checks. Secrets never leave the server."
			>
				{providers.length === 0 ? (
					<div className="home-table-empty">No providers configured for this profile.</div>
				) : (
					<div className="home-provider-grid">
						{providers.map(p => (
							<ProviderCard
								key={p.provider}
								provider={p}
								profileId={profile!}
								onMutated={() => void refetch()}
							/>
						))}
					</div>
				)}
			</Panel>
		</AsyncBoundary>
	);
}
