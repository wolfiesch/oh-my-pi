import { formatCountdown } from "../format";

export interface CountdownRingProps {
	/** Total ms remaining at the reference point. */
	totalMs: number;
	/** Ms remaining right now. */
	remainingMs: number;
	size?: number;
	label?: string;
}

/** Depleting SVG ring used for OAuth rotation/expiry countdowns. */
export function CountdownRing({ totalMs, remainingMs, size = 44, label = "until rotation" }: CountdownRingProps) {
	const stroke = 4;
	const radius = (size - stroke) / 2;
	const circumference = 2 * Math.PI * radius;
	const fraction = totalMs > 0 ? Math.min(1, Math.max(0, remainingMs / totalMs)) : 0;
	const dashOffset = circumference * (1 - fraction);
	const variant = remainingMs <= 0 ? "danger" : fraction < 0.15 ? "warning" : "success";

	return (
		<div className="auther-ring" title={`${formatCountdown(Math.max(0, remainingMs))} ${label}`}>
			<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="auther-ring-svg">
				<circle
					cx={size / 2}
					cy={size / 2}
					r={radius}
					className="auther-ring-track"
					strokeWidth={stroke}
					fill="none"
				/>
				<circle
					cx={size / 2}
					cy={size / 2}
					r={radius}
					className="auther-ring-fill"
					data-variant={variant}
					strokeWidth={stroke}
					fill="none"
					strokeLinecap="round"
					strokeDasharray={circumference}
					strokeDashoffset={dashOffset}
					transform={`rotate(-90 ${size / 2} ${size / 2})`}
				/>
			</svg>
			<span className="auther-ring-text">{formatCountdown(Math.max(0, remainingMs))}</span>
		</div>
	);
}
