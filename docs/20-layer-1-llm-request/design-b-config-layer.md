# Design B: Config via Layer

Configuration is injected at layer construction time. The service interface is simpler but less flexible.

## Service Interface

```typescript
// Separate config tag
class LLMRequestConfig extends Context.Tag("@app/LLMRequestConfig")<
  LLMRequestConfig,
  {
    readonly primary: ProviderConfig
    readonly fallback: Option.Option<ProviderConfig>
    readonly schedule: Schedule.Schedule<unknown, LLMError>
    readonly timeout: Duration.Duration
  }
>() {}

// Simpler service interface
class LLMRequest extends Context.Tag("@app/LLMRequest")<
  LLMRequest,
  {
    readonly stream: (messages: readonly LLMMessage[]) => Stream.Stream<ContextEvent, LLMError>
  }
>() {}
```

## Implementation

```typescript
class LLMRequest extends Context.Tag("@app/LLMRequest")<
  LLMRequest,
  {
    readonly stream: (messages: readonly LLMMessage[]) => Stream.Stream<ContextEvent, LLMError>
  }
>() {
  static readonly layer = Layer.effect(
    LLMRequest,
    Effect.gen(function*() {
      const languageModel = yield* LanguageModel
      const config = yield* LLMRequestConfig  // Config from layer

      const stream = Effect.fn("LLMRequest.stream")(
        function*(messages: readonly LLMMessage[]) {
          const primaryStream = streamFromProvider(
            languageModel,
            config.primary,
            messages
          ).pipe(
            Stream.retry(config.schedule),
            Stream.timeout(config.timeout)
          )

          return Option.match(config.fallback, {
            onNone: () => primaryStream,
            onSome: (fallback) =>
              primaryStream.pipe(
                Stream.orElse(() =>
                  streamFromProvider(languageModel, fallback, messages).pipe(
                    Stream.timeout(config.timeout)
                  )
                )
              )
          })
        }
      )

      return LLMRequest.of({ stream })
    })
  )
}

// Config layer
class LLMRequestConfig extends Context.Tag("@app/LLMRequestConfig")<
  LLMRequestConfig,
  {
    readonly primary: ProviderConfig
    readonly fallback: Option.Option<ProviderConfig>
    readonly schedule: Schedule.Schedule<unknown, LLMError>
    readonly timeout: Duration.Duration
  }
>() {
  static readonly layer = Layer.effect(
    LLMRequestConfig,
    Effect.gen(function*() {
      // Load from environment
      const apiKey = yield* Config.redacted("OPENAI_API_KEY")
      const model = yield* Config.string("OPENAI_MODEL").pipe(
        Config.withDefault("gpt-4o-mini")
      )
      const maxRetries = yield* Config.number("MAX_RETRIES").pipe(
        Config.withDefault(3)
      )

      return {
        primary: ProviderConfig.make({
          providerId: ProviderId.make("openai"),
          model,
          apiKey,
        }),
        fallback: Option.none(),
        schedule: Schedule.exponential("100 millis").pipe(
          Schedule.compose(Schedule.recurs(maxRetries - 1)),
          Schedule.jittered
        ),
        timeout: Duration.seconds(30),
      }
    })
  )

  static readonly testLayer = Layer.succeed(LLMRequestConfig, {
    primary: ProviderConfig.make({
      providerId: ProviderId.make("test"),
      model: "test-model",
      apiKey: Redacted.make("test-key"),
    }),
    fallback: Option.none(),
    schedule: Schedule.once,
    timeout: Duration.seconds(5),
  })
}
```

## Usage

```typescript
const program = Effect.gen(function*() {
  const llmRequest = yield* LLMRequest

  // Just pass messages - config comes from layer
  const messages = [
    LLMMessage.make({ role: "user", content: "Hello!" })
  ]

  yield* llmRequest.stream(messages).pipe(
    Stream.runForEach((event) => handleEvent(event))
  )
})

// Provide layers at app startup
const appLayer = LLMRequest.layer.pipe(
  Layer.provide(LLMRequestConfig.layer),
  Layer.provide(LanguageModel.layer)
)

Effect.runPromise(program.pipe(Effect.provide(appLayer)))
```

## Overriding Config

To use different config, provide a different layer:

```typescript
// Custom config for specific use case
const customConfigLayer = Layer.succeed(LLMRequestConfig, {
  primary: ProviderConfig.make({
    providerId: ProviderId.make("anthropic"),
    model: "claude-3-opus",
    apiKey: Redacted.make(process.env.ANTHROPIC_API_KEY!),
  }),
  fallback: Option.none(),
  schedule: Schedule.exponential("200 millis").pipe(
    Schedule.compose(Schedule.recurs(5))
  ),
  timeout: Duration.seconds(60),
})

const withCustomConfig = program.pipe(
  Effect.provide(LLMRequest.layer.pipe(Layer.provide(customConfigLayer)))
)
```

## Trade-offs

### Pros

| Benefit | Explanation |
|---------|-------------|
| **Simple call sites** | Just pass messages |
| **Centralized config** | All config in one place |
| **Easy swapping** | Swap entire config via layer |
| **Environment-driven** | Config naturally loads from env |

### Cons

| Drawback | Explanation |
|----------|-------------|
| **Inflexible** | Same config for all requests in a layer scope |
| **Mismatch with reducer** | Reducer outputs config, but layer ignores it |
| **Testing complexity** | Need different layers for different configs |
| **Hidden config** | Caller doesn't see what config is used |

## Effect Pattern Alignment

This design aligns with:

- **Layer-based DI**: Standard Effect pattern for injecting dependencies
- **@effect/platform patterns**: HttpClient.layer injects base config
- **Separation of concerns**: Config loading separate from usage

## When to Use

- Config is static for application lifetime
- Environment-driven configuration
- All requests use same settings
- Simpler call sites are priority

## Cross-Reference

- Effect Source: `Layer.effect` pattern in `@effect/platform`
- EffectPatterns: Config service pattern in "config-provider.mdx"

## Why NOT for This Use Case

**This design doesn't fit our requirements** because:

1. Config comes from event reduction, not just environment
2. Different contexts may have different retry/provider settings
3. User can add `SetRetryConfigEvent` to change behavior

The reducer produces `ReducedContext` with config, but this design ignores that config. This creates a disconnect between what events specify and what actually happens.
