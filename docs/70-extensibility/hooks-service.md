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

## Hook Composition

Multiple hooks can be composed:

```typescript
const composeBeforeHooks = (
  hooks: readonly BeforeRequestHook[]
): BeforeRequestHook =>
  (input) =>
    hooks.reduce(
      (acc, hook) => Effect.flatMap(acc, hook),
      Effect.succeed(input) as Effect.Effect<ReducedContext, HookError>
    )

// Usage
const composedHook = composeBeforeHooks([
  loggingHook,
  validationHook,
  transformationHook,
])
```

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
