# Recommendations

Synthesized recommendations based on the design exploration.

## Summary of Recommendations

| Layer | Recommended Design | Rationale |
|-------|-------------------|-----------|
| 1. LLM Request | **Config as Parameter** | Config comes from reducer, keeps layer stateless |
| 2. Reducer | **Effect-returning function** | Allows validation, token counting; simpler than full service |
| 3. Session | **Scoped Layer with Ref** | Stateful, lifecycle managed, cleanup via finalizers |
| 4. Handler | **Fiber + SynchronizedRef** | Atomic state transitions, guaranteed interruption |
| 5. Application | **Thin facade** | Just routing, no business logic |
| Extensibility | **HooksService + PubSub** | Hooks for transformation, PubSub for observation |

---

## Layer 1: LLM Request

### Recommendation: Design A (Config as Parameter)

```typescript
class LLMRequest extends Context.Tag("@app/LLMRequest")<
  LLMRequest,
  {
    readonly stream: (ctx: ReducedContext) => Stream.Stream<ContextEvent, LLMError>
  }
>() {}
```

**Why:**
- Config comes from event reduction, not environment
- Different contexts can have different retry/provider settings
- Stateless, easy to test
- Matches the data flow (reducer → config → request)

**Effect patterns used:**
- `Effect.retry(schedule)` for retry
- `Stream.orElse` for fallback
- `Effect.all({ concurrency })` for parallel requests

---

## Layer 2: Event Reducer

### Recommendation: Design B (Effect-returning function)

```typescript
// Reducer takes current state + new events, returns updated state
export const reduce = (
  current: ReducedContext,
  newEvents: readonly PersistedEvent[]
): Effect.Effect<ReducedContext, ReducerError> =>
  Effect.gen(function*() {
    const currentState = reducedContextToState(current)
    const newState = newEvents.reduce(reduceEvent, currentState)
    const reduced = stateToReducedContext(newState)

    // Validation
    if (reduced.messages.length === 0) {
      return yield* Effect.fail(ReducerError.make({ message: "No messages" }))
    }

    return reduced
  })

// Initial state for fresh contexts
export const initialReducedContext: ReducedContext = /* ... */
```

**Why:**
- True functional reducer: `(current, newEvents) => new`
- Simpler than full service (no Context.Tag overhead)
- Can do validation, logging, optional token counting
- Easy to test (just an Effect)
- Can upgrade to full service later if needed

**Alternative:** If you need swappable reducer strategies (truncating, summarizing), use Design C (Service).

---

## Layer 3: Context Session

### Recommendation: Scoped Layer with Ref

```typescript
class ContextSession extends Context.Tag("@app/ContextSession")<
  ContextSession,
  {
    readonly initialize: (contextName: ContextName) => Effect.Effect<void, ContextError>
    readonly addEvent: (event: InputEvent) => Stream.Stream<ContextEvent, LLMError>
    readonly getEvents: () => Effect.Effect<readonly PersistedEvent[]>
    readonly close: () => Effect.Effect<void>
  }
>() {
  static readonly layer = Layer.scoped(ContextSession, /* ... */)
}
```

**Key decisions:**
- Use `Layer.scoped` for lifecycle management
- Use `Effect.addFinalizer` for `SessionEndedEvent`
- Use `Ref` for events state (simple, atomic)
- Persist events immediately (crash-safe)

**Effect patterns used:**
- `Layer.scoped` for resource lifecycle
- `Effect.addFinalizer` for cleanup
- `Ref.make` / `Ref.update` for state
- `Stream.tap` for side effects during streaming

---

## Layer 4: Interruptible Handler

### Recommendation: Design B (Fiber + SynchronizedRef)

```typescript
class InterruptibleHandler extends Context.Tag("@app/InterruptibleHandler")<
  InterruptibleHandler,
  {
    readonly submit: (event: InputEvent) => Effect.Effect<void>
    readonly events: Stream.Stream<ContextEvent, LLMError>
  }
>() {}
```

**Key decisions:**
- Use `SynchronizedRef.modifyEffect` for atomic state transitions
- Use `Fiber.interrupt` for guaranteed cancellation
- Use `PubSub` for output (multiple subscribers possible)
- "Wait for quiet" debouncing with `Effect.sleep`

**Why Fiber.interrupt over Deferred:**
- More direct—track fiber, interrupt it
- Guaranteed cleanup via `onInterrupt`
- `SynchronizedRef` ensures we emit `InterruptedEvent` before interrupting

