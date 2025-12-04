# Design C: Reducer as Service

The reducer is a full service with `Context.Tag`, allowing maximum flexibility and testability.

## Interface

```typescript
class EventReducer extends Context.Tag("@app/EventReducer")<
  EventReducer,
  {
    // Reducer takes current state + new events, returns updated state
    readonly reduce: (
      current: ReducedContext,
      newEvents: readonly PersistedEvent[]
    ) => Effect.Effect<ReducedContext, ReducerError>

    // Initial state for fresh contexts
    readonly initialReducedContext: ReducedContext
  }
>() {}
```

## Implementation

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
>() {
  static readonly layer = Layer.effect(
    EventReducer,
    Effect.gen(function*() {
      // Inject dependencies
      const tokenCounter = yield* TokenCounter
      const config = yield* AppConfig

      const initialReducedContext = ReducedContext.make({
        messages: [],
        config: LLMRequestConfig.make({
          primary: getDefaultProvider(),
          retry: config.defaultRetry,
          timeoutMs: config.defaultTimeoutMs,
        }),
      })

      const reduce = Effect.fn("EventReducer.reduce")(
        function*(current: ReducedContext, newEvents: readonly PersistedEvent[]) {
          // Apply new events to current state
          const currentState = reducedContextToState(current)
          const newState = newEvents.reduce(reduceEvent, currentState)
          const reduced = stateToReducedContext(newState)

          // Validation
          if (reduced.messages.length === 0) {
            return yield* Effect.fail(ReducerError.make({
              message: "No messages after reduction",
            }))
          }

          // Token counting with limit check
          const tokenCount = yield* tokenCounter.count(reduced.messages)

          if (tokenCount > config.maxTokens) {
            yield* Effect.logWarning(`Token count ${tokenCount} exceeds limit ${config.maxTokens}`)
          }

          yield* Effect.logDebug(`Applied ${newEvents.length} events, now ${reduced.messages.length} messages`)

          return reduced
        }
      )

      return EventReducer.of({ reduce, initialReducedContext })
    })
  )

  static readonly testLayer = Layer.sync(EventReducer, () => {
    const initialReducedContext = ReducedContext.make({
      messages: [],
      config: LLMRequestConfig.make({
        primary: ProviderConfig.make({
          providerId: ProviderId.make("test"),
          model: "test-model",
          apiKey: Redacted.make("test-key"),
        }),
        retry: RetryConfig.default,
        timeoutMs: 30000,
      }),
    })

    return EventReducer.of({
      initialReducedContext,
      reduce: (current, newEvents) => {
        // Simple test implementation - apply events to current
        const newMessages = newEvents
          .filter((e): e is UserMessageEvent | AssistantMessageEvent =>
            e._tag === "UserMessageEvent" || e._tag === "AssistantMessageEvent"
          )
          .map(e => LLMMessage.make({
            role: e._tag === "UserMessageEvent" ? "user" : "assistant",
            content: e.content,
          }))

        return Effect.succeed(ReducedContext.make({
          messages: [...current.messages, ...newMessages],
          config: current.config,
        }))
      }
    })
  })
}

// The core reduction logic (same as other designs)
const reduceEvent = (state: ReducerState, event: PersistedEvent): ReducerState => {
  switch (event._tag) {
    case "SystemPromptEvent":
      return { ...state, systemPrompt: event.content }
    case "UserMessageEvent":
      return {
        ...state,
        messages: [...state.messages, LLMMessage.make({ role: "user", content: event.content })],
        pendingAttachments: [],
      }
    // ... rest of cases
  }
}
```

## Multiple Reducer Implementations

Could support different reduction strategies:

```typescript
class EventReducer extends Context.Tag("@app/EventReducer")<
  EventReducer,
  {
    readonly reduce: (current: ReducedContext, newEvents: readonly PersistedEvent[]) => Effect.Effect<ReducedContext, ReducerError>
    readonly initialReducedContext: ReducedContext
  }
