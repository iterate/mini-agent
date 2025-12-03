# Persistence Strategy

When and how events are persisted to storage.

## Current Approach: Immediate Persistence

Events are persisted immediately as they occur:

```typescript
// Input event persisted immediately
yield* repository.append(contextName, [inputEvent])

// LLM response events persisted as they stream
llmRequest.stream(reduced).pipe(
  Stream.tap((event) => {
    if (isPersistedEvent(event)) {
      return repository.append(contextName, [event])
    }
    return Effect.void
  })
)
```

## What Gets Persisted

| Event Type | Persisted | Reason |
|------------|-----------|--------|
| `SystemPromptEvent` | Yes | Part of conversation |
| `UserMessageEvent` | Yes | User input |
| `AssistantMessageEvent` | Yes | AI response |
| `FileAttachmentEvent` | Yes | User input |
| `SetRetryConfigEvent` | Yes | Config change |
| `SetProviderConfigEvent` | Yes | Config change |
| `SetTimeoutEvent` | Yes | Config change |
| `SessionStartedEvent` | Yes | Lifecycle audit |
| `SessionEndedEvent` | Yes | Lifecycle audit |
| `LLMRequestStartedEvent` | Yes | Lifecycle audit |
| `LLMRequestCompletedEvent` | Yes | Lifecycle audit |
| `LLMRequestInterruptedEvent` | Yes | Lifecycle + partial response |
| `LLMRequestFailedEvent` | Yes | Error audit |
| `TextDeltaEvent` | **No** | Ephemeral streaming chunk |

## ContextRepository Interface

```typescript
class ContextRepository extends Context.Tag("@app/ContextRepository")<
  ContextRepository,
  {
    // Load all events for a context
    readonly load: (name: ContextName) => Effect.Effect<readonly PersistedEvent[], ContextNotFound>

    // Load or create with default system prompt
    readonly loadOrCreate: (name: ContextName) => Effect.Effect<readonly PersistedEvent[]>

    // Append events (atomic)
    readonly append: (name: ContextName, events: readonly PersistedEvent[]) => Effect.Effect<void, ContextSaveError>

    // List all context names
    readonly list: () => Effect.Effect<readonly ContextName[]>

    // Delete a context
    readonly delete: (name: ContextName) => Effect.Effect<void, ContextNotFound>
  }
>() {}
```

## Implementation: YAML File Backend

```typescript
class ContextRepository extends Context.Tag("@app/ContextRepository")<
  ContextRepository,
  { /* ... */ }
>() {
  static readonly layer = Layer.effect(
    ContextRepository,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const config = yield* AppConfig

      const contextPath = (name: ContextName) =>
        path.join(config.dataDir, "contexts", `${name}.yaml`)

      const load = Effect.fn("ContextRepository.load")(
        function*(name: ContextName) {
          const filePath = contextPath(name)

          const exists = yield* fs.exists(filePath)
          if (!exists) {
            return yield* Effect.fail(ContextNotFound.make({ name }))
          }

          const content = yield* fs.readFileString(filePath)
          const raw = YAML.parse(content) as unknown[]

          // Decode each event
          const events = raw.map((r) =>
            Schema.decodeUnknownSync(PersistedEvent)(r)
          )

          return events
        }
      )

      const append = Effect.fn("ContextRepository.append")(
        function*(name: ContextName, events: readonly PersistedEvent[]) {
          if (events.length === 0) return

          const filePath = contextPath(name)

          // Load existing
          const existing = yield* load(name).pipe(
            Effect.catchTag("ContextNotFound", () => Effect.succeed([]))
          )

          // Encode new events
          const encoded = events.map((e) =>
            Schema.encodeSync(PersistedEvent)(e)
          )

          // Write all (atomic)
          const allEncoded = [
            ...existing.map((e) => Schema.encodeSync(PersistedEvent)(e)),
            ...encoded,
          ]

          const yaml = YAML.stringify(allEncoded)
          yield* fs.writeFileString(filePath, yaml)
        }
      )

      // ... list, delete, loadOrCreate

      return ContextRepository.of({ load, append, list, delete: deleteContext, loadOrCreate })
    })
  )
}
```

## Alternative: Append-Only File

For performance, could use append-only format:

```typescript
const append = Effect.fn("ContextRepository.append")(
  function*(name: ContextName, events: readonly PersistedEvent[]) {
    const filePath = contextPath(name)

    // Append to file (no read required)
    const lines = events
      .map((e) => JSON.stringify(Schema.encodeSync(PersistedEvent)(e)))
      .join("\n") + "\n"

    yield* fs.appendFileString(filePath, lines)
  }
)

const load = Effect.fn("ContextRepository.load")(
  function*(name: ContextName) {
    const content = yield* fs.readFileString(filePath)
    const lines = content.split("\n").filter(Boolean)
    return lines.map((line) =>
      Schema.decodeSync(PersistedEvent)(JSON.parse(line))
    )
  }
)
```

**Trade-offs**:
- ✅ Faster appends (no read-modify-write)
- ✅ Handles large contexts better
- ❌ Less human-readable
- ❌ Compaction needed eventually

## Persistence Timing Options

### Option A: Immediate (Current)

```typescript
// Persist as events occur
yield* repository.append(name, [event])
```

**Pros**: Durable, crash-safe
**Cons**: More I/O

### Option B: Batched

```typescript
// Accumulate, persist on stream end
const buffer: PersistedEvent[] = []

stream.pipe(
  Stream.tap((e) => {
    if (isPersistedEvent(e)) buffer.push(e)
    return Effect.void
  }),
  Stream.onDone(() => repository.append(name, buffer))
)
```

**Pros**: Less I/O, atomic
**Cons**: Lost on crash

### Option C: Configurable

```typescript
interface PersistenceConfig {
  strategy: "immediate" | "batched" | "on_complete"
}
```

## Recommendation: Immediate

For this use case, immediate persistence is best:
1. **Crash safety**: No lost data
2. **Simplicity**: No buffering logic
3. **Audit trail**: Events visible immediately
4. **Small events**: YAML append is fast enough

If performance becomes an issue, switch to append-only JSON lines format.

## Error Handling

```typescript
const append = Effect.fn("ContextRepository.append")(
  function*(name: ContextName, events: readonly PersistedEvent[]) {
    yield* fs.writeFileString(filePath, yaml).pipe(
      Effect.catchAll((cause) =>
        Effect.fail(ContextSaveError.make({
          name,
          cause: Cause.pretty(cause),
        }))
      )
    )
  }
)
```

## Effect Pattern Alignment

| Pattern | Usage |
|---------|-------|
| `FileSystem` from `@effect/platform` | File I/O |
| `Path` from `@effect/platform` | Path handling |
| `Schema.encode/decode` | Serialization |
| `Effect.catchTag` | Error recovery |
| `Context.Tag` | Repository as service |
