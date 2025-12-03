# Design A: Pure Function Reducer

The simplest approach—reducer is just a function with no dependencies.

## Interface

```typescript
export const reduceEvents: (events: readonly PersistedEvent[]) => ReducedContext
```

## Implementation

```typescript
import { ReducedContext, LLMMessage, LLMRequestConfig, RetryConfig, ProviderConfig } from "./schemas.ts"

interface ReducerState {
  messages: LLMMessage[]
  systemPrompt: string | null
  retryConfig: RetryConfig
  primaryProvider: ProviderConfig | null
  fallbackProvider: ProviderConfig | null
  timeoutMs: number
  pendingAttachments: FileAttachmentEvent[]
}

const initialState: ReducerState = {
  messages: [],
  systemPrompt: null,
  retryConfig: RetryConfig.make({
    maxRetries: 3,
    initialDelayMs: 100,
    backoffFactor: 2,
  }),
  primaryProvider: null,
  fallbackProvider: null,
  timeoutMs: 30000,
  pendingAttachments: [],
}

export const reduceEvents = (events: readonly PersistedEvent[]): ReducedContext => {
  const state = events.reduce(reduceEvent, initialState)
  return stateToReducedContext(state)
}

const reduceEvent = (state: ReducerState, event: PersistedEvent): ReducerState => {
  switch (event._tag) {
    case "SystemPromptEvent":
      return {
        ...state,
        systemPrompt: event.content,
      }

    case "UserMessageEvent": {
      // Attach any pending files to this message
      const content = state.pendingAttachments.length > 0
        ? buildMultiModalContent(event.content, state.pendingAttachments)
        : event.content

      return {
        ...state,
        messages: [
          ...state.messages,
          LLMMessage.make({ role: "user", content }),
        ],
        pendingAttachments: [],  // Clear after attaching
      }
    }

    case "AssistantMessageEvent":
      return {
        ...state,
        messages: [
          ...state.messages,
          LLMMessage.make({ role: "assistant", content: event.content }),
        ],
      }

    case "FileAttachmentEvent":
      return {
        ...state,
        pendingAttachments: [...state.pendingAttachments, event],
      }

    case "SetRetryConfigEvent":
      return {
        ...state,
        retryConfig: RetryConfig.make({
          maxRetries: event.maxRetries,
          initialDelayMs: event.initialDelayMs,
          backoffFactor: event.backoffFactor,
        }),
      }

    case "SetProviderConfigEvent":
      if (event.asFallback) {
        return {
          ...state,
          fallbackProvider: ProviderConfig.make({
            providerId: event.providerId,
            model: event.model,
            apiKey: event.apiKey,
            baseUrl: event.baseUrl,
          }),
        }
      }
      return {
        ...state,
        primaryProvider: ProviderConfig.make({
          providerId: event.providerId,
          model: event.model,
          apiKey: event.apiKey,
          baseUrl: event.baseUrl,
        }),
      }

    case "SetTimeoutEvent":
      return {
        ...state,
        timeoutMs: event.timeoutMs,
      }

    // Lifecycle events don't affect reduction
    case "SessionStartedEvent":
    case "SessionEndedEvent":
    case "LLMRequestStartedEvent":
    case "LLMRequestCompletedEvent":
    case "LLMRequestInterruptedEvent":
    case "LLMRequestFailedEvent":
      return state
  }
}

const stateToReducedContext = (state: ReducerState): ReducedContext => {
  // Build messages array with system prompt first
  const messages: LLMMessage[] = []

  if (state.systemPrompt) {
    messages.push(LLMMessage.make({ role: "system", content: state.systemPrompt }))
  }

  messages.push(...state.messages)

  // Build config
  const config = LLMRequestConfig.make({
    primary: state.primaryProvider ?? getDefaultProvider(),
    fallback: state.fallbackProvider,
    retry: state.retryConfig,
    timeoutMs: state.timeoutMs,
  })

  return ReducedContext.make({ messages, config })
}

const getDefaultProvider = (): ProviderConfig =>
  ProviderConfig.make({
    providerId: ProviderId.make("openai"),
    model: "gpt-4o-mini",
    apiKey: Redacted.make(""),  // Will fail validation if not set
  })

const buildMultiModalContent = (
  text: string,
  attachments: readonly FileAttachmentEvent[]
): string => {
  // For simple text-only models, just mention attachments
  // For multi-modal, would return structured content
  const attachmentNotes = attachments
    .map(a => `[Attached: ${a.source}]`)
    .join("\n")
  return `${text}\n\n${attachmentNotes}`
}
```

## Usage

```typescript
// In Layer 3 (Session)
const events = yield* repository.load(contextName)
const reduced = reduceEvents(events)
const stream = yield* llmRequest.stream(reduced)
```

## Testing

```typescript
import { describe, expect, it } from "vitest"

describe("reduceEvents", () => {
  it("builds messages from content events", () => {
    const events = [
      SystemPromptEvent.make({ content: "You are helpful" }),
      UserMessageEvent.make({ content: "Hello" }),
      AssistantMessageEvent.make({ content: "Hi there!" }),
    ]

    const result = reduceEvents(events)

    expect(result.messages).toHaveLength(3)
    expect(result.messages[0]).toEqual(
      LLMMessage.make({ role: "system", content: "You are helpful" })
    )
  })

  it("applies config events", () => {
    const events = [
      SetRetryConfigEvent.make({ maxRetries: 5, initialDelayMs: 200 }),
    ]

    const result = reduceEvents(events)

    expect(result.config.retry.maxRetries).toBe(5)
    expect(result.config.retry.initialDelayMs).toBe(200)
  })

  it("attaches files to next user message", () => {
    const events = [
      FileAttachmentEvent.make({ source: "image.png", mediaType: "image/png" }),
      UserMessageEvent.make({ content: "What's in this image?" }),
    ]

    const result = reduceEvents(events)

    expect(result.messages[0].content).toContain("[Attached: image.png]")
  })
})
```

## Trade-offs

### Pros

| Benefit | Explanation |
|---------|-------------|
| **Simple** | Just a function, no Effect overhead |
| **Fast** | Synchronous, no async |
| **Easy to test** | Pure function, no mocks needed |
| **Predictable** | Same input → same output |
| **No dependencies** | Doesn't need DI |

### Cons

| Drawback | Explanation |
|----------|-------------|
| **No I/O** | Can't fetch data, count tokens, validate |
| **No dependencies** | Can't inject services (token counter, etc.) |
| **Hard to extend** | Adding async features requires redesign |
| **Not swappable** | Can't swap implementation via layers |

## Effect Pattern Alignment

This design **doesn't use Effect patterns** directly, but aligns with:

- **Pure functions where possible**: Effect guidance recommends pure functions for logic without side effects
- **Separation of concerns**: Reduction logic is isolated from I/O

## When to Use

- Reduction is purely computational
- No need to inject dependencies
- Performance is critical
- Simplicity is prioritized

## Recommendation

**Start here** if you don't anticipate needing:
- Token counting during reduction
- Async validation
- Swappable reducer implementations

If these needs arise later, refactor to Design B or C.
