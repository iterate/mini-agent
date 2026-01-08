# Iterate: Agent Harness Bridge Architecture

## Overview

Iterate orchestrates AI coding agents through **durable event streams**. Rather than building a monolithic agent, we create **bridges** that adapt existing agent harnesses (OpenCode, Claude Code, Pi, as well as our own Iterate agent in the future) to our event-driven architecture.

## Terminology

| Term | Definition |
|------|------------|
| **Agent Harness** | A standalone agent runtime (OpenCode, Claude Code, Pi, our own Iterate agent). Handles LLM calls, tool execution, conversation state. |
| **Harness Bridge** | Adapter that connects an agent harness to Iterate's event stream. Reacts to Iterate control events via hooks, wraps harness events with namespace prefix. |
| **Durable Stream** | Append-only event log with offset-based resumption. The source of truth for all agent interactions. |

## Design Principles

### 1. Our Stream is the Superset

Each agent harness (OpenCode, Claude, Pi) has its own internal event format. Our durable stream is a **wrapped superset**:
- Harness events are wrapped verbatim into `iterate:agent:harness:<name>` events
- Control events (`iterate:agent:control:*`) are our own, reacted to by bridge hooks
- External events use source-based naming (`slack:webhook`, `github:pr_comment`) - not wrapped with iterate prefix
- We store everything on our end, even if OpenCode also stores in SQLite

### 2. No Unified Abstraction

We do NOT try to normalize harness events into a common format. The UI must know how to render:
- Claude tool calls in Claude's format
- OpenCode tool calls in OpenCode's format
- Pi events in Pi's format

This avoids lossy translation and keeps full fidelity.

### 3. Native TUI Must Work

Users can SSH into the sandbox and use the native terminal UI (OpenCode, ClaudeCode, Pi). When they do:
- From the agent's perspective, everything is normal
- The bridge captures these events and they appear on our SSE stream
- Our web UI and any other consumers see the same events

### 4. Iterate Tools Available to All Harnesses

We have server-side tools that all agent harnesses should access. The bridge is responsible for injecting/registering these tools with each harness using harness-specific mechanisms.

## Event Design

This section covers event naming, envelope structure, and versioning. These decisions are hard to change later, so we want to get them right.

### Industry Standards & Philosophies

#### CloudEvents (CNCF Standard)