**Effect patterns used:**
- `SynchronizedRef.modifyEffect` for atomic state updates
- `Fiber.interrupt` for cancellation
- `PubSub.unbounded` for event broadcasting
- `Effect.fork` for background processing
- `Effect.sleep` for debounce timer

---

## Layer 5: Application Service

### Recommendation: Thin Facade

```typescript
class ApplicationService extends Context.Tag("@app/ApplicationService")<
  ApplicationService,
  {
    readonly startSession: (contextName: ContextName) => Effect.Effect<void, ContextError>
    readonly sendMessage: (content: string) => Effect.Effect<void>
    readonly events: Stream.Stream<ContextEvent, LLMError>
    readonly endSession: () => Effect.Effect<void>
    // ...
  }
>() {}
```

**Why thin:**
- Business logic belongs in inner layers
- Application layer is just routing and convenience
- Same interface works for CLI and HTTP
- Easy to test by mocking inner layers

---

## Extensibility

### Recommendation: HooksService + PubSub

**HooksService** for transformations:
```typescript
class HooksService extends Context.Tag("@app/HooksService")<
  HooksService,
  {
    readonly beforeRequest: (input: ReducedContext) => Effect.Effect<ReducedContext>
    readonly afterResponse: (event: ContextEvent) => Effect.Effect<ContextEvent>
    readonly onEvent: (event: ContextEvent) => Effect.Effect<void>
  }
>() {}
```

**PubSub** for observation:
```typescript
class EventBus extends Context.Tag("@app/EventBus")<
  EventBus,
  PubSub.PubSub<ContextEvent>
>() {}
```

**Why both:**
- Hooks for transformation (can modify input/output)
- PubSub for observation (read-only, multiple subscribers)
- Different use cases, different patterns

---

## Debouncing

### Recommendation: "Wait for Quiet" in Layer 4

```typescript
// Wait for quiet period
yield* Effect.sleep(Duration.millis(config.debounceMs))

// 0ms = next tick
if (config.debounceMs === 0) {
  yield* Effect.yieldNow()
} else {
  yield* Effect.sleep(Duration.millis(config.debounceMs))
}
```

**Why Layer 4:**
- Debouncing is about managing rapid input
- Prevents unnecessary interruptions
- Session layer stays simple

**Default:** 10ms (reduces interruptions, still responsive)

---

## Session Lifecycle

### Recommendation: Explicit Start/End Events

```
CLI boots
  → app.startSession("chat")
    → SessionStartedEvent persisted

... user interaction ...

CLI exits
  → Effect.addFinalizer runs
    → SessionEndedEvent persisted
```

**Why:**
- Full audit trail
- Debugging support
- Consistent with "everything is an event" philosophy

---

## Full Layer Composition

```typescript
const appLayer = ApplicationService.layer.pipe(
  Layer.provide(InterruptibleHandler.layer),
  Layer.provide(ContextSession.layer),
  Layer.provide(LLMRequest.layer),
  Layer.provide(ContextRepository.layer),
  Layer.provide(HooksService.layer),
  Layer.provide(EventBus.layer),
  Layer.provide(AppConfig.layer),
  Layer.provide(BunContext.layer),
)
```

---

## Key Effect Patterns Summary

| Pattern | Usage |
|---------|-------|
| `Context.Tag` | Service definitions |
| `Layer.effect` / `Layer.scoped` | Service implementations |
| `Effect.fn` | Automatic tracing |
| `Schema.TaggedClass` | Event types |
| `Schema.TaggedError` | Error types |
| `Ref` / `SynchronizedRef` | State management |
| `Fiber.interrupt` | Cancellation |
| `Stream.interruptWhen` | Stream cancellation |
| `PubSub` | Event broadcasting |
| `Effect.retry(schedule)` | Retry with backoff |
| `Effect.addFinalizer` | Cleanup |

---

## Future Considerations

1. **Dynamic Reducers**: Architecture supports swappable reducers via Context.Tag, but single implementation is sufficient for now

2. **Multiple Persistence Backends**: ContextRepository can be swapped for SQLite, remote API, etc.

3. **Multi-Session HTTP**: Would need SessionManager service for concurrent sessions

4. **Token Limits**: Add token counting hook, truncating or summarizing reducer

5. **Caching**: Add caching middleware for repeated queries

---

## Implementation Order

If implementing:

1. **Schemas first** (80-schemas/) - Define all event types
2. **Layer 1** - LLM request with retry/fallback
3. **Layer 2** - Reducer function
4. **Layer 3** - Session with persistence
5. **Layer 4** - Handler with interruption
6. **Layer 5** - Application facade
7. **Extensibility** - Hooks and PubSub

Each layer can be tested independently with mock layers for dependencies.
