# Detailed Design: LLM Context Service Architecture

A layered architecture for managing LLM conversations using Effect's service patterns.

## Core Concepts

```
┌─────────────────────────────────────────────────────────────────┐
│                         Context                                  │
│  A named, append-only event log that represents a conversation  │
│                                                                  │
│  Events: [SystemPrompt, UserMessage, AssistantMessage, ...]     │
│                           │                                      │
│                           ▼                                      │
│                      ┌─────────┐                                │
│                      │ Reducer │                                │
│                      └────┬────┘                                │
│                           │                                      │
│                           ▼                                      │
│                   ReducedContext                                │
│  { messages: Prompt.Message[], config: AgentConfig }            │
└─────────────────────────────────────────────────────────────────┘
```

**Context** = Named conversation (e.g., "chat", "code-review"). Append-only event log.

**Events** = Immutable facts with shared fields (id, timestamp, contextName, parentEventId): user messages, assistant responses, config changes, lifecycle markers.

**Reducer** = Functional fold: `(current, newEvents) => new`. Transforms event history into LLM-ready input.

**ReducedContext** = Current state: messages array (using `@effect/ai` Prompt.Message) + config for the agent.

## Architecture Overview

Four layers, each with single responsibility:

```
┌───────────────────────────────────────────────────────────┐
│                   Layer 4: Application                     │
│  Thin facade. Routes by context name. Graceful shutdown.  │
├───────────────────────────────────────────────────────────┤
│                    Layer 3: Session                        │
│  Stateful. Manages lifecycle, persistence, cancellation.  │
├───────────────────────────────────────────────────────────┤
│                    Layer 2: Reducer                        │
│  Stateless. Folds events into ReducedContext.             │
├───────────────────────────────────────────────────────────┤
│                     Layer 1: Agent                         │
│  Stateless. Takes agent turns. Retry + fallback.          │
└───────────────────────────────────────────────────────────┘
```

## Data Flow

```
User Input
    │
    ▼
┌──────────────────┐
│   Application    │──── addEvent(contextName, event) ────►
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│     Session      │◄─── events stream (continuous) ────────
│                  │
│  - Persists event
│  - Interrupts running turn
│  - Reduces context
│  - Calls Agent.takeTurn
│  - Emits response events
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│     Reducer      │  (current, [newEvent]) => updated
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│      Agent       │  takeTurn(ReducedContext) => Stream<Event>
└──────────────────┘
```

Key insight: `addEvent` returns `void`, not a stream. The `events` stream is separate and continuous until session ends.

---

## Schemas

### Base Event Fields

All events share common fields via object spread:

```typescript
// Shared fields for all events
// parentEventId enables future forking - events can reference their causal parent
export const BaseEventFields = {
  id: EventId,
  timestamp: Schema.DateTimeUtc,
  contextName: ContextName,
  parentEventId: Schema.optionalWith(EventId, { as: "Option" })
}

// Usage in event definitions
export class UserMessageEvent extends Schema.TaggedClass<UserMessageEvent>()(
  "UserMessageEvent",
  {
    ...BaseEventFields,  // Spread shared fields
    content: Schema.String
  }
) {}
```

### Branded Types

```typescript
// Unique identifiers to prevent string mixing
export const ContextName = Schema.String.pipe(Schema.brand("ContextName"))
export type ContextName = typeof ContextName.Type

export const LlmProviderId = Schema.String.pipe(Schema.brand("LlmProviderId"))
export type LlmProviderId = typeof LlmProviderId.Type

export const EventId = Schema.String.pipe(Schema.brand("EventId"))
export type EventId = typeof EventId.Type
```

### Messages

Uses `@effect/ai` Prompt.Message directly - no custom LLMMessage types needed:

```typescript
import type { Prompt } from "@effect/ai"

export interface ReducedContext {
  readonly messages: ReadonlyArray<Prompt.Message>
  readonly config: AgentConfig
}
```

The `Prompt` module provides:
- `Prompt.SystemMessage` - system instructions
- `Prompt.UserMessage` - user input (with multipart content support)
- `Prompt.AssistantMessage` - AI responses (including tool calls)
- `Prompt.ToolMessage` - tool results

