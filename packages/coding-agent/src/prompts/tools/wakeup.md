Schedules a one-shot delayed wakeup for this agent. The completed timer is delivered as a follow-up turn, so the agent resumes automatically without the user sending another message.

## Invoke this when

- The user says "wake yourself", "remind me", "check again later", "retry in N minutes", or "continue after a delay".
- Work should pause until a future time, then resume with a specific instruction.
- A polling workflow needs another check later. Schedule one wakeup at a time; after waking, decide whether another is needed.

## Do not use this when

- Work can continue immediately.
- Waiting for an existing background job. Its result already arrives automatically; use `hub` only to inspect or intervene.
- The user needs durable cron or calendar automation that survives this OMP process.

## Lifecycle

- Wakeups are session-owned, one-shot, and require the OMP process to remain open.
- The scheduled call returns immediately with a background job id.
- Inspect wakeups with `hub` `op="jobs"`; cancel with `hub` `op="cancel"` and the id.
- Closing, replacing, or disposing the owning session cancels its pending wakeups.

<critical>
Use this tool whenever the user clearly requests a delayed self-wakeup, even if they do not say "tool" or "schedule".
Never emulate delayed wakeups with blocking shell sleep commands or repeated polling turns.
For recurring behavior, schedule one wakeup, reassess when it fires, then schedule the next only if still needed.
</critical>
