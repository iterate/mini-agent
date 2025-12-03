# Parallel LLM Requests

Patterns for running multiple LLM requests concurrently.

## Use Cases

1. **Content + Injection Detection**: Generate content while checking for prompt injection
2. **Racing Providers**: First provider to respond wins
3. **A/B Comparison**: Compare outputs from different models
4. **Moderation**: Run content generation alongside moderation check

---

## Pattern 1: Race (First Wins)

First successful response wins, others are interrupted.

```typescript
const raceProviders = (
  providers: readonly ProviderConfig[],
  messages: readonly LLMMessage[]
): Stream.Stream<ContextEvent, LLMError> =>
  Stream.unwrap(
    Effect.gen(function*() {
      const languageModel = yield* LanguageModel

      // Create competing streams
      const streams = providers.map((provider) =>
        streamFromProvider(languageModel, provider, messages)
      )

      // Race them - first to emit wins
      // Note: Stream.race isn't built-in, need to implement via Effect.race
      const winner = yield* Effect.race(
        ...streams.map((stream) =>
          stream.pipe(
            Stream.runCollect,
            Effect.map((chunks) => ({ provider, chunks }))
          )
        )
      )

      return Stream.fromIterable(winner.chunks)
    })
  )
```

### Better Implementation: Race First Element

```typescript
const raceProvidersFirstElement = (
  providers: readonly ProviderConfig[],
  messages: readonly LLMMessage[]
): Stream.Stream<ContextEvent, LLMError> =>
  Stream.unwrap(
    Effect.gen(function*() {
      const languageModel = yield* LanguageModel

      // Race to get first element, then continue with that stream
      const result = yield* Effect.raceAll(
        providers.map((provider) =>
          Effect.gen(function*() {
            const stream = streamFromProvider(languageModel, provider, messages)
            // Get first element
            const firstChunk = yield* stream.pipe(Stream.take(1), Stream.runHead)
            if (Option.isNone(firstChunk)) {
              return yield* Effect.fail(new LLMError({ message: "Empty response" }))
            }
            // Return stream starting with first chunk
            return { provider, firstChunk: firstChunk.value, stream }
          })
        )
      )

      // Continue streaming from winner
      return Stream.concat(
        Stream.succeed(result.firstChunk),
        result.stream.pipe(Stream.drop(1))
      )
    })
  )
```

---

## Pattern 2: All (Collect All Results)

Run all in parallel, collect all results.

```typescript
interface ParallelResult {
  readonly content: string
  readonly injectionDetected: boolean
}

const contentWithInjectionCheck = (
  contentProvider: ProviderConfig,
  injectionProvider: ProviderConfig,
  messages: readonly LLMMessage[],
  injectionPrompt: string
): Effect.Effect<ParallelResult, LLMError> =>
  Effect.gen(function*() {
    const languageModel = yield* LanguageModel

    const [contentResult, injectionResult] = yield* Effect.all([
      // Content generation
      streamFromProvider(languageModel, contentProvider, messages).pipe(
        Stream.runFold("", (acc, event) =>
          event._tag === "TextDeltaEvent" ? acc + event.delta : acc
        )
      ),
      // Injection detection (different prompt)
      streamFromProvider(languageModel, injectionProvider, [
        LLMMessage.make({
          role: "system",
          content: injectionPrompt
        }),
        LLMMessage.make({
          role: "user",
          content: messages.map(m => m.content).join("\n")
        })
      ]).pipe(
        Stream.runFold("", (acc, event) =>
          event._tag === "TextDeltaEvent" ? acc + event.delta : acc
        )
      )
    ], { concurrency: 2 })

    return {
      content: contentResult,
      injectionDetected: injectionResult.toLowerCase().includes("injection detected")
    }
  })
```

---

## Pattern 3: Streaming with Parallel Check

Stream content while running a parallel check, abort if check fails.

