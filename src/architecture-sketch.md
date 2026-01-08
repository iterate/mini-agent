# Iterate Agent Architecture

## What We're Building

Iterate orchestrates AI coding agents (OpenCode, Claude Code, Pi, and our own Iterate Agent) through **durable event streams**. Each agent has its own stream. Harness implementations are **event subscribers** that react to stream events and call harness APIs.

```
                         ┌─────────────────────────────────────────┐
                         │         Agent Stream (per agent)        │
                         │  [external] [actions] [harness events]  │
                         └──────────────────┬──────────────────────┘
                                            │
     ┌──────────────────┬───────────────────┼───────────────────┬──────────────────┐
     │                  │                   │                   │                  │
     ▼                  ▼                   ▼                   ▼                  │
┌──────────┐      ┌──────────┐        ┌──────────┐        ┌──────────┐             │
│ OpenCode │      │ Claude   │        │ Pi       │        │ Iterate  │             │
│ Sub-     │      │ Code     │        │ Sub-     │        │ Agent    │             │
│ scriber  │      │ Sub-     │        │ scriber  │        │ Sub-     │             │
│ (global) │      │ scriber  │        │ (global) │        │ scriber  │             │
└────┬─────┘      └────┬─────┘        └────┬─────┘        └────┬─────┘             │
     │                 │                   │                   │                   │
     ▼                 ▼                   ▼                   ▼                   │
┌──────────┐      ┌──────────┐        ┌──────────┐        ┌──────────┐             │
│ OpenCode │      │ Claude   │        │ Pi       │        │ mini-    │             │
│ Server   │      │ SDK/CLI  │        │ Process  │        │ agent    │             │
└──────────┘      └──────────┘        └──────────┘        └──────────┘             │
     │                 │                   │                   │                   │
     └─────────────────┴───────────────────┴───────────────────┘                   │
                                           │                                       │
                                           ▼                                       │
                                  ┌─────────────────┐                              │
                                  │   Renderers     │◄─────────────────────────────┘
                                  │   (Web UI,      │  (bidirectional)
                                  │    Slack bot,   │
                                  │    CLI)         │
                                  └─────────────────┘
```

**Key properties:**
- One durable stream per agent instance
- Harness subscribers are global (one per harness type, subscribes to all agent streams)
- Action events are first-class stream events (Redux-like pattern)
- Harness events wrapped verbatim in `payload` (no lossy normalization)
- Renderers are bidirectional (can read and append events)
- Native TUIs remain fully functional (SSH in, use OpenCode/Claude/Pi directly)

## Terminology

| Term | Definition |
|------|------------|
| **Agent Harness** | Standalone agent runtime (OpenCode, Claude Code, Pi, Iterate Agent). Handles LLM calls, tool execution, conversation state. |
| **Harness Subscriber** | Event subscriber that reacts to stream events and calls harness APIs. One global subscriber per harness type. |
| **Durable Stream** | Append-only event log with offset-based resumption. One stream per agent instance. |
| **Action Event** | Event requesting a side effect (e.g., `prompt-requested`). Past-tense "-requested" suffix. |
| **Renderer** | Bidirectional stream client (Web UI, Slack bot). Can read events and append new ones. |

## Event Architecture

### Event Types

```
External events (from outside world):
  slack:message-received
  github:webhook-received

Action events (requesting side effects):
  iterate:agent:harness:opencode:action:session-create-requested
  iterate:agent:harness:opencode:action:prompt-requested
  iterate:agent:harness:claude:action:prompt-requested
  iterate:agent:harness:pi:action:prompt-requested
  iterate:agent:harness:iterate:action:prompt-requested

Wrapped harness events (verbatim payload):
  iterate:agent:harness:opencode:event-received
  iterate:agent:harness:claude:event-received
  iterate:agent:harness:pi:event-received
  iterate:agent:harness:iterate:event-received

System events:
  iterate:agent:system:ready
  iterate:agent:system:stopped
  iterate:agent:system:error-occurred
```

**Naming conventions:**
- External events: source-based (`slack:*`, `github:*`), past-tense verbs
- Action events: `-requested` suffix (things we want to happen)
- Wrapped harness: generic `event-received` type, native format in `payload`
- System events: past-tense verbs (`-occurred`, `-stopped`)
- Colon separator: URL-safe, clear hierarchy

