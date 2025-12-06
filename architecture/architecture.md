# Architecture

Actor-based event architecture where each agent is a MiniAgent.

Philosophy: **"Agent events are all you need"** - Everything the agent does is driven by events.

## Conceptual Model

- **ContextEvent**: An event in a context (the fundamental unit)
- **Context**: A list of ContextEvents (the event log for an agent)
- **ReducedContext**: All derived state from events (messages, config, counters, flags)
- **MiniAgent**: Actor with internal state = events + reducedContext (nothing else)
- **Reducer**: Pure function `(events) → ReducedContext`
- **EventId**: Globally unique identifier with format `{agentName}:{counter}`
- **Turn Numbering**: Agent turns are numbered sequentially within each agent

## Reference Files

- **[design.ts](./design.ts)** - Complete service interfaces
- **[actor-implementation-sketch.ts](./actor-implementation-sketch.ts)** - Implementation patterns

---

## Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         MiniAgent                                 │
│                                                                   │
│  INTERNAL STATE:                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ events: ContextEvent[]                                       │ │
│  │ reducedContext: ReducedContext  ◀── reduce(events)          │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  INPUT PATH:                                                      │
│  addEvent(event) ──▶ persist ──▶ add to events ──▶ reduce ──▶   │
│                                                    update ctx     │
│                                                        │          │
│                                                        ▼          │
│                                                  Mailbox.offer    │
│                                                        │          │
│  BROADCAST:                                            ▼          │
│  agent.events ◀── Stream.broadcastDynamic ◀───────────┘          │
│       │                                                           │
│  PROCESSING (triggered by event.triggersAgentTurn=true):          │
│       └──▶ debounce ──▶ read reducedContext ──▶ Agent.takeTurn   │
│                                                        │          │
│                                                        ▼          │
│                                          Stream<TextDeltaEvent>   │
│                                                        │          │
│                                                        ▼          │
│                                          AssistantMessageEvent    │
│                                                        │          │
│                                                        ▼          │
│                        persist ──▶ reduce ──▶ Mailbox.offer      │
│                                                        │          │
│                                                        ▼          │
│                                    (broadcasts to all)            │
└──────────────────────────────────────────────────────────────────┘
```

Key insight: `Mailbox.offer` broadcasts to ALL current subscribers via `Stream.broadcastDynamic`. Late subscribers miss events (live stream).

---

## Service Components

### Core Services

These are stateless domain services:

**Agent** - LLM execution with retry and fallback
```typescript
class Agent extends Effect.Service<Agent>()("@app/Agent", {
  effect: Effect.gen(function*() {
    // Implementation with dependencies
  }),
  dependencies: [/* dependencies */]
}) {
  readonly takeTurn: (ctx: ReducedContext) => Stream.Stream<ContextEvent, AgentError>
}
```

**EventReducer** - Folds events into ReducedContext (including config from events)
```typescript
class EventReducer extends Effect.Service<EventReducer>()("@app/EventReducer", {
  effect: Effect.gen(function*() {
    // Implementation
  }),
  dependencies: []
}) {
  readonly reduce: (current: ReducedContext, newEvents: ReadonlyArray<ContextEvent>) => Effect.Effect<ReducedContext, ReducerError>
  readonly initialReducedContext: ReducedContext
}
```

**EventStore** - Pluggable event persistence
```typescript
class EventStore extends Effect.Service<EventStore>()("@app/EventStore", {
  effect: Effect.gen(function*() {
    // YAML file implementation
  }),
  dependencies: [FileSystem, Path]
}) {
  readonly load: (name: AgentName) => Effect.Effect<ReadonlyArray<ContextEvent>, AgentLoadError>
  readonly append: (name: AgentName, events: ReadonlyArray<ContextEvent>) => Effect.Effect<void, AgentSaveError>
  readonly exists: (name: AgentName) => Effect.Effect<boolean>
}

