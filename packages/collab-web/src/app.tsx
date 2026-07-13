import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { Banners } from "./components/shell/Banners";
import { Composer } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { HeaderBar } from "./components/shell/HeaderBar";
import { Toasts } from "./components/shell/Toasts";
import { Transcript } from "./components/transcript/Transcript";
import { type ConnectionPhase, GuestClient } from "./lib/client";
import { useGuestSnapshot } from "./lib/use-guest";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

const NAME_KEY = "omp.collab.name";
const LAST_LINK_KEY = "omp.collab.lastLink";
const CURRENT_ROOM_PATH = "/current-room.json";
const AUTO_RECOVERY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000] as const;

interface BeforeInstallPromptChoice {
	outcome: "accepted" | "dismissed";
	platform: string;
}

interface BeforeInstallPromptEvent extends Event {
	readonly platforms: string[];
	readonly userChoice: Promise<BeforeInstallPromptChoice>;
	prompt(): Promise<void>;
}

interface PwaInstallState {
	available: boolean;
	standalone: boolean;
	prompt(): void;
}

interface Creds {
	link: string;
	name: string;
}

interface CurrentRoomFile {
	link?: unknown;
}

function storedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "guest";
	} catch {
		return "guest";
	}
}

function storedLastLink(): string | null {
	try {
		const value = localStorage.getItem(LAST_LINK_KEY)?.trim();
		return value ? value : null;
	} catch {
		return null;
	}
}

function currentRoomLinkOf(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const link = (value as CurrentRoomFile).link;
	return typeof link === "string" && link.trim() ? link.trim() : null;
}

async function fetchCurrentRoomLink(signal: AbortSignal): Promise<string | null> {
	try {
		const response = await fetch(CURRENT_ROOM_PATH, { cache: "no-store", signal });
		if (!response.ok) return null;
		return currentRoomLinkOf(await response.json());
	} catch {
		return null;
	}
}

function onClientEndsBeforeLive(client: GuestClient, listener: () => void): () => void {
	let done = false;
	let unsubscribe = (): void => {};
	const check = (): void => {
		if (done) return;
		const phase = client.getSnapshot().phase;
		if (phase === "live") {
			done = true;
			unsubscribe();
			return;
		}
		if (phase === "ended") {
			done = true;
			unsubscribe();
			listener();
		}
	};
	unsubscribe = client.subscribe(check);
	check();
	return () => {
		done = true;
		unsubscribe();
	};
}

function isStandaloneDisplay(): boolean {
	const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
	return window.matchMedia("(display-mode: standalone)").matches || navigatorWithStandalone.standalone === true;
}

/** Deep link = everything after the FIRST `#` (legacy links carry a second `#` inside the fragment). */
function hashLink(): string | null {
	const href = window.location.href;
	const i = href.indexOf("#");
	if (i < 0 || i + 1 >= href.length) return null;
	return href.slice(i + 1);
}

function usePwaInstall(): PwaInstallState {
	const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
	const [standalone, setStandalone] = useState(() => isStandaloneDisplay());

	useEffect(() => {
		const onBeforeInstallPrompt = (event: Event): void => {
			event.preventDefault();
			setDeferredPrompt(event as BeforeInstallPromptEvent);
		};
		const onAppInstalled = (): void => {
			setDeferredPrompt(null);
			setStandalone(true);
		};
		const media = window.matchMedia("(display-mode: standalone)");
		const onDisplayModeChange = (): void => setStandalone(isStandaloneDisplay());

		window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
		window.addEventListener("appinstalled", onAppInstalled);
		media.addEventListener("change", onDisplayModeChange);
		return () => {
			window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
			window.removeEventListener("appinstalled", onAppInstalled);
			media.removeEventListener("change", onDisplayModeChange);
		};
	}, []);

	const prompt = useCallback((): void => {
		const event = deferredPrompt;
		if (!event) return;
		setDeferredPrompt(null);
		event.prompt().catch(() => {
			// Browser rejected the prompt; the normal browser menu install path remains available.
		});
		event.userChoice.then(() => setStandalone(isStandaloneDisplay())).catch(() => {});
	}, [deferredPrompt]);

	return { available: deferredPrompt !== null && !standalone, standalone, prompt };
}