### Configuration Schemas

```typescript
export class LlmProviderConfig extends Schema.Class<LlmProviderConfig>("LlmProviderConfig")({
  providerId: LlmProviderId,
  model: Schema.String,
  apiKey: Schema.Redacted(Schema.String),
  baseUrl: Schema.optionalWith(Schema.String, { as: "Option" }),
}) {}

// No custom RetryConfig - use Effect Schedule directly
export class AgentConfig extends Schema.Class<AgentConfig>("AgentConfig")({
  primary: LlmProviderConfig,
  fallback: Schema.optionalWith(LlmProviderConfig, { as: "Option" }),
  timeoutMs: Schema.Number.pipe(Schema.positive()),
}) {}
```

### Retry Configuration

Uses Effect's built-in Schedule instead of custom RetryConfig:

```typescript
// In AppConfig service
readonly retrySchedule: Schedule.Schedule<unknown, unknown>

// Usage example
const schedule = Schedule.exponential("100 millis").pipe(
  Schedule.intersect(Schedule.recurs(3)),
  Schedule.jittered()
)
```

### Content Events

```typescript
export class SystemPromptEvent extends Schema.TaggedClass<SystemPromptEvent>()(
  "SystemPromptEvent",
  {
    ...BaseEventFields,
    content: Schema.String,
  }
) {}

export class UserMessageEvent extends Schema.TaggedClass<UserMessageEvent>()(
  "UserMessageEvent",
  {
    ...BaseEventFields,
    content: Schema.String,
  }
) {}

export class FileAttachmentEvent extends Schema.TaggedClass<FileAttachmentEvent>()(
  "FileAttachmentEvent",
  {
    ...BaseEventFields,
    source: Schema.String,
    mimeType: Schema.String,
    content: Schema.String, // base64 or text
  }
) {}

export class AssistantMessageEvent extends Schema.TaggedClass<AssistantMessageEvent>()(
  "AssistantMessageEvent",
  {
    ...BaseEventFields,
    content: Schema.String,
  }
) {}

export class TextDeltaEvent extends Schema.TaggedClass<TextDeltaEvent>()(
  "TextDeltaEvent",
  {
    ...BaseEventFields,
    delta: Schema.String,
  }
) {}
```

### Configuration Events

```typescript
export class SetLlmProviderConfigEvent extends Schema.TaggedClass<SetLlmProviderConfigEvent>()(
  "SetLlmProviderConfigEvent",
  {
    ...BaseEventFields,
    providerId: LlmProviderId,
    model: Schema.String,
    apiKey: Schema.Redacted(Schema.String),
    baseUrl: Schema.optionalWith(Schema.String, { as: "Option" }),
    asFallback: Schema.Boolean,
  }
) {}

export class SetTimeoutEvent extends Schema.TaggedClass<SetTimeoutEvent>()(
  "SetTimeoutEvent",
  {
    ...BaseEventFields,
    timeoutMs: Schema.Number,
  }
) {}
```

### Lifecycle Events

Track session and agent turn lifecycle:

```typescript
export class SessionStartedEvent extends Schema.TaggedClass<SessionStartedEvent>()(
  "SessionStartedEvent",
  { ...BaseEventFields }
) {}

export class SessionEndedEvent extends Schema.TaggedClass<SessionEndedEvent>()(
  "SessionEndedEvent",
  { ...BaseEventFields }
) {}

export class AgentTurnStartedEvent extends Schema.TaggedClass<AgentTurnStartedEvent>()(
  "AgentTurnStartedEvent",
  { ...BaseEventFields }
) {}

export class AgentTurnCompletedEvent extends Schema.TaggedClass<AgentTurnCompletedEvent>()(
  "AgentTurnCompletedEvent",
  {
    ...BaseEventFields,
    durationMs: Schema.Number,
  }
) {}

export class AgentTurnInterruptedEvent extends Schema.TaggedClass<AgentTurnInterruptedEvent>()(
  "AgentTurnInterruptedEvent",
  {
    ...BaseEventFields,
    reason: Schema.String,
  }
) {}

export class AgentTurnFailedEvent extends Schema.TaggedClass<AgentTurnFailedEvent>()(
  "AgentTurnFailedEvent",
  {
    ...BaseEventFields,
    error: Schema.String,
  }
) {}
```

