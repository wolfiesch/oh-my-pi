# Changelog

## [Unreleased]

## [0.5.6] - 2026-07-16

### Added

- Add host-scoped `usage.read` and `broker.status` commands with strict, bounded result decoders.
- Add configured, effective, and resolved Thinking state plus Fast availability and activity to session state.

### Fixed

- Reject secret-bearing broker endpoints, malformed usage reset timestamps, invalid aggregate capacity, and unknown
  semantic session-state fields at the wire boundary.
