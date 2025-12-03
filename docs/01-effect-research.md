# Effect Research Notes

Research gathered from exploring the Effect source code and EffectPatterns repository.

## Sources

- Effect source: `~/src/github.com/Effect-TS/effect`
- EffectPatterns: `~/src/github.com/PaulJPhilp/EffectPatterns`
- Effect Solutions CLI: `effect-solutions show <topic>`

---

## 1. Schedule & Retry Patterns

### Schedule Basics

```typescript
// Schedule<Out, In, R> - consumes In, produces Out
Schedule.recurs(n)           // Retry exactly n times
Schedule.fixed(duration)     // Fixed delay between retries
Schedule.spaced(duration)    // Same as fixed
Schedule.exponential(base)   // Exponential backoff
Schedule.fibonacci(base)     // Fibonacci backoff
Schedule.once                // Retry exactly once
```

### Composing Schedules

```typescript
// Limit exponential backoff to 3 retries
const schedule = Schedule.exponential("100 millis").pipe(
  Schedule.compose(Schedule.recurs(3))
)

// Add jitter
const withJitter = schedule.pipe(Schedule.jittered)

// Cap maximum delay
const capped = Schedule.exponential("100 millis").pipe(
  Schedule.either(Schedule.spaced("10 seconds"))  // Whichever is shorter
)
```

### Applying Retry to Effects

```typescript
// Basic retry
const withRetry = effect.pipe(Effect.retry(schedule))

// Retry with options object
effect.pipe(Effect.retry({
  times: 5,
  schedule: Schedule.exponential("100 millis"),
  while: (error) => error.retryable === true,
  until: (error) => error.code === "FATAL"
}))

// Retry with fallback
Effect.retryOrElse(
  effect,
  schedule,
  (error, scheduleOutput) => fallbackEffect
)
```

### Stream Retry

```typescript
// Retry entire stream on failure
stream.pipe(Stream.retry(schedule))

// Retry individual elements
stream.pipe(
  Stream.mapEffect((item) =>
    processItem(item).pipe(Effect.retry(schedule))
  )
)
```

**Source**: `effect/packages/effect/src/Schedule.ts`, `effect/packages/effect/src/Effect.ts`

---

## 2. Parallel Execution Patterns

### Effect.all - Collect All Results

```typescript
// Run concurrently, collect all results
const [result1, result2] = yield* Effect.all(
  [effect1, effect2],
  { concurrency: 2 }
)

// With object syntax
const { content, injectionCheck } = yield* Effect.all({
  content: generateContent(prompt),
  injectionCheck: detectInjection(prompt)
}, { concurrency: "unbounded" })
```

### Effect.race - First Wins

```typescript
// First successful result wins, others interrupted
const fastest = yield* Effect.race(
  openAIRequest(prompt),
  anthropicRequest(prompt)
)
```

### Effect.raceAll - Race Multiple

```typescript
const providers = [openAI, anthropic, cohere].map(p => p.request(prompt))
const result = yield* Effect.raceAll(providers)
```

### Provider Chain with Fallback

```typescript
// Try primary, fallback to secondary on failure
const withFallback = primaryProvider.request(prompt).pipe(
  Effect.retry(retrySchedule),
  Effect.orElse(() => secondaryProvider.request(prompt))
)

// Chain multiple fallbacks
const chain = providers.reduce(
  (fallback, provider) =>
    provider.request(prompt).pipe(
      Effect.retry(schedule),
      Effect.orElse(() => fallback)
    ),
  Effect.fail(new Error("All providers exhausted"))
)
```

**Source**: `effect/packages/effect/src/Effect.ts`

---

## 3. Stateful Services

### Ref - Atomic Immutable State

