# Design A: Deferred-Based Cancellation

Uses `Deferred` as a cancellation signal. The request stream listens for this signal and interrupts itself.

## Concept

```
                    ┌──────────────────────┐
 New Input ────────►│ Deferred.succeed()   │
                    └──────────┬───────────┘
                               │
                               ▼
              ┌────────────────────────────────┐
              │ Stream.interruptWhenDeferred() │
              └────────────────────────────────┘
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

      // Output channel
      const outputQueue = yield* Queue.unbounded<ContextEvent>()

      // State
      const stateRef = yield* Ref.make<{
        cancelSignal: Option.Option<Deferred.Deferred<void, never>>
        partialResponse: string
        currentRequestId: Option.Option<RequestId>
        debounceTimer: Option.Option<Fiber.RuntimeFiber<void, never>>
        pendingEvents: InputEvent[]
      }>({
        cancelSignal: Option.none(),
        partialResponse: "",
        currentRequestId: Option.none(),
        debounceTimer: Option.none(),
        pendingEvents: [],
      })

      const submit = Effect.fn("InterruptibleHandler.submit")(
        function*(event: InputEvent) {
          const state = yield* Ref.get(stateRef)

          // 1. Cancel existing request if any
          yield* Option.match(state.cancelSignal, {
            onNone: () => Effect.void,
            onSome: (signal) =>
              Effect.gen(function*() {
                // Emit interrupted event with partial response
                yield* Option.match(state.currentRequestId, {
                  onNone: () => Effect.void,
                  onSome: (requestId) =>
                    Queue.offer(outputQueue, LLMRequestInterruptedEvent.make({
                      requestId,
                      partialResponse: state.partialResponse,
                      reason: "new_user_input",
                      timestamp: new Date(),
                    }))
                })

                // Signal cancellation
                yield* Deferred.succeed(signal, void 0)
              })
          })

          // 2. Cancel existing debounce timer
          yield* Option.match(state.debounceTimer, {
            onNone: () => Effect.void,
            onSome: (timer) => Fiber.interruptFork(timer),
          })

          // 3. Queue event and start new timer
          yield* Ref.update(stateRef, (s) => ({
            ...s,
            cancelSignal: Option.none(),
            currentRequestId: Option.none(),
            partialResponse: "",
            pendingEvents: [...s.pendingEvents, event],
          }))

          // 4. Start debounce timer
          const timer = yield* Effect.fork(
            Effect.gen(function*() {
              yield* Effect.sleep(Duration.millis(config.debounceMs))

              // Timer fired - process pending events
              const pending = yield* Ref.getAndUpdate(stateRef, (s) => ({
                ...s,
                pendingEvents: [],
              })).pipe(Effect.map((s) => s.pendingEvents))

              if (pending.length === 0) return

              // Create new cancel signal
              const newSignal = yield* Deferred.make<void, never>()
              const requestId = RequestId.make(crypto.randomUUID())

              yield* Ref.update(stateRef, (s) => ({
                ...s,
                cancelSignal: Option.some(newSignal),
                currentRequestId: Option.some(requestId),
                partialResponse: "",
              }))

              // Process each event and stream responses
              for (const pendingEvent of pending) {
                yield* session.addEvent(pendingEvent).pipe(
                  // Interrupt when cancel signal fires
                  Stream.interruptWhenDeferred(newSignal),
                  // Accumulate partial response
                  Stream.tap((e) => {
                    if (e._tag === "TextDeltaEvent") {
                      return Ref.update(stateRef, (s) => ({
                        ...s,
                        partialResponse: s.partialResponse + e.delta,
                      }))
                    }
                    return Effect.void
                  }),
                  // Forward to output
                  Stream.runForEach((e) => Queue.offer(outputQueue, e))
                )
              }

              // Clear signal after completion
              yield* Ref.update(stateRef, (s) => ({
                ...s,
                cancelSignal: Option.none(),
                currentRequestId: Option.none(),
              }))
            })
          )

          yield* Ref.update(stateRef, (s) => ({
            ...s,
            debounceTimer: Option.some(timer),
          }))
        }
      )

      const events = Stream.fromQueue(outputQueue)

      return InterruptibleHandler.of({ submit, events })
    })
  )
}
```

## Usage

```typescript
const program = Effect.gen(function*() {
  const handler = yield* InterruptibleHandler

  // Subscribe to events in background
  yield* Effect.fork(
    handler.events.pipe(
      Stream.runForEach((event) => {
        if (event._tag === "TextDeltaEvent") {
          return Effect.sync(() => process.stdout.write(event.delta))
        }
        if (event._tag === "LLMRequestInterruptedEvent") {
          return Effect.log(`Interrupted: ${event.partialResponse.slice(0, 50)}...`)
        }
        return Effect.void
      })
    )
  )

  // Submit events
  yield* handler.submit(UserMessageEvent.make({ content: "Hello" }))

  // ... later, interrupt with new input
  yield* handler.submit(UserMessageEvent.make({ content: "Actually, goodbye" }))
})
```

## Trade-offs

### Pros

| Benefit | Explanation |
|---------|-------------|
| **Cooperative** | Stream interrupts itself cleanly |
| **Composable** | Deferred works with any Effect/Stream |
| **Multiple uses** | Can reuse Deferred pattern elsewhere |
| **Clean semantics** | Signal is one-time, clear lifecycle |

### Cons

| Drawback | Explanation |
|----------|-------------|
| **Extra indirection** | Signal layer between request and cancel |
| **New Deferred per request** | Must create fresh Deferred each time |
| **Deferred is one-time** | Can't reuse for multiple cancellations |

## Effect Pattern Alignment

From Effect source (`effect/test/Deferred.test.ts`):

```typescript
// Multiple awaiters pattern
const signal = yield* Deferred.make<void, never>()
const fiber1 = yield* Effect.fork(Deferred.await(signal))
const fiber2 = yield* Effect.fork(Deferred.await(signal))
yield* Deferred.succeed(signal, void 0)  // Both wake up
```

From Stream tests (`effect/test/Stream/interrupting.test.ts`):

```typescript
// Stream.interruptWhenDeferred pattern
const halt = yield* Deferred.make<void>()
const stream = Stream.never.pipe(
  Stream.interruptWhenDeferred(halt)
)
yield* Deferred.succeed(halt, void 0)  // Stream ends
```

## When to Use

- Want cooperative interruption (stream decides when to check)
- Multiple streams might share same cancellation signal
- Clean separation between "request to cancel" and "actually cancelled"
