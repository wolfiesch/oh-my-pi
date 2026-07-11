# @oh-my-pi/app-wire

`@oh-my-pi/app-wire` is the dependency-free JSON boundary for the `omp-app/1`
application protocol. It owns branded IDs, bounded decoders, frame guards, and
versioned golden fixtures. JSONL is the durable session truth; sequence numbers
are scoped by `{ epoch, seq }`, while durable transcript entries dedupe by entry
ID. A raw session ID is never globally unique: use the `{ hostId, sessionId }`
tuple.

Use `decodeClientFrame` or `decodeServerFrame` at every JSON boundary. Known
frames keep additive fields, while unknown top-level families fail with a typed
`AppWireError`. Unknown leaf event subtypes are intentionally accepted so
consumers can count and skip them. Epoch is mandatory wherever a cursor or
continuity decision is used. Protocol upgrades require an explicit adapter;
this package does not silently accept another version.

```ts
import { decodeServerFrame } from "@oh-my-pi/app-wire";
const frame = decodeServerFrame(line); // AppWireError on malformed input
```

Remote-only appserver concerns (one `omp --mode rpc` child per live session,
transport supervision, and terminal scraping) are deliberately outside this
wire package.