```typescript
// Create ref
const stateRef = yield* Ref.make<State>({ count: 0, data: [] })

// Read
const current = yield* Ref.get(stateRef)

// Atomic update
yield* Ref.update(stateRef, (s) => ({ ...s, count: s.count + 1 }))

// Update and get new value
const updated = yield* Ref.updateAndGet(stateRef, transform)

// Get old value and update
const old = yield* Ref.getAndUpdate(stateRef, transform)

// Modify: update and return arbitrary value
const [result, newState] = yield* Ref.modify(stateRef, (s) => [
  computeResult(s),
  updateState(s)
])
```

### SynchronizedRef - Effectful State Updates

```typescript
// When you need to run effects during state transition
const syncRef = yield* SynchronizedRef.make<State>(initialState)

// modifyEffect allows effects inside the update
const result = yield* SynchronizedRef.modifyEffect(syncRef, (state) =>
  Effect.gen(function*() {
    const newData = yield* fetchData(state.id)  // Can do I/O
    return [newData, { ...state, data: newData }] as const
  })
)
```

**Key difference**: `Ref.modify` is synchronous; `SynchronizedRef.modifyEffect` can run effects atomically.

### When to Use Which

| Use Case | Choice |
|----------|--------|
| Simple counter/flag | `Ref` |
| Accumulating values | `Ref` |
| State update needs I/O | `SynchronizedRef` |
| State update needs validation effect | `SynchronizedRef` |
| Multiple readers, rare writers | `Ref` |
| Complex state machine | `SynchronizedRef` |

**Source**: `effect/packages/effect/src/Ref.ts`, `effect/packages/effect/src/SynchronizedRef.ts`

---

## 4. Fiber Interruption

### Basic Interruption

```typescript
// Fork a fiber
const fiber = yield* Effect.fork(longRunningTask)

// Interrupt and wait for cleanup
const result = yield* Fiber.interrupt(fiber)  // Blocks until done

// Check if result was interrupted
if (Exit.isFailure(result) && Cause.isInterruptedOnly(result.cause)) {
  // Was interrupted
}

// Interrupt without waiting (fire-and-forget)
yield* Fiber.interruptFork(fiber)

// Interrupt multiple fibers
yield* Fiber.interruptAll([fiber1, fiber2, fiber3])
```

### Cleanup on Interruption

```typescript
const task = Effect.gen(function*() {
  yield* Effect.log("Starting")
  yield* longRunningWork
  yield* Effect.log("Done")
}).pipe(
  Effect.onInterrupt(() => Effect.log("Cleaning up..."))
)
```

### Trade-offs

| Method | Behavior | Use When |
|--------|----------|----------|
| `Fiber.interrupt(f)` | Waits for cleanup | Need confirmation fiber is done |
| `Fiber.interruptFork(f)` | Fire-and-forget | Don't need to wait |
| `Fiber.interruptAll([...])` | Interrupt multiple, wait for all | Cleaning up multiple fibers |

**Source**: `effect/packages/effect/src/Fiber.ts`, `effect/packages/effect/test/Effect/interruption.test.ts`

---

## 5. Deferred - One-Time Signals

### Basic Usage

```typescript
// Create a deferred (one-shot promise-like)
const signal = yield* Deferred.make<void, never>()

// Wait for it (blocks until completed)
yield* Deferred.await(signal)

// Complete it (unblocks all waiters)
yield* Deferred.succeed(signal, void 0)

// Or fail it
yield* Deferred.fail(signal, new Error("Cancelled"))
```

### Cancellation Token Pattern

```typescript
const cancelSignal = yield* Deferred.make<void, never>()

// Worker waits on signal
const worker = Effect.gen(function*() {
  yield* Effect.race(
    actualWork,
    Deferred.await(cancelSignal).pipe(
      Effect.flatMap(() => Effect.fail(new CancelledError()))
    )
  )
})

// Later: trigger cancellation
yield* Deferred.succeed(cancelSignal, void 0)
```

### Multiple Subscribers

