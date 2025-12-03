# Middleware Pattern

Higher-order functions that wrap layers to add cross-cutting concerns.

## Concept

Middleware transforms one layer into another by wrapping its behavior:

```typescript
type Middleware<S> = (service: S) => S

// Example
const withLogging: Middleware<LLMRequest> = (llmRequest) => ({
  stream: (ctx) =>
    Effect.gen(function*() {
      yield* Effect.log("Starting LLM request")
      return llmRequest.stream(ctx).pipe(
        Stream.tap(() => Effect.log("Received event"))
      )
    })
})
```

## Layer Middleware

Transform an entire layer:

```typescript
const withTracing = <S, E, R>(
  layer: Layer.Layer<S, E, R>,
  serviceName: string
): Layer.Layer<S, E, R> =>
  Layer.effect(
    layer.pipe(
      Layer.map((service) => {
        // Wrap each method with tracing
        return Object.fromEntries(
          Object.entries(service).map(([key, value]) => {
            if (typeof value === "function") {
              return [key, (...args: unknown[]) =>
                Effect.withSpan(`${serviceName}.${key}`)(value(...args))
              ]
            }
            return [key, value]
          })
        ) as S
      })
    )
  )

// Usage
const tracedLLMRequest = withTracing(LLMRequest.layer, "LLMRequest")
```

## Stream Middleware

Transform streams flowing through a service:

```typescript
const streamMiddleware = <A, E, R>(
  transform: (stream: Stream.Stream<A, E, R>) => Stream.Stream<A, E, R>
) => (service: {
  stream: (ctx: ReducedContext) => Stream.Stream<A, E, R>
}) => ({
  stream: (ctx: ReducedContext) =>
    transform(service.stream(ctx))
})

// Usage: Add logging to all streams
const withStreamLogging = streamMiddleware<ContextEvent, LLMError, never>(
  (stream) =>
    stream.pipe(
      Stream.tap((event) => Effect.log(`Event: ${event._tag}`))
    )
)

const loggedService = withStreamLogging(llmRequestService)
```

## Request/Response Middleware

Common pattern for transforming input/output:

```typescript
interface RequestResponseMiddleware<Req, Res, E> {
  readonly transformRequest?: (req: Req) => Effect.Effect<Req, E>
  readonly transformResponse?: (res: Res) => Effect.Effect<Res, E>
}

const applyMiddleware = <Req, Res, E>(
  middleware: RequestResponseMiddleware<Req, Res, E>
) => (service: {
  call: (req: Req) => Effect.Effect<Res, E>
}) => ({
  call: (req: Req) =>
    Effect.gen(function*() {
      const transformedReq = middleware.transformRequest
        ? yield* middleware.transformRequest(req)
        : req

      const res = yield* service.call(transformedReq)

      return middleware.transformResponse
        ? yield* middleware.transformResponse(res)
        : res
    })
})
```

## Composing Middleware

Middleware composes via function composition:

```typescript
const compose = <A>(...fns: ((a: A) => A)[]): ((a: A) => A) =>
  fns.reduceRight((acc, fn) => (x) => fn(acc(x)), (x: A) => x)

// Usage
const enhancedService = compose(
  withLogging,
  withTracing,
  withMetrics,
)(baseService)
```

## Middleware for Layers

```typescript
const layerMiddleware = <S, E, R>(
  transform: (service: S) => S
) => (layer: Layer.Layer<S, E, R>): Layer.Layer<S, E, R> =>
  Layer.map(layer, transform)

// Usage
const enhancedLayer = LLMRequest.layer.pipe(
  layerMiddleware(withLogging),
  layerMiddleware(withMetrics),
)
```

## Practical Example: Caching Middleware

```typescript
const withCaching = (
  cache: Cache<string, ContextEvent[]>
): Middleware<LLMRequest> => (llmRequest) => ({
  stream: (ctx) =>
    Effect.gen(function*() {
      // Generate cache key
      const key = hashReducedContext(ctx)

      // Check cache
      const cached = yield* cache.get(key)
      if (Option.isSome(cached)) {
        yield* Effect.log("Cache hit")
        return Stream.fromIterable(cached.value)
      }

      // Cache miss - make request
      yield* Effect.log("Cache miss")
      const events: ContextEvent[] = []

      return llmRequest.stream(ctx).pipe(
        Stream.tap((event) =>
          Effect.sync(() => events.push(event))
        ),
        Stream.onDone(() => cache.set(key, events))
      )
    })
})
```

## Practical Example: Retry Middleware

```typescript
const withRetry = (schedule: Schedule.Schedule<unknown, LLMError>): Middleware<LLMRequest> =>
  (llmRequest) => ({
    stream: (ctx) =>
      llmRequest.stream(ctx).pipe(
        Stream.retry(schedule)
      )
  })
```

## Practical Example: Timeout Middleware

```typescript
const withTimeout = (duration: Duration.Duration): Middleware<LLMRequest> =>
  (llmRequest) => ({
    stream: (ctx) =>
      llmRequest.stream(ctx).pipe(
        Stream.timeout(duration)
      )
  })
```

## Comparison: Middleware vs Hooks

| Aspect | Middleware | Hooks |
|--------|------------|-------|
| **Scope** | Wraps entire service | Specific lifecycle points |
| **Composition** | Function composition | Service composition |
| **Type safety** | Same interface in/out | Different types per hook |
| **Use case** | Cross-cutting concerns | Feature injection |
| **Example** | Logging, tracing, caching | Validation, moderation |

## When to Use Middleware

- Adding cross-cutting concerns (logging, tracing, metrics)
- Wrapping all methods of a service uniformly
- Caching, retry, timeout policies
- When the transformation preserves the service interface

## When to Use Hooks

- Feature-specific extensibility
- When different hook points need different logic
- When hooks need their own configuration
- When hooks might fail and need error handling
