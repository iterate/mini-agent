# Design C: Stream-Based Cancellation

Uses `Stream.interruptWhen` with an Effect that completes on cancellation. Focuses on stream-level interruption.

## Concept

```
                    ┌───────────────────────────────────┐
 New Input ────────►│ Effect completes (trigger)        │
                    └──────────────────┬────────────────┘
                                       │
                                       ▼
              ┌────────────────────────────────────────────┐
              │ Stream.interruptWhen(Effect) → ends stream │
              └────────────────────────────────────────────┘
```

## Implementation

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
      const config = yield* HandlerConfig

      // Output
      const outputPubSub = yield* PubSub.unbounded<ContextEvent>()

      // Mutable state for current request
      const currentRequestRef = yield* Ref.make<Option.Option<{
        interrupt: Deferred.Deferred<void, never>
        requestId: RequestId
        partialResponseRef: Ref.Ref<string>
      }>>(Option.none())

      // Debounce state
      const debounceRef = yield* Ref.make<{
        timer: Option.Option<Fiber.RuntimeFiber<void, never>>
        pending: InputEvent[]
      }>({
        timer: Option.none(),
        pending: [],
      })

      const submit = Effect.fn("InterruptibleHandler.submit")(
        function*(event: InputEvent) {
          // 1. Check for and interrupt current request
          const currentRequest = yield* Ref.get(currentRequestRef)
          yield* Option.match(currentRequest, {
            onNone: () => Effect.void,
            onSome: (req) =>
              Effect.gen(function*() {
                // Get partial response
                const partial = yield* Ref.get(req.partialResponseRef)

                // Emit interrupted event
                yield* outputPubSub.publish(LLMRequestInterruptedEvent.make({
                  requestId: req.requestId,
                  partialResponse: partial,
                  reason: "new_user_input",
                  timestamp: new Date(),
                }))

                // Signal interruption (stream will end)
                yield* Deferred.succeed(req.interrupt, void 0)

                // Clear current request
                yield* Ref.set(currentRequestRef, Option.none())
              })
          })

          // 2. Reset debounce
          const debounce = yield* Ref.get(debounceRef)
          yield* Option.match(debounce.timer, {
            onNone: () => Effect.void,
            onSome: (timer) => Fiber.interruptFork(timer),
          })

          yield* Ref.update(debounceRef, (d) => ({
            ...d,
            pending: [...d.pending, event],
          }))

          // 3. Start new debounce timer
          const timer = yield* Effect.fork(
            Effect.gen(function*() {
              yield* Effect.sleep(Duration.millis(config.debounceMs))

              // Get pending events
              const pending = yield* Ref.getAndUpdate(debounceRef, (d) => ({
                ...d,
                pending: [],
              })).pipe(Effect.map((d) => d.pending))

              if (pending.length === 0) return

              // Create interrupt mechanism
              const interrupt = yield* Deferred.make<void, never>()
              const requestId = RequestId.make(crypto.randomUUID())
              const partialResponseRef = yield* Ref.make("")

              // Store current request
              yield* Ref.set(currentRequestRef, Option.some({
                interrupt,
                requestId,
                partialResponseRef,
              }))

              // Process pending events with interruptible stream
              for (const pendingEvent of pending) {
                yield* session.addEvent(pendingEvent).pipe(
                  // This is the key: interrupt when Deferred completes
                  Stream.interruptWhen(Deferred.await(interrupt)),
                  // Accumulate partial response
                  Stream.tap((e) => {
                    if (e._tag === "TextDeltaEvent") {
                      return Ref.update(partialResponseRef, (p) => p + e.delta)
                    }
                    return Effect.void
                  }),
                  Stream.runForEach((e) => outputPubSub.publish(e))
                )
              }

              // Clear on completion
              yield* Ref.set(currentRequestRef, Option.none())
            })
          )

          yield* Ref.update(debounceRef, (d) => ({
            ...d,
            timer: Option.some(timer),
          }))
        }
      )

      const events = Stream.fromPubSub(outputPubSub)

      return InterruptibleHandler.of({ submit, events })
    })
  )
}
```

## Stream.interruptWhen vs Stream.interruptWhenDeferred

```typescript
// interruptWhen - takes any Effect
stream.pipe(
  Stream.interruptWhen(someEffect)  // When someEffect completes, stream ends
)

// interruptWhenDeferred - optimized for Deferred
stream.pipe(
  Stream.interruptWhenDeferred(deferred)  // When deferred completes, stream ends
)
```

`interruptWhenDeferred` is slightly more efficient when using Deferred.

## How interruptWhen Works

```typescript
// Conceptually:
Stream.interruptWhen(trigger) = (stream) =>
  Stream.race(
    stream,
    Stream.fromEffect(trigger).pipe(Stream.drain)
  )
```

When `trigger` completes (success or failure), the stream ends.

## Trade-offs

### Pros

| Benefit | Explanation |
|---------|-------------|
| **Stream-native** | Uses Stream's built-in interruption |
| **Composable** | Can combine multiple interrupt conditions |
| **Clean separation** | Interrupt logic separate from stream logic |
| **Lazy** | Interrupt only checked as stream pulls |

### Cons

| Drawback | Explanation |
|----------|-------------|
| **Deferred overhead** | Need to create Deferred per request |
| **Cooperative** | Stream must be pulling for interrupt to work |
| **Timing** | Interrupt happens between elements, not mid-element |

## Comparison: interruptWhen vs Fiber.interrupt

```typescript
// Stream.interruptWhen: Stream decides when to stop
stream.pipe(Stream.interruptWhen(signal))
// Stream continues until it tries to pull next element,
// then checks signal and stops

// Fiber.interrupt: External force stops fiber
yield* Fiber.interrupt(streamFiber)
// Fiber is interrupted immediately, wherever it is
```

## Effect Pattern Alignment

From Stream tests:

```typescript
// interruptWhen with Effect
const latch = yield* Deferred.make<void>()
const stream = Stream.repeat(1).pipe(
  Stream.interruptWhen(Deferred.await(latch))
)

// Stream runs until latch completes
yield* Deferred.succeed(latch, void 0)
```

```typescript
// interruptWhenDeferred (optimized)
const halt = yield* Deferred.make<void>()
const stream = Stream.never.pipe(
  Stream.interruptWhenDeferred(halt)
)
yield* Deferred.succeed(halt, void 0)
```

## When to Use

- Working primarily with Streams
- Want cooperative interruption
- Need to compose multiple interrupt conditions
- Prefer stream-level abstraction over fiber-level

## Recommendation

For the LLM request use case, **Design A (Deferred with interruptWhenDeferred)** or **Design C** are essentially the same pattern. The difference is organizational:

- **Design A**: Emphasizes Deferred as the cancellation mechanism
- **Design C**: Emphasizes Stream.interruptWhen as the composition point

Both are valid. Choose based on mental model preference:
- Think in terms of "signals" → Design A
- Think in terms of "stream operations" → Design C
