# @oh-my-pi/omp-auther

Auther is a branded **web control-plane for the existing `omp auth-broker`** — not a
reimplementation of it. The broker's machinery (holding refresh tokens, background
refresh, vending credentials over the wire, multi-account, remote login) already ships
in `@oh-my-pi/pi-ai`. Auther runs that same broker in-process and adds the surface it
lacks: a dashboard of every credential with provider logos, live subscription usage
meters, `$` spend for pay-as-you-go keys (OpenRouter/OpenAI), and a web/Tailscale
re-auth flow so a dead OAuth login can be fixed from any device's browser.

A single `omp-auther` process opens the broker's `AuthStorage` once and serves both:

- the **device-facing broker API** (`/v1`) via `startAuthBroker(...)`, and
- the **dashboard** (`/api/*` + static SPA).

## Run

```bash
bun run src/index.ts --port 3849 --broker-bind 127.0.0.1:8765
```

| Surface             | Default            | Flag             |
| ------------------- | ------------------ | ---------------- |
| Dashboard           | `127.0.0.1:3849`   | `--port`         |
| Auth-broker (`/v1`) | `127.0.0.1:8765`   | `--broker-bind`  |

The dashboard binds to `127.0.0.1`; reach it from other devices over Tailscale.

## Supersedes a standalone broker

`omp-auther` **replaces a standalone `omp auth-broker serve`** on the host: it hosts the
broker in-process so a single process owns the broker SQLite. Running both at once would
have two processes writing one SQLite file — don't. Device consumers are unaffected; they
still point `OMP_AUTH_BROKER_URL` at the same `:8765`.

## Data directories

Paths are **profile-aware**: Auther resolves them from the active OMP config root
(`getConfigRootDir()` / `getAgentDbPath()`), which honors `PI_CONFIG_DIR` / `OMP_PROFILE`.
With the default profile this is `~/.omp`; under a named profile (e.g.
`omp-giga-personal`) it is that profile's config root. Canonical names:

| File                | Purpose                                                      |
| ------------------- | ----------------------------------------------------------- |
| `agent/agent.db`    | Broker credential store (the shared `AuthStorage`)          |
| `auther-meta.db`    | Auther presentation metadata sidecar (display name, brand, tags, category) |
| `auther.token`      | Bearer token gating the dashboard `/api/*`                   |
| `auth-broker.token` | Bearer token gating the device-facing broker `/v1`          |

Tokens are created on first run (mode `0600`).

## Device wiring

Point a consumer at the broker over Tailscale with the broker token:

```bash
OMP_AUTH_BROKER_URL=http://<tailscale>:8765 \
OMP_AUTH_BROKER_TOKEN="$(cat <config-root>/auth-broker.token)" \
omp auth-broker status
```

`<tailscale>` is the host's Tailscale name/IP; `<config-root>` is the active profile's
config root (where `auth-broker.token` lives).

## Security

Local + Tailscale only. Every endpoint is **bearer-gated** (`/v1/healthz` and
`/api/health` excepted). Credentials are stored **plaintext at rest**, matching the broker
store (which is already plaintext) — transport security is the operator's job (loopback
bind + Tailscale).

## License

MIT
