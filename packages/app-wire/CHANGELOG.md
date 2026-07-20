# Changelog

## [Unreleased]

### Added

- Add the local-only `project.reveal` desktop command without exposing absolute folder paths to clients.

- Add a bounded, ordered browser preview contract with backend-neutral authority metadata, capture chunking, tab controls, input actions, policy checks, cooperative leases, and human handoff.
- Add the negotiated `transcript.search` feature with strict, bounded host search and session context commands.
- Add the strict, bounded `SessionRef.attention` summary for cross-session pending questions, approvals, plan reviews, and latest root outcomes.

### Changed

- Replace the fork-owned wire implementation with a compatibility export of the checksum-pinned
  T4 host-wire artifact. The active contract now includes bounded backward transcript paging.

## [0.5.10] - 2026-07-18

### Added

- Add strict, redacted provider transport diagnostics to additive live session state for capability-aware desktop clients.

## [0.5.9] - 2026-07-18

### Added

- Add a frozen Agent View lifecycle corpus covering started, running, completed, parked, resumed, and cancelled worker states for cross-client compatibility verification.

## [0.5.8] - 2026-07-16

### Added

- Advertise the additive `session.observer` feature so capability-aware clients can discover observer support.
- Add categorical `SessionRef.liveState.sessionControl` state: `observer` mode carries `lockStatus`
  (`live` | `suspect` | `malformed`) and `transcript` (`live` | `snapshot`); `reconciling` mode carries
  `transcript` (`live` | `snapshot`). Decoding is fail-closed: unknown modes, invalid values, and
  unexpected fields are rejected at the wire boundary.

## [0.5.7] - 2026-07-16

### Fixed

- Publish `usage.read` and `broker.status` in the desktop command catalog so capability-aware clients can discover them.

## [0.5.6] - 2026-07-16

### Added

- Add host-scoped `usage.read` and `broker.status` commands with strict, bounded result decoders.
- Add configured, effective, and resolved Thinking state plus Fast availability and activity to session state.

### Fixed

- Reject secret-bearing broker endpoints, malformed usage reset timestamps, invalid aggregate capacity, and unknown
  semantic session-state fields at the wire boundary.