// Alternative implementations via Layer.succeed
const EventStoreInMemory: Layer.Layer<EventStore> = Layer.succeed(EventStore, {...})
```

Note: No AppConfig service. All config derives from events via ReducedContext (SetLlmConfigEvent, SetTimeoutEvent).

### ReducedContext (Derived State)

All actor internal state is derived from events via the reducer. ReducedContext contains:

- `messages` - Content for LLM (from content events)
- `config` - LLM settings (from config events)
- `nextEventNumber` - For generating EventId
- `currentTurnNumber` - Current or next turn number
- `agentTurnStartedAtEventId: Option<EventId>` - When Some, turn in progress. When None, no turn.

The reducer is a pure function: `(events) → ReducedContext`. Actor holds events + reducedContext only.

### Actor Service

**MiniAgent** - Per-agent orchestrator

The actor manages a single agent's lifecycle. It uses all core services internally.

```typescript
class MiniAgent extends Effect.Service<MiniAgent>()("@app/MiniAgent", {
  effect: (agentName: AgentName) => Effect.gen(function*() {
    const agent = yield* Agent
    const reducer = yield* EventReducer
    const store = yield* EventStore
    // Implementation using dependencies
  }),
  dependencies: [Agent, EventReducer, EventStore]
}) {
  readonly agentName: AgentName
  readonly addEvent: (event: ContextEvent) => Effect.Effect<void, MiniAgentError>
  readonly events: Stream.Stream<ContextEvent, never>  // Live broadcast
  readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>  // Historical
  readonly getReducedContext: Effect.Effect<ReducedContext>  // Current derived state
  readonly shutdown: Effect.Effect<void>

  static readonly make: (agentName: AgentName) => Layer.Layer<MiniAgent, MiniAgentError, Agent | EventReducer | EventStore>
}
```

Implementation pattern (Mailbox + broadcastDynamic):
```typescript
const mailbox = yield* Mailbox.make<ContextEvent>()
const broadcast = yield* Stream.broadcastDynamic(Mailbox.toStream(mailbox), {
  capacity: "unbounded"
})
// agent.events = broadcast
// Each execution of broadcast creates a new subscriber
```

### Application Facade

**AgentRegistry** - Manages multiple agents (public API)
```typescript
class AgentRegistry extends Effect.Service<AgentRegistry>()("@app/AgentRegistry", {
  effect: Effect.gen(function*() {
    // Implementation manages map of MiniAgent instances
  }),
  dependencies: [Agent, EventReducer, EventStore]
}) {
  readonly getOrCreate: (agentName: AgentName) => Effect.Effect<MiniAgent, MiniAgentError>
  readonly get: (agentName: AgentName) => Effect.Effect<MiniAgent, AgentNotFoundError>
  readonly list: Effect.Effect<ReadonlyArray<AgentName>>
  readonly shutdownAll: Effect.Effect<void>
}
```

---

## Data Flow

### addEvent Flow

1. Persist event via EventStore (immediate durability)
2. Add to events array (Ref)
3. Run reducer: `reducedContext = reduce(events)` → update reducedContext (Ref)
4. `Mailbox.offer(event)` → broadcasts to all current subscribers
5. If `event.triggersAgentTurn=true`: starts 100ms debounce timer (hard-coded) for processing

### Agent Turn Flow

1. 100ms debounce timer fires (no new triggering events for 100ms)
2. Emit `AgentTurnStartedEvent` → persist → reduce → broadcast
3. Read current `reducedContext` (already up-to-date from addEvent flow)
4. Call `Agent.takeTurn(reducedContext)`
5. Stream `TextDeltaEvent` → broadcast (each chunk, not persisted)
6. On completion: emit `AssistantMessageEvent` → persist → reduce → broadcast
7. Emit `AgentTurnCompletedEvent` → persist → reduce → broadcast

### Request Interruption Flow

1. New event with `triggersAgentTurn=true` arrives during agent turn
2. `Fiber.interrupt(turnFiber)` cancels in-flight LLM request
3. `Effect.onInterrupt` handler emits `AgentTurnInterruptedEvent`
4. New event processed, debounce timer restarts
5. New turn begins when quiet

---

## Key Effect Patterns

### Mailbox (Actor Input)

```typescript
const mailbox = yield* Mailbox.make<ContextEvent>()
yield* mailbox.offer(event)  // Fire-and-forget
yield* mailbox.end  // Closes stream
```

### Stream.broadcastDynamic (Fan-out)

```typescript
const broadcast = yield* Stream.broadcastDynamic(Mailbox.toStream(mailbox), {
  capacity: "unbounded"
})
// Each execution creates new subscriber to internal PubSub
// Late subscribers miss events published before they subscribed
```

### Fiber Interruption

```typescript
yield* Fiber.interrupt(runningFiber)  // Blocks until cleanup