[CloudEvents](https://cloudevents.io/) is the CNCF-graduated standard for describing events. Key concepts:

- **Reverse-DNS type naming**: `com.example.object.deleted`
- **Standard envelope fields**: `type`, `source`, `id`, `time`, `data`
- **Lowercase alphanumeric** attribute names only
- **`source` + `id`** must be unique per event

```json
{
  "specversion": "1.0",
  "type": "com.example.order.created",
  "source": "/orders/service",
  "id": "abc-123",
  "time": "2024-01-15T12:00:00Z",
  "data": { "orderId": "12345" }
}
```

**Pros:** Interoperability with other systems, well-documented, wide tooling support.
**Cons:** Verbose, reverse-DNS feels enterprisey, may be overkill for internal system.

#### Domain-Driven Design (Event Sourcing)

DDD events use **past tense** and **domain language**:

- `OrderPlaced`, `CustomerRegistered`, `PaymentFailed`
- Pattern: `[Noun][PastTenseVerb]`
- Natural language: "Stock was depleted" not "StockDepleted"

**Pros:** Business-readable, self-documenting.
**Cons:** Assumes single domain, doesn't address namespacing across systems.

#### Kafka Topic Naming

[Kafka conventions](https://www.confluent.io/learn/kafka-topic-naming-convention/) use hierarchical dot or underscore:

- `domain.entity.action` or `domain_entity_action`
- Components: domain, classification, description, version
- Example: `sales.orders.created.v1`

**Pros:** Well-suited for broker filtering, explicit versioning.
**Cons:** Topic-centric (not event-type-centric), verbose.

### Separator Trade-offs

| Separator | Example | Pros | Cons |
|-----------|---------|------|------|
| **Colon (:)** | `iterate:agent:opencode` | URL-safe, common in URIs, clear hierarchy | Less common than dots |
| **Dot (.)** | `iterate.agent.opencode` | Most common (Java packages, domains), natural hierarchy | Conflicts with JSON path syntax (`event.type` ambiguous) |
| **Slash (/)** | `iterate/agent/opencode` | Path-like, very clear hierarchy | Needs URL encoding in some contexts |
| **Underscore (_)** | `iterate_agent_opencode` | No special meaning, flat | Hard to distinguish hierarchy levels |

**Recommendation:** **Colon (`:`)** - Clear hierarchy without JSON path conflicts. Widely used in URIs and message protocols. Easy to filter: `type.startsWith("iterate:")`.

### Namespace Structure Options

Given the requirement for 50-200+ event sources, and future routing/broker needs:

#### Option A: `iterate:` prefix for internal, flat for external

```typescript
// Internal events - all prefixed with iterate:
iterate:agent:harness:opencode
iterate:agent:harness:claude
iterate:agent:control:create
iterate:agent:system:ready

// External events - no prefix (raw from outside world)
slack_webhook
github_webhook
```

**Pros:** Clear internal/external boundary.
**Cons:** Mixed conventions (colons vs underscores).

#### Option B: Full hierarchy with `iterate:` everywhere

```typescript
// All iterate-owned events
iterate:agent:harness:opencode
iterate:agent:control:create
iterate:external:slack:webhook
iterate:external:github:webhook
iterate:trigger:cron
```

**Pros:** Consistent structure, easy to filter by any level.
**Cons:** Verbose for external events that we don't "own".

#### Option C: Source-based namespacing (Recommended)

```typescript
// External events - named by source
slack:webhook           // Slack sent this
github:webhook          // GitHub sent this
github:pr_comment       // GitHub PR comment

// Iterate-owned events - prefixed with iterate:
iterate:agent:harness:opencode  // Wrapped OpenCode events
iterate:agent:control:create    // Create agent command
iterate:trigger:cron            // Scheduled trigger
```

**Pros:** Clear provenance - external events are from external sources, not "owned" by iterate.
**Cons:** Two namespacing conventions (but they're semantically different).

#### Option D: Flat with type categories

```typescript
// Flat but categorized
agent_harness_opencode
agent_control_create
webhook_slack
webhook_github
trigger_cron
```

**Pros:** Simple, no hierarchy parsing.
**Cons:** Harder to do prefix filtering, long names.

### Recommendation: Option C (Source-based)

External events should be named by their source, not wrapped with `iterate:`:

```
// External events (from outside world)
slack:webhook                    - Slack webhook payload
slack:command                    - Slack slash command
github:webhook                   - GitHub webhook payload
github:pr_comment                - GitHub PR comment

// Iterate-owned events
iterate:agent:harness:opencode   - Wrapped OpenCode events
iterate:agent:harness:claude     - Wrapped Claude events
iterate:agent:harness:pi         - Wrapped Pi events
iterate:agent:control:create     - Create agent command
iterate:agent:control:destroy    - Destroy agent command
iterate:agent:control:message    - Send message command
iterate:agent:system:ready       - Agent ready notification
iterate:agent:system:error       - Agent error notification
iterate:trigger:cron             - Cron trigger
```

**Why:**
- External events are genuinely from external sources - `slack:webhook` is clearer than `iterate:external:slack:webhook`
- `iterate:` prefix reserved for things we actually own/create
- Still easy to filter: `type.startsWith("iterate:")` for our events, or by source prefix

### Envelope Structure

Durable Streams has no opinion on event structure - it just stores bytes with offsets. We define our own envelope.

**Goals:**
1. Single flat envelope (no nested wrappers)
2. Preserve verbatim external payloads
3. Clear separation: our fields vs their payload
4. Both timestamps: when we received it, when they created it

### Flat vs Nested: Type-Specific Fields

A key design question: should type-specific fields like `agentId` be at the root level or nested?

#### Option: Flat (type-specific fields at root)

```typescript
{
  type: "iterate:agent:harness:opencode",
  version: 1,
  timestamp: 1705312800000,
  agentId: "agent-123",           // At root
  payload: { ... }
}
```

#### Option: Nested (type-specific fields inside data)

```typescript
{
  type: "iterate:agent:harness:opencode",
  version: 1,
  timestamp: 1705312800000,
  data: {
    agentId: "agent-123",         // Nested
    payload: { ... }
  }
}
```

#### Comparison

| Aspect | Flat | Nested |
|--------|------|--------|
| **Access pattern** | `event.agentId` | `event.data.agentId` |
| **Querying/filtering** | Easy - top-level fields | Requires path traversal |
| **Schema clarity** | Mixed concerns at one level | Clear envelope vs content separation |
| **Naming collisions** | Possible (if payload has `type` field) | Impossible - separate namespaces |
| **Database indexing** | Most DBs index top-level better | May need special JSON path indexing |
| **Nesting risk** | None | Can lead to `data.payload.data.x` |

#### Modern Systems Using Flat Structures

- **CloudEvents**: Metadata flat at root, only `data` is nested
- **Stripe webhooks**: Flat structure with `type`, `id`, `created`, then type-specific fields
- **AWS EventBridge**: `source`, `detail-type`, `time` at root, `detail` for payload
- **Segment events**: `type`, `timestamp`, `userId` at root

**Common pattern**: Envelope fields + routing fields at root, opaque payload in one nested field.

#### Recommendation: Flat with Reserved Envelope Fields

Use flat structure but reserve a small set of envelope field names:

```typescript
// Reserved envelope fields (always present or optional on all events)
type: string              // Required
version: number           // Required
timestamp: number         // Required
payload?: unknown         // For external data (mutually exclusive with data)
data?: Record<...>        // For our structured data (mutually exclusive with payload)
metadata?: Record<...>    // Optional debug info

// Type-specific fields at root (varies by event type)
agentId?: string          // For agent events
channel?: string          // For slack events
// etc.
```

**Why flat:**
- Simpler access patterns
- Better database indexing
- Avoids deep nesting (`event.data.agentId` vs `event.agentId`)
- Matches how most modern event systems work

**Collision avoidance:**
- We control our field names
- `payload` is opaque - we never reach into it for routing
- If external payload has a `type` field, it's inside `payload.type`, not `event.type`

#### Envelope Schema

```typescript
interface IterateEvent {
  // === Durable Streams fields (protocol-level) ===
  offset: Offset                    // Assigned by durable-streams

  // === Iterate envelope fields (always present) ===
  type: string                      // e.g. "iterate:agent:harness:opencode"
  version: number                   // Envelope schema version (start at 1)
  timestamp: number                 // Our timestamp (when we received/created)

  // === Type-specific fields at root ===
  agentId?: string                  // For agent events
  // ... other type-specific fields as needed

  // === Payload (mutually exclusive) ===
  payload?: unknown                 // Verbatim external data (harness event, webhook body)
  data?: Record<string, unknown>    // Our structured data (for control/system events)

  // === Optional ===
  metadata?: Record<string, unknown>  // Debug info, correlation IDs, etc.
}
```

#### Two Timestamps

When wrapping external events (harness or webhook):

```typescript
{
  type: "iterate:agent:harness:opencode",
  version: 1,
  timestamp: 1705312800000,  // When we received it
  agentId: "agent-123",
  payload: {
    // Verbatim OpenCode event - may have its own timestamp
    type: "Session.Message.Created",
    timestamp: 1705312799500,  // When OpenCode created it
    sessionId: "sess-456",
    message: { ... }
  }
}
```

- `timestamp`: When Iterate received/processed the event
- `payload.timestamp` (or similar): When the source created it

Both are useful - `timestamp` for ordering in our stream, `payload.timestamp` for understanding actual event time.

### Versioning Strategies

Since this is an append-only log, we can't update old events. Versioning options:

#### Strategy 1: Version in Type Name

```typescript
iterate:agent:harness:opencode:v1
iterate:agent:harness:opencode:v2
```

**Pros:** Explicit, easy to filter by version.
**Cons:** Type proliferation, harder to query "all opencode events".

#### Strategy 2: Version Field in Envelope

```typescript
{
  type: "iterate:agent:harness:opencode",
  version: 1,  // Envelope version
  ...
}
```

**Pros:** Type stays stable, consumers check `version` field.
**Cons:** Need to handle multiple versions at runtime.

#### Strategy 3: Semantic Versioning with Breaking Change Policy

- Minor changes (adding optional fields): No version bump
- Breaking changes: Bump `version`, document migration

#### Strategy 4: Never Version, Only Evolve

- Only add optional fields
- Never remove or change field semantics
- If breaking change needed, create new event type entirely

### Recommendation: Strategy 2 + 3

1. **`version` field in envelope** - start at `1`
2. **Minor changes**: Add optional fields, don't bump
3. **Breaking changes**: Bump `version`, emit both versions during transition
4. **Consumer rule**: Ignore unknown fields, fail on unknown `version` > supported

```typescript
// Consumer code
function handleEvent(event: IterateEvent) {
  if (event.version > SUPPORTED_VERSION) {
    log.warn(`Unknown event version ${event.version}, skipping`)
    return
  }
  // Process based on type and version
}
```

### Event Type Summary

| Category | Type | Description |
|----------|------|-------------|
| **Agent harness** | `iterate:agent:harness:opencode` | Wrapped OpenCode event |
| | `iterate:agent:harness:claude` | Wrapped Claude event |
| | `iterate:agent:harness:pi` | Wrapped Pi event |
| | `iterate:agent:harness:iterate` | Our own agent (future) |
| **Agent control** | `iterate:agent:control:create` | Create agent command |
| | `iterate:agent:control:destroy` | Destroy agent command |
| | `iterate:agent:control:message` | Send message to agent |
| **Agent system** | `iterate:agent:system:ready` | Agent ready |
| | `iterate:agent:system:stopped` | Agent stopped |
| | `iterate:agent:system:error` | Agent error |
| **External** | `slack:webhook` | Slack webhook |
| | `slack:command` | Slack slash command |
| | `github:webhook` | GitHub webhook |
| | `github:pr_comment` | GitHub PR comment |
| **Triggers** | `iterate:trigger:cron` | Scheduled trigger |
| | `iterate:trigger:manual` | Manual trigger |

### Example Events

```typescript
// Agent harness event (verbatim payload)
{
  type: "iterate:agent:harness:opencode",
  version: 1,
  timestamp: 1705312800000,
  agentId: "agent-123",
  payload: {
    type: "Session.Message.Created",
    timestamp: 1705312799500,
    sessionId: "sess-456",
    message: { role: "assistant", parts: [...] }
  }
}

// Agent control event (our data)
{
  type: "iterate:agent:control:create",
  version: 1,
  timestamp: 1705312700000,
  data: {
    agentId: "agent-123",
    harness: "opencode",
    config: { model: "claude-3", workingDirectory: "/workspace" }
  }
}

// External webhook (verbatim payload, source-based naming)
{
  type: "slack:webhook",
  version: 1,
  timestamp: 1705312900000,
  payload: {
    type: "message",
    channel: "C123",
    user: "U456",
    text: "Hello agent",
    ts: "1705312899.000100"  // Slack's timestamp format
  }
}
```

## Agent Lifecycle

Agents don't magically exist. The stream starts empty, and agents are created via control events.

### Creating an Agent

```typescript
{
  type: "iterate:agent:control:create",
  version: 1,
  timestamp: 1705312700000,
  data: {
    agentId: "agent-123",
    harness: "opencode" | "claude" | "pi" | "iterate",
    config: {
      model?: string,
      workingDirectory: string,
      tools?: string[],  // Iterate tools to inject
    }
  }
}
```

### Agent Ready

```typescript
{
  type: "iterate:agent:system:ready",
  version: 1,
  timestamp: 1705312750000,
  agentId: "agent-123",
  data: {
    harness: "opencode",
    pid?: number,
    endpoint?: string,  // For server-based harnesses
  }
}
```

### Example: Full Agent Creation Flow

```typescript
// 1. Control event requests agent creation
{ type: "iterate:agent:control:create", version: 1, timestamp: ..., data: { agentId: "agent-123", harness: "opencode", config: {...} } }

// 2. System event confirms agent is ready
{ type: "iterate:agent:system:ready", version: 1, timestamp: ..., agentId: "agent-123", data: { harness: "opencode", pid: 12345 } }

// 3. Control event sends a message
{ type: "iterate:agent:control:message", version: 1, timestamp: ..., agentId: "agent-123", data: { content: "Hello agent" } }

// 4. Agent harness emits events (verbatim OpenCode payload)
{ type: "iterate:agent:harness:opencode", version: 1, timestamp: ..., agentId: "agent-123", payload: { type: "Session.Message.Created", ... } }
{ type: "iterate:agent:harness:opencode", version: 1, timestamp: ..., agentId: "agent-123", payload: { type: "Session.Message.Updated", ... } }

// 5. Eventually agent completes or is destroyed
{ type: "iterate:agent:control:destroy", version: 1, timestamp: ..., agentId: "agent-123", data: {} }
{ type: "iterate:agent:system:stopped", version: 1, timestamp: ..., agentId: "agent-123", data: { reason: "requested" } }
```

## Harness Bridge Architecture

The bridge is **hooks-based**, not translation-based. It reacts to control events by calling harness-specific imperative APIs, and wraps harness output into our event format.

```typescript
interface HarnessBridge {
  readonly harness: "opencode" | "claude" | "pi"

  /** React to agent control events */
  hooks: {
    /** Called on iterate:agent:control:create for this harness type */
    onCreateAgent(agentId: string, config: AgentConfig): Effect<void, BridgeError>

    /** Called on iterate:agent:control:message targeting this agent */
    onMessage(agentId: string, content: string): Effect<void, BridgeError>

    /** Called on iterate:agent:control:destroy */
    onDestroyAgent(agentId: string): Effect<void, BridgeError>
  }

  /** Subscribe to harness's native event stream for an agent */
  subscribeToHarness(agentId: string): Stream<unknown>  // unknown = verbatim harness event

  /** Wrap harness event into our format */
  wrapEvent(agentId: string, nativeEvent: unknown): IterateEvent
  // Returns: { type: "iterate:agent:harness:opencode", version: 1, timestamp: ..., agentId, payload: nativeEvent }

  /** Inject Iterate tools into the harness */
  injectTools(agentId: string, tools: IterateTool[]): Effect<void, BridgeError>
}
```

### Event Flow

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              Durable Stream                                       │
│  [iterate:agent:control:*] [iterate:agent:harness:*] [slack:*] [github:*]        │
└──────────────────────────────────────┬───────────────────────────────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
              ▼                        ▼                        ▼
      ┌───────────────┐        ┌───────────────┐        ┌───────────────┐
      │ OpenCode      │        │ Claude Code   │        │ Pi Bridge     │
      │ Bridge        │        │ Bridge        │        │               │
      │               │        │               │        │               │
      │ hooks.on*()   │        │ hooks.on*()   │        │ hooks.on*()   │
      └───────┬───────┘        └───────┬───────┘        └───────┬───────┘
              │                        │                        │
              ▼                        ▼                        ▼
      ┌───────────────┐        ┌───────────────┐        ┌───────────────┐
      │ OpenCode      │        │ Claude Code   │        │ Pi Process    │
      │ Server        │        │ CLI/SDK       │        │ (RPC)         │
      │               │        │               │        │               │
      │ (SQLite,      │        │ (stream-json) │        │ (stdin/stdout)│
      │  Event Bus)   │        │               │        │               │
      └───────────────┘        └───────────────┘        └───────────────┘
```

### Control Event → Imperative API

When `iterate:agent:control:message` arrives:

1. Bridge hook `onMessage` fires for the target agent
2. Hook calls harness-specific imperative API:
   - **OpenCode**: POST to event bus / SDK call
   - **Claude**: Spawn CLI with `-p` flag or SDK call
   - **Pi**: Write JSON to stdin `{ command: "prompt", message: "..." }`
3. Harness processes and emits its own events
4. Bridge captures and wraps into `iterate:agent:harness:<name>` event

### Harness Event → Wrapped in Stream

When harness emits an event:

1. Bridge `subscribeToHarness()` receives native event (verbatim)
2. Bridge `wrapEvent()` wraps it with envelope fields
3. Appended to durable stream
4. SSE consumers (web UI, etc.) receive it

```typescript
// OpenCode native event (verbatim, we don't touch it)
{
  type: "Session.Message.Created",
  timestamp: 1705312799500,
  sessionId: "sess-456",
  message: { role: "assistant", parts: [...] }
}

// Wrapped in our stream
{
  type: "iterate:agent:harness:opencode",
  version: 1,
  timestamp: 1705312800000,  // Our timestamp
  agentId: "agent-123",
  payload: {
    type: "Session.Message.Created",
    timestamp: 1705312799500,  // Their timestamp (preserved)
    sessionId: "sess-456",
    message: { role: "assistant", parts: [...] }
  }
}
```

The `payload` is byte-for-byte identical to what the harness emitted. UI must understand OpenCode's native event format to render it.

## Process Management

### Open Question: Who Manages Agent Processes?

Different harnesses have different process models:

| Harness | Process Model | Management |
|---------|---------------|------------|
| **OpenCode** | Long-running server, multiple sessions | One server per sandbox, sessions multiplexed |
| **Claude Code** | CLI invocation or SDK | Per-request CLI or persistent SDK connection |
| **Pi** | Per-agent RPC process | One process per agent, stdin/stdout |

**Questions to resolve:**
1. Does Iterate spawn/supervise these processes, or assume they're running?
2. For OpenCode server model: one server shared by multiple "agents" (sessions)?
3. For Pi: one process per agent, managed by Iterate?
4. What happens on crash/restart?

### Sketch: Process Supervisor

```typescript
interface ProcessSupervisor {
  /** Ensure harness process is running */
  ensureRunning(harness: HarnessType, agentId: string): Effect<ProcessHandle, SupervisorError>

  /** Stop a specific agent's process */
  stop(agentId: string): Effect<void, SupervisorError>

  /** Handle process crashes */
  onCrash(agentId: string, reason: unknown): Effect<void>
}
```

### OpenCode: Server Model

```
┌─────────────────────────────────────────┐
│           OpenCode Server               │
│  (one per sandbox)                      │
│                                         │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │Session 1│ │Session 2│ │Session 3│   │
│  │(Agent A)│ │(Agent B)│ │(Agent C)│   │
│  └─────────┘ └─────────┘ └─────────┘   │
│                                         │
│  SQLite DB    Event Bus                 │
└─────────────────────────────────────────┘
         │
         ▼
   OpenCode Bridge
   (subscribes to event bus,
    reacts to iterate:agent:control:* by
    creating sessions / sending messages,
    emits iterate:agent:harness:opencode events)
```

### Pi: Per-Agent Process Model

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  Pi Process     │  │  Pi Process     │  │  Pi Process     │
│  (Agent A)      │  │  (Agent B)      │  │  (Agent C)      │
│                 │  │                 │  │                 │
│  stdin ◀────────│  │  stdin ◀────────│  │  stdin ◀────────│
│  stdout ────────▶  │  stdout ────────▶  │  stdout ────────▶
│                 │  │                 │  │                 │
│  JSONL session  │  │  JSONL session  │  │  JSONL session  │
└─────────────────┘  └─────────────────┘  └─────────────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             ▼
                       Pi Bridge
                 (manages process lifecycle,
                  emits iterate:agent:harness:pi events)
```

## Tool Injection

Iterate has server-side tools that should be available to all agents. Each harness has different mechanisms:

| Harness | Tool Registration |
|---------|-------------------|
| **OpenCode** | Agent config in markdown, or runtime injection via SDK |
| **Claude Code** | `--allowedTools` flag, MCP servers, custom tool definitions |
| **Pi** | TypeBox tool schemas passed to agent runtime |

The bridge must:
1. Convert Iterate tool definitions to harness-specific format
2. Register/inject at agent creation time
3. Handle tool calls that route back to Iterate server

## Consumer Clients

Multiple clients subscribe to the durable stream via SSE:

```
                         Durable Stream
                               │
             ┌─────────────────┼─────────────────┐
             │                 │                 │
             ▼                 ▼                 ▼
       ┌──────────┐      ┌──────────┐      ┌──────────┐
       │ Web UI   │      │ Terminal │      │ Slack    │
       │          │      │ UI       │      │ Bot      │
       │ Renders: │      │          │      │          │
       │ iterate: │      │ Renders: │      │ Posts    │
       │ agent:   │      │ all      │      │ replies  │
       │ harness: │      │ events   │      │          │
       │ *        │      │          │      │          │
       └──────────┘      └──────────┘      └──────────┘
```

Each client must understand the native event formats inside `payload` - no translation layer.

### Example: Web UI Event Handler

```typescript
function handleStreamEvent(event: IterateEvent) {
  // Check version compatibility
  if (event.version > SUPPORTED_VERSION) {
    console.warn(`Unknown event version ${event.version}`)
    return
  }

  // Route by type prefix
  if (event.type.startsWith("iterate:agent:harness:")) {
    const harness = event.type.split(":")[3]  // opencode, claude, pi
    switch (harness) {
      case "opencode":
        renderOpenCodeEvent(event.payload)
        break
      case "claude":
        renderClaudeEvent(event.payload)
        break
      case "pi":
        renderPiEvent(event.payload)
        break
    }
  } else if (event.type.startsWith("iterate:agent:system:")) {
    renderSystemEvent(event)
  } else if (event.type.startsWith("slack:") || event.type.startsWith("github:")) {
    // External webhook - show notification or route to handler
    renderExternalEvent(event)
  }
}
```

## Agent Harness Comparison

| Feature | OpenCode | Claude Code | Pi |
|---------|----------|-------------|-----|
| **Process Model** | Server (multi-session) | CLI or SDK | Per-agent process |
| **Event Format** | BusEvent + MessageV2 | stream-json NDJSON | JSON RPC events |
| **State Storage** | SQLite | Per-session ID | JSONL tree |
| **Tool Definition** | Markdown agent config | MCP / allowedTools | TypeBox schemas |
| **Programmatic Control** | Event Bus / SDK | `-p` flag / SDK | stdin JSON commands |
| **Native TUI** | Yes (Bubble Tea) | Yes | Yes |

### Message Format Comparison

**User Input:**
| Harness | Format |
|---------|--------|
| **OpenCode** | `{ role: "user", parts: [{ type: "text", text }] }` |
| **Claude** | CLI arg, stdin, or SDK Message object |
| **Pi** | `{ command: "prompt", message: string }` |

**Assistant Output:**
| Harness | Format |
|---------|--------|
| **OpenCode** | `{ role: "assistant", parts: [...], tokens, cost, finish }` |
| **Claude** | NDJSON with `type: "assistant"` |
| **Pi** | `message_update` / `turn_end` events |

**Tool Calls:**
| Harness | Format |
|---------|--------|
| **OpenCode** | `{ type: "toolCall", name, args }` in parts array |
| **Claude** | `{ type: "tool_use", name, input }` |
| **Pi** | `tool_execution_start` event with toolName, args |

## Concrete Bridge Implementations

Three dominant patterns for programmatically controlling AI coding agents: **HTTP/SSE servers** (OpenCode), **CLI subprocess with streaming JSON** (Claude Code), and **stdin/stdout RPC** (Pi). All preserve TUI compatibility through session file persistence.

### OpenCode Bridge

OpenCode implements a **client-server architecture** where the TUI communicates with an internal HTTP server.

#### Starting the Server

```bash
opencode serve --port 4096
```

Exposes an OpenAPI 3.1-compliant REST API at `http://localhost:4096/doc`.

#### Key Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/session` | GET/POST | List or create sessions |
| `/session/:id/prompt` | POST | Send message, wait for response |
| `/session/:id/prompt_async` | POST | Send message, stream via SSE |
| `/session/:id/abort` | POST | Cancel running operation |
| `/global/health` | GET | Health check |
| `/event` | GET | SSE event stream |

#### TypeScript Bridge

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk"

class OpenCodeBridge {
  private client: ReturnType<typeof createOpencodeClient>

  constructor(baseUrl = "http://localhost:4096") {
    this.client = createOpencodeClient({ baseUrl })
  }

  async *subscribeToEvents() {
    const events = await this.client.event.subscribe()
    for await (const event of events.stream) {
      yield {
        type: `iterate:agent:harness:opencode`,
        version: 1,
        timestamp: Date.now(),
        agentId: event.sessionId,
        payload: event
      }
    }
  }

  async sendMessage(sessionId: string, text: string) {
    return this.client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text }] }
    })
  }

  async createSession() {
    return this.client.session.create({})
  }

  async abort(sessionId: string) {
    return this.client.session.abort({ path: { id: sessionId } })
  }
}
```

#### TUI Compatibility

Multiple TUI clients can connect to same server simultaneously:

```bash
opencode attach --hostname localhost --port 4096
```

#### Session Storage

Sessions persist as JSON files in `~/.local/share/opencode/project/<project-slug>/storage/session/`.

### Claude Code Bridge

Claude Code uses a **CLI-per-invocation** model. The TypeScript SDK (`@anthropic-ai/claude-agent-sdk`) spawns the CLI binary as a subprocess internally, so SDK and CLI sessions are identical and fully interoperable.

#### Architecture

```
Your Daemon
    │
    ├─── SDK query() ───► Spawns: claude --output-format stream-json ...
    │                         │
    │                         ├─► Writes to ~/.claude/projects/<path>/<session>.jsonl
    │                         │
    │                         └─► Triggers global hooks (if configured)
    │
    └─── Receives events via:
              • SDK async generator (from spawned process)
              • Global hooks (from any Claude process, including user CLI)
