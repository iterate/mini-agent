# Architecture

Actor-based event architecture where each context is a ContextActor.

## Reference Files

- **[design.ts](./design.ts)** - Complete service interfaces
- **[actor-implementation-sketch.ts](./actor-implementation-sketch.ts)** - Implementation patterns

---

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                       ContextActor                               │
│                                                                  │
│  INPUT PATH:                                                     │
│  addEvent(event) ──▶ persist to YAML ──▶ Mailbox.offer          │
│                                              │                   │
│  BROADCAST:                                  ▼                   │
│  actor.events ◀── Stream.broadcastDynamic ◀─┘                   │
│       │                                                          │
│  PROCESSING (triggered by UserMessageEvent):                     │
│       └──▶ debounce ──▶ reduce ──▶ Agent.takeTurn               │
│                                        │                         │
│                                        ▼                         │
│                              Stream<TextDeltaEvent>              │
│                                        │                         │
│                                        ▼                         │
│                              AssistantMessageEvent               │
│                                        │                         │
│                                        ▼                         │
│                              persist ──▶ Mailbox.offer           │
│                                              │                   │
│                                              ▼                   │
│                              (broadcasts to all subscribers)     │
└─────────────────────────────────────────────────────────────────┘
```

Key insight: `Mailbox.offer` broadcasts to ALL current subscribers via `Stream.broadcastDynamic`. Late subscribers miss events (live stream).

---

## Service Components

### Core Services

These are stateless domain services:

**Agent** - LLM execution with retry and fallback
```typescript
class Agent extends Context.Tag("@app/Agent")<Agent, {
  readonly takeTurn: (ctx: ReducedContext) => Stream.Stream<ContextEvent, AgentError>
}>() {}
```

**EventReducer** - Folds events into ReducedContext
```typescript
class EventReducer extends Context.Tag("@app/EventReducer")<EventReducer, {
  readonly reduce: (current: ReducedContext, newEvents: ReadonlyArray<ContextEvent>) => Effect.Effect<ReducedContext, ReducerError>
  readonly initialReducedContext: ReducedContext
}>() {}
```

**ContextRepository** - Event persistence
```typescript
class ContextRepository extends Context.Tag("@app/ContextRepository")<ContextRepository, {
  readonly load: (name: ContextName) => Effect.Effect<ReadonlyArray<ContextEvent>, ContextError>
  readonly append: (name: ContextName, events: ReadonlyArray<ContextEvent>) => Effect.Effect<void, ContextError>
  readonly exists: (name: ContextName) => Effect.Effect<boolean>
}>() {}
```

**HooksService** - Lifecycle callbacks
```typescript
class HooksService extends Context.Tag("@app/HooksService")<HooksService, {
  readonly beforeTurn: BeforeTurnHook
  readonly afterTurn: AfterTurnHook
  readonly onEvent: OnEventHook
}>() {}
```

**AppConfig** - Global configuration
```typescript
class AppConfig extends Context.Tag("@app/AppConfig")<AppConfig, {
  readonly debounceMs: number
  readonly retrySchedule: Schedule.Schedule<unknown, unknown>
}>() {}
```

### Actor Service

**ContextActor** - Per-context orchestrator

The actor manages a single context's lifecycle. It uses all core services internally.

```typescript
class ContextActor extends Context.Tag("@app/ContextActor")<ContextActor, {
  readonly contextName: ContextName
  readonly addEvent: (event: ContextEvent) => Effect.Effect<void, ContextError>
  readonly events: Stream.Stream<ContextEvent, never>  // Live broadcast
  readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>  // Historical
  readonly shutdown: Effect.Effect<void>
}>() {}
```

Implementation pattern (Mailbox + broadcastDynamic):
```typescript
const mailbox = yield* Mailbox.make<ContextEvent>()
const broadcast = yield* Stream.broadcastDynamic(Mailbox.toStream(mailbox), {
  capacity: "unbounded"
})
// actor.events = broadcast
// Each execution of broadcast creates a new subscriber
```

### Application Facade

**ActorRegistry** - Manages multiple actors
```typescript
class ActorRegistry extends Context.Tag("@app/ActorRegistry")<ActorRegistry, {
  readonly getOrCreate: (contextName: ContextName) => Effect.Effect<ContextActor, ContextError>
  readonly get: (contextName: ContextName) => Effect.Effect<ContextActor, ContextNotFoundError>
  readonly list: Effect.Effect<ReadonlyArray<ContextName>>
  readonly shutdownAll: Effect.Effect<void>
}>() {}
```

**ActorApplicationService** - Thin facade for external consumers
```typescript
class ActorApplicationService extends Context.Tag("@app/ActorApplicationService")<ActorApplicationService, {
  readonly addEvent: (contextName: ContextName, event: ContextEvent) => Effect.Effect<void, ContextError>
  readonly getEventStream: (contextName: ContextName) => Effect.Effect<Stream.Stream<ContextEvent, never>, ContextError>
  readonly getEvents: (contextName: ContextName) => Effect.Effect<ReadonlyArray<ContextEvent>, ContextError>
  readonly list: Effect.Effect<ReadonlyArray<ContextName>>
  readonly shutdown: Effect.Effect<void>
}>() {}
```

---

## Data Flow

### addEvent Flow

1. Persist event to YAML (immediate durability)
2. Update in-memory state (Ref)
3. `Mailbox.offer(event)` → broadcasts to all current subscribers
4. If UserMessageEvent: starts debounce timer for processing

### Agent Turn Flow

1. Debounce timer fires (no new events for N ms)
2. Emit `AgentTurnStartedEvent` → broadcast
3. Reduce all events to `ReducedContext`
4. Call `Agent.takeTurn(reducedContext)`
5. Stream `TextDeltaEvent` → broadcast (each chunk)
6. On completion: emit `AssistantMessageEvent` → persist → broadcast
7. Emit `AgentTurnCompletedEvent` → broadcast

### Request Interruption Flow

1. New `UserMessageEvent` arrives during agent turn
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
Layer.scoped(ContextActor, Effect.gen(function*() {
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
const ActorAppLayer = ActorApplicationService.layer.pipe(
  Layer.provide(ActorRegistry.layer),
  Layer.provide(ContextActor.layer),  // Factory for actors
  Layer.provide(EventReducer.layer),
  Layer.provide(Agent.layer),
  Layer.provide(ContextRepository.layer),
  Layer.provide(HooksService.layer),
  Layer.provide(AppConfig.layer)
)
```

---

## Future: @effect/cluster Distribution

When ready to distribute across nodes:

1. Replace `ContextActor` with `Entity`
2. Replace `ActorRegistry` with `Sharding`
3. Add persistent storage (Postgres/Redis)
4. Configure cluster discovery

See design.ts lines 830-860 for migration notes.
