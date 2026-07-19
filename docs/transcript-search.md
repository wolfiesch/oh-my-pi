# Transcript search

The appserver can expose bounded cross-session transcript search to clients that negotiate the
`transcript.search` feature and already hold `sessions.read`.

## Data flow

```text
profile session JSONL files
          |
          v
private rebuildable SQLite FTS index
          |
          +-- transcript.search  (host-wide result snippets)
          +-- transcript.context (one read-only window around an entry)
```

Each OMP profile owns its own index at `~/.omp/agent/appserver/transcript-search.sqlite` (or the
equivalent active profile directory). The index is a cache, not a source of truth. It is opened with
owner-only permissions, rebuilt from session JSONL files, and removed from search when the source
session is permanently deleted.

## Searchable content

The first contract indexes only visible durable text:

- user messages;
- assistant messages;
- visible custom messages; and
- compaction summaries.

It excludes hidden messages, reasoning, tool arguments and results, image data, and raw local paths.
The same display projection used by session discovery removes credentials and path-shaped values
before text enters the index.

## Commands

- `transcript.search` is host scoped. It supports project, role, archive, and time filters plus an
  opaque cursor. A cursor is bound to the exact query and filters that produced it.
- `transcript.context` is session scoped. It returns at most 20 rows before and after one durable
  entry ID. It does not attach the session or change the live transcript projection.

Both responses are strictly bounded by `@oh-my-pi/app-wire`. Search and context reads bypass the
completed-command response cache, so result text is not retained there.

## Index lifecycle

Startup opens the database before the socket is advertised, then schedules history indexing after
the appserver becomes available. Searches can report `building`, `ready`, or `stale` with indexed and
known session counts. Refreshes are coalesced, append only complete JSONL lines, and rebuild a session
after truncation, replacement, or detected in-place rewriting. One unreadable session marks coverage
incomplete but does not prevent healthy sessions from being searched.

Archive keeps a session searchable. Permanent deletion purges its index rows before the successful
delete response is returned.
