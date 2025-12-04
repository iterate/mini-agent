# Hooks Service

A service for extending behavior at key points in the request lifecycle.

## Purpose

Allow external code to:
- Transform requests before they go to the LLM
- Transform responses after they come back
- Observe events as they flow through the system
- Add custom validation or logging

## Service Interface

```typescript
type BeforeRequestHook = (input: ReducedContext) => Effect.Effect<ReducedContext, HookError>
type AfterResponseHook = (event: ContextEvent) => Effect.Effect<ContextEvent, HookError>
type OnEventHook = (event: ContextEvent) => Effect.Effect<void, HookError>

class HooksService extends Context.Tag("@app/HooksService")<
  HooksService,
  {
    // Transform input before LLM request
    readonly beforeRequest: (input: ReducedContext) => Effect.Effect<ReducedContext, HookError>

    // Transform each event after LLM response
    readonly afterResponse: (event: ContextEvent) => Effect.Effect<ContextEvent, HookError>

    // Observe events (for logging, metrics, etc.)
    readonly onEvent: (event: ContextEvent) => Effect.Effect<void, HookError>
  }
>() {}
```

## Default Implementation (No-op)

```typescript
class HooksService extends Context.Tag("@app/HooksService")<
  HooksService,
  { /* ... */ }
>() {
  // Default: pass through unchanged
  static readonly layer = Layer.sync(HooksService, () =>
    HooksService.of({
      beforeRequest: (input) => Effect.succeed(input),
      afterResponse: (event) => Effect.succeed(event),
      onEvent: () => Effect.void,
    })
  )
}
```

## Custom Hooks Implementation

```typescript
// Example: Add logging and validation hooks
const customHooksLayer = Layer.effect(
  HooksService,
  Effect.gen(function*() {
    const logger = yield* Logger
    const validator = yield* ContentValidator

    return HooksService.of({
      beforeRequest: Effect.fn("HooksService.beforeRequest")(
        function*(input: ReducedContext) {
          yield* logger.log(`Request with ${input.messages.length} messages`)

          // Validate content
          for (const message of input.messages) {
            if (message.role === "user") {
              const isValid = yield* validator.validate(message.content)
              if (!isValid) {
                return yield* Effect.fail(HookError.make({
                  hook: "beforeRequest",
                  message: "Content validation failed",
                }))
              }
            }
          }

          return input
        }
      ),

      afterResponse: Effect.fn("HooksService.afterResponse")(
        function*(event: ContextEvent) {
          if (event._tag === "AssistantMessageEvent") {
            yield* logger.log(`Response: ${event.content.slice(0, 100)}...`)
          }
          return event
        }
      ),

      onEvent: Effect.fn("HooksService.onEvent")(
        function*(event: ContextEvent) {
          yield* logger.log(`Event: ${event._tag}`)
        }
      ),
    })
  })
)
```

## Using Hooks in Session Layer

```typescript
class ContextSession extends Context.Tag("@app/ContextSession")<
  ContextSession,
  { /* ... */ }
>() {
  static readonly layer = Layer.scoped(
    ContextSession,
    Effect.gen(function*() {
      const hooks = yield* HooksService
      const llmRequest = yield* LLMRequest
      const reducer = yield* EventReducer

      const addEvent = Effect.fn("ContextSession.addEvent")(
        function*(event: InputEvent) {
          // Notify hook of input event
          yield* hooks.onEvent(event)

          // Reduce - apply new event to current state
          const reduced = yield* reducer.reduce(currentReduced, [event])

          // Before request hook
          const processedInput = yield* hooks.beforeRequest(reduced)

          // Make LLM request
          return llmRequest.stream(processedInput).pipe(
            // After response hook for each event
            Stream.mapEffect((e) => hooks.afterResponse(e)),
            // Notify hook of each event
            Stream.tap((e) => hooks.onEvent(e)),
          )
        }
      )

      // ...
    })
  )
}
```

## Event Expansion (1 → N)

The basic `afterResponse` signature is 1:1. To expand one event into multiple:

### Option A: Return Array

```typescript
type AfterResponseHook = (event: ContextEvent) => Effect.Effect<readonly ContextEvent[], HookError>

// Usage in stream
llmRequest.stream(ctx).pipe(
  Stream.mapEffect(hooks.afterResponse),
  Stream.flatMap(Stream.fromIterable),  // Flatten arrays
)
```

### Option B: Return Stream

```typescript
type AfterResponseHook = (event: ContextEvent) => Stream.Stream<ContextEvent, HookError>

// Usage
llmRequest.stream(ctx).pipe(
  Stream.flatMap(hooks.afterResponse),
)
```

### Option C: Filtering (return empty to drop)

```typescript
type AfterResponseHook = (event: ContextEvent) => Effect.Effect<Option.Option<ContextEvent>, HookError>

// Filter hook that drops TextDelta events
const filterHook: AfterResponseHook = (event) =>
  Effect.succeed(
    event._tag === "TextDeltaEvent" ? Option.none() : Option.some(event)
  )
```

**Recommendation**: Option A (return array) is simplest. Most hooks return `[event]` unchanged; expansion hooks return `[event, additionalEvent]`.

