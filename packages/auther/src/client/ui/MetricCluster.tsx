export interface MetricCardProps {
	label: string;
	value: string | number;
	variant?: "primary" | "secondary";
}

export interface MetricClusterProps {
	cards: MetricCardProps[];
}

export function MetricCluster({ cards }: MetricClusterProps) {
	// Primary cards render in the top 4-up grid; secondary cards in the 6-up grid.
	const primary = cards.filter(c => (c.variant ?? "primary") === "primary");
	const secondary = cards.filter(c => c.variant === "secondary");

	return (
		<div className="home-metric-cluster">
			{primary.length > 0 && (
				<div className="home-metric-primary-grid">
					{primary.map(card => (
						<div key={card.label} className="home-metric-card primary">
							<div className="home-metric-label">{card.label}</div>
							<div className="home-metric-value">{card.value}</div>
						</div>
					))}
				</div>
			)}
			{secondary.length > 0 && (
				<div className="home-metric-secondary-grid">
					{secondary.map(card => (
						<div key={card.label} className="home-metric-card secondary">
							<div className="home-metric-label">{card.label}</div>
							<div className="home-metric-value">{card.value}</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
