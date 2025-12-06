# Requirements

## Overview

Design an actor-based architecture for LLM request handling using Effect. Each agent is modeled as a MiniAgent with fire-and-forget input and live event streaming output.

Philosophy: **"Agent events are all you need"** - Everything the agent does is driven by events.

### Conceptual Model

- **ContextEvent**: An event in a context (user message, assistant response, config change, lifecycle event)
- **Context**: A list of ContextEvents - the event log that records everything that happened
- **ReducedContext**: ALL derived state computed by the reducer from Context events
- **Reducer**: Pure function that derives everything from events (messages, config, counters, flags)
- **MiniAgent**: The actor - state = events (context) + reducedContext. External interface: `addEvent`, event stream

---

## MVP Requirements

### Core Flow

1. **Actor per agent**: Each agent is a MiniAgent with its own mailbox
2. **Fire-and-forget input**: `addEvent` persists immediately and returns void
3. **Live event stream**: Subscribers receive events published after they subscribe
4. **Immediate persistence**: Events persist via EventStore before entering the processing queue

### ReducedContext (Derived State)

The reducer derives ALL actor internal state from events:
- `messages` - Prompt.Message array for LLM
- `config` - AgentConfig from SetLlmConfigEvent, SetTimeoutEvent
- `nextEventNumber` - Counter for EventId generation
- `currentTurnNumber` - Sequential turn counter
- `agentTurnStartedAtEventId` - Option<EventId> tracking current turn's AgentTurnStartedEvent (Option.none() = no turn in progress, Option.some(eventId) = turn in progress + parent for new events)

No separate counters or flags in actor - everything from reducer.

### Event Types

All events share base fields:
- `id` (EventId) - Format: `{agentName}:{counter}` - globally unique within an agent's event log
- `timestamp` (DateTimeUtc)
- `agentName` (AgentName)
- `parentEventId` (Option<EventId>) - REQUIRED field linking to causal parent event
  - Every event (except first) links to the event that caused it
  - New events automatically link to `agentTurnStartedAtEventId` from ReducedContext when present
  - First event in context has `parentEventId = Option.none()`
  - Enables causal chains and future forking capabilities
- `triggersAgentTurn` (Boolean) - Whether this event should trigger an LLM request

**Content Events**:
- `SystemPromptEvent` - Sets AI behavior
- `UserMessageEvent` - User input (typically triggersAgentTurn=true)
- `AssistantMessageEvent` - AI response (final)
- `FileAttachmentEvent` - Image/file with source and mimeType
- `TextDeltaEvent` - Streaming chunk (ephemeral, not persisted)

**Configuration Events**:
- `SetLlmConfigEvent` - Change LLM provider (primary or fallback)
- `SetTimeoutEvent` - Change request timeout

**Lifecycle Events**:
- `SessionStartedEvent` - Emitted when actor starts
- `SessionEndedEvent` - Emitted when actor shuts down
- `AgentTurnStartedEvent` - Before agent turn begins (includes turnNumber: monotonic counter starting at 1)
- `AgentTurnCompletedEvent` - After successful turn (includes turnNumber, durationMs)
- `AgentTurnInterruptedEvent` - When turn is cancelled (includes turnNumber, reason)
- `AgentTurnFailedEvent` - When turn fails (includes turnNumber, error)

### Request Interruption (Required)

When a new event with `triggersAgentTurn=true` arrives while an agent turn is in-flight:
1. Interrupt the running fiber via `Fiber.interrupt`
2. Emit `AgentTurnInterruptedEvent`
3. Start new turn with updated context

Implementation uses Effect's fiber interruption:
- `Fiber.interrupt(fiber)` - blocks until cleanup completes
- `Effect.onInterrupt(() => ...)` - cleanup handler for resources

### Debouncing

When events with `triggersAgentTurn=true` arrive rapidly, wait 100ms (hard-coded for MVP) after last triggering event before starting agent turn. Implementation: `Stream.debounce(Duration.millis(100))`

### Session Lifecycle

- `SessionStartedEvent` MUST be emitted when actor is created
- `SessionEndedEvent` MUST be emitted when actor scope closes
- Both events are persisted for audit trail

### Single LLM Request

MVP supports one LLM request at a time:
- Primary provider with retry (exponential backoff)
- Fallback provider on exhausted retries
- No parallel requests in MVP

---

## Non-Functional Requirements

### Testability

- All services have `testLayer` with mock implementations
- Actor tests use `Layer.scoped` for lifecycle management
- Pure functions where possible
- `EventStore.inMemoryLayer` for tests (no disk I/O)

### Effect Idioms

- `Context.Tag` for service definitions (not `Effect.Service`)
- `Effect.fn` for automatic span creation
- `Schema.TaggedClass` for events with `...BaseEventFields` spread (includes triggersAgentTurn)
- `Schema.TaggedError` for errors
- `@effect/ai` Prompt.Message for LLM messages
- Effect Schedule for retry (not custom RetryConfig)
- `Mailbox` for actor input queue
- `Stream.broadcastDynamic` for fan-out to subscribers

### Observability

- All lifecycle events for tracing
- Structured logging via `Effect.log*`
- Integration with OpenTelemetry (existing setup)

### Constraints

- Bun as runtime
- `@effect/platform` for I/O (no direct node:fs)
- `@effect/ai` LanguageModel abstraction
- kebab-case filenames
- Tests colocated with .test.ts suffix

---

## Eventually (Future Scope)

These are documented for architectural awareness but not implemented in MVP.

Philosophy: **"Agent events are all you need"** - Everything should be driven by events.

### Events-Driven Extensions

Future capabilities defined as events:
- `SetRetryConfigEvent` - Define retry Schedule via event
- `DefineToolEvent` - Define callable tools (function calling)
- `DefineWorkflowEvent` - Define multi-step workflows
- `SetMemoryConfigEvent` - Configure vector store, summarization
- Dynamic reducers defined as events

### Parallel LLM Requests
- Content generation + prompt injection detection
- Primary provider + fallback racing
- A/B testing different prompts

### Advanced Reducers
- Truncating reducer (keeps last N messages)
- Summarizing reducer (uses LLM to summarize old context)

### Agent Forking
- Uses **parentEventId** (MVP field) for branching: create a new agent from a specific event in another agent's context
- Both agents share history up to the fork point
- Each continues independently with its own event log after the fork
- Use cases: exploring alternate conversation paths, A/B testing different responses, parallel problem-solving
- Note: parentEventId is implemented in MVP for causal chains; forking is the future USE of that field

### Distribution
- Replace MiniAgent with @effect/cluster Entity
- Replace AgentRegistry with Sharding
- Persistent EventStore (Postgres/Redis) for event logs

### Other
- HTTP API server wrapper
- Multi-tenant sessions (multiple concurrent agents per user)
- Full event sourcing replay capability