### Event Envelope

```typescript
interface IterateEvent {
  // Protocol fields
  offset: Offset                    // Assigned by durable-streams

  // Envelope fields (always present)
  type: string                      // e.g. "iterate:agent:harness:opencode:event-received"
  version: number                   // Schema version (start at 1)
  timestamp: number                 // When Iterate received/created

  // Type-specific fields at root (varies by event)
  agentId?: string                  // For agent events
  harness?: string                  // "opencode" | "claude" | "pi" | "iterate"

  // Payload (mutually exclusive)
  payload?: unknown                 // Verbatim external data (harness/webhook)
  data?: Record<string, unknown>    // Iterate's structured data

  // Optional
  metadata?: Record<string, unknown>  // Debug info, correlation IDs
}
```

Flat structure at root for easy filtering/indexing. External payloads preserved byte-for-byte in `payload` field.

### Example Events

```typescript
// 1. External event arrives
{
  type: "slack:message-received",
  version: 1,
  timestamp: 1705312900000,
  payload: {
    type: "message",
    channel: "C123",
    user: "U456",
    text: "Hello agent"
  }
}

// 2. Harness subscriber transforms to action event
{
  type: "iterate:agent:harness:opencode:action:prompt-requested",
  version: 1,
  timestamp: 1705312900100,
  agentId: "agent-123",
  harness: "opencode",
  data: {
    content: "Hello agent",
    source: "slack:message-received"
  }
}

// 3. Harness subscriber executes action, wraps response
{
  type: "iterate:agent:harness:opencode:event-received",
  version: 1,
  timestamp: 1705312800000,
  agentId: "agent-123",
  harness: "opencode",
  payload: {
    type: "Session.Message.Created",      // OpenCode's native format
    timestamp: 1705312799500,             // OpenCode's timestamp
    sessionId: "sess-456",
    message: { role: "assistant", parts: [...] }
  }
}

// Action that failed (at-most-once, fail fast)
{
  type: "iterate:agent:system:error-occurred",
  version: 1,
  timestamp: 1705312900200,
  agentId: "agent-123",
  data: {
    action: "iterate:agent:harness:opencode:action:prompt-requested",
    error: "OpenCode server unreachable",
    code: "HARNESS_UNAVAILABLE"
  }
}
```

### Versioning Strategy

- `version` field in envelope, starting at 1
- Adding optional fields: no version bump
- Breaking changes: bump version, emit both during transition
- Consumer rule: ignore unknown fields, warn on unsupported version

## Agent Lifecycle

```typescript
// 1. Request agent creation (action event)
{ type: "iterate:agent:harness:opencode:action:session-create-requested", agentId: "agent-123", harness: "opencode", data: { config: {...} } }

// 2. Agent ready (system event)
{ type: "iterate:agent:system:ready", agentId: "agent-123", data: { harness: "opencode", pid: 12345 } }

// 3. External event arrives
{ type: "slack:message-received", payload: { channel: "C123", text: "Hello" } }

// 4. Subscriber transforms to action
{ type: "iterate:agent:harness:opencode:action:prompt-requested", agentId: "agent-123", harness: "opencode", data: { content: "Hello" } }

// 5. Harness events flow (verbatim wrapped)
{ type: "iterate:agent:harness:opencode:event-received", agentId: "agent-123", harness: "opencode", payload: { type: "Session.Message.Created", ... } }
{ type: "iterate:agent:harness:opencode:event-received", agentId: "agent-123", harness: "opencode", payload: { type: "Session.Message.Updated", ... } }

// 6. Destroy
{ type: "iterate:agent:harness:opencode:action:session-destroy-requested", agentId: "agent-123" }
{ type: "iterate:agent:system:stopped", agentId: "agent-123", data: { reason: "requested" } }
```

## Harness Subscriber Architecture

Harness implementations are **event subscribers**. One global subscriber per harness type subscribes to all agent streams and:
1. Transforms external events → action events
2. Executes action events → calls harness API
3. Wraps harness output → appends to stream

