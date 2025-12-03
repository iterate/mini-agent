# Context Events Schema

Events are the fundamental unit of data in the system. Every piece of information—user messages, AI responses, configuration changes, lifecycle markers—is represented as an event.

## Branded Types

```typescript
import { Schema } from "effect"

// Prevent mixing context names with arbitrary strings
export const ContextName = Schema.String.pipe(Schema.brand("ContextName"))
export type ContextName = typeof ContextName.Type

// Unique request identifiers
export const RequestId = Schema.String.pipe(Schema.brand("RequestId"))
export type RequestId = typeof RequestId.Type
```

---

## Content Events

Events that carry conversation content.

### SystemPromptEvent

Sets the AI's behavior/personality.

```typescript
export class SystemPromptEvent extends Schema.TaggedClass<SystemPromptEvent>()(
  "SystemPromptEvent",
  {
    content: Schema.String,
  }
) {
  // Convert to LLM message format
  toLLMMessage(): LLMMessage {
    return LLMMessage.make({ role: "system", content: this.content })
  }
}
```

### UserMessageEvent

User input text.

```typescript
export class UserMessageEvent extends Schema.TaggedClass<UserMessageEvent>()(
  "UserMessageEvent",
  {
    content: Schema.String,
  }
) {
  toLLMMessage(): LLMMessage {
    return LLMMessage.make({ role: "user", content: this.content })
  }
}
```

### AssistantMessageEvent

AI response text.

```typescript
export class AssistantMessageEvent extends Schema.TaggedClass<AssistantMessageEvent>()(
  "AssistantMessageEvent",
  {
    content: Schema.String,
  }
) {
  toLLMMessage(): LLMMessage {
    return LLMMessage.make({ role: "assistant", content: this.content })
  }
}
```

### FileAttachmentEvent

File/image attachment.

```typescript
export class FileAttachmentEvent extends Schema.TaggedClass<FileAttachmentEvent>()(
  "FileAttachmentEvent",
  {
    source: Schema.String,  // File path or URL
    mediaType: Schema.String,  // MIME type: "image/png", "application/pdf", etc.
  }
) {}
```

---

## Configuration Events

Events that modify LLM request behavior.

### SetRetryConfigEvent

Change retry/backoff policy.

```typescript
export class SetRetryConfigEvent extends Schema.TaggedClass<SetRetryConfigEvent>()(
  "SetRetryConfigEvent",
  {
    maxRetries: Schema.Number.pipe(Schema.int(), Schema.positive()),
    initialDelayMs: Schema.Number.pipe(Schema.positive()),
    backoffFactor: Schema.optional(Schema.Number.pipe(Schema.positive())),
  }
) {}
```

### SetProviderConfigEvent

Change LLM provider or add fallback.

```typescript
export class SetProviderConfigEvent extends Schema.TaggedClass<SetProviderConfigEvent>()(
  "SetProviderConfigEvent",
  {
    providerId: ProviderId,
    model: Schema.String,
    apiKey: Schema.Redacted(Schema.String),
    baseUrl: Schema.optional(Schema.String),
    asFallback: Schema.optional(Schema.Boolean),  // If true, sets as fallback provider
  }
) {}
```

### SetTimeoutEvent

Change request timeout.

```typescript
export class SetTimeoutEvent extends Schema.TaggedClass<SetTimeoutEvent>()(
  "SetTimeoutEvent",
  {
    timeoutMs: Schema.Number.pipe(Schema.positive()),
  }
) {}
```

---

## Lifecycle Events

Events that mark system state transitions for observability.

### SessionStartedEvent

Emitted when a session boots and loads a context.

```typescript
export class SessionStartedEvent extends Schema.TaggedClass<SessionStartedEvent>()(
  "SessionStartedEvent",
  {
    timestamp: Schema.DateFromNumber,
    loadedEventCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  }
) {}
```

### SessionEndedEvent

Emitted when a session ends (program exit).

```typescript
export class SessionEndedEvent extends Schema.TaggedClass<SessionEndedEvent>()(
  "SessionEndedEvent",
  {
    timestamp: Schema.DateFromNumber,
    reason: Schema.optional(Schema.String),  // "user_exit", "error", etc.
  }
) {}
```

### LLMRequestStartedEvent

Emitted before making an LLM API call.

```typescript
export class LLMRequestStartedEvent extends Schema.TaggedClass<LLMRequestStartedEvent>()(
  "LLMRequestStartedEvent",
  {
    requestId: RequestId,
    timestamp: Schema.DateFromNumber,
  }
) {}
```

### LLMRequestCompletedEvent

Emitted after successful LLM response.

```typescript
export class LLMRequestCompletedEvent extends Schema.TaggedClass<LLMRequestCompletedEvent>()(
  "LLMRequestCompletedEvent",
  {
    requestId: RequestId,
    timestamp: Schema.DateFromNumber,
    durationMs: Schema.Number.pipe(Schema.nonNegative()),
    inputTokens: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
    outputTokens: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  }
) {}
```