### ContextEvent Union

All events flow through the same union. There's no distinction between "input" and "output" events - they're all just events that get streamed through the system.

```typescript
export const ContextEvent = Schema.Union(
  // Content events
  SystemPromptEvent,
  UserMessageEvent,
  FileAttachmentEvent,
  AssistantMessageEvent,
  TextDeltaEvent,
  // Configuration events
  SetLlmProviderConfigEvent,
  SetTimeoutEvent,
  // Lifecycle events
  SessionStartedEvent,
  SessionEndedEvent,
  AgentTurnStartedEvent,
  AgentTurnCompletedEvent,
  AgentTurnInterruptedEvent,
  AgentTurnFailedEvent
)
export type ContextEvent = typeof ContextEvent.Type
```

### Errors

```typescript
export class AgentError extends Schema.TaggedError<AgentError>()(
  "AgentError",
  {
    message: Schema.String,
    provider: LlmProviderId,
    cause: Schema.optionalWith(Schema.Defect, { as: "Option" }),
  }
) {}

export class ReducerError extends Schema.TaggedError<ReducerError>()(
  "ReducerError",
  {
    message: Schema.String,
    event: Schema.optionalWith(ContextEvent, { as: "Option" }),
  }
) {}

export class ContextNotFoundError extends Schema.TaggedError<ContextNotFoundError>()(
  "ContextNotFoundError",
  { contextName: ContextName }
) {}

export class ContextLoadError extends Schema.TaggedError<ContextLoadError>()(
  "ContextLoadError",
  {
    contextName: ContextName,
    message: Schema.String,
    cause: Schema.optionalWith(Schema.Defect, { as: "Option" }),
  }
) {}

export class HookError extends Schema.TaggedError<HookError>()(
  "HookError",
  {
    hook: Schema.Literal("beforeTurn", "afterTurn", "onEvent"),
    message: Schema.String,
    cause: Schema.optionalWith(Schema.Defect, { as: "Option" }),
  }
) {}

// Union types
export const ContextError = Schema.Union(ContextNotFoundError, ContextLoadError)
export type ContextError = typeof ContextError.Type

export const SessionError = Schema.Union(ContextError, ReducerError, HookError)
export type SessionError = typeof SessionError.Type
```

---

## Layer 1: Agent

Innermost layer. Takes agent turns with retry and fallback.

### Interface

```typescript
class Agent extends Context.Tag("@app/Agent")<
  Agent,
  {
    // Execute an agent turn (may involve multiple LLM requests in future)
    readonly takeTurn: (ctx: ReducedContext) => Stream.Stream<ContextEvent, AgentError>
  }
>() {}
```

### Behavior

```
ReducedContext
      │
      ▼
┌─────────────────────────────────────────────┐
│                   Agent                      │
│                                              │
│  1. Extract config from ReducedContext       │
│  2. Try primary provider                     │
│  3. On failure: retry with backoff           │
│  4. On exhausted retries: try fallback       │
│  5. Stream response events                   │
└─────────────────────────────────────────────┘
      │
      ▼
Stream<ContextEvent, AgentError>
```

### Effect Patterns

```typescript
// Retry with exponential backoff using Schedule
const schedule = Schedule.exponential("100 millis").pipe(
  Schedule.intersect(Schedule.recurs(3)),
  Schedule.jittered()
)

// Fallback on primary failure
primaryStream.pipe(
  Stream.retry(schedule),
  Stream.orElse(() => fallbackStream)
)
```

### Dependencies

```
Agent
  └─► LanguageModel (from @effect/ai)
        └─► HttpClient (from @effect/platform)
```

---

## Layer 2: Reducer

Stateless service that folds events into ReducedContext.

### Interface

```typescript
class EventReducer extends Context.Tag("@app/EventReducer")<
  EventReducer,
  {
    // Reduce: (accumulator, newEvents) => updated accumulator
    readonly reduce: (
      current: ReducedContext,
      newEvents: readonly ContextEvent[]
    ) => Effect.Effect<ReducedContext, ReducerError>

    // Initial state for fresh contexts
    readonly initialReducedContext: ReducedContext
  }
>() {}
```