```

#### TypeScript Bridge

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk'

class ClaudeCodeBridge extends EventEmitter {
  private sessionId: string | null = null
  private abortController: AbortController | null = null

  async startSession(prompt: string, options: {
    resume?: string
    cwd?: string
    allowedTools?: string[]
  } = {}): Promise<string> {
    this.abortController = new AbortController()

    const response = query({
      prompt,
      options: {
        model: 'claude-sonnet-4-5',
        cwd: options.cwd || process.cwd(),
        resume: options.resume,
        allowedTools: options.allowedTools || ['Read', 'Write', 'Edit', 'Bash'],
        permissionMode: 'acceptEdits',
        abortController: this.abortController,
        settingSources: ['project'],
      }
    })

    for await (const message of response) {
      if (message.session_id) this.sessionId = message.session_id

      this.emit('event', {
        type: `iterate:agent:harness:claude`,
        version: 1,
        timestamp: Date.now(),
        agentId: this.sessionId,
        payload: message
      })
    }

    return this.sessionId!
  }

  interrupt(): void {
    this.abortController?.abort()
  }
}
```

#### Performance Note

SDK spawns a fresh CLI process for each `query()` call: **~12 second overhead** per query. Mitigations:
- Batch work into fewer, longer sessions
- Use raw Anthropic Messages API for simple queries
- Accept startup cost for agentic workflows

