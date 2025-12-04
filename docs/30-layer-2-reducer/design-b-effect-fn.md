# Design B: Effect-Returning Function

The reducer returns an Effect, allowing dependencies and async operations.

## Interface

```typescript
// Reducer takes current state + new events, returns updated state
export const reduce: (
  current: ReducedContext,
  newEvents: readonly PersistedEvent[]
) => Effect.Effect<ReducedContext, ReducerError, TokenCounter>

// Initial state for fresh contexts
export const initialReducedContext: ReducedContext
```

## Implementation

```typescript
import { Effect, Context, Layer } from "effect"

// Optional dependency for token counting
class TokenCounter extends Context.Tag("@app/TokenCounter")<
  TokenCounter,
  {
    readonly count: (messages: readonly LLMMessage[]) => Effect.Effect<number>
  }
>() {
  static readonly layer = Layer.succeed(TokenCounter, {
    count: (messages) => Effect.succeed(
      // Simple estimation: ~4 chars per token
      messages.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0)
    )
  })
}

// Reducer error
export class ReducerError extends Schema.TaggedError<ReducerError>()(
  "ReducerError",
  {
    message: Schema.String,
    event: Schema.optional(PersistedEvent),
  }
) {}

// Initial state for fresh contexts
export const initialReducedContext: ReducedContext = ReducedContext.make({
  messages: [],
  config: LLMRequestConfig.make({
    primary: getDefaultProvider(),
    retry: defaultRetryConfig,
    timeoutMs: 30000,
  }),
})

export const reduce = (
  current: ReducedContext,
  newEvents: readonly PersistedEvent[]
): Effect.Effect<ReducedContext, ReducerError, TokenCounter> =>
  Effect.gen(function*() {
    const tokenCounter = yield* TokenCounter

    // Convert current state, apply new events
    const currentState = reducedContextToState(current)
    const newState = newEvents.reduce(reduceEvent, currentState)
    const reduced = stateToReducedContext(newState)

    // Validate
    if (reduced.messages.length === 0) {
      return yield* Effect.fail(ReducerError.make({
        message: "No messages after reduction",
      }))
    }

    // Optional: count tokens for logging/limits
    const tokenCount = yield* tokenCounter.count(reduced.messages)
    yield* Effect.logDebug(`Reduced to ${reduced.messages.length} messages, ~${tokenCount} tokens`)

    // Could add token limit check here
    if (tokenCount > 100000) {
      return yield* Effect.fail(ReducerError.make({
        message: `Token count ${tokenCount} exceeds limit`,
      }))
    }

    return reduced
  }).pipe(
    Effect.withSpan("reduce", {
      attributes: { newEventCount: newEvents.length }
    })
  )

// Same reduce logic as Design A
const reduceEvent = (state: ReducerState, event: PersistedEvent): ReducerState => {
  // ... same implementation
}
```

## Variant: Optional Dependencies

If token counting is optional:

```typescript
export const reduce = (
  current: ReducedContext,
  newEvents: readonly PersistedEvent[]
): Effect.Effect<ReducedContext, ReducerError> =>
  Effect.gen(function*() {
    // Try to get token counter, use fallback if not provided
    const tokenCounter = yield* Effect.serviceOption(TokenCounter)

    const currentState = reducedContextToState(current)
    const newState = newEvents.reduce(reduceEvent, currentState)
    const reduced = stateToReducedContext(newState)

    // Only count if service is available
    if (Option.isSome(tokenCounter)) {
      const count = yield* tokenCounter.value.count(reduced.messages)
      yield* Effect.logDebug(`~${count} tokens`)
    }

    return reduced
  })
```

## Usage

```typescript
// In Layer 3 (Session) - first load
const program = Effect.gen(function*() {
  const events = yield* repository.load(contextName)
  const reduced = yield* reduce(initialReducedContext, events)
  const stream = yield* llmRequest.stream(reduced)
  // ...
})

// On new event - incremental update
const newEvent = UserMessageEvent.make({ content: "Hello" })
const updatedReduced = yield* reduce(currentReduced, [newEvent])

// Provide token counter if needed
program.pipe(Effect.provide(TokenCounter.layer))
```

## Testing

```typescript
import { describe, expect, it } from "@effect/vitest"

describe("reduce", () => {
  const testTokenCounter = Layer.succeed(TokenCounter, {
    count: (messages) => Effect.succeed(messages.length * 10)
  })

  it.effect("builds messages from content events", () =>
    Effect.gen(function*() {
      const events = [
        SystemPromptEvent.make({ content: "You are helpful" }),
        UserMessageEvent.make({ content: "Hello" }),
      ]

      const result = yield* reduce(initialReducedContext, events)

      expect(result.messages).toHaveLength(2)
    }).pipe(Effect.provide(testTokenCounter))
  )

  it.effect("incrementally applies new events", () =>
    Effect.gen(function*() {
      const initial = yield* reduce(initialReducedContext, [
        UserMessageEvent.make({ content: "Hello" }),
      ])

      const updated = yield* reduce(initial, [
        AssistantMessageEvent.make({ content: "Hi!" }),
      ])

      expect(updated.messages).toHaveLength(2)
    }).pipe(Effect.provide(testTokenCounter))
  )

  it.effect("fails on empty messages", () =>
    Effect.gen(function*() {
      const result = yield* reduce(initialReducedContext, []).pipe(Effect.flip)
      expect(result._tag).toBe("ReducerError")
    }).pipe(Effect.provide(testTokenCounter))
  )
})
```

## Trade-offs

### Pros

| Benefit | Explanation |
|---------|-------------|
| **Supports I/O** | Can do async validation, token counting |
| **Injectable dependencies** | Token counter, validators, etc. |
| **Structured errors** | Uses Effect error channel |
| **Observability** | Can add spans, logs |
| **Composable** | Works with Effect's composition |

### Cons

| Drawback | Explanation |
|----------|-------------|
| **More complex** | Effect wrapping adds overhead |
| **Requires providing deps** | Must provide TokenCounter |
| **Slightly slower** | Effect overhead for simple cases |
| **Not a service** | Can't swap implementation via layers |

## Effect Pattern Alignment

This design aligns with:

- **Effect.gen for control flow**: Standard pattern for effectful logic
- **Tagged errors**: Using Schema.TaggedError for typed errors
- **Optional services**: Using Effect.serviceOption for optional deps
- **Observability**: withSpan for tracing

## When to Use

- Need to inject services (token counter, validators)
- Want validation with typed errors
- Need observability (spans, logs)
- Don't need to swap reducer implementation

## Comparison with Design A

```typescript
// Design A: Pure function
const reduced = reduce(current, newEvents)

// Design B: Effect function
const reduced = yield* reduce(current, newEvents)
```

The call site is nearly identical, but Design B allows dependencies and error handling.
