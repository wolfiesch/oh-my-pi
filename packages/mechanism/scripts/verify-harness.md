# The Mechanism — Visual + State Verification Harness

`scripts/verify-harness.ts` is a self-contained, executable proof that **100% of the orrery's
visual transitions and event bindings** behave as the build brief's truth-binding table specifies.
It needs **no live OMP session**: it stands up its own deterministic mock SSE feed, drives the
**actual built client** through a real headless Chrome, screenshots at the exact moment each event
lands, and turns every screenshot into a quantitative pass/fail by decoding it back into pixels.

## Why this shape

The brief demands two things be proven: **visual appearance** (screenshots) *and* **SSE event
binding functionality**. A screenshot alone is not an assertion — it needs a human. So the harness
verifies every binding across **three independent layers**, each a different kind of evidence:

| Layer | Evidence | What it proves | How |
|---|---|---|---|
| **Transport** | exact event log | the SSE wire contract | a page-side probe `EventSource("/events")` records every frame; harness asserts byte-exact `MechEvent[]` arrival, in order |
| **Application** | DOM read-back | event → app state binding | `#hud-agents` / `#hud-cost` / `#hud-profile` must reflect the derived roster, summed spend, profile |
| **Render** | decoded pixels | event → scene binding | `page.screenshot()` at each keyframe, decoded in a 2nd page via the browser's own PNG decoder → per-region metrics |

No client source is modified or instrumented. The render layer reads only real composited pixels;
the transport layer rides the same `/events` endpoint the client uses; the application layer reads
the same DOM a human sees. This keeps the harness fully decoupled from client internals.

## Determinism strategy

Geometry checks (spawn-into-ring, lane placement, scaling) run under **`prefers-reduced-motion:
reduce`**, where `client/scene.ts` makes the scene deterministic:

- The camera is pinned to its static pose `(0, 46, 64)` looking at the origin — no breath/orbit.
- Ring phases never drift (`if (!reduced)` guards), and slot tweens snap in one frame (`ease = 1`).
- A body alone in ring `d`'s bucket therefore sits at angle 0 → **world `(RING_RADII[d], 0, 0)`**.

Because the camera and every body position are then known, the harness mirrors three.js'
`PerspectiveCamera` projection (fov 46°, the same static pose) to compute the **exact screen pixel**
where each ring body and rim solid must appear, and samples a tight box there. The motion-vs-still
contrast checks instead run with motion **on** (control) and **reduced** to assert the reduced-motion
contract by frame-delta.

Viewport is **1280×720** (16:9): it frames **4 of the 5** rim solids. The 5th (front lane, world
≈`(14,0,43)`) projects *below* the camera's fixed vertical fov — a scene-design fact, not a harness
gap. It is recorded as an `info` row and covered functionally by the usage-scaling + transport
checks (which exercise all 5 lanes).

## Components

```
verify-harness.ts
├── project()                camera projection mirror → exact ring/lane screen boxes
├── MockMechServer           Bun.serve: static client + push-controlled /events SSE (+ keepalive)
├── resolveChrome()          env / PATH / well-known Chrome-Chromium discovery
├── Analyzer                 2nd page; decodes PNG via browser, returns region pixel metrics + frame-delta
├── Harness                  check accumulator + screenshot persistence
├── suiteReducedMotion()     geometry + every event binding (deterministic)
├── suiteMotionContrast()    motion-on liveness vs reduced stillness vs reduced-still-registers
└── writeReport()            report.html (table + screenshot gallery) + report.json; exit 0 iff all pass
```

Pixel metrics per region (decoded in-browser, so no Node image deps): `lum` (max channel > 40 — any
luminous stroke over ink-black), `bright` (min channel > 120 — a body's bloomed near-white core),
`red` (the reserved `PALETTE.flare` aborted accent — nothing else in the gold palette is red),
`white` (the IRC `pulse` / brightest strokes), `mean`, and a whole-frame `frameDelta` for motion.

## Blueprint — brief truth-binding ⇒ harness check

Every row of the brief's truth-binding table maps to one or more checks:

| Brief visual element (truth-binding) | Harness check(s) | Assertion |
|---|---|---|
| Central great wheel + π engraving | `structure-present` | luminous fraction ≥ 0.04 (scene rendered, not blank) |
| Model lanes → 5 Platonic-solid wireframes | `lanes-present`, `lanes-offscreen-documented` | every on-screen lane luminous at its projected rim point; off-frame lane projection recorded |
| Subagent spawned → body accretes into orbit | `spawn-depth-0..3`, `hud-agent-count` | bright core appears at each ring; HUD agents = 4 |
| Recursion depth (0–3) → which ring | `spawn-depth-0`, `-1`, `-2`, `-3` | a body lands at the projected screen point of **its** ring radius (11/19/27/35) |
| running / idle | `status-running-to-idle` | node-box mean brightness drops ≥ 6 (intensity 1.0 → 0.55) |
| parked | `status-parked` | parked node dimmer than idle |
| aborted → red flare, then heal | `aborted-flare`, `aborted-heal` | red px jumps ≥ 120 on abort, decays to ≤ 60 after the ~1.4 s heal |
| IRC / inter-agent message → arc of light | `irc-arc` | white pulse px jumps ≥ 200 while the arc travels |
| Tool call → compass-and-straightedge strike | `tool-strike` | luminous px rises during the strike, falls back after |
| Token / cost → orbital mass (solid scales) | `usage-scaling`, `hud-cost` | dominant-spend lane's solid mean brightness rises ≥ 18; HUD cost = Σ usage |
| (SSE binding functionality) | `sse-transport-contract`, `client-no-errors` | byte-exact ordered delivery of all pushed `MechEvent`s; zero client decode errors |
| `prefers-reduced-motion` — visible by default | `reduced-visible-at-t0` | scene luminous on the first frame (never a blank reveal) |
| `prefers-reduced-motion` — no continuous motion | `motion-continuous` (control), `reduced-no-continuous-motion` | idle frame-delta ≈ 1.4 with motion vs **0.0** reduced |
| `prefers-reduced-motion` — state still registers | `reduced-state-registers` | an aborted flare still appears under reduced motion (crossfade, not suppressed) |

**Contract note — "Jobs queued → gears at the rim":** this row of the *brief* has **no event** in
the implemented V1 `MechEvent` union (no `queued`/`job` variant), so there is nothing to bind or
verify. It is intentionally out of scope for V1 and is the only truth-binding row with no check.

## Run it

```bash
# from the repo root
bun run packages/mechanism/scripts/verify-harness.ts
# or via the package script
bun --cwd packages/mechanism run verify
```

Flags: `--out <dir>` (default `./verify-out`), `--headful`, `--no-build` (reuse `dist/client`),
`--keep-open`, `--chrome <path>`.

Outputs to `verify-out/`: `report.html` (pass/fail table + screenshot gallery with a
`100% COMPLIANCE` banner), `report.json` (machine-readable), and `shots/*.png` (20 keyframes).
**Exit code is 0 iff every graded check passes**, so it drops straight into CI.

## Requirements

- A Chromium-family browser (auto-discovered; the harness pins SwiftShader GL flags
  `--enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader` so headless WebGL is
  deterministic and never depends on a physical GPU/display).
- `puppeteer-core` + `three` (already workspace deps). No new dependencies.
