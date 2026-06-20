# Design

## Product

OMP Home is a local profile hub, routing graph, launcher, and settings surface for Oh My Pi.

## Design System

- Register: product UI.
- Visual language: shared OMP tokens from `packages/collab-web/src/styles/tokens.css` and the current Home CSS variables.
- Default scene: an expert operator at a workstation switching between local OMP profiles. Dark mode is the primary cockpit; light mode must be first-class for system preference and screenshots.
- Density: compact, scannable, data-first. Avoid marketing-page spacing and hero-metric clichés.

## Color

Preserve these token roles and values unless the shared OMP system changes upstream:

- `--page`: deep purple page surface in dark mode; near-white tinted surface in light mode.
- `--surface`, `--surface-2`: panel and elevated layers.
- `--text`, `--muted`, `--dim`: primary, secondary, and tertiary text.
- `--accent`: OMP pink for primary actions and selected state.
- `--link`: OMP cyan for focus, links, and graph highlights.
- `--success`, `--danger`, `--warning`: semantic status only.

The graph may derive low-alpha tints from these tokens, but it must not introduce a second brand palette.

## Typography

Use the existing product UI system font stack. Keep labels and data readable at density. Headings are fixed-size product headings, not fluid marketing display type. Prefer weight, spacing, and proximity over decorative typography.

## Layout

- Shell: persistent nav rail/top bar, responsive collapse, profile context always visible.
- Home: profile summary, KPIs, and launcher tiles with process state and exact ports.
- Graph: full-frame canvas workspace with overlay controls, minimap, search, legend, and inspector.
- Editors: preserve current table/form flows, but improve hierarchy, loading, empty, error, and focus states.

## Components

- Buttons: consistent filled/quiet/destructive states with hover, focus-visible, disabled, and busy treatment.
- Panels: radius ≤ 12px, one clear border or surface contrast; no decorative wide shadow plus border ghost-card pattern.
- Status pills: semantic color, compact copy, no full-saturation inactive states.
- Tool tiles: operational cards only; must show Running/Stopped/Unavailable plus Launch/Open/Stop affordances.
- Graph inspector: side panel with node facts and edit-through controls using existing config mutation semantics.

## Motion

Motion is 150–250ms and state-driven: hover highlight, graph transform easing, inspector reveal, tile status change. Respect `prefers-reduced-motion: reduce` with instant transforms or simple opacity changes. Content must be visible without waiting for animation.

## Accessibility

All interactive controls are keyboard reachable with visible focus. Canvas graph has keyboard pan/zoom/fit and a DOM-backed node list or equivalent screen-reader path. Color is never the only signal for provider auth, disabled agents, running processes, or unsaved edits.

## Absolute Bans

No gradient text, side-stripe accent cards, decorative glassmorphism, over-rounded cards, identical icon-heading-text grids as a default structure, decorative page-load choreography, or invented form controls where native semantics work.
