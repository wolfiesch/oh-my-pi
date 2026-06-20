# Changelog

## [Unreleased]

### Added

- Initial Auther package: a branded web dashboard and control-plane for the existing `omp auth-broker`. A single process opens the broker's `AuthStorage`, hosts the device-facing broker API (`/v1`) in-process, and serves the dashboard (`/api/*` + static SPA) with per-credential provider logos, live subscription usage meters, `$` spend for OpenRouter/OpenAI keys, credential reveal/refresh, and a web/Tailscale OAuth re-authentication flow.
