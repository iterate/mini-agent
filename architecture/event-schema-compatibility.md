# Event Schema Compatibility Analysis

Comparison between current implementation (`src/context.model.ts`) and proposed architecture (`architecture/design.ts`).

---

## Schema Comparison

### Current Events (`src/context.model.ts`)

| Event | Fields | Notes |
|-------|--------|-------|
| `SystemPromptEvent` | `content: string` | Has `toLLMMessage()` method |
| `UserMessageEvent` | `content: string` | Has `toLLMMessage()` method |
| `AssistantMessageEvent` | `content: string` | Has `toLLMMessage()` method |
| `TextDeltaEvent` | `delta: string` | Ephemeral, not persisted |
| `LLMRequestInterruptedEvent` | `requestId, reason, partialResponse` | Has `toLLMMessage()` returning partial |
| `FileAttachmentEvent` | `source, mediaType, fileName?` | `source` is union type |
| `SetLlmConfigEvent` | `config: LlmConfig` | Full LlmConfig object |

### Proposed Events (`architecture/design.ts`)

| Event | Fields | Notes |
|-------|--------|-------|
| `SystemPromptEvent` | `BaseEventFields + content` | No methods |
| `UserMessageEvent` | `BaseEventFields + content` | No methods |
| `AssistantMessageEvent` | `BaseEventFields + content` | No methods |
| `TextDeltaEvent` | `BaseEventFields + delta` | Ephemeral |
| `FileAttachmentEvent` | `BaseEventFields + source, mimeType, content` | Different structure |
| `SetLlmProviderConfigEvent` | `BaseEventFields + providerId, model, apiKey, baseUrl?, asFallback` | Flattened config |
| `SetTimeoutEvent` | `BaseEventFields + timeoutMs` | New - timeout config |
| `SessionStartedEvent` | `BaseEventFields` | New - lifecycle |
| `SessionEndedEvent` | `BaseEventFields` | New - lifecycle |
| `AgentTurnStartedEvent` | `BaseEventFields + turnNumber` | New - turn lifecycle |
| `AgentTurnCompletedEvent` | `BaseEventFields + turnNumber, durationMs` | New - turn lifecycle |
| `AgentTurnInterruptedEvent` | `BaseEventFields + turnNumber, reason` | Replaces LLMRequestInterrupted |
| `AgentTurnFailedEvent` | `BaseEventFields + turnNumber, error` | New - error tracking |

### BaseEventFields (Proposed)

All proposed events include:
```typescript
{
  id: EventId,              // "{agentName}:{counter}" e.g. "chat:0001"
  timestamp: DateTimeUtc,
  agentName: AgentName,
  parentEventId: Option<EventId>,
  triggersAgentTurn: boolean
}
```

---

## Key Differences

### 1. Event Metadata

**Current:** No metadata - events are bare content containers.

**Proposed:** All events have `BaseEventFields` with:
- Globally unique ID
- Timestamp
- Agent name (which context/agent owns this)
- Parent event ID (causal linking)
- Trigger flag (whether to start LLM request)

**Migration Impact:** All event constructors change. Existing YAML files need migration.

### 2. LLM Message Conversion

**Current:** Events have `toLLMMessage()` instance methods.

**Proposed:** No methods on events. LLM messages derived by `EventReducer`.

**Migration Impact:** Replace `event.toLLMMessage()` calls with reducer logic.

### 3. Interruption Event

**Current `LLMRequestInterruptedEvent`:**
```typescript
{
  requestId: string,
  reason: "user_cancel" | "user_new_message" | "timeout",
  partialResponse: string
}
```

**Proposed `AgentTurnInterruptedEvent`:**
```typescript
{
  ...BaseEventFields,
  turnNumber: AgentTurnNumber,
  reason: string  // Free-form string
}
```

**Gap:** Proposed version lacks `partialResponse` field.

**Recommendation:** Add to AgentTurnInterruptedEvent:
```typescript
partialResponse: Schema.optionalWith(Schema.String, { as: "Option" })
```

### 4. File Attachment

**Current:**
```typescript
{
  source: { type: "file", path: string } | { type: "url", url: string },
  mediaType: string,
  fileName?: string
}
```

**Proposed:**
```typescript
{
  ...BaseEventFields,
  source: string,      // Path or URL as string
  mimeType: string,    // Renamed from mediaType
  content: string      // Base64 or text content
}
```