Effect.onInterrupt(() =>
  Effect.gen(function*() {
    yield* emit(AgentTurnInterruptedEvent.make({ reason: "new input" }))
  })
)
```

### Scoped Lifecycle

```typescript
Layer.scoped(MiniAgent, Effect.gen(function*() {
  const mailbox = yield* Mailbox.make<ContextEvent>()

  yield* Effect.addFinalizer((_exit) =>
    Effect.gen(function*() {
      yield* mailbox.offer(SessionEndedEvent.make({ ... }))
      yield* mailbox.end
    })
  )

  return { /* service */ }
}))
```

---

## Dependency Composition

```typescript
// Production - Effect.Service auto-generates .Default layer with dependencies
const MainLayer = AgentRegistry.Default
// Includes: AgentRegistry + Agent + EventReducer + EventStore (YAML)

// Tests - Replace EventStore with in-memory implementation
const TestLayer = Layer.provide(
  AgentRegistry.Default,
  EventStoreInMemory
)
// Alternative test layers use Layer.succeed for mocks:
const MockAgentLayer = Layer.succeed(Agent, {
  takeTurn: (ctx) => Stream.make(/* mock events */)
})
```

---

## Compatibility with Current Implementation

### Event Schema Alignment

Event names and fields are aligned with current `src/context.model.ts` where possible:

| Current Event | Architecture Event | Changes |
|---------------|-------------------|---------|
| `SystemPromptEvent` | `SystemPromptEvent` | + BaseEventFields |
| `UserMessageEvent` | `UserMessageEvent` | + BaseEventFields |
| `AssistantMessageEvent` | `AssistantMessageEvent` | + BaseEventFields |
| `TextDeltaEvent` | `TextDeltaEvent` | + BaseEventFields |
| `FileAttachmentEvent` | `FileAttachmentEvent` | Same source union, mediaType, fileName |
| `SetLlmConfigEvent` | `SetLlmConfigEvent` | Flattened structure vs nested |
| `LLMRequestInterruptedEvent` | `AgentTurnInterruptedEvent` | Same InterruptReason enum, + partialResponse |

New events not in current: `SessionStartedEvent`, `SessionEndedEvent`, `AgentTurnStartedEvent`, `AgentTurnCompletedEvent`, `AgentTurnFailedEvent`, `SetTimeoutEvent`.

### Interruption Handling

Current implementation (`chat-ui.ts`) has interruption support via per-turn fiber:
```typescript
const streamFiber = yield* Effect.fork(streamLLMResponse(events))
const result = yield* Effect.race(
  Fiber.join(streamFiber),          // Wait for completion
  mailbox.take.pipe(                 // Or user input
    Effect.tap(() => Fiber.interrupt(streamFiber))
  )
)
```

Architecture uses background processing fiber with debouncing:
```typescript
const processingFiber = yield* broadcast.pipe(
  Stream.filter((e) => e.triggersAgentTurn),
  Stream.debounce(Duration.millis(100)),
  Stream.mapEffect(() => processBatch),
  Effect.fork
)
```

Both use Effect's standard fiber interruption patterns.

### Migration Notes

- **BaseEventFields**: Add id, timestamp, agentName, parentEventId, triggersAgentTurn to all events
- **toLLMMessage()**: Remove methods from events; EventReducer derives messages
- **InterruptReason**: Reuse existing enum (`"user_cancel" | "user_new_message" | "timeout"`)
- **partialResponse**: Preserved in AgentTurnInterruptedEvent for capturing partial LLM output

---

## Future Considerations

### @effect/cluster Distribution

When ready to distribute across nodes:

1. Replace `MiniAgent` with `Entity`
2. Replace `AgentRegistry` with `Sharding`
3. Use persistent EventStore (Postgres/Redis)
4. Configure cluster nodes and discovery

See design.ts Future Considerations section for details.