```typescript
// Multiple fibers can await the same Deferred
const signal = yield* Deferred.make<void, never>()

yield* Effect.fork(Deferred.await(signal).pipe(Effect.flatMap(() => worker1)))
yield* Effect.fork(Deferred.await(signal).pipe(Effect.flatMap(() => worker2)))

// All workers start when signal fires
yield* Deferred.succeed(signal, void 0)
```

**Source**: `effect/packages/effect/src/Deferred.ts`, `effect/packages/effect/test/Deferred.test.ts`

---

## 6. Stream Interruption

### Stream.interruptWhen

```typescript
// Interrupt stream when effect completes
const interruptible = stream.pipe(
  Stream.interruptWhen(Deferred.await(cancelSignal))
)

// Optimized variant for Deferred
const interruptible = stream.pipe(
  Stream.interruptWhenDeferred(cancelSignal)
)
```

### Cleanup on Stream Interruption

```typescript
const stream = Stream.fromEffect(
  Effect.gen(function*() {
    yield* acquireResource
    yield* processData
  }).pipe(
    Effect.onInterrupt(() => releaseResource)
  )
)

const interruptible = stream.pipe(
  Stream.interruptWhenDeferred(cancelSignal)
)
```

### Combining with Fiber

```typescript
// Fork stream processing, interrupt later
const fiber = yield* stream.pipe(
  Stream.runForEach((item) => processItem(item)),
  Effect.fork
)

// Later: interrupt the stream
yield* Fiber.interrupt(fiber)
```

**Source**: `effect/packages/effect/test/Stream/interrupting.test.ts`

---

## 7. PubSub - Event Broadcasting

### Basic Usage

```typescript
// Create unbounded pubsub
const pubsub = yield* PubSub.unbounded<Event>()

// Publish
yield* pubsub.publish(event)

// Subscribe (returns a Queue)
const queue = yield* pubsub.subscribe

// Consume from queue
yield* Stream.fromQueue(queue).pipe(
  Stream.runForEach((event) => handleEvent(event))
)
```

### With Replay Buffer

```typescript
// New subscribers get last 100 messages
const pubsub = yield* PubSub.unbounded<Event>({ replay: 100 })
```

### Multiple Subscribers

```typescript
const eventBus = yield* PubSub.unbounded<LLMEvent>()

// Subscriber 1: logging
yield* Effect.fork(
  Stream.fromPubSub(eventBus).pipe(
    Stream.runForEach((e) => Effect.log(`Event: ${e._tag}`))
  )
)

// Subscriber 2: metrics
yield* Effect.fork(
  Stream.fromPubSub(eventBus).pipe(
    Stream.runForEach((e) => recordMetric(e))
  )
)

// Both receive all published events
yield* eventBus.publish(LLMRequestStarted.make({ ... }))
```

**Source**: `effect/packages/effect/src/PubSub.ts`

---

## 8. FiberRef - Fiber-Scoped State

### Basic Usage

```typescript
// Create fiber-local state
const requestContext = FiberRef.unsafeMake<RequestContext>({
  traceId: "",
  userId: null
})

// Read
const ctx = yield* FiberRef.get(requestContext)

// Update for current fiber
yield* FiberRef.set(requestContext, { ...ctx, userId: "123" })

// Temporarily override (scoped)
yield* Effect.locally(requestContext, newContext)(
  Effect.gen(function*() {
    // Inside here, requestContext has newContext value
    const ctx = yield* FiberRef.get(requestContext)
  })
)
```

### Use Cases

- Request-scoped context (userId, traceId)
- Logging context
- Hook chains (like pre/post response handlers)
- Thread-local configuration

**Source**: `effect/packages/effect/src/FiberRef.ts`, `effect/packages/platform/src/HttpApp.ts`

---

## 9. Hooks & Middleware Patterns

### HTTP Middleware Pattern (@effect/platform)