### Behavior

True functional reducer pattern:

```
current: ReducedContext    newEvents: ContextEvent[]
         │                           │
         └───────────┬───────────────┘
                     │
                     ▼
              ┌─────────────┐
              │   Reducer   │
              │             │
              │  fold left  │
              │  validate   │
              └──────┬──────┘
                     │
                     ▼
           updated: ReducedContext
```

### Implementation Notes

```typescript
// Internal state for reduction
interface ReducerState {
  messages: Prompt.Message[]
  systemPrompt: string | null
  primaryProvider: ProviderConfig | null
  fallbackProvider: ProviderConfig | null
  timeoutMs: number
  pendingAttachments: FileAttachmentEvent[]
}

// Pure reduction step
const reduceEvent = (state: ReducerState, event: ContextEvent): ReducerState => {
  switch (event._tag) {
    case "SystemPromptEvent":
      return { ...state, systemPrompt: event.content }
    case "UserMessageEvent":
      return {
        ...state,
        messages: [...state.messages, Prompt.userMessage({ content: event.content })],
        pendingAttachments: [],
      }
    case "AssistantMessageEvent":
      return {
        ...state,
        messages: [...state.messages, Prompt.assistantMessage({ content: event.content })],
      }
    // ... other cases
    default:
      return state // Lifecycle events don't affect reduction
  }
}
```

### Multiple Strategies

The service pattern allows swapping implementations:

```typescript
// Standard reducer
EventReducer.layer

// Truncating reducer (keeps last N messages)
EventReducer.truncatingLayer

// Summarizing reducer (uses LLM to summarize old context)
EventReducer.summarizingLayer
```

---

## Layer 3: Session

Stateful, scoped layer. Manages a single context's lifecycle.

### Interface

```typescript
class ContextSession extends Context.Tag("@app/ContextSession")<
  ContextSession,
  {
    // Initialize session for a context
    readonly initialize: (contextName: ContextName) => Effect.Effect<void, ContextError>

    // Add event to context (triggers agent turn for user messages)
    // Returns void - use events stream for output
    readonly addEvent: (event: ContextEvent) => Effect.Effect<void, SessionError>

    // Continuous stream of events until session ends
    readonly events: Stream.Stream<ContextEvent, SessionError>

    // Get all events in context
    readonly getEvents: () => Effect.Effect<readonly ContextEvent[]>
  }
>() {}
```

### Key Design: Decoupled addEvent and events

```
┌─────────────────────────────────────────────────────────────┐
│                       Session                                │
│                                                              │
│  addEvent(event)                  events (Stream)            │
│       │                               ▲                      │
│       ▼                               │                      │
│  ┌─────────────┐              ┌───────┴───────┐             │
│  │  Persist    │              │    PubSub     │             │
│  │  event      │              │   (internal)  │             │
│  └──────┬──────┘              └───────▲───────┘             │
│         │                             │                      │
│         ▼                             │                      │
│  ┌─────────────┐              ┌───────┴───────┐             │
│  │  If user    │──────────────│  Emit to      │             │
│  │  message:   │              │  subscribers  │             │
│  │  interrupt  │              └───────────────┘             │
│  │  & call     │                                            │
│  │  takeTurn   │                                            │
│  └─────────────┘                                            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

`addEvent` returns `Effect.Effect<void>` - fire and forget.
`events` is a continuous stream that emits all events (input + output) until session ends.

### Cancellation Handling

Session handles interruption internally:

```typescript
// On new user message while agent turn is running:
// 1. Emit AgentTurnInterruptedEvent
// 2. Interrupt running fiber
// 3. Start new agent turn

