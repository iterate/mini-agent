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
│  STATE: events[] + reducedContext (derived via reducer)           │
│                                                                   │
│  INPUT:                                                           │
│  addEvent(e) → persist → add to events → reduce → Mailbox.offer  │
│                                                      │            │
│  BROADCAST:                                          ▼            │
│  agent.tapEventStream ◀── Stream.broadcastDynamic ◀──┘            │
│       │                                                           │
│  PROCESSING (when event.triggersAgentTurn=true):                  │
│       └──▶ debounce(100ms) ──▶ MiniAgentTurn.execute(ctx)        │
│                                         │                         │
│                                         ▼                         │
│                         TextDeltaEvent... → AssistantMessageEvent │
│                                         │                         │
│                         persist → reduce → broadcast              │
└──────────────────────────────────────────────────────────────────┘
```

Key: Mailbox.offer broadcasts to ALL current subscribers via broadcastDynamic. Late subscribers miss historical events.

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
1. Persist via EventStore (immediate durability)
2. Add to events array, run reducer, update reducedContext
3. Mailbox.offer → broadcast to subscribers
4. If `triggersAgentTurn=true`: start 100ms debounce

### Agent Turn
1. Debounce fires → emit AgentTurnStartedEvent
2. MiniAgentTurn.execute(reducedContext) → stream TextDeltaEvents
3. Complete → emit AssistantMessageEvent + AgentTurnCompletedEvent

### Interruption
1. New triggering event during turn → Fiber.interrupt(turnFiber)
2. Effect.onInterrupt emits AgentTurnInterruptedEvent
3. New turn starts after debounce

## Layer Composition

```typescript
// Production
const MainLayer = AgentRegistry.Default  // includes all dependencies

// Tests - swap EventStore
const TestLayer = Layer.provide(AgentRegistry.Default, EventStoreInMemory)
```

## Future

- Replace AgentRegistry with @effect/cluster Sharding
- Replace EventStore with Postgres/Redis
- See design.ts for event-driven extensions (tools, workflows, memory)
