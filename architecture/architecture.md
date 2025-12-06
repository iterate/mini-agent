# Architecture

## Overview

Actor-based event architecture where each context is a ContextActor with:
- **Input**: Fire-and-forget `addEvent` via Mailbox
- **Output**: Live event stream via `Stream.broadcastDynamic`
- **Processing**: Background fiber with debouncing

```
┌─────────────────────────────────────────────────────────────────┐
│                       ContextActor                               │
│                                                                  │
│  addEvent(event) ──▶ [persist to YAML] ──▶ [Mailbox.offer]      │
│                                                 │                │
│                         ┌───────────────────────┘                │
│                         ▼                                        │
│            Mailbox.toStream(mailbox)                             │
│                         │                                        │
│                         ▼                                        │
│            Stream.broadcastDynamic ──▶ [internal PubSub]        │
│                         │                      │                 │
│                         ▼                      ▼                 │
│            Stream.debounce          actor.events (subscribers)   │
│                         │                                        │
│                         ▼                                        │
│           ┌───────────────────────────────┐                     │
│           │  Process: Reduce → Agent Turn │                     │
│           └───────────────────────────────┘                     │
│                         │                                        │
│                         ▼                                        │
│            [persist to YAML] ──▶ [Mailbox.offer]                │
└─────────────────────────────────────────────────────────────────┘
```

## Reference Files

- **[design.ts](./design.ts)** - Complete service interfaces (no implementations)
- **[actor-implementation-sketch.ts](./actor-implementation-sketch.ts)** - Key implementation patterns

---

## Service Layers

### Layer 1: Agent

Innermost layer. Takes agent turns with retry and fallback.

```typescript
class Agent extends Context.Tag("@app/Agent")<
  Agent,
  {
    readonly takeTurn: (ctx: ReducedContext) => Stream.Stream<ContextEvent, AgentError>
  }
>() {}
```

**Responsibilities**:
- Execute LLM request with retry (exponential backoff via Schedule)
- Fallback to alternate provider on failure
- Stream TextDeltaEvent during generation
- Emit AssistantMessageEvent on completion

**Dependencies**: LanguageModel (from @effect/ai)

### Layer 2: EventReducer

Stateless service that folds events into ReducedContext.

```typescript
class EventReducer extends Context.Tag("@app/EventReducer")<
  EventReducer,
  {
    readonly reduce: (
      current: ReducedContext,
      newEvents: ReadonlyArray<ContextEvent>
    ) => Effect.Effect<ReducedContext, ReducerError>

    readonly initialReducedContext: ReducedContext
  }
>() {}
```

**Responsibilities**:
- Apply events to build messages array (using @effect/ai Prompt.Message)
- Extract config from SetLlmProviderConfig/SetTimeout events
- Validate final state

### Layer 3: ContextActor

Per-context actor with scoped lifecycle.

```typescript
class ContextActor extends Context.Tag("@app/ContextActor")<
  ContextActor,
  {
    readonly contextName: ContextName
    readonly addEvent: (event: ContextEvent) => Effect.Effect<void, ContextError>
    readonly events: Stream.Stream<ContextEvent, never>  // Live stream
    readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>  // Historical
    readonly shutdown: Effect.Effect<void>
  }
>() {}
```

**Key Pattern**: Mailbox + broadcastDynamic

```typescript
const mailbox = yield* Mailbox.make<ContextEvent>()
const broadcast = yield* Stream.broadcastDynamic(Mailbox.toStream(mailbox), {
  capacity: "unbounded"
})
```

- Each execution of `events` creates a new subscriber
- Late subscribers only receive events published AFTER they subscribe
- For historical events, use `getEvents`

### Layer 4: ActorRegistry

Manages multiple ContextActor instances.

```typescript
class ActorRegistry extends Context.Tag("@app/ActorRegistry")<
  ActorRegistry,
  {
    readonly getOrCreate: (contextName: ContextName) => Effect.Effect<ContextActor, ContextError>
    readonly get: (contextName: ContextName) => Effect.Effect<ContextActor, ContextNotFoundError>
    readonly list: Effect.Effect<ReadonlyArray<ContextName>>
    readonly shutdownActor: (contextName: ContextName) => Effect.Effect<void, ContextNotFoundError>
    readonly shutdownAll: Effect.Effect<void>
  }
>() {}
```

**Responsibilities**:
- Lazy actor creation (create on first access)
- Actor caching by context name
- Graceful shutdown of all actors