yield* SynchronizedRef.modifyEffect(state, (current) =>
  Effect.gen(function*() {
    if (current.runningFiber) {
      yield* emit(AgentTurnInterruptedEvent.make({ reason: "new input" }))
      yield* Fiber.interrupt(current.runningFiber)
    }
    // Start new turn...
  })
)
```

### Lifecycle

```typescript
static readonly layer = Layer.scoped(
  ContextSession,
  Effect.gen(function*() {
    // Dependencies
    const reducer = yield* EventReducer
    const agent = yield* Agent
    const repository = yield* ContextRepository
    const hooks = yield* HooksService

    // State
    const eventsRef = yield* Ref.make<readonly ContextEvent[]>([])
    const reducedRef = yield* Ref.make(reducer.initialReducedContext)
    const runningFiberRef = yield* SynchronizedRef.make<Fiber.Fiber<void> | null>(null)
    const eventPubSub = yield* PubSub.unbounded<ContextEvent>()

    // Cleanup on scope close
    yield* Effect.addFinalizer(() =>
      Effect.gen(function*() {
        // Interrupt any running turn
        const fiber = yield* SynchronizedRef.get(runningFiberRef)
        if (fiber) yield* Fiber.interrupt(fiber)
        // Emit session ended
        yield* PubSub.publish(eventPubSub, SessionEndedEvent.make({ ... }))
      })
    )

    // ... implementation
  })
)
```

---

## Layer 4: Application

Thin facade. Routes by context name. Manages multiple sessions.

### Interface

```typescript
class ApplicationService extends Context.Tag("@app/ApplicationService")<
  ApplicationService,
  {
    // Add event to a context (creates session if needed)
    readonly addEvent: (
      contextName: ContextName,
      event: ContextEvent
    ) => Effect.Effect<void, SessionError>

    // Get event stream for a context
    readonly eventStream: (
      contextName: ContextName
    ) => Stream.Stream<ContextEvent, SessionError>

    // Graceful shutdown - ends all sessions
    readonly shutdown: () => Effect.Effect<void>
  }
>() {}
```

### Session Management

```typescript
// Internal: Map of active sessions
const sessions = yield* Ref.make(new Map<ContextName, ContextSession>())

// Get or create session
const getSession = (contextName: ContextName) =>
  Effect.gen(function*() {
    const map = yield* Ref.get(sessions)
    if (map.has(contextName)) {
      return map.get(contextName)!
    }
    // Create new session with scoped layer
    const session = yield* createSession(contextName)
    yield* Ref.update(sessions, (m) => new Map(m).set(contextName, session))
    return session
  })
```

### Graceful Shutdown

```typescript
readonly shutdown = Effect.gen(function*() {
  const map = yield* Ref.get(sessions)
  // End all sessions in parallel
  yield* Effect.all(
    Array.from(map.values()).map((session) =>
      // Session's finalizer handles cleanup
      session.close()
    ),
    { concurrency: "unbounded" }
  )
  yield* Ref.set(sessions, new Map())
})
```

---

## Extensibility: HooksService

Transform turns at key points.

### Interface

```typescript
type BeforeTurnHook = (input: ReducedContext) => Effect.Effect<ReducedContext, HookError>
type AfterTurnHook = (event: ContextEvent) => Effect.Effect<readonly ContextEvent[], HookError>
type OnEventHook = (event: ContextEvent) => Effect.Effect<void, HookError>

class HooksService extends Context.Tag("@app/HooksService")<
  HooksService,
  {
    // Transform input before agent turn
    readonly beforeTurn: BeforeTurnHook

    // Transform each event after agent turn (can expand 1→N)
    readonly afterTurn: AfterTurnHook

    // Observe events (for logging, metrics, etc.)
    readonly onEvent: OnEventHook
  }
>() {}
```

### Event Expansion (1→N)

`afterTurn` returns an array, allowing one event to become multiple:

```typescript
// Most hooks pass through unchanged
afterTurn: (event) => Effect.succeed([event])

// Expansion example: split long messages
afterTurn: (event) =>
  Effect.gen(function*() {
    if (event._tag === "AssistantMessageEvent" && event.content.length > 1000) {
      const chunks = splitIntoChunks(event.content, 1000)
      return chunks.map((chunk, i) =>
        AssistantMessageEvent.make({ content: chunk, ... })
      )
    }
    return [event]
  })
```

### Hook Composition

Multiple hooks run in sequence:

```typescript
const composeBeforeTurnHooks = (
  hooks: readonly BeforeTurnHook[]
): BeforeTurnHook =>
  (input) =>
    hooks.reduce(
      (acc, hook) => Effect.flatMap(acc, hook),
      Effect.succeed(input)
    )
