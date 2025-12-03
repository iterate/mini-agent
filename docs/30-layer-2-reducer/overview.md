# Layer 2: Event Reducer - Overview

Transforms a sequence of events into a `ReducedContext` containing everything needed for an LLM request.

## Responsibility

Given all events in a context, produce:
- Messages in LLM format
- Configuration (provider, retry, timeout, parallel)

## Interface Options

The key design question: **Should the reducer be a pure function, an Effect-returning function, or a full service?**

| Design | Type | See |
|--------|------|-----|
| A. Pure Function | `(events) => ReducedContext` | [design-a-pure-fn.md](./design-a-pure-fn.md) |
| B. Effect Function | `(events) => Effect<ReducedContext>` | [design-b-effect-fn.md](./design-b-effect-fn.md) |
| C. Service | `Context.Tag` with `reduce` method | [design-c-service.md](./design-c-service.md) |

## Input

`readonly PersistedEvent[]` - All persisted events in order

## Output

`ReducedContext` containing:
- `messages: LLMMessage[]` - Conversation history
- `config: LLMRequestConfig` - Provider, retry, timeout settings

## Reduction Logic

The reducer processes events in order, accumulating state:

```
Event                     | Effect on State
--------------------------|----------------------------------
SystemPromptEvent         | Adds/replaces system message
UserMessageEvent          | Appends user message
AssistantMessageEvent     | Appends assistant message
FileAttachmentEvent       | Adds to current user message
SetRetryConfigEvent       | Updates retry configuration
SetProviderConfigEvent    | Updates provider (primary or fallback)
SetTimeoutEvent           | Updates timeout
SessionStartedEvent       | No effect (lifecycle only)
LLMRequestStartedEvent    | No effect (lifecycle only)
LLMRequestCompletedEvent  | No effect (lifecycle only)
LLMRequestInterruptedEvent| No effect (lifecycle only)
```

## Key Design Decisions

### 1. What state does the reducer accumulate?

```typescript
interface ReducerState {
  messages: LLMMessage[]
  systemPrompt: string | null
  retryConfig: RetryConfig
  primaryProvider: ProviderConfig | null
  fallbackProvider: ProviderConfig | null
  timeoutMs: number
  // Could add more: tokenCount, metadata, etc.
}
```

### 2. How are file attachments handled?

Options:
- **A)** FileAttachment modifies the previous user message
- **B)** FileAttachment creates a separate message part
- **C)** FileAttachments are grouped with the next user message

### 3. Should reduction be lazy or eager?

- **Eager**: Reduce all events upfront, cache result
- **Lazy**: Reduce on-demand (re-reduce after each new event)

Given events are append-only and reduction is fast, **lazy** is simpler.

## Does NOT Handle

- Where events come from (that's Layer 3)
- Making LLM requests (that's Layer 1)
- Persistence (that's Layer 3)

## Effect Patterns Used

Depends on design choice:
- **Pure function**: No Effect patterns, just TypeScript
- **Effect function**: `Effect.gen`, potentially service dependencies
- **Service**: `Context.Tag`, `Layer.effect`, `Effect.fn`