export function App(): ReactNode {
	const [client, setClient] = useState<GuestClient | null>(null);
	const [clientPhase, setClientPhase] = useState<ConnectionPhase | null>(null);
	const [connectError, setConnectError] = useState<string | null>(null);
	const [autoReconnecting, setAutoReconnecting] = useState(false);
	const clientRef = useRef<GuestClient | null>(null);
	const connectAttemptRef = useRef(0);
	const credsRef = useRef<Creds | null>(null);
	const explicitLeaveRef = useRef(false);
	const rejoinAbortRef = useRef<AbortController | null>(null);
	const install = usePwaInstall();
	useEffect(() => {
		if ("serviceWorker" in navigator) {
			void navigator.serviceWorker.register("/sw.js").catch(() => {});
		}
	}, []);

	const connect = useCallback((link: string, name: string): GuestClient | null => {
		rejoinAbortRef.current?.abort();
		rejoinAbortRef.current = null;
		explicitLeaveRef.current = false;
		setAutoReconnecting(false);
		connectAttemptRef.current += 1;
		let next: GuestClient;
		try {
			next = new GuestClient(link, name);
		} catch (err) {
			setConnectError(err instanceof Error ? err.message : String(err));
			return null;
		}
		next.connect();
		try {
			localStorage.setItem(NAME_KEY, name);
			localStorage.setItem(LAST_LINK_KEY, link);
		} catch {
			// storage unavailable (private mode) — non-fatal
		}
		credsRef.current = { link, name };
		clientRef.current = next;
		window.location.hash = link;
		setConnectError(null);
		setClient(prev => {
			prev?.close();
			return next;
		});
		return next;
	}, []);

	const leave = useCallback((): void => {
		explicitLeaveRef.current = true;
		rejoinAbortRef.current?.abort();
		rejoinAbortRef.current = null;
		connectAttemptRef.current += 1;
		setAutoReconnecting(false);
		setClientPhase(null);
		clientRef.current = null;
		setClient(prev => {
			prev?.close();
			return null;
		});
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}, []);

	const rejoin = useCallback(async (): Promise<void> => {
		rejoinAbortRef.current?.abort();
		const abort = new AbortController();
		rejoinAbortRef.current = abort;
		const expectedClient = clientRef.current;
		const expectedAttempt = connectAttemptRef.current;
		const name = credsRef.current?.name ?? storedName();

		const liveLink = await fetchCurrentRoomLink(abort.signal);
		if (rejoinAbortRef.current === abort) rejoinAbortRef.current = null;
		if (abort.signal.aborted || clientRef.current !== expectedClient || connectAttemptRef.current !== expectedAttempt)
			return;

		const link = liveLink ?? credsRef.current?.link ?? storedLastLink();
		if (link) connect(link, name);
	}, [connect]);

	useEffect(() => {
		return () => {
			rejoinAbortRef.current?.abort();
		};
	}, []);

	useEffect(() => {
		if (!client) {
			setClientPhase(null);
			return;
		}
		const updatePhase = (): void => {
			setClientPhase(client.getSnapshot().phase);
		};
		updatePhase();
		return client.subscribe(updatePhase);
	}, [client]);

	useEffect(() => {
		if (!client || clientPhase !== "ended" || client.getSnapshot().phase !== "ended" || explicitLeaveRef.current) {
			setAutoReconnecting(false);
			return;
		}

		const expectedClient = client;
		const expectedAttempt = connectAttemptRef.current;
		const deadLink = (credsRef.current?.link ?? storedLastLink())?.trim() ?? null;
		const name = credsRef.current?.name ?? storedName();
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let abort: AbortController | null = null;
		let delayIndex = 0;

		const stale = (): boolean =>
			cancelled ||
			explicitLeaveRef.current ||
			clientRef.current !== expectedClient ||
			connectAttemptRef.current !== expectedAttempt;

		async function poll(): Promise<void> {
			if (stale()) return;
			abort = new AbortController();
			const link = await fetchCurrentRoomLink(abort.signal);
			abort = null;
			if (stale()) return;
			if (link && link !== deadLink) {
				connect(link, name);
				return;
			}
			scheduleNext();
		}

		function scheduleNext(): void {
			if (stale()) return;
			const delay = AUTO_RECOVERY_DELAYS_MS[Math.min(delayIndex, AUTO_RECOVERY_DELAYS_MS.length - 1)];
			delayIndex += 1;
			timer = setTimeout(() => {
				timer = null;
				void poll();
			}, delay);
		}

		setAutoReconnecting(true);
		scheduleNext();

		return () => {
			cancelled = true;
			if (timer !== null) clearTimeout(timer);
			abort?.abort();
			setAutoReconnecting(false);
		};
	}, [client, clientPhase, connect]);

	// Visual Viewport: adjust app height to fit screen space when mobile keyboard opens.
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const updateHeight = () => {
			document.documentElement.style.setProperty("--viewport-height", `${vv.height}px`);
			window.scrollTo(0, 0);
		};

		updateHeight();
		vv.addEventListener("resize", updateHeight);
		vv.addEventListener("scroll", updateHeight);

		return () => {
			vv.removeEventListener("resize", updateHeight);
			vv.removeEventListener("scroll", updateHeight);
		};
	}, []);

	// Deep link: a page load with a hash auto-connects. Installed/standalone launches
	// start at `/`, so use the last successful collab link first. If that cached
	// room is gone, ask the same-origin Sentry bridge for the current room.
	useEffect(() => {
		const name = storedName();
		const initialHashLink = hashLink();
		const initialAttempt = connectAttemptRef.current;
		if (initialHashLink) {
			connect(initialHashLink, name);
			return;
		}

		const abort = new AbortController();
		let cancelled = false;
		let stopWatchingStored: (() => void) | undefined;

		const connectCurrentRoom = async (expectedClient: GuestClient | null, expectedAttempt: number): Promise<void> => {
			const link = await fetchCurrentRoomLink(abort.signal);
			if (cancelled || clientRef.current !== expectedClient || connectAttemptRef.current !== expectedAttempt) return;
			if (link) {
				connect(link, name);
				return;
			}
			if (expectedClient) {
				clientRef.current = null;
				setClient(prev => {
					if (prev !== expectedClient) return prev;
					prev.close();
					return null;
				});
				history.replaceState(null, "", window.location.pathname + window.location.search);
			}
		};

		const stored = storedLastLink();
		if (!stored) {
			void connectCurrentRoom(null, initialAttempt);
			return () => {
				cancelled = true;
				abort.abort();
			};
		}

		const storedClient = connect(stored, name);
		if (!storedClient) {
			void connectCurrentRoom(null, connectAttemptRef.current);
			return () => {
				cancelled = true;
				abort.abort();
			};
		}

		const storedAttempt = connectAttemptRef.current;

		stopWatchingStored = onClientEndsBeforeLive(storedClient, () => {
			void connectCurrentRoom(storedClient, storedAttempt);
		});
		return () => {
			cancelled = true;
			abort.abort();
			stopWatchingStored?.();
		};
	}, [connect]);

	useEffect(() => {
		if (!client) document.title = "omp collab";
	}, [client]);

	if (!client) {
		return (
			<ConnectScreen
				defaultLink={storedLastLink() ?? ""}
				defaultName={storedName()}
				error={connectError}
				installAvailable={install.available}
				onConnect={connect}
				onInstall={install.prompt}
			/>
		);
	}
	return (
		<Session
			client={client}
			autoReconnecting={autoReconnecting}
			installAvailable={install.available}
			onInstall={install.prompt}
			onLeave={leave}
			onRejoin={rejoin}
		/>
	);
}