```

### Use Cases

**Content Moderation:**
```typescript
beforeTurn: (ctx) =>
  Effect.gen(function*() {
    for (const msg of ctx.messages) {
      if (msg.role === "user") {
        const flagged = yield* moderationService.check(msg.content)
        if (flagged) {
          return yield* Effect.fail(HookError.make({
            hook: "beforeTurn",
            message: "Content flagged",
          }))
        }
      }
    }
    return ctx
  })
```

**Token Counting:**
```typescript
beforeTurn: (ctx) =>
  Effect.gen(function*() {
    const count = yield* tokenCounter.count(ctx.messages)
    yield* Effect.log(`Token count: ${count}`)
    if (count > 100000) {
      return yield* Effect.fail(HookError.make({
        hook: "beforeTurn",
        message: `Token limit exceeded: ${count}`,
      }))
    }
    return ctx
  })
```

**Metrics:**
```typescript
onEvent: (event) =>
  Effect.gen(function*() {
    const metrics = yield* MetricsService
    switch (event._tag) {
      case "AgentTurnStartedEvent":
        yield* metrics.increment("agent.turns.started")
        break
      case "AgentTurnCompletedEvent":
        yield* metrics.timing("agent.turns.duration", event.durationMs)
        break
    }
  })
```

### Default Implementation

```typescript
static readonly layer = Layer.succeed(HooksService, {
  beforeTurn: (input) => Effect.succeed(input),
  afterTurn: (event) => Effect.succeed([event]),
  onEvent: () => Effect.void,
})
```

---

## Persistence: ContextRepository

Stores and loads events for contexts.

### Interface

```typescript
class ContextRepository extends Context.Tag("@app/ContextRepository")<
  ContextRepository,
  {
    readonly load: (name: ContextName) => Effect.Effect<readonly ContextEvent[], ContextError>
    readonly append: (name: ContextName, events: readonly ContextEvent[]) => Effect.Effect<void, ContextError>
    readonly exists: (name: ContextName) => Effect.Effect<boolean>
  }
>() {}
```

### JSONL File Implementation

```
.contexts/
  chat.jsonl          # One JSON object per line
  code-review.jsonl
```

Each line is a JSON-encoded ContextEvent. What to persist is an implementation decision - e.g., may skip TextDeltaEvent for storage efficiency.

---

## Layer Composition

```typescript
// Full application layer
const appLayer = ApplicationService.layer.pipe(
  Layer.provide(ContextSession.layer),
  Layer.provide(EventReducer.layer),
  Layer.provide(Agent.layer),
  Layer.provide(ContextRepository.layer),
  Layer.provide(HooksService.layer),
  Layer.provide(AppConfig.layer),
  Layer.provide(BunContext.layer),
)

// Run application
Effect.gen(function*() {
  const app = yield* ApplicationService

  // Add user message
  yield* app.addEvent(
    ContextName.make("chat"),
    UserMessageEvent.make({
      id: EventId.make(crypto.randomUUID()),
      timestamp: DateTime.unsafeNow(),
      contextName: ContextName.make("chat"),
      content: "Hello!"
    })
  )

  // Subscribe to events
  yield* app.eventStream(ContextName.make("chat")).pipe(
    Stream.tap((event) => Console.log(`Event: ${event._tag}`)),
    Stream.runDrain
  )
}).pipe(
  Effect.provide(appLayer),
  Effect.runPromise
)
```

---

## Effect Patterns Summary

| Pattern | Usage |
|---------|-------|
| `Context.Tag` | Service definitions |
| `Layer.scoped` | Lifecycle-managed services |
| `Effect.fn` | Call-site tracing |
| `Schema.TaggedClass` | Event types with `...BaseEventFields` |
| `Schema.TaggedError` | Error types |
| `Ref` | Simple state |
| `SynchronizedRef` | Atomic state transitions |
| `Fiber.interrupt` | Cancellation |
| `PubSub` | Event broadcasting |
| `Effect.addFinalizer` | Cleanup |
| `Schedule.exponential` | Retry with backoff |
| `Stream.orElse` | Fallback |
| `Prompt.Message` | LLM message types from @effect/ai |