>() {
  // Standard reducer
  static readonly layer = /* ... as above ... */

  // Reducer that truncates old messages
  static readonly truncatingLayer = Layer.effect(
    EventReducer,
    Effect.gen(function*() {
      const config = yield* AppConfig

      const reduce = Effect.fn("EventReducer.reduce.truncating")(
        function*(current: ReducedContext, newEvents: readonly PersistedEvent[]) {
          const currentState = reducedContextToState(current)
          const newState = newEvents.reduce(reduceEvent, currentState)
          const full = stateToReducedContext(newState)

          // Keep only last N messages
          return ReducedContext.make({
            ...full,
            messages: full.messages.slice(-config.maxMessages),
          })
        }
      )

      return EventReducer.of({ reduce, initialReducedContext })
    })
  )

  // Reducer that summarizes old context
  static readonly summarizingLayer = Layer.effect(
    EventReducer,
    Effect.gen(function*() {
      const llm = yield* LLMRequest  // Use LLM to summarize!

      const reduce = Effect.fn("EventReducer.reduce.summarizing")(
        function*(current: ReducedContext, newEvents: readonly PersistedEvent[]) {
          const currentState = reducedContextToState(current)
          const newState = newEvents.reduce(reduceEvent, currentState)
          const full = stateToReducedContext(newState)

          if (full.messages.length <= 10) {
            return full
          }

          // Summarize older messages
          const oldMessages = full.messages.slice(0, -10)
          const recentMessages = full.messages.slice(-10)

          const summary = yield* summarizeMessages(llm, oldMessages)

          return ReducedContext.make({
            ...full,
            messages: [
              LLMMessage.make({ role: "system", content: `Previous context summary: ${summary}` }),
              ...recentMessages,
            ],
          })
        }
      )

      return EventReducer.of({ reduce, initialReducedContext })
    })
  )
}
```

## Usage

```typescript
// In Layer 3 (Session) - first load
const program = Effect.gen(function*() {
  const reducer = yield* EventReducer
  const events = yield* repository.load(contextName)
  const reduced = yield* reducer.reduce(reducer.initialReducedContext, events)
  const stream = yield* llmRequest.stream(reduced)
  // ...
})

// On new event - incremental update
const newEvent = UserMessageEvent.make({ content: "Hello" })
const updatedReduced = yield* reducer.reduce(currentReduced, [newEvent])

// Choose reducer at app composition
const appLayer = SessionLayer.pipe(
  Layer.provide(EventReducer.layer),  // or truncatingLayer, summarizingLayer
  Layer.provide(TokenCounter.layer),
  Layer.provide(AppConfig.layer),
)
```

## Testing

```typescript
import { describe, expect, it } from "@effect/vitest"

describe("EventReducer", () => {
  // Test with real layer
  it.effect("reduces events with dependencies", () =>
    Effect.gen(function*() {
      const reducer = yield* EventReducer

      const events = [
        UserMessageEvent.make({ content: "Hello" }),
        AssistantMessageEvent.make({ content: "Hi!" }),
      ]

      const result = yield* reducer.reduce(reducer.initialReducedContext, events)

      expect(result.messages).toHaveLength(2)
    }).pipe(
      Effect.provide(EventReducer.layer),
      Effect.provide(TokenCounter.layer),
      Effect.provide(AppConfig.testLayer),
    )
  )

  // Test incremental reduction
  it.effect("incrementally applies new events", () =>
    Effect.gen(function*() {
      const reducer = yield* EventReducer

      const initial = yield* reducer.reduce(reducer.initialReducedContext, [
        UserMessageEvent.make({ content: "Hello" }),
      ])

      const updated = yield* reducer.reduce(initial, [
        AssistantMessageEvent.make({ content: "Hi!" }),
      ])

      expect(updated.messages).toHaveLength(2)
    }).pipe(Effect.provide(EventReducer.testLayer))
  )
})
```

## Trade-offs

### Pros

| Benefit | Explanation |
|---------|-------------|
| **Maximum flexibility** | Swap implementations via layers |
| **Full DI** | All dependencies injected |
| **Testable** | Mock via testLayer |
| **Multiple strategies** | Different reducers for different needs |
| **Consistent pattern** | Same as other services |

### Cons

| Drawback | Explanation |
|----------|-------------|
| **Most complex** | Full service boilerplate |
| **Overkill for simple cases** | If reduction never changes |
| **More indirection** | Must yield* service |

## Effect Pattern Alignment

This design aligns with:

- **Service-first design**: Context.Tag with static layers
- **Effect.fn for tracing**: Automatic span creation
- **Swappable implementations**: Multiple layer variants
- **Test layers**: Dedicated test implementation

## When to Use

- Multiple reducer strategies needed
- Reducer needs heavy dependencies
- Want to swap reducer at composition time
- Maximum testability required

## Recommendation

**Use this design if**:
- You anticipate needing different reduction strategies (truncating, summarizing)
- The reducer needs non-trivial dependencies
- Consistency with other services is important

**Use Design A or B if**:
- Single reduction strategy is sufficient
- Dependencies are minimal or optional
- Simpler is better