---

## Hook Ordering and Composition

Multiple hooks run in defined order via composition:

### Sequential Composition (flatMap chain)

```typescript
const composeBeforeHooks = (
  hooks: readonly BeforeRequestHook[]
): BeforeRequestHook =>
  (input) =>
    hooks.reduce(
      (acc, hook) => Effect.flatMap(acc, hook),
      Effect.succeed(input) as Effect.Effect<ReducedContext, HookError>
    )

// Hooks run in array order: logging → validation → transformation
const composedHook = composeBeforeHooks([
  loggingHook,       // runs first
  validationHook,    // runs second (receives output of first)
  transformationHook, // runs third (receives output of second)
])
```

### Priority-Based Ordering

If hooks need explicit priority:

```typescript
interface PrioritizedHook<T> {
  priority: number  // Lower = runs first
  hook: T
}

const composeWithPriority = <T extends (...args: any[]) => Effect.Effect<any, any>>(
  hooks: readonly PrioritizedHook<T>[]
): T => {
  const sorted = [...hooks].sort((a, b) => a.priority - b.priority)
  return composeHooks(sorted.map(h => h.hook))
}

// Usage
const hooks: PrioritizedHook<BeforeRequestHook>[] = [
  { priority: 100, hook: transformationHook },  // runs last
  { priority: 1, hook: loggingHook },           // runs first
  { priority: 50, hook: validationHook },       // runs middle
]
```

### Effect Pattern: FiberRef for Dynamic Hook Registration

For runtime hook registration (like @effect/platform's preResponseHandlers):

```typescript
const HookRegistry = FiberRef.unsafeMake<readonly BeforeRequestHook[]>([])

// Register a hook for this fiber tree
const withHook = <A, E, R>(hook: BeforeRequestHook) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.locallyWith(HookRegistry, (hooks) => [...hooks, hook])(effect)

// In HooksService implementation
const beforeRequest = (input: ReducedContext) =>
  Effect.gen(function*() {
    const registeredHooks = yield* FiberRef.get(HookRegistry)
    const composed = composeBeforeHooks(registeredHooks)
    return yield* composed(input)
  })
```

This allows scoped hook registration without global mutation.

## Hook Error Handling

Hooks can fail, which should abort the request:

```typescript
export class HookError extends Schema.TaggedError<HookError>()(
  "HookError",
  {
    hook: Schema.Literal("beforeRequest", "afterResponse", "onEvent"),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  }
) {}

// In session layer
const addEvent = Effect.fn("ContextSession.addEvent")(
  function*(event: InputEvent) {
    // Hook failure aborts request
    const processedInput = yield* hooks.beforeRequest(reduced).pipe(
      Effect.catchTag("HookError", (e) =>
        Effect.gen(function*() {
          yield* Effect.logError(`Hook ${e.hook} failed: ${e.message}`)
          return yield* Effect.fail(e)
        })
      )
    )

    // ...
  }
)
```

## Use Cases

### Content Moderation

```typescript
const moderationHook: BeforeRequestHook = (input) =>
  Effect.gen(function*() {
    for (const message of input.messages) {
      if (message.role === "user") {
        const result = yield* moderationService.check(message.content)
        if (result.flagged) {
          return yield* Effect.fail(HookError.make({
            hook: "beforeRequest",
            message: `Content flagged: ${result.categories.join(", ")}`,
          }))
        }
      }
    }
    return input
  })
```

### Token Counting

```typescript
const tokenCountingHook: BeforeRequestHook = (input) =>
  Effect.gen(function*() {
    const count = yield* tokenCounter.count(input.messages)
    yield* Effect.log(`Token count: ${count}`)

    if (count > 100000) {
      return yield* Effect.fail(HookError.make({
        hook: "beforeRequest",
        message: `Token limit exceeded: ${count}`,
      }))
    }

    return input
  })
```

### Response Transformation

```typescript
const censoringHook: AfterResponseHook = (event) =>
  Effect.gen(function*() {
    if (event._tag === "AssistantMessageEvent") {
      const censored = yield* censorService.censor(event.content)
      return AssistantMessageEvent.make({ content: censored })
    }
    return event
  })
```

### Metrics Collection

```typescript
const metricsHook: OnEventHook = (event) =>
  Effect.gen(function*() {
    const metrics = yield* MetricsService

    switch (event._tag) {
      case "LLMRequestStartedEvent":
        yield* metrics.increment("llm.requests.started")
        break
      case "LLMRequestCompletedEvent":
        yield* metrics.timing("llm.requests.duration", event.durationMs)
        break
      case "LLMRequestInterruptedEvent":
        yield* metrics.increment("llm.requests.interrupted")
        break
      case "LLMRequestFailedEvent":
        yield* metrics.increment("llm.requests.failed")
        break
    }
  })
```

## Effect Pattern Alignment

This pattern aligns with:

- **@effect/platform HttpMiddleware**: Higher-order functions for request/response
- **FiberRef preResponseHandlers**: Chain of handlers in @effect/platform
- **Service composition**: Hooks are just another service to inject
