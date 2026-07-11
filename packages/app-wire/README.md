# @oh-my-pi/app-wire

`@oh-my-pi/app-wire` is the dependency-free `omp-app/1` JSON boundary. It owns branded control IDs, allocation-conscious UTF-8 bounds, duplicate-key rejection, cycle-safe JSON validation, safe relative paths, and versioned golden fixtures. JSONL is the sole durable session truth. Volatile order uses an opaque string epoch plus a safe sequence; durable entries carry explicit nullable `parentId` and deduplicate by entry ID separately from sequence replay.

Use `decodeClientFrame` or `decodeServerFrame` at every JSON boundary. Every decoder accepts encoded JSON (`string` or `Uint8Array`) and already-parsed JSON. Known frames preserve additive fields; unknown top-level families fail with typed `AppWireError`; unknown leaf event subtypes are accepted. Hello declares a protocol range, client identity, requested features, and saved cursors. Welcome records selected protocol, host/appserver identity, restart epoch, capabilities, negotiated limits, and resume status.

```ts
import { decodeServerFrame } from "@oh-my-pi/app-wire";
const frame = decodeServerFrame(line); // AppWireError on malformed input
```

The exact device capability set and command mapping are exported. Destructive confirmation is separate from one-time `pair.start`/`pair.ok` pairing. File and review paths, plus known file-command arguments, must be safe relative POSIX paths. Remote-only transport supervision and terminal scraping remain outside this wire package.
