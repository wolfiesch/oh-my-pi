# @oh-my-pi/app-wire

This package is the compatibility import used by OMP's T4 launcher. The active `omp-app/1` schema,
bounded decoders, branded IDs, transcript paging contract, and security limits are owned by T4 and
come from the checksum-pinned `@t4-code/host-wire` artifact in `vendor/t4-host`.

```ts
import { decodeClientFrame, decodeServerFrame } from "@oh-my-pi/app-wire";
```

OMP code should use this root import. New protocol behavior belongs in T4; OMP contributes only the
runtime authority needed to connect that generic host to OMP sessions, locks, workers, settings,
models, credentials, and native events.
