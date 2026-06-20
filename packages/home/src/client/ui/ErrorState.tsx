export interface ErrorStateProps {
	error?: Error | null;
	onRetry?: () => void;
	className?: string;
}

export function ErrorState({ error, onRetry, className = "" }: ErrorStateProps) {
	return (
		<div className={`home-error-state ${className}`}>
			<div className="home-error-state-content">
				<h4 className="home-error-state-title">Failed to load data</h4>
				{error && <p className="home-error-state-message">{error.message}</p>}
				{onRetry && (
					<button
						type="button"
						onClick={onRetry}
						className="home-button home-button-secondary home-error-state-btn"
					>
						Retry
					</button>
				)}
			</div>
		</div>
	);
}
