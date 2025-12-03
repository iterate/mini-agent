# Design B: Fiber-Based Cancellation

Uses `Fiber.interrupt` directly on the request fiber. More forceful than Deferred.

## Concept

```
                    ┌──────────────────────┐
 New Input ────────►│ Fiber.interrupt(f)   │
                    └──────────┬───────────┘
                               │
                               ▼
              ┌────────────────────────────────┐
              │   Fiber exits (interrupted)    │
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
      const outputPubSub = yield* PubSub.unbounded<ContextEvent>()

      // State using SynchronizedRef for atomic effectful updates
      const stateRef = yield* SynchronizedRef.make<{
        currentFiber: Option.Option<Fiber.RuntimeFiber<void, LLMError>>
        partialResponse: string
        currentRequestId: Option.Option<RequestId>
        debounceTimer: Option.Option<Fiber.RuntimeFiber<void, never>>
        pendingEvents: InputEvent[]
      }>({
        currentFiber: Option.none(),
        partialResponse: "",
        currentRequestId: Option.none(),
        debounceTimer: Option.none(),
        pendingEvents: [],
      })

      const submit = Effect.fn("InterruptibleHandler.submit")(
        function*(event: InputEvent) {
          yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
            Effect.gen(function*() {
              // 1. Interrupt existing fiber if any
              yield* Option.match(state.currentFiber, {
                onNone: () => Effect.void,
                onSome: (fiber) =>
                  Effect.gen(function*() {
                    // Emit interrupted event BEFORE interrupting
                    yield* Option.match(state.currentRequestId, {
                      onNone: () => Effect.void,
                      onSome: (requestId) =>
                        outputPubSub.publish(LLMRequestInterruptedEvent.make({
                          requestId,
                          partialResponse: state.partialResponse,
                          reason: "new_user_input",
                          timestamp: new Date(),
                        }))
                    })

                    // Interrupt and wait (ensures cleanup)
                    yield* Fiber.interrupt(fiber)
                  })
              })

              // 2. Cancel debounce timer
              yield* Option.match(state.debounceTimer, {
                onNone: () => Effect.void,
                onSome: (timer) => Fiber.interruptFork(timer),
              })

              // 3. Start new debounce timer
              const timer = yield* Effect.fork(
                Effect.gen(function*() {
                  yield* Effect.sleep(Duration.millis(config.debounceMs))

                  // Get and clear pending events
                  const pending = yield* SynchronizedRef.modifyEffect(stateRef, (s) =>
                    Effect.succeed([s.pendingEvents, { ...s, pendingEvents: [] }] as const)
                  )

                  if (pending.length === 0) return

                  const requestId = RequestId.make(crypto.randomUUID())

                  // Fork request processing
                  const requestFiber = yield* Effect.fork(
                    Effect.gen(function*() {
                      for (const pendingEvent of pending) {
                        yield* session.addEvent(pendingEvent).pipe(
                          Stream.tap((e) => {
                            if (e._tag === "TextDeltaEvent") {
                              return SynchronizedRef.update(stateRef, (s) => ({
                                ...s,
                                partialResponse: s.partialResponse + e.delta,
                              }))
                            }
                            return Effect.void
                          }),
                          Stream.runForEach((e) => outputPubSub.publish(e))
                        )
                      }
                    }).pipe(
                      // Register cleanup on interrupt
                      Effect.onInterrupt(() =>
                        Effect.logDebug("Request fiber interrupted")
                      )
                    )
                  )

                  // Store fiber reference
                  yield* SynchronizedRef.update(stateRef, (s) => ({
                    ...s,
                    currentFiber: Option.some(requestFiber),
                    currentRequestId: Option.some(requestId),
                    partialResponse: "",
                  }))

                  // Wait for completion
                  yield* Fiber.join(requestFiber)

                  // Clear fiber reference
                  yield* SynchronizedRef.update(stateRef, (s) => ({
                    ...s,
                    currentFiber: Option.none(),
                    currentRequestId: Option.none(),
                  }))
                })
              )

              return [
                void 0,
                {
                  ...state,
                  currentFiber: Option.none(),
                  currentRequestId: Option.none(),
                  partialResponse: "",
                  debounceTimer: Option.some(timer),
                  pendingEvents: [...state.pendingEvents, event],
                }
              ] as const
            })
          )
        }
      )

      const events = Stream.fromPubSub(outputPubSub)

      return InterruptibleHandler.of({ submit, events })
    })
  )
}
```

## Fiber.interrupt vs Fiber.interruptFork

```typescript
// Blocking: wait for fiber to exit
yield* Fiber.interrupt(fiber)

// Non-blocking: signal and continue
yield* Fiber.interruptFork(fiber)
```

Use `Fiber.interrupt` when you need to:
- Ensure cleanup completed before continuing
- Read state after interruption

Use `Fiber.interruptFork` when you need to:
- Continue immediately
- Don't care about cleanup timing

## Trade-offs

### Pros

| Benefit | Explanation |
|---------|-------------|
| **Direct** | No signal indirection |
| **Forceful** | Fiber is definitely interrupted |
| **Cleanup guaranteed** | `onInterrupt` handlers run |
| **Simple model** | Track fiber, interrupt when needed |

### Cons

| Drawback | Explanation |
|----------|-------------|
| **Blocking (if using Fiber.interrupt)** | Must wait for cleanup |
| **Less composable** | Can't share interrupt signal |
| **Order sensitive** | Must emit InterruptedEvent before interrupt |

## Effect Pattern Alignment

From Effect source (`effect/test/Effect/interruption.test.ts`):

```typescript
// Basic interruption
const fiber = yield* Effect.fork(Effect.never)
const result = yield* Fiber.interrupt(fiber)
expect(Exit.isInterrupted(result)).toBe(true)
```

```typescript
// Cleanup on interrupt
const cleanupRef = yield* Ref.make(false)
const fiber = yield* Effect.fork(
  Effect.never.pipe(
    Effect.onInterrupt(() => Ref.set(cleanupRef, true))
  )
)
yield* Fiber.interrupt(fiber)
const didCleanup = yield* Ref.get(cleanupRef)
expect(didCleanup).toBe(true)
```

## SynchronizedRef for Atomic State

Using `SynchronizedRef.modifyEffect` ensures:
1. State read and update are atomic
2. Effects inside can't race
3. No torn reads during interrupt handling

```typescript
yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
  Effect.gen(function*() {
    // This entire block is atomic
    yield* Fiber.interrupt(state.currentFiber)
    return [result, newState]
  })
)
```

## When to Use

- Need guaranteed interruption
- Want simpler mental model (track fiber, interrupt it)
- Don't need to share cancellation signal
- Can tolerate blocking wait for cleanup