interface SessionProps {
	client: GuestClient;
	autoReconnecting: boolean;
	installAvailable: boolean;
	onInstall(): void;
	onLeave(): void;
	onRejoin(): void;
}

function Session({
	client,
	autoReconnecting,
	installAvailable,
	onInstall,
	onLeave,
	onRejoin,
}: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds],
	);

	// Auto-open the rail the first time a subagent appears.
	useEffect(() => {
		if (subCount > 0 && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			setRailOpen(true);
		}
	}, [subCount]);

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		document.title = `${title} · omp collab`;
	}, [title]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;

	return (
		<div className="sh-app">
			<HeaderBar
				snapshot={snap}
				subCount={subCount}
				railOpen={railOpen}
				installAvailable={installAvailable}
				onInstall={onInstall}
				onToggleRail={() => setRailOpen(open => !open)}
				onLeave={onLeave}
			/>
			<main className="sh-main">
				<section className="sh-content" data-rail={railOpen ? "true" : "false"}>
					<div className="sh-transcript">
						<Transcript
							entries={snap.entries}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							host={toolHost}
						/>
					</div>
				</section>
				{railOpen && (
					<>
						<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
						<aside className="sh-rail">
							<AgentsPanel
								agents={snap.agents}
								progress={snap.progress}
								lifecycle={snap.lifecycle}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						</aside>
					</>
				)}
			</main>
			<Composer client={client} snapshot={snap} />
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={() => setSelectedId(null)} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						client={client}
						readOnly={snap.readOnly}
						host={toolHost}
						onClose={() => setSelectedId(null)}
					/>
				</>
			)}
			<Banners
				phase={snap.phase}
				endedReason={snap.endedReason}
				autoReconnecting={autoReconnecting}
				onRejoin={onRejoin}
				onNewLink={onLeave}
			/>
			<Toasts notices={snap.notices} />
		</div>
	);
}
