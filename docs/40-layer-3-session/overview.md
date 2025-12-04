# Layer 3: Context Session - Overview

Manages a context's lifecycle: loading events, running reducers, making LLM requests, persisting events, and emitting lifecycle markers.

## Responsibility

Given a context name and new input events:
1. Load existing events from storage
2. Emit `SessionStartedEvent` (on first load)
3. Persist new input events
4. Reduce all events to `ReducedContext`
5. Emit `LLMRequestStartedEvent`
6. Stream LLM response
7. Persist response events
8. Emit `LLMRequestCompletedEvent`
9. Support `SessionEndedEvent` on cleanup

## Service Interface

```typescript
class ContextSession extends Context.Tag("@app/ContextSession")<
  ContextSession,
  {
    // Initialize session for a context
    readonly initialize: (contextName: ContextName) => Effect.Effect<void, ContextError>

    // Add event and get response stream
    readonly addEvent: (event: InputEvent) => Stream.Stream<ContextEvent, LLMError>

    // Get current state (for introspection)
    readonly getState: () => Effect.Effect<ReducedContext>

    // Get all events
    readonly getEvents: () => Effect.Effect<readonly PersistedEvent[]>

    // Clean shutdown
    readonly close: () => Effect.Effect<void>
  }
>() {}
```

## State Management

The session maintains state across calls:

```typescript
interface SessionState {
  contextName: ContextName | null
  events: PersistedEvent[]
  reduced: ReducedContext  // Current reduced state for incremental updates
  initialized: boolean
}
```

Uses `Ref` or `SynchronizedRef` for state management. The `reduced` field caches the current reduced context, allowing incremental application of new events without re-reducing all historical events.

## Key Features

| Feature | Description | See |
|---------|-------------|-----|
| **Debouncing** | Wait for quiet before LLM request | [debouncing.md](./debouncing.md) |
| **Lifecycle Events** | SessionStarted, SessionEnded, etc. | [lifecycle-events.md](./lifecycle-events.md) |
| **Persistence** | When and how to persist events | [persistence.md](./persistence.md) |

## Dependencies

```
ContextSession
├── ContextRepository (load/save events)
├── EventReducer (reduce events)
├── LLMRequest (make LLM calls)
└── HooksService (optional: extensibility)
```

## Does NOT Handle

- Request interruption (that's Layer 4)
- Debounce timing (that's Layer 4)
- External interface (that's Layer 5)

Note: There's a design question about whether debouncing belongs in Layer 3 or Layer 4. See [debouncing.md](./debouncing.md) for discussion.

## Implementation Outline

```typescript
class ContextSession extends Context.Tag("@app/ContextSession")<
  ContextSession,
  {
    readonly initialize: (contextName: ContextName) => Effect.Effect<void, ContextError>
    readonly addEvent: (event: InputEvent) => Stream.Stream<ContextEvent, LLMError>
    readonly getState: () => Effect.Effect<ReducedContext>
    readonly getEvents: () => Effect.Effect<readonly PersistedEvent[]>
    readonly close: () => Effect.Effect<void>
  }
>() {
  static readonly layer = Layer.scoped(
    ContextSession,
    Effect.gen(function*() {
      const repository = yield* ContextRepository
      const reducer = yield* EventReducer
      const llmRequest = yield* LLMRequest

      // Session state
      const stateRef = yield* Ref.make<SessionState>({
        contextName: null,
        events: [],
        initialized: false,
      })

      // Cleanup on scope close
      yield* Effect.addFinalizer(() =>
        Effect.gen(function*() {
          const state = yield* Ref.get(stateRef)
          if (state.contextName && state.initialized) {
            const endEvent = SessionEndedEvent.make({
              timestamp: new Date(),
              reason: "scope_closed",
            })
            yield* repository.append(state.contextName, [endEvent])
          }
        })
      )

      const initialize = Effect.fn("ContextSession.initialize")(
        function*(contextName: ContextName) {
          const events = yield* repository.loadOrCreate(contextName)

          // Emit session started
          const startEvent = SessionStartedEvent.make({
            timestamp: new Date(),
            loadedEventCount: events.length,
          })
          yield* repository.append(contextName, [startEvent])

          yield* Ref.set(stateRef, {
            contextName,
            events: [...events, startEvent],
            initialized: true,
          })
        }
      )

      const addEvent = Effect.fn("ContextSession.addEvent")(
        function*(event: InputEvent) {
          const state = yield* Ref.get(stateRef)

          if (!state.contextName) {
            return yield* Effect.fail(new Error("Session not initialized"))
          }

          // Persist input event
          yield* repository.append(state.contextName, [event])
          yield* Ref.update(stateRef, (s) => ({
            ...s,
            events: [...s.events, event],
          }))

          // Get updated events
          const updatedEvents = yield* Ref.get(stateRef).pipe(
            Effect.map((s) => s.events)
          )

          // Reduce - apply new event to current state
          const reduced = yield* reducer.reduce(state.reduced, [event])

          // Emit request started
          const requestId = RequestId.make(crypto.randomUUID())
          const startedEvent = LLMRequestStartedEvent.make({
            requestId,
            timestamp: new Date(),
          })
          yield* repository.append(state.contextName, [startedEvent])

          // Stream LLM response with persistence
          return Stream.concat(
            Stream.succeed(startedEvent),
            llmRequest.stream(reduced).pipe(
              Stream.tap((event) => {
                // Persist non-ephemeral events
                if (isPersistedEvent(event)) {
                  return Effect.gen(function*() {
                    const s = yield* Ref.get(stateRef)
                    yield* repository.append(s.contextName!, [event])
                    yield* Ref.update(stateRef, (st) => ({
                      ...st,
                      events: [...st.events, event],
                    }))
                  })
                }
                return Effect.void
              }),
              Stream.onDone(() =>
                Effect.gen(function*() {
                  const completedEvent = LLMRequestCompletedEvent.make({
                    requestId,
                    timestamp: new Date(),
                    durationMs: Date.now() - startedEvent.timestamp.getTime(),
                  })
                  const s = yield* Ref.get(stateRef)
                  yield* repository.append(s.contextName!, [completedEvent])
                })
              )
            )
          )
        }
      )

      // ... getState, getEvents, close implementations

      return ContextSession.of({ initialize, addEvent, getState, getEvents, close })
    })
  )
}
```

## Effect Patterns Used

- `Layer.scoped` - Session has lifecycle (cleanup on scope close)
- `Effect.addFinalizer` - Emit SessionEnded on cleanup
- `Ref.make` / `Ref.update` - State management
- `Stream.tap` - Side effects during streaming
- `Stream.onDone` - Action after stream completes
- `Effect.fn` - Automatic tracing spans
