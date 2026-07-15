# RPC Protocol Reference

RPC mode runs the coding agent as a newline-delimited JSON protocol over stdio.

- **stdin**: commands (`RpcCommand`), extension UI responses, and host-tool updates/results
- **stdout**: a ready frame, command responses (`RpcResponse`), session/agent events, extension UI requests, host-tool requests/cancellations

Primary implementation:

- `src/modes/rpc/rpc-mode.ts`
- `src/modes/rpc/rpc-types.ts`
- `src/session/agent-session.ts`
- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`

## Startup

```bash
omp --mode rpc [regular CLI options]
```

Behavior notes:

- `@file` CLI arguments are rejected in RPC mode.
- RPC mode disables automatic session title generation by default to avoid an extra model call.
- RPC mode resets workflow-altering `todo.*`, `task.*`, `memory.backend`/`memories.enabled`, `advisor.*`, `async.*`, and `bash.autoBackground.*` settings to their built-in defaults instead of inheriting user overrides.
- The process reads stdin as JSONL (`readJsonl(Bun.stdin.stream())`).
- At startup it writes `{ "type": "ready" }` before processing commands.
- When stdin closes, pending host-tool calls and host-URI requests are rejected and the process exits with code `0`.
- Responses/events are written as one JSON object per line.

## Transport and Framing

Each frame is a single JSON object followed by `\n`.

There is no envelope beyond the object shape itself.

### Outbound frame categories (stdout)

1. Ready frame (`{ type: "ready" }`)
2. `RpcResponse` (`{ type: "response", ... }`)
3. `AgentSessionEvent` objects (`agent_start`, `message_update`, etc.)
4. `RpcExtensionUIRequest` (`{ type: "extension_ui_request", ... }`)
5. Host tool requests/cancellations (`host_tool_call`, `host_tool_cancel`)
6. Host URI requests/cancellations (`host_uri_request`, `host_uri_cancel`)
7. Extension errors (`{ type: "extension_error", extensionPath, event, error }`)
8. Available-commands updates (`{ type: "available_commands_update", commands }`), emitted at startup and whenever command metadata changes
9. Prompt lifecycle hints for accepted prompts that later resolve locally (`{ type: "prompt_result", id?, agentInvoked }`) or fail (`{ type: "prompt_result", id?, error }`)
10. Subagent frames (`subagent_lifecycle`, `subagent_progress`, `subagent_event`), gated by `set_subagent_subscription`
11. Builtin slash-command side channels (`command_output`, `session_info_update`, `config_update`)

12. Managed durable session-entry notifications (`session_entry`), gated by `OMP_APP_RPC_SESSION_ENTRIES=1`

### Inbound frame categories (stdin)

1. `RpcCommand`
2. `RpcExtensionUIResponse` (`{ type: "extension_ui_response", ... }`)
3. Host tool updates/results (`host_tool_update`, `host_tool_result`)
4. Host URI results (`host_uri_result`)

### Managed durable session-entry notifications

The local appserver opts its managed RPC children into durable-entry notifications with `OMP_APP_RPC_SESSION_ENTRIES=1`. Standard RPC mode does not emit these additive frames. When enabled, each exact durable append is emitted once on stdout:

```json
{
  "type": "session_entry",
  "entry": {
    "type": "message",
    "id": "entry-id",
    "parentId": "parent-entry-id",
    "timestamp": "2026-07-11T12:00:00.000Z",
    "message": { "role": "user", "content": "..." }
  }
}
```

`entry` is the typed `SessionEntry` object, including its exact `id`, `parentId`, and `timestamp`. The JSONL session transcript remains the durable authority for replay and recovery. `session_entry` is a live notification only, not a replacement for reading JSONL.

The appserver also sets `OMP_APP_RPC_INLINE_IMAGE_DATA=omit`. In that internal transport only, image-block payloads and standalone image data URLs are omitted recursively from stdout frames and the frame receives `inlineImageDataOmitted: true`. Valid transcript images carry an `appImageSha256` digest so the appserver can resolve the persisted blob without copying base64 through the control channel. The managed transport projects other oversized or structurally unsafe fields to app-wire limits as well. It never resizes, rewrites, or removes the image persisted in the session or sent to the model.

This frame is additive: older RPC consumers may ignore unknown outbound `type` values and continue handling existing responses/events unchanged.

## Request/Response Correlation

All commands accept optional `id?: string`.

- If provided, normal command responses echo the same `id`.
- `RpcClient` relies on this for pending-request resolution.

Important edge behavior from runtime:

- Unknown command responses are emitted with `id: undefined` (even if the request had an `id`).
- Parse/handler exceptions in the input loop emit `command: "parse"` with `id: undefined`.
- Every command emits at most one `response` for its id. A `prompt` or `abort_and_prompt` failure before acceptance uses that response. After a success acknowledgement, an asynchronous failure is emitted as `prompt_result` with the original id and an `error` string, never as a second response.
- `prompt` success responses may include `data.agentInvoked`. `false` means the prompt completed locally without an agent turn; `true` means the prompt produced agent lifecycle events; omitted means the host must rely on session events for completion.
- `abort_and_prompt` does not emit `data.agentInvoked`; hosts should treat it as the legacy abort-then-schedule path and rely on session events or a `prompt_result` error.

## Command Schema (canonical)

`RpcCommand` is defined in `src/modes/rpc/rpc-types.ts`:

### Prompting

- `{ id?, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp" }`
- `{ id?, type: "steer", message: string, images?: ImageContent[] }`
- `{ id?, type: "follow_up", message: string, images?: ImageContent[] }`
- `{ id?, type: "abort" }`
- `{ id?, type: "abort_and_prompt", message: string, images?: ImageContent[] }`
- `{ id?, type: "new_session", parentSession?: string }`

### State

- `{ id?, type: "get_state" }`
- `{ id?, type: "get_available_commands" }`
- `{ id?, type: "set_todos", phases: TodoPhase[] }`
- `{ id?, type: "set_host_tools", tools: RpcHostToolDefinition[] }`
- `{ id?, type: "set_host_uri_schemes", schemes: RpcHostUriSchemeDefinition[] }`
- `{ id?, type: "set_subagent_subscription", level: "off" | "progress" | "events" }`
- `{ id?, type: "get_subagents" }`
- `{ id?, type: "get_subagent_messages", subagentId?: string, sessionFile?: string, fromByte?: number, maxBytes?: number, includeMessages?: boolean }`

Subagent transcript reads use byte cursors. `maxBytes` must be an integer from 1
through 393,216 and defaults to 393,216. A response contains complete JSONL
records only, with at most 256 physical records per call. It can stop earlier
to keep the RPC response inside the app-wire structural limits. Continue from
`nextByte` until it no longer advances.

`includeMessages` defaults to `true` for compatibility. Set it to `false` when
the `entries` array is sufficient; this avoids returning the same message data
twice. An incomplete final JSONL record does not advance `nextByte`. If the file
was truncated or `fromByte` is not on a record boundary, the response sets
`reset: true` and restarts at byte zero. A single record that exceeds the byte
or structural limit returns an error instead of skipping data.

### Model

- `{ id?, type: "set_model", provider: string, modelId: string }`
- `{ id?, type: "cycle_model" }`
- `{ id?, type: "get_available_models" }`

### Thinking

- `{ id?, type: "set_thinking_level", level: ThinkingLevel }`
- `{ id?, type: "cycle_thinking_level" }`

### Queue modes

- `{ id?, type: "set_steering_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_follow_up_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_interrupt_mode", mode: "immediate" | "wait" }`

### Compaction

- `{ id?, type: "compact", customInstructions?: string }`
- `{ id?, type: "set_auto_compaction", enabled: boolean }`

### Retry

- `{ id?, type: "set_auto_retry", enabled: boolean }`
- `{ id?, type: "abort_retry" }`

### Bash

- `{ id?, type: "bash", command: string }`
- `{ id?, type: "abort_bash" }`

`bash` is dispatched concurrently: the RPC server continues reading commands
while the shell command runs, so `abort_bash` (or any other command) sent
during a long-running `bash` is handled without waiting for it to finish on
its own. The `bash` response is emitted when the command completes; hosts
correlate it via `id`. Ordering across concurrent commands is not guaranteed
— clients MUST match responses on `id`, not on emission order.

### Session

- `{ id?, type: "get_session_stats" }`
- `{ id?, type: "export_html", outputPath?: string }`
- `{ id?, type: "switch_session", sessionPath: string }`
- `{ id?, type: "branch", entryId: string }`
- `{ id?, type: "get_branch_messages" }`
- `{ id?, type: "get_last_assistant_text" }`
- `{ id?, type: "set_session_name", name: string }`
- `{ id?, type: "handoff", customInstructions?: string }`

### Messages

- `{ id?, type: "get_messages" }`

### Login

- `{ id?, type: "get_login_providers" }`
- `{ id?, type: "login", providerId: string }`

## Response Schema

All command results use `RpcResponse`:

- Success: `{ id?, type: "response", command: <command>, success: true, data?: ... }`
- Failure: `{ id?, type: "response", command: string, success: false, error: string }`

Data payloads are command-specific and defined in `rpc-types.ts`.

### `prompt` payload

`prompt` is acknowledged after the command is accepted, not after a model turn finishes:

```json
{
  "id": "req_1",
  "type": "response",
  "command": "prompt",
  "success": true,
  "data": { "agentInvoked": false }
}
```

`data.agentInvoked: false` is a completion signal for local-only prompts, including slash commands that produce output without starting an agent turn. `data.agentInvoked: true` means the prompt produced agent lifecycle events; those events can be emitted before or after the prompt response depending on the command path. Older runtimes may omit `data`; hosts should then rely on `agent_end`, custom message completion, or `prompt_result`.

`prompt_result` is emitted when a prompt was accepted immediately but later resolves as local-only:

```json
{ "type": "prompt_result", "id": "req_1", "agentInvoked": false }
```

If that accepted prompt later rejects, the same asynchronous channel carries the failure. It is not a second command response:

```json
{ "type": "prompt_result", "id": "req_1", "error": "No API key found for provider" }
```

Hosts that track prompt lifecycles must assign a unique `id` to each prompt and settle only the unresolved lifecycle whose ID exactly matches `prompt_result.id`. A missing, unmatched, or stale ID may still be shown as non-terminal diagnostic output, but it must not settle another prompt or close its active turn.

Local-only slash commands may emit `command_output` frames before completing via `data.agentInvoked: false` or a later `prompt_result`. They do not emit `agent_end`.

### `get_state` payload

```json
{
  "model": { "provider": "...", "id": "..." },
  "thinkingLevel": "off|minimal|low|medium|high|xhigh|max",
  "isStreaming": false,
  "isCompacting": false,
  "steeringMode": "all|one-at-a-time",
  "followUpMode": "all|one-at-a-time",
  "interruptMode": "immediate|wait",
  "sessionFile": "...",
  "sessionId": "...",
  "sessionName": "...",
  "autoCompactionEnabled": true,
  "messageCount": 0,
  "queuedMessageCount": 0,
  "todoPhases": [
    {
      "id": "phase-1",
      "name": "Todos",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the tool surface",
          "status": "in_progress"
        }
      ]
    }
  ],
  "systemPrompt": ["..."],
  "dumpTools": [
    {
      "name": "read",
      "description": "Read files and URLs",
      "parameters": {}
    }
  ],
  "contextUsage": {
    "tokens": 1100,
    "contextWindow": 200000,
    "percent": 0.55
  }
}
```

### `set_todos` payload

Replaces the in-memory todo state for the current session and returns the normalized phase list:

```json
{
  "id": "req_2",
  "type": "set_todos",
  "phases": [
    {
      "id": "phase-1",
      "name": "Evaluation",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the read tool surface",
          "status": "in_progress"
        },
        {
          "id": "task-2",
          "content": "Exercise edit operations",
          "status": "pending"
        }
      ]
    }
  ]
}
```

This is useful for hosts that want to pre-seed a plan before the first prompt.

### `set_host_tools` payload

Replaces the current set of host-owned tools that the RPC server may call back
into over stdio:

```json
{
  "id": "req_3",
  "type": "set_host_tools",
  "tools": [
    {
      "name": "echo_host",
      "label": "Echo Host",
      "description": "Echo a value from the embedding host",
      "parameters": {
        "type": "object",
        "properties": {
          "message": { "type": "string" }
        },
        "required": ["message"],
        "additionalProperties": false
      }
    }
  ]
}
```

The response payload is:

```json
{
  "toolNames": ["echo_host"]
}
```

These tools are added to the active session tool registry before the next model
call. Re-sending `set_host_tools` replaces the previous host-owned set.

### `set_host_uri_schemes` payload

Replaces the current set of host-owned URL schemes the RPC server should
dispatch reads/writes through:

```json
{
  "id": "req_4",
  "type": "set_host_uri_schemes",
  "schemes": [
    {
      "scheme": "db",
      "description": "Virtual db row files",
      "writable": true,
      "immutable": false
    }
  ]
}
```

The response payload is:

```json
{
  "schemes": ["db"]
}
```

Schemes are case-insensitive on the wire and normalized to lowercase before
the response is sent. Re-sending `set_host_uri_schemes` replaces the entire
previous set — schemes missing from the new list are unregistered.

## Event Stream Schema

RPC mode forwards `AgentSessionEvent` objects from `AgentSession.subscribe(...)`.

Common event types:

- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`
- `todo_auto_clear`

Extension runner errors are emitted separately as:

```json
{
  "type": "extension_error",
  "extensionPath": "...",
  "event": "...",
  "error": "..."
}
```

`message_update` includes streaming deltas in `assistantMessageEvent` (text/thinking/toolcall deltas).

`agent_end` aggregates remain below the host's 1 MiB line ceiling and satisfy
the app-wire bounded-JSON structural limits for depth, collection size, and
total nodes. When an aggregate would exceed any of those limits,
`messages` contains the newest contiguous suffix that fits and the event adds
the original `messageCount` plus a terminal `status` of `completed`, `failed`,
or `cancelled`. Managed appserver children additionally project every stdout
frame to those transport limits. When `OMP_APP_RPC_SESSION_ENTRIES=1`, durable
messages arrive individually as `session_entry` frames before the terminal
event.

When an appserver RPC child crashes, the session is projected as `closed` with
`liveState.runtimeCrashed: true` while that child is being reaped. Only after it
exits does the projection become restartable `idle`; the next prompt can then
spawn a fresh child, and successful activity clears the crash marker. An
explicit `session.close` remains `closed` and does not become restartable.

## Prompt/Queue Concurrency and Ordering

This is the most important operational behavior.

### Immediate ack vs completion

`prompt` and `abort_and_prompt` acknowledge accepted work without waiting for run completion. A failure before acceptance uses the command's single failure response. A successful acknowledgement has this shape:

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
```

That means:

- command acceptance != run completion
- `turn_end` closes one agent-loop iteration and may be followed by another `turn_start`; it is not prompt completion or an idle boundary
- agent-backed prompts complete via the final `agent_end`
- local-only prompts complete via `data.agentInvoked: false` on the response or via a later `prompt_result`
- late prompt failures complete via `prompt_result.error`, never a second `response` with the settled command id

### While streaming

`AgentSession.prompt()` requires `streamingBehavior` during active streaming:

- `"steer"` => queued steering message (interrupt path)
- `"followUp"` => queued follow-up message (post-turn path)

If omitted during streaming, prompt fails.

### Queue defaults

From `packages/agent/src/agent.ts` defaults:

- `steeringMode`: `"one-at-a-time"`
- `followUpMode`: `"one-at-a-time"`
- `interruptMode`: `"immediate"`

### Mode semantics

- `set_steering_mode` / `set_follow_up_mode`
  - `"one-at-a-time"`: dequeue one queued message per turn
  - `"all"`: dequeue entire queue at once
- `set_interrupt_mode`
  - `"immediate"`: tool execution checks steering between tool calls; pending steering can abort remaining tool calls in the turn
  - `"wait"`: defer steering until turn completion

## Extension UI Sub-Protocol

Extensions in RPC mode use request/response UI frames.

### Outbound request

`RpcExtensionUIRequest` (`type: "extension_ui_request"`) methods:

- `select`, `confirm`, `input`, `editor`, `cancel`
- `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`
- `open_url` (emitted by RPC login flows)

Runtime note:

- Automatic session title generation is disabled in RPC mode, and `setTitle` UI
  requests are also suppressed by default because most hosts do not have a
  meaningful terminal-title surface. Set `PI_RPC_EMIT_TITLE=1` to opt back in to
  the UI event only.

Example:

```json
{
  "type": "extension_ui_request",
  "id": "123",
  "method": "confirm",
  "title": "Confirm",
  "message": "Continue?",
  "timeout": 30000
}
```

### Inbound response

`RpcExtensionUIResponse` (`type: "extension_ui_response"`):

- `{ type: "extension_ui_response", id: string, value: string }`
- `{ type: "extension_ui_response", id: string, confirmed: boolean }`
- `{ type: "extension_ui_response", id: string, cancelled: true, timedOut?: boolean }`

If a dialog has a timeout, RPC mode resolves to a default value when timeout/abort fires.

## Host Tool Sub-Protocol

RPC hosts can expose custom tools to the agent by sending `set_host_tools`, then
serving execution requests over the same transport.

### Outbound request

When the agent wants the host to execute one of those tools, RPC mode emits:

```json
{
  "type": "host_tool_call",
  "id": "host_1",
  "toolCallId": "toolu_123",
  "toolName": "echo_host",
  "arguments": { "message": "hello" }
}
```

If the tool execution is later aborted, RPC mode emits:

```json
{
  "type": "host_tool_cancel",
  "id": "host_cancel_1",
  "targetId": "host_1"
}
```

### Inbound updates and completion

Hosts can optionally stream progress:

```json
{
  "type": "host_tool_update",
  "id": "host_1",
  "partialResult": {
    "content": [{ "type": "text", "text": "working" }]
  }
}
```

Completion uses:

```json
{
  "type": "host_tool_result",
  "id": "host_1",
  "result": {
    "content": [{ "type": "text", "text": "done" }]
  }
}
```

Set top-level `isError: true` on `host_tool_result` to reject the pending host tool call and surface the returned text content as a tool error.

## Host URI Sub-Protocol

RPC hosts can also own custom URL schemes (virtual files). After
`set_host_uri_schemes`, every read of `<scheme>://…` and write of
`<scheme>://…` (when registered as `writable`) is bounced back to the host
over the same transport.

### Outbound request

When a session tool resolves a host-owned URL, RPC mode emits:

```json
{
  "type": "host_uri_request",
  "id": "uri_1",
  "operation": "read",
  "url": "db://users/42"
}
```

Writes look the same with `"operation": "write"` and an additional
`"content": "..."` field carrying the full replacement bytes.

If the request is later aborted (caller cancels, session ends), RPC mode
emits:

```json
{
  "type": "host_uri_cancel",
  "id": "uri_cancel_1",
  "targetId": "uri_1"
}
```

### Inbound result

For successful reads:

```json
{
  "type": "host_uri_result",
  "id": "uri_1",
  "content": "id=42\nname=Alice\n",
  "contentType": "text/plain",
  "notes": ["fresh from cache"],
  "immutable": false
}
```

For successful writes, omit content:

```json
{ "type": "host_uri_result", "id": "uri_1" }
```

To reject the request, set `isError: true` and either populate `error` with
a message or fall back to `content` for textual error surfacing:

```json
{
  "type": "host_uri_result",
  "id": "uri_1",
  "isError": true,
  "error": "row 42 not found"
}
```

### Constraints

- The agent's `edit` tool does not target host URIs. Hosts that want to
  mutate virtual files expose `write` and let the model use the `write` tool
  with replacement content.
- Schemes are global to the process; `set_host_uri_schemes` replaces the
  previous set, unregistering anything not in the new list.
- Schemes are normalized to lowercase before registration.

## Error Model and Recoverability

### Command-level failures

Failures are `success: false` with string `error`.

```json
{
  "id": "req_2",
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: provider/model"
}
```

### Recoverability expectations

- Most command failures are recoverable; process remains alive.
- Malformed JSONL / parse-loop exceptions emit a `parse` error response and continue reading subsequent lines.
- Empty `set_session_name` is rejected (`Session name cannot be empty`).
- Extension UI responses with unknown `id` are ignored.
- Process termination conditions are stdin close or explicit extension-triggered shutdown after the current command.

## Compact Command Flows

### 1) Prompt and stream

stdin:

```json
{ "id": "req_1", "type": "prompt", "message": "Summarize this repo" }
```

stdout sequence (typical):

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
{ "type": "agent_start" }
{ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "..." }, "message": { "role": "assistant", "content": [] } }
{ "type": "agent_end", "messages": [] }
```

### 2) Prompt during streaming with explicit queue policy

stdin:

```json
{
  "id": "req_2",
  "type": "prompt",
  "message": "Also include risks",
  "streamingBehavior": "followUp"
}
```

### 3) Inspect and tune queue behavior

stdin:

```json
{ "id": "q1", "type": "get_state" }
{ "id": "q2", "type": "set_steering_mode", "mode": "all" }
{ "id": "q3", "type": "set_interrupt_mode", "mode": "wait" }
```

### 4) Extension UI round trip

stdout:

```json
{
  "type": "extension_ui_request",
  "id": "ui_7",
  "method": "input",
  "title": "Branch name",
  "placeholder": "feature/..."
}
```

stdin:

```json
{ "type": "extension_ui_response", "id": "ui_7", "value": "feature/rpc-host" }
```

## Notes on `RpcClient` helper

`src/modes/rpc/rpc-client.ts` is a convenience wrapper, not the protocol definition.

Current helper characteristics:

- Spawns `bun <cliPath> --mode rpc`
- Correlates responses by generated `req_<n>` ids
- Dispatches recognized core `AgentEvent` types to listeners
- Supports host-owned custom tools via `setCustomTools()` and automatic handling of `host_tool_call` / `host_tool_cancel`
- Wraps common protocol commands including OAuth `getLoginProviders()` / `login(...)`; use raw protocol frames for any surface not wrapped by the helper.

Use raw protocol frames if you need complete surface coverage.
