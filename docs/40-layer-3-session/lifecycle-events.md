# Lifecycle Events

Events that mark system state transitions for observability and audit.

## Event Types

### SessionStartedEvent

Emitted when a session boots and loads a context.

```typescript
export class SessionStartedEvent extends Schema.TaggedClass<SessionStartedEvent>()(
  "SessionStartedEvent",
  {
    timestamp: Schema.DateFromNumber,
    loadedEventCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  }
) {}
```

**When emitted**: After loading events from storage, before first LLM request.

**Persistence**: Yes - persisted for audit trail.

### SessionEndedEvent

Emitted when a session ends.

```typescript
export class SessionEndedEvent extends Schema.TaggedClass<SessionEndedEvent>()(
  "SessionEndedEvent",
  {
    timestamp: Schema.DateFromNumber,
    reason: Schema.optional(Schema.String),
  }
) {}
```

**Reasons**:
- `"user_exit"` - User explicitly closed
- `"error"` - Session ended due to error
- `"scope_closed"` - Effect scope closed (cleanup)
- `"timeout"` - Session timed out (future)

**When emitted**: On session cleanup (finalizer).

**Persistence**: Yes - persisted for audit trail.

### LLMRequestStartedEvent

Emitted before making an LLM API call.

```typescript
export class LLMRequestStartedEvent extends Schema.TaggedClass<LLMRequestStartedEvent>()(
  "LLMRequestStartedEvent",
  {
    requestId: RequestId,
    timestamp: Schema.DateFromNumber,
  }
) {}
```

**When emitted**: After reducing events, before LLM call.

**Persistence**: Yes.

### LLMRequestCompletedEvent

Emitted after successful LLM response.

```typescript
export class LLMRequestCompletedEvent extends Schema.TaggedClass<LLMRequestCompletedEvent>()(
  "LLMRequestCompletedEvent",
  {
    requestId: RequestId,
    timestamp: Schema.DateFromNumber,
    durationMs: Schema.Number.pipe(Schema.nonNegative()),
    inputTokens: Schema.optional(Schema.Number),
    outputTokens: Schema.optional(Schema.Number),
  }
) {}
```

**When emitted**: After stream completes successfully.

**Persistence**: Yes.

### LLMRequestInterruptedEvent

Emitted when an LLM request is cancelled.

```typescript
export class LLMRequestInterruptedEvent extends Schema.TaggedClass<LLMRequestInterruptedEvent>()(
  "LLMRequestInterruptedEvent",
  {
    requestId: RequestId,
    timestamp: Schema.DateFromNumber,
    partialResponse: Schema.String,
    reason: Schema.String,
  }
) {}
```

**Reasons**:
- `"new_user_input"` - New event arrived during request
- `"timeout"` - Request timed out
- `"cancelled"` - Explicitly cancelled

**When emitted**: When request is interrupted (Layer 4).

**Persistence**: Yes - includes partial response for context.

### LLMRequestFailedEvent

Emitted when an LLM request fails after all retries.

```typescript
export class LLMRequestFailedEvent extends Schema.TaggedClass<LLMRequestFailedEvent>()(
  "LLMRequestFailedEvent",
  {
    requestId: RequestId,
    timestamp: Schema.DateFromNumber,
    error: Schema.String,
    retriesAttempted: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  }
) {}
```

**When emitted**: After all retries exhausted.

**Persistence**: Yes.

---

## Lifecycle Flow

### Normal Flow

```
┌─────────────────────────────────────────────────────────────┐
│ CLI boots                                                    │
│   └→ SessionStartedEvent { loadedEventCount: 15 }           │
├─────────────────────────────────────────────────────────────┤
│ User sends "Hello"                                          │
│   ├→ LLMRequestStartedEvent { requestId: "abc" }            │
│   ├→ TextDeltaEvent (ephemeral, not persisted)              │
│   ├→ TextDeltaEvent ...                                      │
│   ├→ AssistantMessageEvent { content: "Hi there!" }         │
│   └→ LLMRequestCompletedEvent { requestId: "abc", ... }     │
├─────────────────────────────────────────────────────────────┤
│ User sends "Goodbye"                                         │
│   ├→ LLMRequestStartedEvent { requestId: "def" }            │
│   ├→ AssistantMessageEvent { content: "Goodbye!" }          │
│   └→ LLMRequestCompletedEvent { requestId: "def", ... }     │
├─────────────────────────────────────────────────────────────┤
│ CLI exits                                                    │
│   └→ SessionEndedEvent { reason: "user_exit" }              │
└─────────────────────────────────────────────────────────────┘
```