**Differences:**
- `source` changed from union to plain string
- `mediaType` → `mimeType`
- Added `content` field (inline content vs reference)

**Migration Impact:** Need to decide on attachment semantics - reference vs inline.

### 5. LLM Config

**Current `SetLlmConfigEvent`:**
```typescript
{
  config: LlmConfig  // Nested object with all settings
}
```

**Proposed `SetLlmProviderConfigEvent`:**
```typescript
{
  ...BaseEventFields,
  providerId: LlmProviderId,
  model: string,
  apiKey: Redacted<string>,
  baseUrl?: Option<string>,
  asFallback: boolean
}
```

**Differences:**
- Flattened structure (no nested `config`)
- Added `asFallback` for fallback provider
- Uses branded `LlmProviderId` type
- Uses `Redacted` for API key

### 6. New Lifecycle Events

Not present in current:
- `SessionStartedEvent` - when agent session begins
- `SessionEndedEvent` - when agent session ends
- `AgentTurnStartedEvent` - before LLM call
- `AgentTurnCompletedEvent` - after successful LLM call
- `AgentTurnFailedEvent` - on LLM error
- `SetTimeoutEvent` - timeout configuration

---

## Event Unions

### Current

```typescript
// Persisted to disk
const PersistedEvent = Schema.Union(
  SystemPromptEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  LLMRequestInterruptedEvent,
  FileAttachmentEvent,
  SetLlmConfigEvent
)

// All events (including ephemeral)
const ContextEvent = Schema.Union(
  ...PersistedEvent members,
  TextDeltaEvent
)

// Input-only events
const InputEvent = Schema.Union(
  UserMessageEvent,
  FileAttachmentEvent,
  SystemPromptEvent
)
```

### Proposed

```typescript
// Single union - no Input/Persisted distinction
const ContextEvent = Schema.Union(
  SystemPromptEvent,
  UserMessageEvent,
  FileAttachmentEvent,
  AssistantMessageEvent,
  TextDeltaEvent,
  SetLlmProviderConfigEvent,
  SetTimeoutEvent,
  SessionStartedEvent,
  SessionEndedEvent,
  AgentTurnStartedEvent,
  AgentTurnCompletedEvent,
  AgentTurnInterruptedEvent,
  AgentTurnFailedEvent
)
```

**Difference:** Proposed has single union. Persistence decision is per-event (TextDeltaEvent not persisted).

---

## Migration Path

### Phase 1: Add BaseEventFields

1. Add fields to all existing events
2. Generate IDs on event creation
3. Update YAML serialization to include new fields
4. Write migration script for existing context files

### Phase 2: Rename/Restructure

1. `SetLlmConfigEvent` → `SetLlmProviderConfigEvent` (flatten)
2. `LLMRequestInterruptedEvent` → `AgentTurnInterruptedEvent` (add partialResponse)
3. `FileAttachmentEvent` - decide on source/content semantics

### Phase 3: Add New Events

1. Add lifecycle events (SessionStarted/Ended)
2. Add turn events (AgentTurnStarted/Completed/Failed)
3. Add SetTimeoutEvent

### Phase 4: Remove Legacy

1. Remove `toLLMMessage()` methods
2. Remove `PersistedEvent` / `InputEvent` unions if not needed
3. Update EventReducer to derive messages

---

## Backwards Compatibility

**File format:** Not compatible. Existing YAML files lack:
- Event IDs
- Timestamps
- Agent names
- Parent event IDs
- triggersAgentTurn flag

**Migration script needed:**
```typescript
// Pseudocode
const migrateContextFile = (oldEvents: OldEvent[]): NewEvent[] => {
  let counter = 0
  return oldEvents.map((old) => ({
    ...old,
    id: makeEventId("chat", counter++),
    timestamp: DateTime.unsafeNow(),
    agentName: "chat" as AgentName,
    parentEventId: Option.none(),
    triggersAgentTurn: old._tag === "UserMessage"
  }))
}
```

---

## Recommendations

1. **Add `partialResponse` to AgentTurnInterruptedEvent** - preserves current functionality

2. **Keep `toLLMMessage()` during migration** - can coexist with reducer approach

3. **Decide on FileAttachment semantics** - inline content vs path reference

4. **Version the file format** - add version field to context files for future migrations

5. **Consider gradual rollout** - can implement new events while keeping old ones working
