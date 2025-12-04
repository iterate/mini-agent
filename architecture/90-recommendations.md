# Recommendations

Synthesized recommendations based on the design exploration.

> **See also:** [detailed-design.md](./detailed-design.md) for complete schemas and code examples.

## Summary of Recommendations

| Layer | Recommended Design | Rationale |
|-------|-------------------|-----------|
| 1. Agent | **Config as Parameter** | Config comes from reducer, keeps layer stateless |
| 2. Reducer | **Service (Design C)** | Supports swappable strategies (truncating, summarizing) |
| 3. Session | **Scoped Layer with Ref + Cancellation** | Stateful, handles lifecycle and interruption internally |
| 4. Application | **Thin facade** | Routes by context name, graceful shutdown |
| Extensibility | **HooksService** | Hooks for transformation and observation |

---

## Layer 1: Agent

### Recommendation: Config as Parameter

```typescript
class Agent extends Context.Tag("@app/Agent")<
  Agent,
  {
    readonly stream: (ctx: ReducedContext) => Stream.Stream<StreamEvent, AgentError>
  }
>() {}
```

**Why:**
- Config comes from event reduction, not environment
- Different contexts can have different retry/provider settings
- Stateless, easy to test
- Matches the data flow (reducer → config → agent)

**Effect patterns used:**
- `Effect.retry(schedule)` for retry
- `Stream.orElse` for fallback

---

## Layer 2: Event Reducer

### Recommendation: Design C (Service)

```typescript
class EventReducer extends Context.Tag("@app/EventReducer")<
  EventReducer,
  {
    readonly reduce: (
      current: ReducedContext,
      newEvents: readonly PersistedEvent[]
    ) => Effect.Effect<ReducedContext, ReducerError>

    readonly initialReducedContext: ReducedContext
  }
>() {}
```

**Why:**
- True functional reducer: `(current, newEvents) => new`
- Service pattern allows swapping implementations (truncating, summarizing)
- Can inject dependencies (token counter, validators)
- Consistent with other services

**Implementations:**
- `EventReducer.layer` - Standard reducer
- `EventReducer.truncatingLayer` - Keeps last N messages
- `EventReducer.summarizingLayer` - Uses LLM to summarize old context

---

## Layer 3: Context Session

### Recommendation: Scoped Layer with Internal Cancellation

Session layer handles both state management and interruption (no separate Handler layer).

```typescript
class ContextSession extends Context.Tag("@app/ContextSession")<
  ContextSession,
  {
    readonly initialize: (contextName: ContextName) => Effect.Effect<void, ContextError>

    // Add event - returns void, not stream
    readonly addEvent: (event: InputEvent) => Effect.Effect<void, SessionError>

    // Continuous stream until session ends
    readonly events: Stream.Stream<PersistedEvent, SessionError>

    readonly getEvents: () => Effect.Effect<readonly PersistedEvent[]>
  }
>() {
  static readonly layer = Layer.scoped(ContextSession, /* ... */)
}
```

**Key design: Decoupled addEvent and events**

`addEvent` returns `Effect.Effect<void>` - fire and forget. The `events` stream is separate and continuous until session ends.

**Why merge Handler into Session:**
- Session already manages state
- Cancellation is just another aspect of session lifecycle
- Simpler architecture (4 layers instead of 5)
- No artificial separation between "session state" and "request handling"

**Cancellation handling:**
```typescript
// On new user message while agent is running:
yield* SynchronizedRef.modifyEffect(state, (current) =>
  Effect.gen(function*() {
    if (current.runningFiber) {
      yield* emit(AgentRequestInterruptedEvent.make({ reason: "new input" }))
      yield* Fiber.interrupt(current.runningFiber)
    }
    // Start new request...
  })
)
```

**Effect patterns used:**
- `Layer.scoped` for resource lifecycle
- `Effect.addFinalizer` for cleanup
- `SynchronizedRef` for atomic state transitions
- `Fiber.interrupt` for cancellation

---

## Layer 4: Application Service

### Recommendation: Thin Facade with Context Routing

```typescript
class ApplicationService extends Context.Tag("@app/ApplicationService")<
  ApplicationService,
  {
    readonly addEvent: (
      contextName: ContextName,
      event: InputEvent
    ) => Effect.Effect<void, SessionError>

    readonly eventStream: (
      contextName: ContextName
    ) => Stream.Stream<PersistedEvent, SessionError>

    readonly shutdown: () => Effect.Effect<void>
  }
>() {}
```

**Why thin:**
- Business logic belongs in inner layers
- Application layer is just routing and convenience
- Same interface works for CLI and HTTP
- Easy to test by mocking inner layers

**Graceful shutdown:**
```typescript
readonly shutdown = Effect.gen(function*() {
  const sessions = yield* Ref.get(sessionsRef)
  yield* Effect.all(
    Array.from(sessions.values()).map((session) => session.close()),
    { concurrency: "unbounded" }
  )
})
```

---

## Extensibility

### Recommendation: HooksService

```typescript
class HooksService extends Context.Tag("@app/HooksService")<
  HooksService,
  {
    // Transform input before agent request
    readonly beforeRequest: (input: ReducedContext) => Effect.Effect<ReducedContext, HookError>

    // Transform response events (can expand 1→N)
    readonly afterResponse: (event: StreamEvent) => Effect.Effect<readonly StreamEvent[], HookError>

    // Observe events (logging, metrics)
    readonly onEvent: (event: PersistedEvent) => Effect.Effect<void, HookError>
  }
>() {}
```

**Event expansion (1→N):**
`afterResponse` returns an array, allowing one event to become multiple:
```typescript
afterResponse: (event) => Effect.succeed([event])  // Pass through
afterResponse: (event) => Effect.succeed([event, extraEvent])  // Expand
```

**Hook composition:**
```typescript
const composeBeforeHooks = (hooks: readonly BeforeRequestHook[]): BeforeRequestHook =>
  (input) => hooks.reduce(
    (acc, hook) => Effect.flatMap(acc, hook),
    Effect.succeed(input)
  )
```

**Use cases:**
- Content moderation (beforeRequest)
- Token counting (beforeRequest)
- Response transformation (afterResponse)
- Metrics collection (onEvent)

---

## Full Layer Composition

```typescript
const appLayer = ApplicationService.layer.pipe(
  Layer.provide(ContextSession.layer),
  Layer.provide(EventReducer.layer),
  Layer.provide(Agent.layer),
  Layer.provide(ContextRepository.layer),
  Layer.provide(HooksService.layer),
  Layer.provide(AppConfig.layer),
  Layer.provide(BunContext.layer),
)
```

---

## Key Effect Patterns Summary

| Pattern | Usage |
|---------|-------|
| `Context.Tag` | Service definitions |
| `Layer.scoped` | Lifecycle-managed services |
| `Effect.fn` | Call-site tracing |
| `Schema.TaggedClass` | Event types |
| `Schema.TaggedError` | Error types |
| `Ref` | Simple state |
| `SynchronizedRef` | Atomic state transitions |
| `Fiber.interrupt` | Cancellation |
| `Effect.addFinalizer` | Cleanup |
| `Schedule.exponential` | Retry with backoff |
| `Stream.orElse` | Fallback |

---

## Implementation Order

1. **Schemas first** - Define all event types (see [detailed-design.md](./detailed-design.md))
2. **Layer 1: Agent** - LLM request with retry/fallback
3. **Layer 2: Reducer** - Service with swappable strategies
4. **Layer 3: Session** - State, persistence, cancellation
5. **Layer 4: Application** - Routing facade
6. **Extensibility** - HooksService

Each layer can be tested independently with mock layers for dependencies.