```typescript
// Middleware is a higher-order function
type HttpMiddleware = <E, R>(app: HttpApp<E, R>) => HttpApp<E, R>

// Example: logging middleware
const logger: HttpMiddleware = (httpApp) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    yield* Effect.log(`${request.method} ${request.url}`)
    return yield* httpApp
  })

// Compose middlewares
const app = myApp.pipe(logger, auth, cors)
```

### Pre/Post Response Hooks (FiberRef Chain)

```typescript
// From @effect/platform HttpApp.ts
type PreResponseHandler = (
  request: ServerRequest,
  response: HttpServerResponse
) => Effect.Effect<HttpServerResponse>

// Append handler to chain
const appendPreResponseHandler = (handler: PreResponseHandler) =>
  FiberRef.update(
    currentPreResponseHandlers,
    Option.match({
      onNone: () => Option.some(handler),
      onSome: (prev) =>
        Option.some((request, response) =>
          Effect.flatMap(prev(request, response), (r) => handler(request, r))
        )
    })
  )
```

### Stream Transformation

```typescript
// Tap: inspect without changing
stream.pipe(Stream.tap((event) => Effect.log(`Received: ${event}`)))

// MapEffect: transform effectfully
stream.pipe(Stream.mapEffect((event) => enrichEvent(event)))

// FilterEffect: conditional filtering
stream.pipe(Stream.filterEffect((event) => shouldKeep(event)))

// Compose transformers
const pipeline = flow(
  Stream.tap(logEvent),
  Stream.mapEffect(enrichEvent),
  Stream.filterEffect(validateEvent)
)
```

**Source**: `effect/packages/platform/src/HttpMiddleware.ts`, `effect/packages/platform/src/HttpApp.ts`

---

## 10. Service-First Design (Effect Solutions)

### Core Principle

Define service interfaces (contracts) before implementations. This enables:
- Type-checking orchestration code before leaf implementations exist
- Clear dependency graphs
- Easy testing with mock layers

### Pattern

```typescript
// 1. Define service interface
class Users extends Context.Tag("@app/Users")<
  Users,
  {
    readonly findById: (id: UserId) => Effect.Effect<User>
    readonly all: () => Effect.Effect<readonly User[]>
  }
>() {}

// 2. Higher-level service can use it immediately
class Events extends Context.Tag("@app/Events")<
  Events,
  {
    readonly register: (eventId: EventId, userId: UserId) => Effect.Effect<Registration>
  }
>() {
  static readonly layer = Layer.effect(
    Events,
    Effect.gen(function*() {
      const users = yield* Users  // Uses service before it's implemented

      const register = Effect.fn("Events.register")(
        function*(eventId: EventId, userId: UserId) {
          const user = yield* users.findById(userId)
          // ... orchestration logic
        }
      )

      return Events.of({ register })
    })
  )
}

// 3. Implement leaf services later
Users.layer = Layer.effect(Users, /* actual implementation */)
Users.testLayer = Layer.sync(Users, () => /* mock */)
```

### Benefits

- Orchestration code compiles before leaf services exist
- Clear separation of interface and implementation
- Easy to swap implementations via layers
- Test layers for isolated testing

**Source**: Effect Solutions `services-and-layers`, `effect/packages/effect/src/Context.ts`

---

## 11. Layer Composition

### Basic Composition

```typescript
// Merge independent layers
const layer1 = Layer.mergeAll(
  ServiceA.layer,
  ServiceB.layer,
  ServiceC.layer
)

// Sequential dependencies
const appLayer = ServiceC.layer.pipe(
  Layer.provide(ServiceB.layer),
  Layer.provide(ServiceA.layer)
)

// Or using provideMerge
const appLayer = ServiceC.layer.pipe(
  Layer.provideMerge(ServiceB.layer),
  Layer.provideMerge(ServiceA.layer)
)
```

### Scoped Layers

