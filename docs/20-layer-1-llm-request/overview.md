# Layer 1: LLM Request - Overview

The innermost layer. Responsible for making LLM API calls with retry, fallback, timeout, and parallel execution support.

## Responsibility

Given a `ReducedContext` (everything needed for the request), make the LLM call and return a stream of events.

## Service Interface

```typescript
class LLMRequest extends Context.Tag("@app/LLMRequest")<
  LLMRequest,
  {
    readonly stream: (ctx: ReducedContext) => Stream.Stream<ContextEvent, LLMError>
  }
>() {}
```

## Input

`ReducedContext` containing:
- `messages: LLMMessage[]` - The conversation history
- `config: LLMRequestConfig` - Provider, retry, timeout, parallel settings

## Output

`Stream<ContextEvent>` containing:
- `TextDeltaEvent` - Streaming chunks (ephemeral)
- `AssistantMessageEvent` - Final complete response

## Key Capabilities

1. **Retry with Schedule** - Exponential backoff, configurable max retries
2. **Fallback Provider** - Try secondary provider if primary fails
3. **Timeout** - Request-level timeout
4. **Parallel Requests** - Run multiple requests concurrently (race or collect all)

## Does NOT Handle

- Where the ReducedContext came from
- Persistence of events
- Request interruption (that's Layer 4)
- Lifecycle events (that's Layer 3)

## Design Decisions

The key design question is: **How does configuration reach the service?**

| Design | Description | See |
|--------|-------------|-----|
| A. Config as Parameter | Everything in ReducedContext | [design-a-config-param.md](./design-a-config-param.md) |
| B. Config via Layer | Injected at layer construction | [design-b-config-layer.md](./design-b-config-layer.md) |
| C. Hybrid | Defaults from layer, override per-request | [design-c-hybrid.md](./design-c-hybrid.md) |

For parallel request patterns, see [parallel-requests.md](./parallel-requests.md).

## Effect Patterns Used

- `Effect.retry(schedule)` - Retry logic
- `Effect.orElse` - Fallback chaining
- `Effect.timeout` - Request timeout
- `Effect.all` / `Effect.race` - Parallel execution
- `Stream.mapEffect` - Transform stream elements
- `Effect.fn` - Automatic tracing spans