```typescript
interface HarnessSubscriber {
  readonly harness: "opencode" | "claude" | "pi" | "iterate"

  // Called for every event on every agent stream using this harness
  handleEvent(
    agentId: string,
    event: IterateEvent
  ): Effect<ReadonlyArray<IterateEvent>, HarnessError>
}

// Example: OpenCode subscriber
const openCodeSubscriber: HarnessSubscriber = {
  harness: "opencode",

  handleEvent: (agentId, event) => Effect.gen(function*() {
    switch (event.type) {
      // Transform external events to actions
      case "slack:message-received":
        return [{
          type: "iterate:agent:harness:opencode:action:prompt-requested",
          agentId,
          harness: "opencode",
          data: { content: event.payload.text }
        }]

      // Execute actions by calling harness API
      case "iterate:agent:harness:opencode:action:prompt-requested":
        yield* openCodeClient.sendPrompt(agentId, event.data.content)
        return []  // Harness events come via SSE subscription

      case "iterate:agent:harness:opencode:action:session-create-requested":
        yield* openCodeClient.createSession(agentId, event.data.config)
        return []

      default:
        return []  // Ignore events we don't handle
    }
  })
}
```

### Event Flow (Slack → OpenCode Example)

```
slack:message-received arrives on agent-123 stream
    │
    ▼
OpenCode subscriber sees event, returns action:
  iterate:agent:harness:opencode:action:prompt-requested
    │
    ▼
Action appended to stream
    │
    ▼
OpenCode subscriber sees action, calls:
  POST /session/:id/prompt_async
    │
    ▼
OpenCode SSE subscription receives native events
    │
    ▼
Wrapped as iterate:agent:harness:opencode:event-received
    │
    ▼
Appended to stream → Renderers see it
```

### Offset Tracking (Replay Safety)

Each subscriber tracks its last-processed offset per stream in a simple file:

```
~/.iterate/subscriber-offsets/opencode.json
{
  "agent-123": 42,
  "agent-456": 17
}
```

On daemon restart, subscriber resumes from stored offset, skipping already-handled events. At-most-once semantics: if action execution fails, emit error event, don't retry.

## Harness Implementations

### OpenCode Subscriber

HTTP/SSE server architecture. One server per sandbox, multiple sessions multiplexed.

```bash
opencode serve --port 4096
```

| Endpoint | Purpose |
|----------|---------|
| `/session` | List/create sessions |
| `/session/:id/prompt` | Send message (sync) |
| `/session/:id/prompt_async` | Send message (SSE stream) |
| `/session/:id/abort` | Cancel operation |
| `/event` | SSE event stream |

**Action handlers:**
- `session-create-requested` → `POST /session`
- `prompt-requested` → `POST /session/:id/prompt_async`
- `abort-requested` → `POST /session/:id/abort`

**Event wrapping:** Subscribe to `/event` SSE, wrap each native event as `iterate:agent:harness:opencode:event-received`.

TUI attach: `opencode attach --hostname localhost --port 4096`

### Claude Code Subscriber

CLI-per-invocation via SDK. SDK spawns CLI binary internally.

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk'

const response = query({
  prompt: "Hello",
  options: {
    model: 'claude-sonnet-4-5',
    cwd: process.cwd(),
    resume: sessionId,
    allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
    permissionMode: 'acceptEdits',
    abortController,
  }
})

for await (const message of response) {
  // Wrap as iterate:agent:harness:claude:event-received
}
```

**Startup overhead**: ~12 seconds per query (SDK spawns fresh CLI process).

**Global hooks** for CLI sessions (user SSH): Configure in `~/.claude/settings.json` to forward lifecycle events.

**Concurrency warning**: No file locking on sessions. Concurrent SDK + CLI access causes corruption.

TUI resume: `claude --resume <session-id>`

### Pi Subscriber

Long-running subprocess with JSON RPC on stdin/stdout.

```typescript
const process = spawn('pi', ['--mode', 'rpc', '--session', sessionPath])

// Send command
process.stdin.write(JSON.stringify({ type: 'prompt', message: "Hello" }) + '\n')

