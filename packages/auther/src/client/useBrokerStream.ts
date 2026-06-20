/**
 * Live broker state via the device-facing SSE stream.
 *
 * `EventSource` cannot attach an `Authorization` header, so Auther exposes a
 * same-origin `/api/broker/stream` proxy that forwards the dashboard-authenticated
 * request to the device-facing broker. Reconnects use exponential backoff with
 * jitter, mirroring the collab socket.
 */
import type { SnapshotEntry, SnapshotStreamEvent } from "@oh-my-pi/pi-ai";
import { useEffect, useRef, useState } from "react";
import { openBrokerStream } from "./api";

/** Live rotation projection for a single OAuth credential. */
export interface RotationState {
	/** Ms until the broker is projected to rotate this credential, or null. */
	rotatesInMs: number | null;
	/** Broker clock at the time the projection was produced. */
	serverNowMs: number;
	/** Local clock when this projection was received (for countdown drift). */
	receivedAt: number;
	provider: string;
	/** Absolute token expiry (epoch ms), when known. */
	expires: number | null;
}

export interface BrokerStreamState {
	connected: boolean;
	/** Rotation projections keyed by credential row id. */
	rotations: Map<number, RotationState>;
	/** Row id whose state most recently changed — drives the refresh pulse. */
	lastChangedId: number | null;
	/** Local clock of the last change, so equal ids still re-trigger a pulse. */
	lastChangedAt: number;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function backoffDelay(attempt: number): number {
	const capped = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
	const jitter = capped * 0.2 * (Math.random() * 2 - 1);
	return Math.max(RECONNECT_BASE_MS, Math.round(capped + jitter));
}

function rotationFromEntry(entry: SnapshotEntry, serverNowMs: number): RotationState {
	return {
		rotatesInMs: entry.rotatesInMs,
		serverNowMs,
		receivedAt: Date.now(),
		provider: entry.provider,
		expires:
			entry.credential.type === "oauth" && typeof entry.credential.expires === "number"
				? entry.credential.expires
				: null,
	};
}

export function useBrokerStream(): BrokerStreamState {
	const [state, setState] = useState<BrokerStreamState>(() => ({
		connected: false,
		rotations: new Map(),
		lastChangedId: null,
		lastChangedAt: 0,
	}));

	const rotationsRef = useRef<Map<number, RotationState>>(new Map());

	useEffect(() => {
		const abort = new AbortController();
		let attempt = 0;
		let reconnectTimer: TimerHandle | undefined;
		let stopped = false;

		const commit = (changedId: number | null): void => {
			setState({
				connected: true,
				rotations: new Map(rotationsRef.current),
				lastChangedId: changedId,
				lastChangedAt: Date.now(),
			});
		};

		const markDisconnected = (): void => {
			setState(prev => ({ ...prev, connected: false }));
		};

		const handleEvent = (event: SnapshotStreamEvent): void => {
			if (event.kind === "snapshot") {
				rotationsRef.current = new Map();
				for (const entry of event.credentials) {
					rotationsRef.current.set(entry.id, rotationFromEntry(entry, event.serverNowMs));
				}
				commit(null);
				return;
			}
			if (event.kind === "entry") {
				rotationsRef.current.set(event.entry.id, rotationFromEntry(event.entry, event.serverNowMs));
				commit(event.entry.id);
				return;
			}
			rotationsRef.current.delete(event.id);
			commit(event.id);
		};

		const consumeStream = async (): Promise<void> => {
			const response = await openBrokerStream(abort.signal);
			if (!response.ok || !response.body) throw new Error(`Broker stream HTTP ${response.status}`);
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			attempt = 0; // a clean open resets backoff

			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let sep = buffer.indexOf("\n\n");
				while (sep !== -1) {
					const block = buffer.slice(0, sep);
					buffer = buffer.slice(sep + 2);
					const dataLines: string[] = [];
					for (const line of block.split("\n")) {
						if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
					}
					if (dataLines.length > 0) {
						try {
							handleEvent(JSON.parse(dataLines.join("\n")) as SnapshotStreamEvent);
						} catch {
							// Malformed frame; skip and keep reading.
						}
					}
					sep = buffer.indexOf("\n\n");
				}
			}
		};

		const loop = async (): Promise<void> => {
			while (!stopped) {
				try {
					await consumeStream();
				} catch {
					if (stopped) return;
				}
				markDisconnected();
				if (stopped) return;
				const delay = backoffDelay(attempt++);
				const wait = Promise.withResolvers<void>();
				reconnectTimer = setTimeout(wait.resolve, delay);
				await wait.promise;
			}
		};

		void loop();

		return () => {
			stopped = true;
			abort.abort();
			clearTimeout(reconnectTimer);
		};
	}, []);

	return state;
}

/** Shared 1-second tick so countdown rings re-render without per-card timers. */
export function useNowTick(intervalMs = 1_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}

type TimerHandle = number | NodeJS.Timeout;
