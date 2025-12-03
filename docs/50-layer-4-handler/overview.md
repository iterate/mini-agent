# Layer 4: Interruptible Handler - Overview

Manages request concurrency: debounces rapid input, cancels in-flight requests on new input, accumulates partial responses.

## Responsibility

1. **Debounce input**: Wait for quiet period before starting LLM request
2. **Cancel on new input**: When new user input arrives, cancel any in-flight request
3. **Capture partial response**: Before interrupting, capture accumulated response so far
4. **Emit lifecycle events**: `LLMRequestInterruptedEvent` with partial response
5. **Manage request state**: Track current request fiber, accumulated response

## Service Interface

```typescript
class InterruptibleHandler extends Context.Tag("@app/InterruptibleHandler")<
  InterruptibleHandler,
  {
    // Submit an event (may trigger cancellation of in-flight request)
    readonly submit: (event: InputEvent) => Effect.Effect<void>

    // Stream of all output events
    readonly events: Stream.Stream<ContextEvent, LLMError>

    // Configure handler (optional)
    readonly configure: (config: HandlerConfig) => Effect.Effect<void>
  }
>() {}
```

## State

```typescript
interface HandlerState {
  // Current request fiber (if any)
  currentFiber: Option.Option<Fiber.RuntimeFiber<void, LLMError>>

  // Request ID of current request
  currentRequestId: Option.Option<RequestId>

  // Accumulated partial response
  partialResponse: string

  // Debounce timer fiber (if any)
  debounceTimer: Option.Option<Fiber.RuntimeFiber<void, never>>

  // Pending events (waiting for debounce)
  pendingEvents: InputEvent[]
}
```

## Design Decisions

The key question: **How to implement cancellation?**

| Design | Mechanism | See |
|--------|-----------|-----|
| A. Deferred-based | `Deferred.await` + `Stream.interruptWhen` | [design-a-deferred.md](./design-a-deferred.md) |
| B. Fiber-based | `Fiber.interrupt` directly | [design-b-fiber.md](./design-b-fiber.md) |
| C. Stream-based | `Stream.interruptWhenDeferred` | [design-c-stream.md](./design-c-stream.md) |

## Dependencies

```
InterruptibleHandler
└── ContextSession (add events, get responses)
```

## Event Flow

```
User Input
    │
    ▼
┌───────────────────────────────┐
│  InterruptibleHandler.submit  │
├───────────────────────────────┤
│ 1. Cancel existing request?   │
│    - Get partial response     │
│    - Emit InterruptedEvent    │
│    - Interrupt fiber          │
│                               │
│ 2. Reset debounce timer       │
│    - Cancel existing timer    │
│    - Queue event              │
│    - Start new timer          │
│                               │
│ 3. On timer fire:             │
│    - Get pending events       │
│    - Call session.addEvent    │
│    - Start accumulating       │
│    - Stream to output         │
└───────────────────────────────┘
    │
    ▼
Stream<ContextEvent>
```

## Partial Response Accumulation

As `TextDeltaEvent`s stream, accumulate them:

```typescript
Stream.tap((event) => {
  if (event._tag === "TextDeltaEvent") {
    return Ref.update(partialResponseRef, (acc) => acc + event.delta)
  }
  return Effect.void
})
```

On interruption:

```typescript
const partial = yield* Ref.get(partialResponseRef)
const interruptedEvent = LLMRequestInterruptedEvent.make({
  requestId: currentRequestId,
  partialResponse: partial,
  reason: "new_user_input",
  timestamp: new Date(),
})
```

## Debounce + Interrupt Interaction

```
T=0ms    User sends "Hello"
         → Queue "Hello"
         → Start 10ms timer

T=5ms    User sends "World"
         → Cancel timer
         → Queue "World"
         → Start new 10ms timer

T=15ms   Timer fires
         → Process ["Hello", "World"]
         → Start LLM request
         → Streaming...

T=100ms  User sends "Stop"
         → Interrupt LLM request
         → Emit InterruptedEvent with partial
         → Queue "Stop"
         → Start new 10ms timer

T=110ms  Timer fires
         → Process ["Stop"]
         → Start new LLM request
```

## Effect Patterns Used

- `SynchronizedRef` or `Ref` - State management
- `Fiber.interrupt` / `Fiber.interruptFork` - Cancellation
- `Deferred` - Cancellation signal
- `Stream.interruptWhen` / `Stream.interruptWhenDeferred` - Stream cancellation
- `PubSub` - Output event broadcasting
- `Effect.fork` - Background request processing
- `Effect.sleep` - Debounce timer
