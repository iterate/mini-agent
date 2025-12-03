# Debouncing Pattern

"Wait for quiet" debouncing: after the last event, wait N ms before starting the LLM request.

## The Problem

When events arrive rapidly (e.g., file attachment + message):
1. First event arrives → start LLM request
2. Second event arrives 5ms later → need to interrupt and restart

This causes unnecessary interruptions. Better: wait briefly after each event to see if more are coming.

## The Pattern

```
Event 1 arrives
  → Start timer (10ms)
  → Timer running...
Event 2 arrives (at 5ms)
  → Cancel timer
  → Start new timer (10ms)
  → Timer running...
No more events
  → Timer fires at 15ms total
  → Start LLM request
```

## Configuration

```typescript
interface DebounceConfig {
  // Delay in milliseconds
  delayMs: number
  // 0 = next tick (Effect.yieldNow semantics)
}

// Default: 10ms
const DEFAULT_DEBOUNCE_MS = 10
```

## Design Question: Which Layer?

Debouncing could live in Layer 3 (Session) or Layer 4 (Handler).

### Option A: Layer 3 (Session)

Session's `addEvent` method handles debouncing internally.

```typescript
class ContextSession extends Context.Tag("@app/ContextSession")<
  ContextSession,
  {
    readonly addEvent: (event: InputEvent) => Stream.Stream<ContextEvent, LLMError>
  }
>() {
  static readonly layer = Layer.scoped(
    ContextSession,
    Effect.gen(function*() {
      // Debounce state
      const debounceTimerRef = yield* Ref.make<Option.Option<Fiber.RuntimeFiber<void, never>>>(
        Option.none()
      )
      const pendingEventsRef = yield* Ref.make<InputEvent[]>([])

      const addEvent = Effect.fn("ContextSession.addEvent")(
        function*(event: InputEvent) {
          // Cancel existing timer
          const existingTimer = yield* Ref.get(debounceTimerRef)
          yield* Option.match(existingTimer, {
            onNone: () => Effect.void,
            onSome: (fiber) => Fiber.interruptFork(fiber),
          })

          // Add to pending
          yield* Ref.update(pendingEventsRef, (events) => [...events, event])

          // Start new timer
          const outputQueue = yield* Queue.unbounded<ContextEvent>()

          const timer = yield* Effect.fork(
            Effect.gen(function*() {
              yield* Effect.sleep(Duration.millis(config.debounceMs))

              // Timer fired - process pending events
              const pending = yield* Ref.getAndSet(pendingEventsRef, [])
              yield* processPendingEvents(pending, outputQueue)
            })
          )

          yield* Ref.set(debounceTimerRef, Option.some(timer))

          return Stream.fromQueue(outputQueue)
        }
      )

      // ...
    })
  )
}
```

**Pros**: Encapsulates debouncing within session
**Cons**: Session API becomes more complex, harder to test

### Option B: Layer 4 (Handler)

Debouncing is a concern of the Handler, not Session.

```typescript
class InterruptibleHandler extends Context.Tag("@app/InterruptibleHandler")<
  InterruptibleHandler,
  {
    readonly submit: (event: InputEvent) => Effect.Effect<void>
    readonly events: Stream.Stream<ContextEvent, LLMError>
  }
>() {
  static readonly layer = Layer.scoped(
    InterruptibleHandler,
    Effect.gen(function*() {
      const session = yield* ContextSession

      // Debounce state
      const debounceTimerRef = yield* Ref.make<Option.Option<Fiber.RuntimeFiber<void, never>>>(
        Option.none()
      )
      const pendingEventsRef = yield* Ref.make<InputEvent[]>([])
      const outputPubSub = yield* PubSub.unbounded<ContextEvent>()

      const submit = Effect.fn("InterruptibleHandler.submit")(
        function*(event: InputEvent) {
          // Cancel existing timer
          const existingTimer = yield* Ref.get(debounceTimerRef)
          yield* Option.match(existingTimer, {
            onNone: () => Effect.void,
            onSome: (fiber) => Fiber.interruptFork(fiber),
          })

          // Add to pending
          yield* Ref.update(pendingEventsRef, (events) => [...events, event])

          // Start new timer
          const timer = yield* Effect.fork(
            Effect.gen(function*() {
              yield* Effect.sleep(Duration.millis(config.debounceMs))

              // Timer fired - process all pending events
              const pending = yield* Ref.getAndSet(pendingEventsRef, [])

              for (const pendingEvent of pending) {
                yield* session.addEvent(pendingEvent).pipe(
                  Stream.runForEach((e) => outputPubSub.publish(e))
                )
              }
            })
          )

          yield* Ref.set(debounceTimerRef, Option.some(timer))
        }
      )

      const events = Stream.fromPubSub(outputPubSub)

      return InterruptibleHandler.of({ submit, events })
    })
  )
}
```

**Pros**: Session stays simple, Handler owns timing logic
**Cons**: Two layers of complexity for event processing

## Recommendation: Layer 4 (Handler)

Debouncing is inherently about **managing rapid input** and **preventing unnecessary interruptions**. These are the Handler's concerns.

The Session should be simple: "add event → get response stream".

## Implementation Details

### Using Effect.sleep

```typescript
const debounce = (delayMs: number) =>
  delayMs === 0
    ? Effect.yieldNow()  // Next tick
    : Effect.sleep(Duration.millis(delayMs))
```

### Fiber Cancellation

```typescript
// Cancel timer (non-blocking)
yield* Fiber.interruptFork(existingTimer)

// Or wait for cancellation (blocking)
yield* Fiber.interrupt(existingTimer)
```

Use `interruptFork` for debouncing—we don't need to wait.

### Accumulating Pending Events

```typescript
// Simple: just accumulate
yield* Ref.update(pendingEventsRef, (events) => [...events, event])

// Or with deduplication (if needed)
yield* Ref.update(pendingEventsRef, (events) => {
  // Remove duplicate file attachments, etc.
  return deduplicateEvents([...events, event])
})
```

## Edge Cases

### Delay of 0ms

When `delayMs = 0`, use `Effect.yieldNow()`:

```typescript
if (config.debounceMs === 0) {
  // Next tick - still allows synchronous batching
  yield* Effect.yieldNow()
} else {
  yield* Effect.sleep(Duration.millis(config.debounceMs))
}
```

This means synchronously-added events in the same tick are grouped.

### Very Rapid Events

If events arrive faster than the debounce delay, they accumulate:

```
Event 1 @ 0ms
Event 2 @ 5ms
Event 3 @ 10ms
Event 4 @ 15ms
Event 5 @ 20ms
... timer keeps resetting
Event 6 @ 25ms
... 10ms quiet ...
Timer fires @ 35ms → process all 6 events
```

This is correct behavior—we batch all pending events.

### Configurable per-Session

```typescript
interface SessionConfig {
  contextName: ContextName
  debounceMs: number  // Can vary per session
}

const handler = yield* InterruptibleHandler
yield* handler.configure({ debounceMs: 50 })  // Override for this session
```

## Effect Pattern Alignment

| Pattern | Usage |
|---------|-------|
| `Effect.sleep` | Delay before processing |
| `Effect.yieldNow` | Next tick delay |
| `Fiber.interruptFork` | Cancel timer non-blocking |
| `Ref` | Pending events state |
| `PubSub` | Output event stream |
