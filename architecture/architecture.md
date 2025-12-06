# Architecture

Actor-based event architecture. Philosophy: **"Agent events are all you need"**

## Conceptual Model

- **ContextEvent**: Fundamental unit - an event in a context
- **Context**: List of ContextEvents (the event log)
- **ReducedContext**: All derived state (messages, config, counters) via pure reducer
- **MiniAgent**: Actor holding events + reducedContext only
- **EventId**: Format `{contextName}:{counter}` - unique within a context
- **AgentName vs ContextName**: Agent identity vs event storage location (enables context switching)

Reference: **[design.ts](./design.ts)** for complete service interfaces and types.

## Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         MiniAgent                                 │
│                                                                   │
│  STATE: Ref<{ events[], reducedContext }> with Ref.modify        │
│                                                                   │
│  INPUT:                                                           │
│  addEvent(e) → Ref.modify(atomic id) → uninterruptible(persist)  │
│              → Ref.modify(reduce) → Mailbox.offer                │
│                                                      │            │
│  BROADCAST: (bounded, sliding)                       ▼            │
│  agent.events ◀── broadcastDynamic(256, sliding) ◀───┘            │
│       │                                                           │
│  PROCESSING (when event.triggersAgentTurn=true):                  │
│       └──▶ aggregateWithin(last, 500ms) ──▶ MiniAgentTurn        │
│                                         │                         │
│                                         ▼                         │
│                         TextDeltaEvent... → AssistantMessageEvent │
│                                         │                         │
│                         uninterruptible(persist) → broadcast      │
│                                                                   │
│  SHUTDOWN: end → race(await, 5s) → shutdown                      │
└──────────────────────────────────────────────────────────────────┘
```

## Key Patterns

| Pattern | Implementation | Why |
|---------|---------------|-----|
| Atomic state | `Ref.modify()` | Single atomic primitive, no races |
| Bounded broadcast | `{ capacity: 256, strategy: "sliding" }` | TextDelta can drop, final message preserved |
| Batching | `aggregateWithin(Sink.last(), 500ms)` | Max wait guarantee, no starvation |
| Safe persistence | `Effect.uninterruptible(persist)` | Can't interrupt mid-write |
| Graceful shutdown | `race(await, timeout)` | Returns when drained OR timeout (up to 5s, not always 5s) |
| Service access | `yield* ServiceTag` | No `accessors: true` (Effect's own packages don't use it) |

## Services

| Service | Purpose |
|---------|---------|
| **MiniAgentTurn** | Executes LLM request (retry + fallback) |
| **EventReducer** | Folds events → ReducedContext |
| **EventStore** | Persists events by ContextName |
| **AgentRegistry** | Creates/manages MiniAgent instances |

MiniAgent is NOT a service - it's an interface returned by `AgentRegistry.getOrCreate()`.

## Data Flows

### addEvent
1. `Ref.modify` generates atomic EventId
2. `Effect.uninterruptible(persist)` - can't interrupt mid-write
3. `Ref.modify` runs reducer, updates reducedContext
4. `Mailbox.offer` broadcasts to subscribers
5. If `triggersAgentTurn=true`: batched via aggregateWithin

### Agent Turn
1. `aggregateWithin` fires (max 500ms wait) → emit AgentTurnStartedEvent
2. `MiniAgentTurn.execute(reducedContext)` → stream TextDeltaEvents
3. Complete → emit AssistantMessageEvent + AgentTurnCompletedEvent

### Interruption
1. New triggering event during turn → `Fiber.interrupt(turnFiber)`
2. `Effect.onInterrupt` emits AgentTurnInterruptedEvent
3. New turn starts after next batch fires

### Shutdown
```typescript
// Returns immediately when subscribers drain, OR after 5s max
yield* mailbox.end
yield* Effect.race(mailbox.await, Effect.sleep("5 seconds"))
yield* mailbox.shutdown
```

## Layer Composition

```typescript
// Services use Context.Tag (not Effect.Service with accessors)
// Access via: const reducer = yield* EventReducer

// Production
const MainLayer = AgentRegistry.Default

// Tests - swap EventStore
const TestLayer = Layer.provide(AgentRegistry.Default, EventStoreInMemory)
```

## Future

- Replace AgentRegistry with @effect/cluster Sharding
- Replace EventStore with Postgres/Redis
- See design.ts for event-driven extensions (tools, workflows, memory)
