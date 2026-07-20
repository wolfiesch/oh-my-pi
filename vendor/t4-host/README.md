# T4 host artifacts

These immutable package archives contain the generic T4 host and wire implementation. OMP keeps
only the launcher and the authority code that understands OMP sessions, locks, workers, settings,
models, credentials, and native events.

The exact T4 source commit, tree, package versions, filenames, and SHA-256 hashes are recorded in
`manifest.json`. Regenerate both archives together from that exact source with `pnpm pack`; never
edit an archive in place.
