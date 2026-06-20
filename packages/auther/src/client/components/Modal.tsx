import { X } from "lucide-react";
import type React from "react";
import { useEffect, useRef } from "react";

export interface ModalProps {
	title: string;
	onClose: () => void;
	children: React.ReactNode;
	footer?: React.ReactNode;
	width?: number;
}

/** Centered modal dialog: Esc closes, overlay click closes, focus on open. */
export function Modal({ title, onClose, children, footer, width = 460 }: ModalProps) {
	const closeRef = useRef<HTMLButtonElement>(null);
	const restoreRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		restoreRef.current = document.activeElement as HTMLElement | null;
		const timer = setTimeout(() => closeRef.current?.focus(), 30);
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("keydown", onKey);
			restoreRef.current?.focus();
		};
	}, [onClose]);

	const onOverlay = (event: React.MouseEvent<HTMLDivElement>): void => {
		if (event.target === event.currentTarget) onClose();
	};

	return (
		<div className="auther-modal-overlay" role="presentation" onClick={onOverlay}>
			<div className="auther-modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
				<div className="auther-modal-header">
					<h2 className="auther-modal-title">{title}</h2>
					<button
						ref={closeRef}
						type="button"
						className="auther-icon-btn home-button home-button-secondary"
						onClick={onClose}
						aria-label="Close dialog"
					>
						<X size={16} />
					</button>
				</div>
				<div className="auther-modal-body">{children}</div>
				{footer && <div className="auther-modal-footer">{footer}</div>}
			</div>
		</div>
	);
}