#### Global Hooks for CLI Sessions

The SDK captures events for sessions *you* initiate. For events from user CLI sessions (SSH TUI), configure global hooks in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{ "type": "command", "command": "/path/to/hook-forwarder.ts SessionStart" }]
    }],
    "PreToolUse": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "/path/to/hook-forwarder.ts PreToolUse" }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "/path/to/hook-forwarder.ts PostToolUse" }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "/path/to/hook-forwarder.ts Stop" }]
    }]
  }
}
```

**Critical limitation**: Hooks cannot capture streaming text chunks - only discrete lifecycle events.

#### Hook Events Reference

| Hook | When it Fires | Can Block? |
|------|---------------|------------|
| `SessionStart` | Session begins | No |
| `SessionEnd` | Session ends | No |
| `UserPromptSubmit` | User sends message | No |
| `PreToolUse` | Before tool executes | Yes (exit 2) |
| `PostToolUse` | After tool completes | No |
| `Stop` | Agent turn complete | No |

#### Concurrent Access Warning

**No file locking on session files.** Running multiple processes on same session causes corruption. Must:
1. Track which sessions are "active"
2. Reject concurrent access attempts
3. Allow resumption only after previous query completes

If user SSHes in and runs `claude --resume` on active SDK session: **corruption will occur**.

#### TUI Compatibility

```bash
claude --resume <session-id>    # Resume specific session
claude --continue               # Resume most recent in current directory
```

#### Session Storage

Sessions: `~/.claude/projects/<encoded-path>/<session-id>.jsonl`
Path encoding: `/home/user/myproject` → `-home-user-myproject`

### Pi Bridge

Pi uses the simplest model: a **long-running subprocess** with JSON commands on stdin and events on stdout.

#### TypeScript Bridge

```typescript
import { spawn, ChildProcess } from 'child_process'
import { createInterface } from 'readline'

