# ReducedContext Schema

The `ReducedContext` is the output of reducing all events in a context. It contains everything needed to make an LLM request.

## Overview

```typescript
// The full reduced state
export class ReducedContext extends Schema.Class<ReducedContext>("ReducedContext")({
  messages: Schema.Array(LLMMessage),
  config: LLMRequestConfig,
}) {}
```

---

## LLMMessage

Messages in LLM-native format.

```typescript
export class LLMMessage extends Schema.Class<LLMMessage>("LLMMessage")({
  role: Schema.Literal("system", "user", "assistant"),
  content: Schema.String,
}) {}
```

For multi-modal messages (images, files):

```typescript
// Content part types
export class TextPart extends Schema.TaggedClass<TextPart>()("TextPart", {
  text: Schema.String,
}) {}

export class ImagePart extends Schema.TaggedClass<ImagePart>()("ImagePart", {
  source: Schema.String,  // URL or base64
  mediaType: Schema.String,
}) {}

export const ContentPart = Schema.Union(TextPart, ImagePart)
export type ContentPart = typeof ContentPart.Type

// Extended message with multi-modal support
export class LLMMessageMultiModal extends Schema.Class<LLMMessageMultiModal>("LLMMessageMultiModal")({
  role: Schema.Literal("system", "user", "assistant"),
  content: Schema.Union(
    Schema.String,
    Schema.Array(ContentPart),
  ),
}) {}
```

---

## LLMRequestConfig

Configuration for making the LLM request.

```typescript
export class LLMRequestConfig extends Schema.Class<LLMRequestConfig>("LLMRequestConfig")({
  // Primary provider
  primary: ProviderConfig,

  // Optional fallback provider
  fallback: Schema.optional(ProviderConfig),

  // Retry configuration
  retry: RetryConfig,

  // Request timeout
  timeoutMs: Schema.Number.pipe(Schema.positive()),

  // Optional: parallel request configuration
  parallel: Schema.optional(ParallelConfig),
}) {}
```

### ProviderConfig

Configuration for a single LLM provider.

```typescript
export const ProviderId = Schema.String.pipe(Schema.brand("ProviderId"))
export type ProviderId = typeof ProviderId.Type

export class ProviderConfig extends Schema.Class<ProviderConfig>("ProviderConfig")({
  providerId: ProviderId,  // "openai", "anthropic", "cohere", etc.
  model: Schema.String,  // "gpt-4o-mini", "claude-3-opus", etc.
  apiKey: Schema.Redacted(Schema.String),
  baseUrl: Schema.optional(Schema.String),

  // Provider-specific options
  temperature: Schema.optional(Schema.Number.pipe(
    Schema.greaterThanOrEqualTo(0),
    Schema.lessThanOrEqualTo(2)
  )),
  maxTokens: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
}) {}
```

### RetryConfig

Configuration for retry behavior.

```typescript
export class RetryConfig extends Schema.Class<RetryConfig>("RetryConfig")({
  // Maximum number of retry attempts
  maxRetries: Schema.Number.pipe(Schema.int(), Schema.positive()),

  // Initial delay before first retry
  initialDelayMs: Schema.Number.pipe(Schema.positive()),

  // Backoff multiplier (default: 2)
  backoffFactor: Schema.optional(Schema.Number.pipe(Schema.positive())),

  // Maximum delay cap
  maxDelayMs: Schema.optional(Schema.Number.pipe(Schema.positive())),

  // Add jitter to delays
  jitter: Schema.optional(Schema.Boolean),
}) {
  // Default configuration
  static readonly default = RetryConfig.make({
    maxRetries: 3,
    initialDelayMs: 100,
    backoffFactor: 2,
    maxDelayMs: 10000,
    jitter: true,
  })
}
```

### ParallelConfig

Configuration for parallel LLM requests.

```typescript
export class ParallelConfig extends Schema.Class<ParallelConfig>("ParallelConfig")({
  // Type of parallel execution
  mode: Schema.Literal("race", "all"),

  // Additional requests to run in parallel
  requests: Schema.Array(ParallelRequest),
}) {}

export class ParallelRequest extends Schema.Class<ParallelRequest>("ParallelRequest")({
  // Identifier for this parallel request
  id: Schema.String,

  // Optional: different provider for this request
  provider: Schema.optional(ProviderConfig),

  // Optional: different prompt/system message
  systemPromptOverride: Schema.optional(Schema.String),

  // Purpose of this request
  purpose: Schema.Literal("content", "injection_detection", "moderation", "comparison"),
}) {}
```

---

## Full ReducedContext

```typescript
export class ReducedContext extends Schema.Class<ReducedContext>("ReducedContext")({
  // Messages to send to LLM
  messages: Schema.Array(LLMMessage),

  // Request configuration (providers, retry, timeout)
  config: LLMRequestConfig,
}) {
  // Helper: get message count by role
  countByRole(role: "system" | "user" | "assistant"): number {
    return this.messages.filter(m => m.role === role).length
  }

  // Helper: get last message
  get lastMessage(): LLMMessage | undefined {
    return this.messages[this.messages.length - 1]
  }

  // Helper: check if conversation has content
  get hasContent(): boolean {
    return this.messages.some(m => m.role !== "system")
  }
}
```

---

## Default Configuration

```typescript
export const defaultReducedContext = (): ReducedContext =>
  ReducedContext.make({
    messages: [],
    config: LLMRequestConfig.make({
      primary: ProviderConfig.make({
        providerId: ProviderId.make("openai"),
        model: "gpt-4o-mini",
        apiKey: Redacted.make(""),  // Must be provided
      }),
      retry: RetryConfig.default,
      timeoutMs: 30000,
    }),
  })
```

---

## Validation

The ReducedContext should be validated before use:

```typescript
export class ReducedContextValidationError extends Schema.TaggedError<ReducedContextValidationError>()(
  "ReducedContextValidationError",
  {
    message: Schema.String,
    field: Schema.String,
  }
) {}

export const validateReducedContext = (
  ctx: ReducedContext
): Effect.Effect<ReducedContext, ReducedContextValidationError> =>
  Effect.gen(function*() {
    // Must have at least one message
    if (ctx.messages.length === 0) {
      return yield* Effect.fail(ReducedContextValidationError.make({
        message: "Context must have at least one message",
        field: "messages",
      }))
    }

    // API key must not be empty
    if (Redacted.value(ctx.config.primary.apiKey) === "") {
      return yield* Effect.fail(ReducedContextValidationError.make({
        message: "API key is required",
        field: "config.primary.apiKey",
      }))
    }

    return ctx
  })
```

---

## Usage Example

```typescript
// After reducing events
const reduced: ReducedContext = yield* reducer.reduce(events)

// Validate
const validated = yield* validateReducedContext(reduced)

// Use for LLM request
const stream = yield* llmRequest.stream(validated)
```

---

## Effect Pattern Alignment

| Pattern | Usage |
|---------|-------|
| `Schema.Class` | Structured data with methods |
| `Schema.Redacted` | Secure API key handling |
| `Schema.TaggedError` | Validation errors |
| `Schema.Literal` | Enum-like constrained values |
| `Schema.optional` | Optional fields with defaults |