### LLMRequestInterruptedEvent

Emitted when an LLM request is cancelled (e.g., new user input arrived).

```typescript
export class LLMRequestInterruptedEvent extends Schema.TaggedClass<LLMRequestInterruptedEvent>()(
  "LLMRequestInterruptedEvent",
  {
    requestId: RequestId,
    timestamp: Schema.DateFromNumber,
    partialResponse: Schema.String,  // Response accumulated before interruption
    reason: Schema.String,  // "new_user_input", "timeout", etc.
  }
) {}
```

### LLMRequestFailedEvent

Emitted when an LLM request fails after all retries.

```typescript
export class LLMRequestFailedEvent extends Schema.TaggedClass<LLMRequestFailedEvent>()(
  "LLMRequestFailedEvent",
  {
    requestId: RequestId,
    timestamp: Schema.DateFromNumber,
    error: Schema.String,
    retriesAttempted: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  }
) {}
```

---

## Ephemeral Events

Events that are never persisted—only exist during streaming.

### TextDeltaEvent

Streaming chunk from LLM.

```typescript
export class TextDeltaEvent extends Schema.TaggedClass<TextDeltaEvent>()(
  "TextDeltaEvent",
  {
    delta: Schema.String,
  }
) {}

// Type guard
export const isTextDeltaEvent = Schema.is(TextDeltaEvent)
```

---

## Union Types

### PersistedEvent

All events that should be saved to storage.

```typescript
export const PersistedEvent = Schema.Union(
  // Content
  SystemPromptEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  FileAttachmentEvent,
  // Configuration
  SetRetryConfigEvent,
  SetProviderConfigEvent,
  SetTimeoutEvent,
  // Lifecycle
  SessionStartedEvent,
  SessionEndedEvent,
  LLMRequestStartedEvent,
  LLMRequestCompletedEvent,
  LLMRequestInterruptedEvent,
  LLMRequestFailedEvent,
)
export type PersistedEvent = typeof PersistedEvent.Type

// Type guard
export const isPersistedEvent = Schema.is(PersistedEvent)
```

### ContextEvent

All events including ephemeral ones.

```typescript
export const ContextEvent = Schema.Union(
  PersistedEvent,
  TextDeltaEvent,
)
export type ContextEvent = typeof ContextEvent.Type
```

### InputEvent

Events that represent user input.

```typescript
export const InputEvent = Schema.Union(
  UserMessageEvent,
  FileAttachmentEvent,
)
export type InputEvent = typeof InputEvent.Type
```

### ContentEvent

Events that carry conversation content (for reduction).

```typescript
export const ContentEvent = Schema.Union(
  SystemPromptEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  FileAttachmentEvent,
)
export type ContentEvent = typeof ContentEvent.Type
```

### ConfigEvent

Events that modify configuration (for reduction).

```typescript
export const ConfigEvent = Schema.Union(
  SetRetryConfigEvent,
  SetProviderConfigEvent,
  SetTimeoutEvent,
)
export type ConfigEvent = typeof ConfigEvent.Type
```

---

## Pattern Matching

Use Effect's pattern matching for type-safe event handling:

```typescript
import { Match } from "effect"

const handleEvent = Match.type<ContextEvent>().pipe(
  Match.tag("UserMessageEvent", (e) => console.log(`User: ${e.content}`)),
  Match.tag("AssistantMessageEvent", (e) => console.log(`AI: ${e.content}`)),
  Match.tag("TextDeltaEvent", (e) => process.stdout.write(e.delta)),
  Match.tag("LLMRequestInterruptedEvent", (e) =>
    console.log(`Interrupted: ${e.partialResponse}`)
  ),
  Match.orElse(() => { /* ignore other events */ }),
)
```

---

## Serialization

Events serialize to JSON via Schema.encode:

```typescript
const encoded = Schema.encodeSync(PersistedEvent)(event)
// { "_tag": "UserMessageEvent", "content": "Hello" }

const decoded = Schema.decodeSync(PersistedEvent)(json)
// UserMessageEvent instance
```

For YAML storage, encode to plain objects first:

```typescript
const events: PersistedEvent[] = [...]
const plain = events.map(e => Schema.encodeSync(PersistedEvent)(e))
const yaml = YAML.stringify(plain)
```

---

## Effect Pattern Alignment

| Pattern | Usage |
|---------|-------|
| `Schema.TaggedClass` | All event types—enables discriminated unions |
| `Schema.Union` | Event category unions |
| `Schema.brand` | Branded types for IDs |
| `Schema.is` | Runtime type guards |
| `Match.type` | Pattern matching on events |
| `Schema.encode/decode` | Serialization |