// Receive events on stdout (NDJSON), wrap as iterate:agent:harness:pi:event-received
```

| Command | Purpose |
|---------|---------|
| `prompt` | Send user message |
| `abort` | Cancel operation |
| `get_state` | Query session state |
| `branch` | Fork from message index |

TUI resume: `pi --session /path/to/session.jsonl`

### Iterate Agent Subscriber

Our own agent implementation. Details TBD—will use mini-agent infrastructure with Effect-based LLM adapter.

### Comparison

| Aspect | OpenCode | Claude Code | Pi | Iterate Agent |
|--------|----------|-------------|-----|---------------|
| Architecture | HTTP/SSE server | CLI per query | stdin/stdout RPC | TBD |
| Concurrent safe | Yes (server) | No (file-based) | No (file-based) | TBD |
| Startup overhead | Server must run | ~12s per query | Process spawn | TBD |
| CLI capture | Built-in (same server) | Global hooks needed | Same process | N/A |

## Tool Injection

Iterate tools registered in each harness using harness-specific mechanisms:

| Harness | Registration |
|---------|-------------|
| OpenCode | Agent config or runtime SDK |
| Claude Code | MCP servers, `--allowedTools` |
| Pi | TypeBox schemas |
| Iterate Agent | Effect Schema directly |

**Approach**: Define tools using Effect Schema, convert to harness-specific format. Long-term: MCP as canonical format where supported.

## TUI Compatibility

Users can SSH into sandbox and use native TUI. When they do:
- From agent's perspective, everything is normal
- Subscriber captures events → appear on SSE stream
- Web UI sees same events

**Handoff protocol**: When TUI attaches, emit `iterate:agent:system:client-attached`. Web UI shows takeover banner, optionally enters read-only mode. On TUI exit, emit `iterate:agent:system:client-detached`, web UI resumes.

## Renderers

Renderers are **bidirectional** stream clients. They can:
1. Subscribe to events via SSE (read)
2. Append new events to the stream (write)

Examples: Web UI, Slack bot, CLI.

```typescript
// Reading events
function handleStreamEvent(event: IterateEvent) {
  if (event.type === "iterate:agent:harness:opencode:event-received") {
    return renderOpenCodeEvent(event.payload)
  }
  if (event.type === "iterate:agent:harness:claude:event-received") {
    return renderClaudeEvent(event.payload)
  }
  if (event.type === "iterate:agent:harness:pi:event-received") {
    return renderPiEvent(event.payload)
  }
  if (event.type === "iterate:agent:harness:iterate:event-received") {
    return renderIterateEvent(event.payload)
  }
  // Show raw event for unknown types
  return renderRawEvent(event)
}

// Writing events (user sends message from Web UI)
async function onUserSubmit(agentId: string, text: string) {
  await stream.append({
    type: "iterate:agent:harness:opencode:action:prompt-requested",
    agentId,
    harness: "opencode",
    data: { content: text, source: "web-ui" }
  })
}
```

Initial implementation: Show all events raw in a feed. Later: Rich rendering for user/assistant messages per harness.

---

## Decisions Made

| Decision | Choice |
|----------|--------|
| Action event persistence | First-class stream events |
| Subscriber cardinality | One global subscriber per harness type |
| Stream topology | One stream per agent instance |
| External event routing | Hardcoded rules in harness subscriber |
| Action namespace | `iterate:agent:harness:{harness}:action:{verb}-requested` |
| Wrapped event naming | Generic `event-received` type, native in payload |
| Renderer capabilities | Bidirectional (read + write) |
| Replay safety | Offset file per subscriber |
| Action execution | At-most-once (fail fast, emit error event) |

---

## Open Questions

### Session Concurrency

**How to prevent file corruption for Claude Code/Pi?**

Ignore for now

### Event Deduplication

Ignore for now

### Process Supervision

**Who manages harness processes?**

- OpenCode: Hybrid auto-daemon (connect to existing, spawn if needed)
- Claude: SDK manages per-query
- Pi: Supervised with auto-restart on crash
- Iterate Agent: TBD

**Health monitoring?**
- Passive exit monitoring + periodic health checks
- Emit structured crash events (`iterate:agent:system:error-occurred`)

### Storage

**Duplication strategy**: We store the full wrapped harness events ourselves, separately to how the harness themselves does it. So technically harness events are stored twice - once by opencode/pi/claude and once wrapped by us.

**Session ID mapping**: Mapping events in stream (`iterate:agent:system:session-mapped`). Need to elaborate on this

