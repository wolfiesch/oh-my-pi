import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BrokerInfo } from "../api";

export interface DevicesPopoverProps {
	broker: BrokerInfo | null;
	onClose: () => void;
}

function redactToken(token: string): string {
	if (token.length <= 12) return "••••••••";
	return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export function DevicesPopover({ broker, onClose }: DevicesPopoverProps) {
	const [copied, setCopied] = useState<"url" | "token" | null>(null);
	const ref = useRef<HTMLDivElement>(null);
	const resetRef = useRef<number>(0);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		const onDown = (event: MouseEvent): void => {
			if (ref.current && !ref.current.contains(event.target as Node)) onClose();
		};
		window.addEventListener("keydown", onKey);
		// Defer so the opening click doesn't immediately close the popover.
		const timer = setTimeout(() => window.addEventListener("mousedown", onDown), 0);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("mousedown", onDown);
			window.clearTimeout(resetRef.current);
		};
	}, [onClose]);

	const copy = async (field: "url" | "token", value: string): Promise<void> => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(field);
			window.clearTimeout(resetRef.current);
			resetRef.current = window.setTimeout(() => setCopied(null), 1500);
		} catch {
			// Clipboard unavailable; ignore.
		}
	};

	return (
		<div ref={ref} className="auther-popover" role="dialog" aria-label="Device connection details">
			<h3 className="auther-popover-title">Devices connect here</h3>
			<p className="auther-popover-hint">
				Point consumers at this broker with <code>OMP_AUTH_BROKER_URL</code> and <code>OMP_AUTH_BROKER_TOKEN</code>.
			</p>

			{!broker ? (
				<p className="auther-meter-empty">Broker info unavailable.</p>
			) : (
				<>
					<div className="auther-popover-field">
						<span className="auther-popover-label">Broker URL</span>
						<div className="auther-popover-value">
							<code>{broker.url}</code>
							<button
								type="button"
								className="home-json-copy-btn"
								onClick={() => copy("url", broker.url)}
								aria-label="Copy broker URL"
							>
								{copied === "url" ? <Check size={12} /> : <Copy size={12} />}
							</button>
						</div>
					</div>

					<div className="auther-popover-field">
						<span className="auther-popover-label">Broker token {broker.tokenPresent ? "" : "(missing)"}</span>
						<div className="auther-popover-value">
							<code>{broker.token ? redactToken(broker.token) : "—"}</code>
							{broker.token && (
								<button
									type="button"
									className="home-json-copy-btn"
									onClick={() => copy("token", broker.token)}
									aria-label="Copy broker token"
								>
									{copied === "token" ? <Check size={12} /> : <Copy size={12} />}
								</button>
							)}
						</div>
					</div>

					{broker.refresher && (
						<p className="auther-popover-hint">
							Refresher {broker.refresher.enabled ? "active" : "idle"} · sweep every{" "}
							{Math.round(broker.refresher.intervalMs / 1000)}s
						</p>
					)}
				</>
			)}
		</div>
	);
}
