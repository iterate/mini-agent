# Layer 2: Event Reducer - Overview

Applies new events to the current reduced state, producing an updated `ReducedContext`.

## Responsibility

A true functional reducer: takes current state + new events, produces new state.

```typescript
type Reducer = (current: ReducedContext, newEvents: readonly PersistedEvent[]) => ReducedContext
```

## Interface Options

The key design question: **Should the reducer be a pure function, an Effect-returning function, or a full service?**

| Design | Type | See |
|--------|------|-----|
| A. Pure Function | `(current, events) => ReducedContext` | [design-a-pure-fn.md](./design-a-pure-fn.md) |
| B. Effect Function | `(current, events) => Effect<ReducedContext>` | [design-b-effect-fn.md](./design-b-effect-fn.md) |
| C. Service | `Context.Tag` with `reduce` method | [design-c-service.md](./design-c-service.md) |

## Input

- `current: ReducedContext` - Current accumulated state
- `newEvents: readonly PersistedEvent[]` - New events to apply

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

### 3. State management

Since reduction is incremental `(current, newEvents) => new`, the session layer can:
- Cache the current `ReducedContext`
- Apply only new events when they arrive
- Avoid re-reducing all historical events

## Does NOT Handle

- Where events come from (that's Layer 3)
- Making LLM requests (that's Layer 1)
- Persistence (that's Layer 3)

## Effect Patterns Used

Depends on design choice:
- **Pure function**: No Effect patterns, just TypeScript
- **Effect function**: `Effect.gen`, potentially service dependencies
- **Service**: `Context.Tag`, `Layer.effect`, `Effect.fn`