### Layer 5: ActorApplicationService

Thin facade over ActorRegistry.

```typescript
class ActorApplicationService extends Context.Tag("@app/ActorApplicationService")<
  ActorApplicationService,
  {
    readonly addEvent: (contextName: ContextName, event: ContextEvent) => Effect.Effect<void, ContextError>
    readonly getEventStream: (contextName: ContextName) => Effect.Effect<Stream.Stream<ContextEvent, never>, ContextError>
    readonly getEvents: (contextName: ContextName) => Effect.Effect<ReadonlyArray<ContextEvent>, ContextError>
    readonly list: Effect.Effect<ReadonlyArray<ContextName>>
    readonly shutdown: Effect.Effect<void>
  }
>() {}
```

---

## Key Effect Patterns

### Mailbox (Actor Input)

```typescript
const mailbox = yield* Mailbox.make<ContextEvent>()

// Add events (fire-and-forget)
yield* mailbox.offer(event)

// Close mailbox (ends stream)
yield* mailbox.end

// Convert to stream
const stream = Mailbox.toStream(mailbox)
```

Backpressure strategies: `suspend` (default), `dropping`, `sliding`

### Stream.broadcastDynamic (Fan-out)

```typescript
const broadcast = yield* Stream.broadcastDynamic(sourceStream, {
  capacity: "unbounded"
})

// Each execution creates new subscriber
yield* broadcast.pipe(Stream.runForEach(handleEvent))
```

**Critical**: This is a LIVE stream. Late subscribers miss events published before they subscribed.

### Fiber Interruption (Request Cancellation)

```typescript
// Interrupt and wait for cleanup
yield* Fiber.interrupt(runningFiber)

// Cleanup handler
Effect.onInterrupt(() =>
  Effect.gen(function*() {
    yield* emit(AgentTurnInterruptedEvent.make({ reason: "new input" }))
    yield* cancelHttpRequest()
  })
)
```

### Scoped Resources

```typescript
static readonly make = (contextName: ContextName) =>
  Layer.scoped(
    ContextActor,
    Effect.gen(function*() {
      // Setup
      const mailbox = yield* Mailbox.make<ContextEvent>()

      // Cleanup on scope close
      yield* Effect.addFinalizer((_exit) =>
        Effect.gen(function*() {
          yield* mailbox.offer(SessionEndedEvent.make({ ... }))
          yield* mailbox.end
        })
      )

      return { /* service */ }
    })
  )
```

---

## Data Flow

### addEvent Flow

1. Persist event to YAML immediately
2. Update in-memory state (Ref)
3. Offer to mailbox → broadcasts to all subscribers
4. If UserMessageEvent: debounce timer starts

### Agent Turn Flow

1. Debounce timer fires
2. Emit AgentTurnStartedEvent
3. Reduce all events to ReducedContext
4. Call Agent.takeTurn(reducedContext)
5. Stream TextDeltaEvent to subscribers
6. On completion: emit AssistantMessageEvent
7. Persist response events
8. Emit AgentTurnCompletedEvent

### Interruption Flow

1. New UserMessageEvent arrives during turn
2. Interrupt running fiber: `Fiber.interrupt(turnFiber)`
3. Fiber cleanup runs: emit AgentTurnInterruptedEvent
4. New event processed, debounce timer starts
5. New turn begins

---

## Layer Composition

```typescript
const ActorAppLayer = ActorApplicationService.layer.pipe(
  Layer.provide(ActorRegistry.layer),
  Layer.provide(EventReducer.layer),
  Layer.provide(Agent.layer),
  Layer.provide(ContextRepository.layer),
  Layer.provide(HooksService.layer),
  Layer.provide(AppConfig.layer)
)
```

---

## Future: @effect/cluster Distribution

When ready to distribute:

1. Replace `ContextActor` with `Entity`:
   ```typescript
   const ContextEntity = Entity.define({
     id: ContextName,
     initialState: () => ({ events: [] }),
     onMessage: (state, msg) => { ... }
   })
   ```

2. Replace `ActorRegistry` with `Sharding`:
   ```typescript
   const sharding = yield* Sharding
   const proxy = yield* sharding.entity(ContextEntity)
   yield* proxy.send(contextName, AddEventMessage.make({ event }))
   ```

3. Add persistent storage (Postgres/Redis) for event logs
4. Configure cluster nodes and discovery