```typescript
// Layer with cleanup (scoped resource)
const layer = Layer.scoped(
  MyService,
  Effect.gen(function*() {
    const resource = yield* acquireResource
    yield* Effect.addFinalizer(() => releaseResource(resource))
    return MyService.of({ /* ... */ })
  })
)
```

### Layer Memoization

Layers are memoized by reference. Store in constants to share:

```typescript
// Good: single instance
const dbLayer = Database.layer({ pool: 10 })
const appLayer = Layer.mergeAll(
  UserRepo.layer.pipe(Layer.provide(dbLayer)),
  OrderRepo.layer.pipe(Layer.provide(dbLayer))  // Same instance
)

// Bad: two instances
const appLayer = Layer.mergeAll(
  UserRepo.layer.pipe(Layer.provide(Database.layer({ pool: 10 }))),
  OrderRepo.layer.pipe(Layer.provide(Database.layer({ pool: 10 })))  // Different!
)
```

**Source**: `effect/packages/effect/src/Layer.ts`

---

## 12. Debouncing Pattern

Effect doesn't have a built-in debounce, but it's easy to implement:

```typescript
// Using Deferred + sleep
const debounce = <A>(
  delayMs: number,
  onTrigger: Effect.Effect<A>
): Effect.Effect<void, never, Scope> =>
  Effect.gen(function*() {
    const debounceRef = yield* Ref.make<Option.Option<Deferred.Deferred<void, never>>>(
      Option.none()
    )

    return {
      trigger: Effect.gen(function*() {
        // Cancel previous timer
        const prev = yield* Ref.get(debounceRef)
        yield* Option.match(prev, {
          onNone: () => Effect.void,
          onSome: (d) => Deferred.interrupt(d)
        })

        // Create new timer
        const signal = yield* Deferred.make<void, never>()
        yield* Ref.set(debounceRef, Option.some(signal))

        // Fork: wait for delay or interruption
        yield* Effect.fork(
          Effect.race(
            Effect.sleep(Duration.millis(delayMs)).pipe(
              Effect.flatMap(() => onTrigger)
            ),
            Deferred.await(signal)
          )
        )
      })
    }
  })
```

### "Wait for Quiet" Pattern

```typescript
class Debouncer<A> {
  private timerRef: Ref.Ref<Option.Option<Fiber.RuntimeFiber<A, never>>>

  trigger = (action: Effect.Effect<A>) =>
    Effect.gen(function*(this: Debouncer<A>) {
      // Cancel any existing timer
      const existingTimer = yield* Ref.get(this.timerRef)
      yield* Option.match(existingTimer, {
        onNone: () => Effect.void,
        onSome: (fiber) => Fiber.interruptFork(fiber)
      })

      // Start new timer
      const fiber = yield* Effect.sleep(this.delayMs).pipe(
        Effect.flatMap(() => action),
        Effect.fork
      )
      yield* Ref.set(this.timerRef, Option.some(fiber))
    }.bind(this))
}
```

---

## Summary: Recommended Patterns

| Need | Pattern |
|------|---------|
| Retry with backoff | `Effect.retry(Schedule.exponential(...).pipe(Schedule.compose(Schedule.recurs(n))))` |
| Fallback provider | `primary.pipe(Effect.retry(schedule), Effect.orElse(() => fallback))` |
| Parallel requests | `Effect.all([...], { concurrency: n })` |
| Race providers | `Effect.race(provider1, provider2)` |
| Atomic state | `Ref.make` + `Ref.update` |
| Effectful state updates | `SynchronizedRef.modifyEffect` |
| Cancel running work | `Fiber.interrupt` or `Deferred` signal |
| Interruptible stream | `Stream.interruptWhenDeferred(signal)` |
| Event broadcast | `PubSub.unbounded` |
| Request context | `FiberRef` |
| Middleware | Higher-order functions |
| Service-first | `Context.Tag` + static `layer`/`testLayer` |
| Debouncing | `Ref` + `Fiber.interruptFork` + `Effect.sleep` |