class PiBridge extends EventEmitter {
  private process: ChildProcess
  private sessionPath: string | null

  constructor(options: { sessionPath?: string } = {}) {
    super()

    const args = ['--mode', 'rpc']
    if (options.sessionPath) {
      args.push('--session', options.sessionPath)
      this.sessionPath = options.sessionPath
    }

    this.process = spawn('pi', args, {
      stdio: ['pipe', 'pipe', 'inherit']
    })

    const rl = createInterface({ input: this.process.stdout! })
    rl.on('line', (line) => {
      const event = JSON.parse(line)
      this.emit('event', {
        type: `iterate:agent:harness:pi`,
        version: 1,
        timestamp: Date.now(),
        agentId: this.sessionPath,
        payload: event
      })
    })
  }

  async prompt(message: string): Promise<void> {
    this.process.stdin!.write(JSON.stringify({ type: 'prompt', message }) + '\n')
  }

  async abort(): Promise<void> {
    this.process.stdin!.write(JSON.stringify({ type: 'abort' }) + '\n')
  }

  kill(): void {
    this.process.kill()
  }
}
```

#### RPC Commands Reference

| Command | Purpose | Response |
|---------|---------|----------|
| `prompt` | Send user message | Streams events, ends with `turn_end` |
| `abort` | Cancel current operation | Confirmation |
| `get_state` | Query session state | State object |
| `get_messages` | Get message history | Message array |
| `branch` | Fork from message index | New branch created |
| `switch_session` | Load different session | Confirmation |

#### TUI Compatibility

```bash
pi --continue              # Resume most recent session
pi --resume                # Interactive session picker
pi --session /path/to.jsonl  # Load specific session file
```

#### Session Storage

Sessions: `~/.pi/agent/sessions/` as JSONL with tree structure (`id`/`parentId` for branching).

### Bridge Comparison Summary

| Aspect | OpenCode | Claude Code | Pi |
|--------|----------|-------------|-----|
| **Architecture** | HTTP/SSE server | CLI per query + SDK | stdin/stdout RPC |
| **Event source** | SSE endpoint | SDK async generator + hooks | stdout NDJSON |
| **Session ID format** | API-assigned | UUID from `session_id` | File path |
| **TUI attach** | `opencode attach` | `claude --resume` | `pi --session` |
| **Concurrent safe** | Yes (server) | No (file-based) | No (file-based) |
| **Interruption** | `abort()` API | `AbortController` | `abort` command |
| **Startup overhead** | Server must be running | ~12s per query | Process spawn |
| **CLI event capture** | Built-in (same server) | Global hooks needed | Same process |

### TUI Compatibility Guarantee

All three harnesses preserve TUI compatibility through their native session storage:

- **OpenCode**: Multiple TUIs can attach to same server simultaneously
- **Claude Code**: Sessions in `~/.claude/projects/` accessible via `claude --resume`
- **Pi**: Sessions in `~/.pi/agent/sessions/` accessible via `pi --session`

Bridge design principles:
1. Let harness manage its own session storage (don't intercept or modify)
2. Capture session identifiers and expose them for TUI resumption
3. Prevent concurrent programmatic access to same session
4. Allow users to "take over" in TUI by terminating programmatic access first

When something goes wrong in web UI, users can SSH in, run native TUI command with session ID, and continue exactly where things left off.

## Open Questions

Comprehensive list of implementation decisions with multiple solutions. Each question includes recommended approach.

---

### Session Management & Concurrency

#### 1. How to prevent file corruption for Claude Code/Pi sessions without built-in locking?

Claude Code SDK/CLI uses file-based sessions (JSONL) with NO built-in file locking. Concurrent access from SDK and TUI (`claude --resume`) causes corruption.

**Solution A: Advisory Lock File (`.lock` suffix)** ⭐ Recommended
- Bridge creates `<session-id>.lock` file before read/write
- Use `flock` (POSIX) with timeout
- Release lock after operation completes
- Requires Claude CLI to also implement locking (may need upstream patch)

**Solution B: Single Owner with Event Queue**
- Bridge maintains single `SessionManager` process per session
- All access routed through manager via IPC queue
- Manager serializes all reads/writes
- More complex architecture but guaranteed serialization

**Solution C: Copy-on-Write Sessions**
- SDK operates on `.sdk` copy, TUI on `.tui` copy
- Bridge periodically merges into canonical file
- No blocking, but complex merge logic and storage overhead (3x)

**Solution D: Event-Sourced Writes**
- SDK only reads session files, never writes
- All mutations go through durable stream as control events
- Bridge applies events atomically
- Major architectural change

#### 2. Session locking strategy - lease-based vs ownership transfer?

User SSHes in and runs `claude --resume` on session actively used by SDK. Who "owns" the session?

**Solution A: Lease-Based with Heartbeat**
- Session lock acquired as timed lease (30s)
- Lock holder sends heartbeat every 10s to renew
- Missed heartbeat = lock expires
- Automatic recovery from crashed processes

**Solution B: Explicit Handoff Protocol** ⭐ Recommended
- SDK holds session, user types `claude --resume`
- TUI sends `iterate:agent:control:request_ownership` event
- Bridge gracefully pauses SDK, releases lock
- Emits `iterate:agent:system:ownership_transferred`
- Clean handoff, no race conditions, audit trail

**Solution C: Read-Only Observer Mode**
- TUI launches in "observer" mode if session locked by SDK
- User sees live updates but cannot send messages
- User types `/takeover` command to trigger handoff

#### 3. How to amortize 12-second Claude Code SDK startup overhead?

**Solution A: Long-Lived SDK Daemon per Session**
- Bridge spawns SDK process once, keeps alive for session lifetime
- Queries sent via stdin/IPC
- Near-instant response time after first query
- Memory overhead (one daemon per active session)

**Solution B: Connection Pool with Session Affinity**
- Maintain pool of N warm SDK processes
- Incoming query assigned to idle process from pool
- LRU eviction when pool full
- Bounded resource usage

**Solution C: Lazy Initialization with Prompt Queue**
- User sends message → immediately returns "Initializing agent..."
- SDK starts in background (12s)
- Subsequent messages queued during startup
- Poor UX for first message

**Solution D: Pre-Warmed SDK on Agent Create** ⭐ Recommended
- `iterate:agent:control:create` triggers immediate SDK spawn
- SDK starts loading context before any user messages
- By the time user types first message, SDK likely ready
- Best UX, explicit lifecycle management

---

### Event Streaming & Format

#### 4. Event deduplication between SDK and hook events?

When using both SDK async generators AND global hooks for same harness, events may appear twice. Both get wrapped into `iterate:agent:harness:claude` and appended.

**Solution A: Hash-Based Deduplication** ⭐ Recommended
- Generate deterministic IDs from content hash
- Deduplicate at append time via before-append hook
- TTL cache of recent event IDs (last 1000 events)
- Works for any event source, idempotent appends

**Solution B: Event Source Tagging**
- Tag events with source (`sdk` vs `hook`)
- Suppress hook events if SDK is active for session
- Requires per-harness coordination logic

**Solution C: Offset-Based Windowed Deduplication**
- Store recent event content (last N offsets)
- Check for duplicates within window
- Bounded memory, transparent to sources

#### 5. Timestamp reconciliation - our time vs harness time vs LLM time?

Three different timestamp sources with different semantics.

**Solution A: Multi-Timestamp Envelope** ⭐ Recommended
- Store all three timestamps in event
- Use Iterate time (`timestamp`) for ordering
- Expose harness/LLM times in `metadata` for debugging
- Can compute latencies: `harnessToIterate`, `llmToHarness`

```typescript
interface IterateEvent {
  timestamp: number           // PRIMARY - for ordering
  payload: {
    timestamp?: number        // Harness emit time
  }
  metadata?: {
    llmTimestamp?: number
    latencies?: { harnessToIterate: number }
  }
}
```

**Solution B: Iterate Time Only**
- Only `timestamp` at envelope level
- Harness/LLM times stay in payload as opaque data
- Simpler but less debuggable

#### 6. Capturing streaming text from Claude Code when user is in native TUI?

SDK sessions yield streaming chunks, but CLI hooks can't capture streaming text. When user uses TUI directly, streaming invisible to hooks.

**Solution A: PTY Wrapper Interception**
- Wrap CLI in pseudo-terminal
- Parse ANSI output to reconstruct streaming chunks
- No harness changes needed
- Brittle, high overhead, false positives risk

**Solution B: Patch Claude Code for Streaming Hooks**
- Fork or patch Claude Code with `onStreamingChunk` hook
- Clean first-class streaming support
- Requires maintaining fork or upstreaming

**Solution C: Dual-Path Hybrid** ⭐ Recommended
- SDK for Iterate-initiated sessions (full streaming)
- Lifecycle-only capture for user CLI sessions
- Document limitation: "Streaming text visible in web UI for SDK sessions; CLI sessions show lifecycle events only"
- Pragmatic, no brittle parsing

---

### Process Lifecycle & Supervision

#### 7. OpenCode server ownership - who starts and manages the server process?

**Solution A: User-Managed Server (Assume Running)**
- Iterate connects to existing server via config
- User controls lifecycle (systemd, Docker, manual)
- Simple for Iterate, poor developer experience

**Solution B: Iterate Spawns and Supervises Server**
- Process supervisor launches OpenCode server on first agent creation
- Keeps alive, restarts on crashes
- Better UX but Iterate must manage external binary

**Solution C: Hybrid Auto-Daemon Pattern** ⭐ Recommended
- Attempt to connect to existing server
- Spawn local daemon if none found
- User can override with `OPENCODE_SERVER_URL` env var
- Matches durable-streams pattern, best of both worlds

#### 8. Pi process supervision strategy?

**Solution A: Basic Spawn with Manual Restart**
- Spawn Pi process when agent created, kill on destroy
- If Pi crashes, agent unavailable until user recreates
- Simplest but poor reliability

**Solution B: Supervised with Automatic Restart** ⭐ Recommended
- Monitor Pi process health via heartbeat/stderr
- Automatically restart on crash, emit system events
- Implement backoff/retry, circuit breaker (max restarts)
- Resilient to transient failures

**Solution C: Supervised with Manual Restart**
- Detect and notify on crashes
- Require explicit restart command
- Good for debugging but higher user burden

#### 9. Health monitoring mechanism for agent processes?

**Solution A: Passive - Monitor Process Exit Events Only**
- Listen to `process.on('exit')` events
- Zero overhead but doesn't detect hangs/zombies

**Solution B: Active Heartbeat via RPC Ping**
- Periodic ping to RPC processes
- Expect pong within timeout
- Detects hangs, measures latency
- Overhead from periodic messages

**Solution C: Hybrid** ⭐ Recommended
- Passive exit monitoring (immediate crash detection)
- Plus 60s health checks (hang detection)
- Emit structured events with crash reason

---

### TUI Compatibility & Handoff

#### 10. Handoff protocol when user transitions from web UI to native TUI?

**Solution A: Passive Handoff (No Coordination)**
- No explicit handoff, both clients see all events via SSE
- Race conditions, confusing UX

**Solution B: Explicit Handoff with Lock File**
- `.iterate/active-client` file indicates which client has control
- Web UI checks before sending, warns if TUI active
- Stale lock file risk if TUI crashes

**Solution C: Graceful Takeover with Warning** ⭐ Recommended
- TUI launches → emit `iterate:agent:system:client-attached` event
- Web UI shows takeover banner, remains functional (read-only or warnings)
- Explicit signal without hard locks

```typescript
{
  type: "iterate:agent:system:client-attached",
  agentId: "agent-123",
  data: {
    clientType: "tui",
    clientId: "opencode-tty",
    pid: 12345
  }
}
```

#### 11. Should handoff be graceful (coordinate) or forced (take over immediately)?

**Solution A: Forced Takeover**
- TUI just works, no handoff protocol
- Race conditions, confusing UX when both sending

**Solution B: Graceful Handoff with Pause** ⭐ Recommended
- When TUI attaches, web UI enters "paused" state
- Shows banner, disables input until TUI detaches
- Clear state machine: web-active → tui-active → transitioning

**Solution C: Collaborative Mode with Input Tagging**
- Both clients remain active
- All inputs tagged with `clientId`
- UI shows who sent what
- Good for pair debugging

#### 12. How does programmatic control resume after user exits TUI?

**Solution A: Automatic Reactivation** ⭐ Recommended
- TUI process exits → bridge emits `client-detached` event
- Web UI automatically resumes
- Seamless, no manual intervention

**Solution B: Explicit Resume Command**
- User must run `iterate resume <agent-id>` or click "Resume Control"
- More explicit but extra step

**Solution C: Session Timeout with Auto-Resume**
- If no TUI activity for N minutes, auto-resume web
- Handles crashes gracefully but timeout tuning tricky

---

### Tool Injection & Routing

#### 13. Tool definition format conversion across harnesses?

Each harness has different tool registration formats.

**Solution A: Schema-First with Format Adapters** ⭐ Recommended for MVP
- Define tools using `@effect/ai/Tool` (Effect Schema)
- Adapt to each format via converter functions
- Single source of truth, type-safe

```typescript
interface ToolFormatAdapter {
  toOpenCode(tool: IterateTool): OpenCodeToolDef
  toClaudeCode(tool: IterateTool): ClaudeToolDef
  toPi(tool: IterateTool): TypeBoxSchema
  toMcp(tool: IterateTool): McpToolDef
}
```

**Solution B: MCP-Native with Converters** ⭐ Recommended long-term
- Use MCP tool schema as canonical format
- Convert to harness-specific on demand
- MCP is emerging standard (Anthropic-backed)
- Future-proof as harnesses adopt MCP natively

#### 14. MCP server vs native tool injection?

**Solution A: MCP Server (Harnesses Connect to Iterate)**
- Run Iterate as MCP server
- Harnesses that support MCP connect via protocol
- Works immediately with Claude Code
- Not all harnesses support MCP yet

**Solution B: Native Injection via Harness APIs**
- Inject tools using each harness's native mechanism
- Works with all harnesses
- N implementations (one per harness)

**Solution C: Hybrid (MCP + Native Fallback)** ⭐ Recommended
- Use MCP where supported (Claude Code)
- Fall back to native injection otherwise (Pi, OpenCode)
- Best of both worlds, future-proof

#### 15. Tool call interception and routing to Iterate server?

Some tools need Iterate state (event stream access).

**Solution A: Bridge Subscribes to Harness Events, Intercepts**
- Bridge listens to harness event stream
- Intercepts tool call events, executes on Iterate side, injects result back
- Race conditions if harness executes locally first

**Solution B: Tool Handlers are HTTP Endpoints** ⭐ Recommended for native injection
- Register tools where handler is HTTP call to Iterate
- Harness executes HTTP call directly
- Simple request/response model

**Solution C: MCP Protocol Routing** ⭐ Recommended for MCP path
- Using MCP, routing is built-in
- Harness calls tool via MCP protocol → routes to server
- Zero custom routing logic

---

### Error Recovery & State

#### 16. State recovery after Iterate daemon restarts?

**Solution A: PID File Registry with Process Liveness Check**
- Maintain `.iterate/agents/{agentId}.pid` files
- On startup, scan PID files, verify processes alive
- Reconnect to survivors, clean up stale PIDs
- PID reuse risk, race conditions

**Solution B: State File + Offset-Based Resume** ⭐ Recommended
- Store agent state file: `.iterate/agents/{agentId}.json`
- On restart, replay stream from last offset to reconstruct lifecycle
- Stream is source of truth, handles partial operations naturally

```json
{
  "agentId": "agent-123",
  "harness": "opencode",
  "status": "running",
  "lastEventOffset": "0000000000000042",
  "processHint": { "pid": 12345, "endpoint": "http://localhost:8080" }
}
```

**Solution C: Ephemeral Agents + Explicit Restart**
- Daemon restart = all agents considered stopped
- Clients must explicitly re-create
- Simple but user-facing disruption

#### 17. Handling partial operations after crashes?

Agent turn interrupted mid-operation (tool started but no result).

**Solution A: Idempotent Event Replay**
- Every operation has start+end events
- Replay stream, detect incomplete operations
- Emit synthetic completion events with status="cancelled"
- No special cleanup logic needed

**Solution B: Compensation Events** ⭐ Recommended
- If operation incomplete after timeout, emit compensation event
- `tool_execution_start` with no `tool_execution_end` → emit `tool_execution_cancelled`
- Explicit failure handling in stream
- Use operation-specific timeouts (tool: 5min, LLM request: 2min)

#### 18. Checkpoint strategy for fast startup?

For long-running agents with thousands of events, replaying from offset 0 is slow.

**Solution A: Periodic State Snapshots** ⭐ Recommended
- Every N events (1000), serialize reducedContext to `.iterate/snapshots/{agentId}-{offset}.json`
- On startup, load latest snapshot + replay events since that offset
- Fast startup, standard event sourcing pattern

```json
{
  "agentId": "agent-123",
  "offset": "0000000000001000",
  "reducedContext": { "messages": [...], "config": {...} },
  "version": 1
}
```

**Solution B: Last-Event-Offset Tracking Only**
- Store only last processed offset
- Replay from that offset (no full state)
- Minimal storage but doesn't help if replay slow

---

### Storage Architecture

#### 19. Storage duplication - do we need harness storage if we have our stream?

**Solution A: Full Duplication** ⭐ Recommended (current architecture)
- Both systems maintain independent storage
- Native TUI works unchanged
- Simple bridge implementation
- 2x storage space but avoids complexity

**Solution B: Single Source of Truth (Iterate Only)**
- Configure harnesses to skip persistence
- Breaking change to native TUI
- Not viable if harnesses don't support memory-only mode

**Solution C: Harness as Primary, Iterate as Index**
- Iterate maintains lightweight index pointing to harness storage
- No duplication but complex query path

#### 20. Session ID mapping - Iterate agentId ↔ Harness sessionId?

**Solution A: Deterministic Derivation**
- `harnessSessionId = iterate-${harness}-${agentId}`
- Stateless, no storage needed
- Naming collision risk

**Solution B: Mapping Events in Stream** ⭐ Recommended
- Store mapping as `iterate:agent:system:session_mapped` events
- Auditable, flexible, supports one-to-many

```typescript
{
  type: "iterate:agent:system:session_mapped",
  agentId: "agent-123",
  data: { harness: "opencode", harnessSessionId: "sess-abc-xyz" }
}
```

**Solution C: Separate Mapping Storage**
- Store in `{dataDir}/session-mappings.json`
- Fast lookup without stream replay
- Consistency risk with stream

#### 21. Query patterns - when to hit our stream vs harness storage?

| Query | Iterate Stream | Harness Storage | Recommended |
|-------|---------------|-----------------|-------------|
| Get latest agent state | Replay from offset | Query harness API | Harness (cached state) |
| Stream new events (SSE) | PubSub subscription | Poll harness | Iterate (real-time) |
| Search across all agents | Scan all streams | N/A | Iterate (global view) |
| Full conversation history | Read stream file | Query harness DB | Iterate (source of truth) |

**Recommendation:** Read-through cache pattern - check Iterate in-memory cache first, fall back to stream read.

#### 22. Storage cleanup - when to GC old sessions?

**Solution A: Manual Cleanup Only**
- CLI command: `iterate cleanup --older-than 30d`
- User control, no accidental loss
- Storage can grow unchecked

**Solution B: Automatic Time-Based Expiry**
- Background job deletes sessions older than 30 days
- No intervention needed
- Data loss risk if user wants old sessions

**Solution C: Lifecycle with Archival** ⭐ Recommended
- Active (30 days) → Archived (compressed) → Deleted (90 days)
- User can restore archived sessions
- Clear lifecycle stages

---

### Future Considerations

#### 23. Subscription filtering for consumers?

Consumers need to subscribe to event subsets (web UI: agent X only, Slack bot: messages only).

**Solution A: Stream-per-Agent** ⭐ Recommended for MVP
- Create separate durable stream per agent
- Perfect isolation, no server-side filtering
- Stream proliferation concern (1000 agents = 1000 streams)

**Solution B: Single Stream with Server-Side Filtering**
- Add `filter` parameter to SSE subscribe endpoint
- Flexible but CPU overhead

**Solution C: Event Type-Based Topic Routing**
- Subscribe to event type prefixes
- Efficient but can't filter by non-type fields

#### 24. Multi-agent coordination?

Can agents communicate via the shared stream?

**Options to explore:**
- Agent A emits event, bridge for Agent B can react via hook
- Explicit `iterate:agent:control:forward` event
- Cross-agent event subscriptions: "notify agent X when `slack:webhook` arrives"
- The naming scheme supports this, routing logic TBD

---

### Recommendations Summary

| Domain | Question | Recommended Solution |
|--------|----------|---------------------|
| **Session Management** | File corruption prevention | Advisory lock files |
| **Session Management** | Session ownership | Explicit handoff protocol |
| **Session Management** | SDK startup overhead | Pre-warmed SDK on create |
| **Event Streaming** | Deduplication | Hash-based with source tagging |
| **Event Streaming** | Timestamp reconciliation | Multi-timestamp envelope |
| **Event Streaming** | CLI streaming capture | Dual-path hybrid (accept limitation) |
| **Process Lifecycle** | OpenCode server | Hybrid auto-daemon |
| **Process Lifecycle** | Pi supervision | Supervised with auto-restart |
| **Process Lifecycle** | Health monitoring | Hybrid exit + health checks |
| **TUI Handoff** | Handoff protocol | Graceful takeover with warning |
| **TUI Handoff** | Graceful vs forced | Graceful handoff with pause |
| **TUI Handoff** | Resume after TUI | Automatic reactivation |
| **Tool Injection** | Format conversion | Schema-first adapters → MCP long-term |
| **Tool Injection** | MCP vs native | Hybrid (MCP + native fallback) |
| **Tool Injection** | Call routing | MCP routing + HTTP endpoints |
| **Error Recovery** | State recovery | State file + offset replay |
| **Error Recovery** | Partial operations | Compensation events |
| **Error Recovery** | Checkpointing | Periodic state snapshots |
| **Storage** | Duplication strategy | Full duplication |
| **Storage** | Session mapping | Mapping events in stream |
| **Storage** | Cleanup | Lifecycle with archival |

## Next Steps

1. **Review event naming** - Confirm Option C (source-based namespacing) with team
2. **Prototype OpenCode bridge** - Connect to event bus, emit `iterate:agent:harness:opencode` events
3. **Prototype Pi bridge** - Process management, stdin/stdout RPC, emit `iterate:agent:harness:pi` events
4. **Tool injection POC** - One Iterate tool registered in each harness
5. **SSE consumer** - Simple web UI that renders native event formats
6. **Versioning test** - Verify `version` field handling with schema evolution
