# @oh-my-pi/omp-home

Profile-aware OMP Home web UI for routing, tool launchers, agents, providers, and profiles.

## Features

- **Home hub**: profile KPIs plus launch/open/stop tiles for stats, collab, and robomp.
- **Routing graph**: full-frame canvas DAG with pan/zoom/fit/reset, minimap, search, filters, legend, keyboard controls, DOM node list, and role/agent edit-through inspector.
- **Profile switcher**: discovers and selects registered OMP profile agent directories.
- **Roles & cycle editor**: edits `modelRoles` and `cycleOrder` with an unsaved-changes tray and comment-preserving YAML writes.
- **General settings editor**: renders schema-driven controls for booleans, numbers, enums, strings, string arrays, and records.
- **Provider auth management**: lists masked credentials, adds API keys, deletes stored credentials, and runs provider credential checks.

## Usage

```bash
# Start OMP Home through the OMP CLI (default: http://localhost:4878)
omp home

# Package binary entrypoint
omp-home

# Custom port
omp home --port 4881

# Start without opening a browser
omp home --no-open
```

The server binds to `127.0.0.1` only.

## API Endpoints

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Health check |
| `GET /api/profiles` | Registered/discovered profiles |
| `POST /api/profiles` | Add a profile by path |
| `DELETE /api/profiles/:id` | Remove a profile from the registry only |
| `GET /api/profiles/:id/config` | Resolved config + schema metadata |
| `PUT /api/profiles/:id/config` | Apply config edits to `config.yml` |
| `GET /api/profiles/:id/agents` | Bundled/user/project agent roster |
| `GET /api/profiles/:id/providers` | Provider auth summary with masked credentials |
| `POST /api/profiles/:id/providers/:provider/credentials` | Add API-key credential |
| `DELETE /api/profiles/:id/providers/:provider/credentials/:credentialId` | Delete credential |
| `POST /api/profiles/:id/providers/:provider/test` | Test stored provider credentials |
| `GET /api/profiles/:id/graph` | Routing graph nodes and edges |
| `GET /api/catalog/models` | Catalog model picker data |
| `GET /api/theme-colors` | Theme color enum values |
| `GET /api/tools?profile=:id` | Companion tool launcher status |
| `POST /api/tools/:tool/launch` | Spawn a companion tool process |
| `POST /api/tools/:tool/stop` | Stop a launched companion tool process |

## Safety

- Config writes validate all edits before applying any edit.
- YAML comments are preserved through `yaml` document edits.
- Provider secrets are never returned to the client; stored keys are masked.
- Removing a profile only removes the registry entry. It never deletes files.

## License

MIT
