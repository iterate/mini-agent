# Requirements

## Overview

Design a layered "onion" architecture for LLM request handling following Effect's service-first design philosophy. The system manages conversational contexts as streams of events, reduces them to make LLM requests, and handles request interruption gracefully.

## Functional Requirements

### Core Flow

1. **Event-driven context**: Conversations are represented as ordered sequences of events (messages, config changes, lifecycle markers)
2. **Reduction**: Events are reduced into a `ReducedContext` containing everything needed for an agent turn
3. **Streaming responses**: LLM responses stream back as events (deltas during streaming, final message on completion)
4. **Persistence**: Events are persisted immediately as they occur

### Event Types

All events share base fields: `id` (EventId), `timestamp` (DateTimeUtc), `contextName` (ContextName).

**Content Events** (user-facing):
- `SystemPromptEvent` - Sets AI behavior
- `UserMessageEvent` - User input
- `AssistantMessageEvent` - AI response
- `FileAttachmentEvent` - Image/file with source and mediaType

**Configuration Events** (modify LLM behavior):
- `SetLlmProviderConfigEvent` - Change LLM provider or add fallback
- `SetTimeoutEvent` - Change request timeout

**Lifecycle Events** (observability):
- `SessionStartedEvent` - Emitted when session boots (CLI/HTTP start)
- `SessionEndedEvent` - Emitted when session ends (program exit)
- `AgentTurnStartedEvent` - Before agent turn begins
- `AgentTurnCompletedEvent` - After successful agent turn
- `AgentTurnInterruptedEvent` - When turn is cancelled (contains partial response)
- `AgentTurnFailedEvent` - When turn fails

**Streaming Events** (during turn):
- `TextDeltaEvent` - Streaming chunk from LLM

### Request Interruption

When new user input arrives while an agent turn is in-flight:
1. Cancel the in-flight turn
2. Emit `AgentTurnInterruptedEvent` with partial response accumulated so far
3. Start new turn with updated context

### Debouncing

When events are added rapidly (e.g., file attachment + message):
- Use "wait for quiet" pattern: wait N ms after last event before starting agent turn
- If N=0, wait for next event loop tick
- Default: 10ms to reduce unnecessary interruptions
- Configurable per-session

### Parallel LLM Requests

Support running multiple LLM requests in parallel for use cases like:
- Content generation + prompt injection detection
- Primary provider + fallback racing
- A/B testing different prompts

### Session Lifecycle

- `SessionStartedEvent` MUST be emitted when CLI/HTTP boots and loads a context
- `SessionEndedEvent` MUST be emitted when program exits
- These events are persisted for audit trail

## Non-Functional Requirements

### Testability

- All services must have `testLayer` with mock implementations
- Pure functions where possible
- Service interfaces should not leak implementation details

### Extensibility

- Hooks for before/after agent turns
- Event interception/transformation
- Pluggable persistence backends (future)
- Pluggable reducers (architecture supports, single implementation for now)

### Effect Idioms

- Use `Context.Tag` for service definitions (not `Effect.Service`)
- Use `Effect.fn` for automatic span creation
- Use `Schema.TaggedClass` for events with `...BaseEventFields` spread
- Use `Schema.TaggedError` for errors
- Use `@effect/ai` Prompt.Message for LLM messages (not custom types)
- Use Effect Schedule for retry configuration (not custom RetryConfig)
- Follow Effect Solutions service-first design

### Observability

- All lifecycle events for tracing
- Integration with existing OpenTelemetry setup
- Structured logging via Effect.log*

## Future Considerations (Out of Scope)

These are documented for architectural awareness but not implemented:

- **Dynamic reducers**: Reducers defined as events containing code (sandboxed execution)
- **Multiple persistence backends**: SQLite, remote API, etc.
- **HTTP API**: Server wrapper around same services
- **Multi-tenant sessions**: Multiple concurrent contexts
- **Event sourcing**: Full replay capability

## Constraints

- Must use bun as runtime
- Must use `@effect/platform` for I/O (no direct node:fs)
- Must integrate with existing `@effect/ai` LanguageModel abstraction
- kebab-case filenames
- Tests colocated with .test.ts suffix
