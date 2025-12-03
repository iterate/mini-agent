# Design A: Config as Parameter

All configuration is passed via `ReducedContext`. The service is completely stateless.

## Service Interface

```typescript
class LLMRequest extends Context.Tag("@app/LLMRequest")<
  LLMRequest,
  {
    readonly stream: (ctx: ReducedContext) => Stream.Stream<ContextEvent, LLMError>
  }
>() {}
```

## Implementation

```typescript
class LLMRequest extends Context.Tag("@app/LLMRequest")<
  LLMRequest,
  {
    readonly stream: (ctx: ReducedContext) => Stream.Stream<ContextEvent, LLMError>
  }
>() {
  static readonly layer = Layer.effect(
    LLMRequest,
    Effect.gen(function*() {
      // Only dependency: the underlying language model abstraction
      const languageModel = yield* LanguageModel

      const stream = Effect.fn("LLMRequest.stream")(
        function*(ctx: ReducedContext) {
          // Build retry schedule from config
          const schedule = buildSchedule(ctx.config.retry)

          // Build primary request stream
          const primaryStream = streamFromProvider(
            languageModel,
            ctx.config.primary,
            ctx.messages
          ).pipe(
            Stream.retry(schedule),
            Stream.timeout(Duration.millis(ctx.config.timeoutMs))
          )

          // Add fallback if configured
          const withFallback = ctx.config.fallback
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

          return withFallback
        }
      )

      return LLMRequest.of({ stream })
    })
  )

  static readonly testLayer = Layer.sync(LLMRequest, () =>
    LLMRequest.of({
      stream: (ctx) =>
        Stream.make(
          TextDeltaEvent.make({ delta: "Mock " }),
          TextDeltaEvent.make({ delta: "response" }),
        ).pipe(
          Stream.concat(
            Stream.succeed(
              AssistantMessageEvent.make({ content: "Mock response" })
            )
          )
        )
    })
  )
}

// Helper: build Schedule from RetryConfig
const buildSchedule = (config: RetryConfig): Schedule.Schedule<unknown, LLMError> => {
  let schedule = Schedule.exponential(Duration.millis(config.initialDelayMs))

  if (config.backoffFactor && config.backoffFactor !== 2) {
    // Custom backoff factor requires manual construction
    schedule = Schedule.exponential(
      Duration.millis(config.initialDelayMs),
      config.backoffFactor
    )
  }

  if (config.maxDelayMs) {
    schedule = schedule.pipe(
      Schedule.either(Schedule.spaced(Duration.millis(config.maxDelayMs)))
    )
  }

  if (config.jitter) {
    schedule = schedule.pipe(Schedule.jittered)
  }

  return schedule.pipe(Schedule.compose(Schedule.recurs(config.maxRetries - 1)))
}

// Helper: create stream from provider
const streamFromProvider = (
  languageModel: LanguageModel,
  provider: ProviderConfig,
  messages: readonly LLMMessage[]
): Stream.Stream<ContextEvent, LLMError> =>
  Stream.unwrap(
    Effect.gen(function*() {
      // Accumulate full response for final AssistantMessageEvent
      const accumulatorRef = yield* Ref.make("")

      // Get streaming response from language model
      const response = yield* languageModel.streamText({
        model: provider.model,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
        temperature: provider.temperature,
        maxTokens: provider.maxTokens,
      })

      // Transform to our event types
      return Stream.fromAsyncIterable(response.textStream, (e) =>
        new LLMError({ message: String(e) })
      ).pipe(
        Stream.tap((delta) => Ref.update(accumulatorRef, (acc) => acc + delta)),
        Stream.map((delta) => TextDeltaEvent.make({ delta })),
        Stream.concat(
          Stream.fromEffect(
            Ref.get(accumulatorRef).pipe(
              Effect.map((content) => AssistantMessageEvent.make({ content }))
            )
          )
        )
      )
    })
  )
```

## Usage

```typescript
const program = Effect.gen(function*() {
  const llmRequest = yield* LLMRequest

  // All config comes from ReducedContext
  const ctx = ReducedContext.make({
    messages: [
      LLMMessage.make({ role: "user", content: "Hello!" })
    ],
    config: LLMRequestConfig.make({
      primary: ProviderConfig.make({
        providerId: ProviderId.make("openai"),
        model: "gpt-4o-mini",
        apiKey: Redacted.make(process.env.OPENAI_API_KEY!),
      }),
      retry: RetryConfig.make({
        maxRetries: 3,
        initialDelayMs: 100,
        backoffFactor: 2,
      }),
      timeoutMs: 30000,
    }),
  })

  yield* llmRequest.stream(ctx).pipe(
    Stream.runForEach((event) => {
      if (event._tag === "TextDeltaEvent") {
        return Effect.sync(() => process.stdout.write(event.delta))
      }
      return Effect.void
    })
  )
})
```

## Trade-offs

### Pros

| Benefit | Explanation |
|---------|-------------|
| **Explicit** | Caller sees exactly what config is used |
| **Flexible** | Each request can have different config |
| **Testable** | Easy to test with different configs |
| **Stateless** | Service has no internal state |
| **Matches reducer output** | ReducedContext comes directly from reducer |

### Cons

| Drawback | Explanation |
|----------|-------------|
| **Verbose call sites** | Must construct full ReducedContext every time |
| **No defaults** | Can't rely on sensible defaults from layer |
| **Config duplication** | Same config repeated if making multiple calls |

## Effect Pattern Alignment

This design aligns with:

- **Service-first design**: Interface is clear, implementation is separate
- **EffectPatterns guidance**: Config as parameter is common for request-level config
- **Effect source patterns**: Similar to how `HttpClient.request` takes full request config

## When to Use

- Config comes from event reduction (your use case)
- Different requests legitimately need different config
- Testing requires varying config per test
- Maximum explicitness is desired

## Cross-Reference

- Effect Source: `@effect/platform` HttpClient takes request config as parameter
- EffectPatterns: "handle-flaky-operations-with-retry-timeout.mdx" shows retry config as parameter
