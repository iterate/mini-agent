# Design C: Hybrid (Default + Override)

Combines both approaches: defaults from layer, with per-request override capability.

## Service Interface

```typescript
class LLMRequest extends Context.Tag("@app/LLMRequest")<
  LLMRequest,
  {
    // Use defaults from layer
    readonly stream: (messages: readonly LLMMessage[]) => Stream.Stream<ContextEvent, LLMError>

    // Override with custom config
    readonly streamWithConfig: (ctx: ReducedContext) => Stream.Stream<ContextEvent, LLMError>
  }
>() {}
```

## Implementation

```typescript
class LLMRequest extends Context.Tag("@app/LLMRequest")<
  LLMRequest,
  {
    readonly stream: (messages: readonly LLMMessage[]) => Stream.Stream<ContextEvent, LLMError>
    readonly streamWithConfig: (ctx: ReducedContext) => Stream.Stream<ContextEvent, LLMError>
  }
>() {
  static readonly layer = Layer.effect(
    LLMRequest,
    Effect.gen(function*() {
      const languageModel = yield* LanguageModel
      const defaultConfig = yield* LLMRequestConfig  // Default from layer

      // Core implementation - takes full config
      const streamWithConfig = Effect.fn("LLMRequest.streamWithConfig")(
        function*(ctx: ReducedContext) {
          const schedule = buildSchedule(ctx.config.retry)

          const primaryStream = streamFromProvider(
            languageModel,
            ctx.config.primary,
            ctx.messages
          ).pipe(
            Stream.retry(schedule),
            Stream.timeout(Duration.millis(ctx.config.timeoutMs))
          )

          return ctx.config.fallback
            ? primaryStream.pipe(
                Stream.orElse(() =>
                  streamFromProvider(
                    languageModel,
                    ctx.config.fallback!,
                    ctx.messages
                  ).pipe(
                    Stream.timeout(Duration.millis(ctx.config.timeoutMs))
                  )
                )
              )
            : primaryStream
        }
      )

      // Convenience method - uses defaults
      const stream = Effect.fn("LLMRequest.stream")(
        function*(messages: readonly LLMMessage[]) {
          const ctx = ReducedContext.make({
            messages: [...messages],
            config: LLMRequestConfig.make({
              primary: defaultConfig.primary,
              fallback: Option.getOrUndefined(defaultConfig.fallback),
              retry: defaultConfig.retry,
              timeoutMs: Duration.toMillis(defaultConfig.timeout),
            }),
          })
          return yield* streamWithConfig(ctx)
        }
      )

      return LLMRequest.of({ stream, streamWithConfig })
    })
  )
}
```

## Usage

```typescript
const program = Effect.gen(function*() {
  const llmRequest = yield* LLMRequest

  // Option 1: Use defaults (simple)
  yield* llmRequest.stream([
    LLMMessage.make({ role: "user", content: "Hello!" })
  ]).pipe(Stream.runForEach(handleEvent))

  // Option 2: Override with custom config (from reducer)
  const reducedContext = yield* reducer.reduce(events)
  yield* llmRequest.streamWithConfig(reducedContext).pipe(
    Stream.runForEach(handleEvent)
  )
})
```

## Partial Override Pattern

Could also support partial overrides:

```typescript
class LLMRequest extends Context.Tag("@app/LLMRequest")<
  LLMRequest,
  {
    readonly stream: (messages: readonly LLMMessage[]) => Stream.Stream<ContextEvent, LLMError>
    readonly streamWithConfig: (ctx: ReducedContext) => Stream.Stream<ContextEvent, LLMError>
    readonly streamWithOverrides: (
      messages: readonly LLMMessage[],
      overrides: Partial<LLMRequestConfig>
    ) => Stream.Stream<ContextEvent, LLMError>
  }
>() {}
```

```typescript
// Usage with partial override
yield* llmRequest.streamWithOverrides(
  messages,
  { timeoutMs: 60000 }  // Just override timeout
)
```

## Trade-offs

### Pros

| Benefit | Explanation |
|---------|-------------|
| **Best of both worlds** | Simple for simple cases, flexible for complex |
| **Backwards compatible** | Can add override later |
| **Sensible defaults** | Most calls use defaults |
| **Full control available** | Can override everything when needed |

### Cons

| Drawback | Explanation |
|----------|-------------|
| **Larger API surface** | Two (or more) methods to maintain |
| **Potential confusion** | Which method to use? |
| **Config merging complexity** | Partial overrides need careful merging |
| **Testing both paths** | Need to test default and override paths |

## Effect Pattern Alignment

This design aligns with:

- **Dual API pattern**: Common in Effect (e.g., `Effect.retry` vs `Effect.retry(options)`)
- **Progressive disclosure**: Simple things simple, complex things possible
- **@effect/platform patterns**: Many functions have both simple and configurable variants

## When to Use

- Need both simple calls and full configurability
- Building a library with multiple consumers
- Migrating from simple to configurable API
- Default behavior covers 80% of use cases

## Recommendation for This Use Case

**This design is reasonable** but adds complexity. Given that:

1. The reducer always produces a full `ReducedContext`
2. Simple calls without config aren't common in our flow
3. Extra API surface has maintenance cost

**Design A (Config as Parameter)** is likely simpler and sufficient. The "simple" path of this hybrid design would rarely be used since we always go through the reducer.

However, if you anticipate uses where you want to bypass the reducer (e.g., quick one-off requests), this hybrid approach provides that escape hatch.

## Cross-Reference

- Effect Source: `Effect.retry` has both schedule parameter and options object variants
- EffectPatterns: Progressive API patterns