### Interrupted Flow

```
┌─────────────────────────────────────────────────────────────┐
│ User sends "Tell me a long story"                            │
│   ├→ LLMRequestStartedEvent { requestId: "xyz" }            │
│   ├→ TextDeltaEvent { delta: "Once" }                       │
│   ├→ TextDeltaEvent { delta: " upon" }                      │
│   ├→ TextDeltaEvent { delta: " a" }                         │
├─────────────────────────────────────────────────────────────┤
│ User sends "Actually, stop"   ← Interrupt!                   │
│   ├→ LLMRequestInterruptedEvent {                           │
│   │     requestId: "xyz",                                    │
│   │     partialResponse: "Once upon a",                      │
│   │     reason: "new_user_input"                             │
│   │   }                                                      │
│   ├→ LLMRequestStartedEvent { requestId: "abc" }            │
│   ├→ AssistantMessageEvent { content: "OK, stopping." }     │
│   └→ LLMRequestCompletedEvent { requestId: "abc", ... }     │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation

### Session Start

```typescript
const initialize = Effect.fn("ContextSession.initialize")(
  function*(contextName: ContextName) {
    // Load existing events
    const events = yield* repository.loadOrCreate(contextName)

    // Emit session started
    const startEvent = SessionStartedEvent.make({
      timestamp: new Date(),
      loadedEventCount: events.length,
    })
    yield* repository.append(contextName, [startEvent])

    // Update state
    yield* Ref.set(stateRef, {
      contextName,
      events: [...events, startEvent],
      initialized: true,
    })
  }
)
```

### Session End (Finalizer)

```typescript
static readonly layer = Layer.scoped(
  ContextSession,
  Effect.gen(function*() {
    // ... setup ...

    // Register cleanup
    yield* Effect.addFinalizer(() =>
      Effect.gen(function*() {
        const state = yield* Ref.get(stateRef)

        if (state.contextName && state.initialized) {
          const endEvent = SessionEndedEvent.make({
            timestamp: new Date(),
            reason: "scope_closed",
          })

          yield* repository.append(state.contextName, [endEvent]).pipe(
            Effect.catchAll((e) => Effect.logWarning(`Failed to persist SessionEnded: ${e}`))
          )
        }
      })
    )

    // ... rest of implementation ...
  })
)
```

### Request Lifecycle

```typescript
const addEvent = Effect.fn("ContextSession.addEvent")(
  function*(event: InputEvent) {
    const state = yield* Ref.get(stateRef)

    // Persist input
    yield* repository.append(state.contextName!, [event])

    // Reduce
    const reduced = yield* reducer.reduce([...state.events, event])

    // Started event
    const requestId = RequestId.make(crypto.randomUUID())
    const startTime = Date.now()
    const startedEvent = LLMRequestStartedEvent.make({
      requestId,
      timestamp: new Date(startTime),
    })
    yield* repository.append(state.contextName!, [startedEvent])

    // Stream with completion tracking
    return Stream.concat(
      Stream.succeed(startedEvent),
      llmRequest.stream(reduced).pipe(
        Stream.tap((e) => persistIfNeeded(e)),
        Stream.onDone(() =>
          Effect.gen(function*() {
            const completedEvent = LLMRequestCompletedEvent.make({
              requestId,
              timestamp: new Date(),
              durationMs: Date.now() - startTime,
            })
            yield* repository.append(state.contextName!, [completedEvent])
          })
        )
      )
    )
  }
)
```

---

## Observability Integration

Lifecycle events integrate with OpenTelemetry:

```typescript
const startedEvent = LLMRequestStartedEvent.make({
  requestId,
  timestamp: new Date(),
})

// Add to current span
yield* Effect.annotateCurrentSpan({
  "llm.request_id": requestId,
  "llm.start_time": startedEvent.timestamp.toISOString(),
})
```

---

## Effect Pattern Alignment

| Pattern | Usage |
|---------|-------|
| `Layer.scoped` | Session has lifecycle |
| `Effect.addFinalizer` | Cleanup on scope close |
| `Stream.onDone` | Action after stream |
| `Effect.annotateCurrentSpan` | Observability |
| `Schema.TaggedClass` | Type-safe events |