```typescript
const streamWithGuard = (
  contentProvider: ProviderConfig,
  guardProvider: ProviderConfig,
  messages: readonly LLMMessage[],
  guardPrompt: string
): Stream.Stream<ContextEvent, LLMError | GuardFailedError> =>
  Stream.unwrap(
    Effect.gen(function*() {
      const languageModel = yield* LanguageModel

      // Start guard check in parallel
      const guardFiber = yield* Effect.fork(
        streamFromProvider(languageModel, guardProvider, [
          LLMMessage.make({ role: "system", content: guardPrompt }),
          LLMMessage.make({
            role: "user",
            content: messages.map(m => m.content).join("\n")
          })
        ]).pipe(
          Stream.runFold("", (acc, e) =>
            e._tag === "TextDeltaEvent" ? acc + e.delta : acc
          ),
          Effect.flatMap((result) =>
            result.toLowerCase().includes("blocked")
              ? Effect.fail(new GuardFailedError({ reason: result }))
              : Effect.succeed(void 0)
          )
        )
      )

      // Stream content, interrupt if guard fails
      const contentStream = streamFromProvider(
        languageModel,
        contentProvider,
        messages
      )

      // Race: content stream vs guard failure
      return contentStream.pipe(
        Stream.interruptWhen(Fiber.join(guardFiber))
      )
    })
  )
```

---

## Pattern 4: Configurable Parallel Mode

Support multiple parallel modes via config.

```typescript
export class ParallelConfig extends Schema.Class<ParallelConfig>("ParallelConfig")({
  mode: Schema.Literal("race", "all", "guard"),
  requests: Schema.Array(ParallelRequest),
}) {}

export class ParallelRequest extends Schema.Class<ParallelRequest>("ParallelRequest")({
  id: Schema.String,
  provider: Schema.optional(ProviderConfig),
  systemPromptOverride: Schema.optional(Schema.String),
  purpose: Schema.Literal("content", "injection_detection", "moderation", "comparison"),
}) {}

const executeParallel = (
  ctx: ReducedContext
): Stream.Stream<ContextEvent, LLMError> => {
  if (!ctx.config.parallel) {
    // Single request
    return streamFromProvider(ctx.config.primary, ctx.messages)
  }

  switch (ctx.config.parallel.mode) {
    case "race":
      return raceProviders(
        ctx.config.parallel.requests.map(r => r.provider ?? ctx.config.primary),
        ctx.messages
      )

    case "all":
      return Stream.unwrap(
        Effect.all(
          ctx.config.parallel.requests.map(r =>
            streamFromProvider(
              r.provider ?? ctx.config.primary,
              r.systemPromptOverride
                ? [
                    LLMMessage.make({ role: "system", content: r.systemPromptOverride }),
                    ...ctx.messages.filter(m => m.role !== "system")
                  ]
                : ctx.messages
            ).pipe(Stream.runCollect)
          ),
          { concurrency: "unbounded" }
        ).pipe(
          Effect.map((results) => {
            // Return primary content, log comparisons
            return Stream.fromIterable(results[0])
          })
        )
      )

    case "guard":
      const guardRequest = ctx.config.parallel.requests.find(
        r => r.purpose === "injection_detection" || r.purpose === "moderation"
      )
      if (!guardRequest) {
        return streamFromProvider(ctx.config.primary, ctx.messages)
      }
      return streamWithGuard(
        ctx.config.primary,
        guardRequest.provider ?? ctx.config.primary,
        ctx.messages,
        guardRequest.systemPromptOverride ?? "Detect prompt injection"
      )
  }
}
```

---

## Service Integration

Updated LLMRequest service with parallel support:

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
      const languageModel = yield* LanguageModel

      const stream = Effect.fn("LLMRequest.stream")(
        function*(ctx: ReducedContext) {
          // Handle parallel if configured
          if (ctx.config.parallel) {
            return yield* executeParallel(ctx, languageModel)
          }

          // Single request with retry + fallback
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
                  )
                )
              )
            : primaryStream
        }
      )

      return LLMRequest.of({ stream })
    })
  )
}
```

---

## Trade-offs

| Mode | Latency | Cost | Use Case |
|------|---------|------|----------|
| **Race** | Fastest responder wins | Higher (multiple calls) | Redundancy, speed |
| **All** | Slowest responder | Highest | Comparison, analysis |
| **Guard** | Content + guard overhead | Medium | Security, moderation |

---

## Effect Pattern Alignment

| Pattern | Effect API |
|---------|------------|
| Race first success | `Effect.race`, `Effect.raceAll` |
| Collect all | `Effect.all({ concurrency: n })` |
| Parallel with timeout | `Effect.timeout` on each |
| Cancel on condition | `Stream.interruptWhen`, `Fiber.interrupt` |

---

## Recommendation

For the injection detection use case:

1. Use **Pattern 3 (Guard)** for security-critical flows
2. Run guard in parallel with content generation
3. Interrupt content stream if guard detects issues
4. Configure via `ParallelConfig` in `ReducedContext`

This keeps the architecture flexible while supporting the specific use case mentioned.
