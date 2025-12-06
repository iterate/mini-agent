# Requirements

## Overview

Design an actor-based architecture for LLM request handling using Effect. Each context is modeled as an actor with fire-and-forget input and live event streaming output.

---

## MVP Requirements

### Core Flow

1. **Actor per context**: Each conversation context is a ContextActor with its own mailbox
2. **Fire-and-forget input**: `addEvent` persists immediately and returns void
3. **Live event stream**: Subscribers receive events published after they subscribe
4. **Immediate persistence**: Events persist to YAML before entering the processing queue

### Event Types

All events share base fields: `id` (EventId), `timestamp` (DateTimeUtc), `contextName` (ContextName), `parentEventId` (optional, for future forking).

**Content Events**:
- `SystemPromptEvent` - Sets AI behavior
- `UserMessageEvent` - User input
- `AssistantMessageEvent` - AI response (final)
- `FileAttachmentEvent` - Image/file with source and mimeType
- `TextDeltaEvent` - Streaming chunk (ephemeral, not persisted)

**Configuration Events**:
- `SetLlmProviderConfigEvent` - Change LLM provider (primary or fallback)
- `SetTimeoutEvent` - Change request timeout

**Lifecycle Events**:
- `SessionStartedEvent` - Emitted when actor starts
- `SessionEndedEvent` - Emitted when actor shuts down
- `AgentTurnStartedEvent` - Before agent turn begins
- `AgentTurnCompletedEvent` - After successful turn (includes durationMs)
- `AgentTurnInterruptedEvent` - When turn is cancelled (includes reason)
- `AgentTurnFailedEvent` - When turn fails (includes error)

### Request Interruption (Required)

When new user input arrives while an agent turn is in-flight:
1. Interrupt the running fiber via `Fiber.interrupt`
2. Emit `AgentTurnInterruptedEvent`
3. Start new turn with updated context

Implementation uses Effect's fiber interruption:
- `Fiber.interrupt(fiber)` - blocks until cleanup completes
- `Effect.onInterrupt(() => ...)` - cleanup handler for resources

### Debouncing

When events arrive rapidly (file attachment + message):
- Wait N ms after last event before starting agent turn
- Default: 100ms (configurable via ActorConfig)
- Implementation: `Stream.debounce(Duration.millis(config.debounceMs))`

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

### Effect Idioms

- `Context.Tag` for service definitions (not `Effect.Service`)
- `Effect.fn` for automatic span creation
- `Schema.TaggedClass` for events with `...BaseEventFields` spread
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

These are documented for architectural awareness but not implemented in MVP:

### Parallel LLM Requests
- Content generation + prompt injection detection
- Primary provider + fallback racing
- A/B testing different prompts

### Advanced Reducers
- Truncating reducer (keeps last N messages)
- Summarizing reducer (uses LLM to summarize old context)

### Distribution
- Replace ContextActor with @effect/cluster Entity
- Replace ActorRegistry with Sharding
- Persistent storage (Postgres/Redis) for event logs

### Other
- HTTP API server wrapper
- Multi-tenant sessions (multiple concurrent contexts per user)
- Full event sourcing replay capability
- Dynamic reducers defined as events
