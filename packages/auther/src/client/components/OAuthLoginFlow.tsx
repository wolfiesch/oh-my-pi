import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	cancelOAuthLogin,
	getOAuthProviders,
	getOAuthSession,
	type OAuthProviderInfo,
	type OAuthSessionView,
	startOAuthLogin,
	submitOAuthInput,
} from "../api";
import { Modal } from "./Modal";

export interface OAuthLoginFlowProps {
	/** Pre-selected provider id when re-authenticating an existing credential. */
	initialProvider?: string;
	onClose: () => void;
	onCompleted: () => void;
}

const POLL_INTERVAL_MS = 1_500;

function isTerminal(status: OAuthSessionView["status"]): boolean {
	return status === "done" || status === "error" || status === "cancelled";
}

export function OAuthLoginFlow({ initialProvider, onClose, onCompleted }: OAuthLoginFlowProps) {
	const [providers, setProviders] = useState<OAuthProviderInfo[]>([]);
	const [provider, setProvider] = useState(initialProvider ?? "");
	const [session, setSession] = useState<OAuthSessionView | null>(null);
	const [inputValue, setInputValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const sessionRef = useRef<OAuthSessionView | null>(null);
	sessionRef.current = session;

	useEffect(() => {
		const controller = new AbortController();
		getOAuthProviders(controller.signal)
			.then(list => {
				if (controller.signal.aborted) return;
				setProviders(list);
				if (!initialProvider && list.length > 0) setProvider(list.find(p => p.available)?.id ?? list[0].id);
			})
			.catch(() => undefined);
		return () => controller.abort();
	}, [initialProvider]);

	// Poll the active session until it reaches a terminal state.
	useEffect(() => {
		if (!session || isTerminal(session.status)) return;
		const loginId = session.loginId;
		const timer = setInterval(() => {
			getOAuthSession(loginId)
				.then(next => {
					setSession(next);
					if (next.status === "done") onCompleted();
				})
				.catch(() => undefined);
		}, POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [session, onCompleted]);

	// Cancel a still-running session if the modal unmounts.
	useEffect(() => {
		return () => {
			const current = sessionRef.current;
			if (current && !isTerminal(current.status)) void cancelOAuthLogin(current.loginId).catch(() => undefined);
		};
	}, []);

	const start = async (): Promise<void> => {
		if (!provider) return;
		setBusy(true);
		setError(null);
		try {
			setSession(await startOAuthLogin(provider));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const submit = async (): Promise<void> => {
		if (!session || !inputValue.trim()) return;
		setBusy(true);
		setError(null);
		try {
			setSession(await submitOAuthInput(session.loginId, inputValue.trim()));
			setInputValue("");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const cancel = async (): Promise<void> => {
		if (session && !isTerminal(session.status)) {
			try {
				setSession(await cancelOAuthLogin(session.loginId));
			} catch {
				// Already gone; close anyway.
			}
		}
		onClose();
	};

	return (
		<Modal title={initialProvider ? `Re-authenticate ${initialProvider}` : "Add OAuth account"} onClose={cancel}>
			{!session && (
				<div className="auther-form">
					<label className="auther-field">
						<span className="auther-field-label">Provider</span>
						<select
							className="auther-input"
							value={provider}
							onChange={event => setProvider(event.target.value)}
							disabled={Boolean(initialProvider)}
						>
							{providers.length === 0 && <option value="">Loading…</option>}
							{providers.map(p => (
								<option key={p.id} value={p.id} disabled={!p.available}>
									{p.name}
									{p.available ? "" : " (unavailable)"}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						className="home-button home-button-primary"
						onClick={start}
						disabled={busy || !provider}
					>
						Start login
					</button>
				</div>
			)}

			{session && (
				<div className="auther-login-state">
					<div className="auther-login-status">Status: {session.status.replace(/_/g, " ")}</div>
					{session.progress && <p className="auther-login-progress">{session.progress}</p>}

					{session.status === "awaiting_redirect" && session.authUrl && (
						<a
							className="home-button home-button-primary auther-login-open"
							href={session.authUrl}
							target="_blank"
							rel="noreferrer"
						>
							<ExternalLink size={14} /> Open login page
						</a>
					)}
					{session.instructions && <p className="auther-login-instructions">{session.instructions}</p>}

					{session.status === "awaiting_input" && session.prompt && (
						<div className="auther-form">
							<label className="auther-field">
								<span className="auther-field-label">{session.prompt.message}</span>
								<input
									className="auther-input"
									value={inputValue}
									placeholder={session.prompt.placeholder ?? ""}
									onChange={event => setInputValue(event.target.value)}
									onKeyDown={event => {
										if (event.key === "Enter") void submit();
									}}
								/>
							</label>
							<button
								type="button"
								className="home-button home-button-primary"
								onClick={submit}
								disabled={busy || !inputValue.trim()}
							>
								Submit code
							</button>
						</div>
					)}

					{session.status === "done" && <p className="auther-login-done">Login complete. Credential saved.</p>}
					{(session.status === "error" || session.status === "cancelled") && (
						<p className="auther-card-error">{session.error ?? "Login did not complete."}</p>
					)}
				</div>
			)}

			{error && <p className="auther-card-error">{error}</p>}

			<div className="auther-modal-actions">
				{session && isTerminal(session.status) ? (
					<button type="button" className="home-button home-button-secondary" onClick={onClose}>
						Close
					</button>
				) : (
					<button type="button" className="home-button home-button-secondary" onClick={cancel}>
						Cancel
					</button>
				)}
			</div>
		</Modal>
	);
}
