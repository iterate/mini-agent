# PubSub Event Broadcasting

Using PubSub for event broadcasting to multiple subscribers.

## Concept

`PubSub` allows publishing events to multiple subscribers. Each subscriber gets all events independently.

```
                    ┌─────────────┐
                    │   PubSub    │
                    └─────────────┘
                          │
           ┌──────────────┼──────────────┐
           ▼              ▼              ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐
    │Subscriber│   │Subscriber│   │Subscriber│
    │(Display) │   │(Logging) │   │(Metrics) │
    └──────────┘   └──────────┘   └──────────┘
```

## EventBus Service

```typescript
class EventBus extends Context.Tag("@app/EventBus")<
  EventBus,
  PubSub.PubSub<ContextEvent>
>() {
  static readonly layer = Layer.scoped(
    EventBus,
    PubSub.unbounded<ContextEvent>()
  )
}
```

## Publishing Events

```typescript
const publishEvent = (event: ContextEvent) =>
  Effect.gen(function*() {
    const eventBus = yield* EventBus
    yield* eventBus.publish(event)
  })

// In session layer
llmRequest.stream(reduced).pipe(
  Stream.tap((event) => publishEvent(event)),
  // ...
)
```

## Subscribing to Events

```typescript
const subscribeToEvents = Effect.gen(function*() {
  const eventBus = yield* EventBus

  // Get subscription (queue of events)
  const queue = yield* eventBus.subscribe

  // Process events
  yield* Stream.fromQueue(queue).pipe(
    Stream.runForEach((event) => handleEvent(event))
  )
})

// Or as a stream
const eventStream = (eventBus: PubSub.PubSub<ContextEvent>) =>
  Stream.fromPubSub(eventBus)
```

## Multiple Subscribers

```typescript
const program = Effect.gen(function*() {
  const eventBus = yield* EventBus

  // Subscriber 1: Display
  yield* Effect.fork(
    Stream.fromPubSub(eventBus).pipe(
      Stream.runForEach((event) => displayEvent(event))
    )
  )

  // Subscriber 2: Logging
  yield* Effect.fork(
    Stream.fromPubSub(eventBus).pipe(
      Stream.runForEach((event) => logEvent(event))
    )
  )

  // Subscriber 3: Metrics
  yield* Effect.fork(
    Stream.fromPubSub(eventBus).pipe(
      Stream.runForEach((event) => recordMetrics(event))
    )
  )

  // Publish events (all subscribers receive them)
  yield* eventBus.publish(LLMRequestStartedEvent.make({ ... }))
})
```

## Filtered Subscriptions

Subscribers can filter events:

```typescript
// Only lifecycle events
const lifecycleEvents = Stream.fromPubSub(eventBus).pipe(
  Stream.filter((e) =>
    e._tag === "LLMRequestStartedEvent" ||
    e._tag === "LLMRequestCompletedEvent" ||
    e._tag === "LLMRequestInterruptedEvent"
  )
)

// Only content events
const contentEvents = Stream.fromPubSub(eventBus).pipe(
  Stream.filter((e) =>
    e._tag === "TextDeltaEvent" ||
    e._tag === "AssistantMessageEvent"
  )
)
```

## Replay Buffer

New subscribers can receive recent events:

```typescript
// Keep last 100 events for late subscribers
const eventBusWithReplay = PubSub.unbounded<ContextEvent>({ replay: 100 })
```

## Integration with Layers

```typescript
// Handler publishes to EventBus
class InterruptibleHandler extends Context.Tag("@app/InterruptibleHandler")<
  InterruptibleHandler,
  { /* ... */ }
>() {
  static readonly layer = Layer.scoped(
    InterruptibleHandler,
    Effect.gen(function*() {
      const session = yield* ContextSession
      const eventBus = yield* EventBus

      const submit = Effect.fn("InterruptibleHandler.submit")(
        function*(event: InputEvent) {
          // ... debounce, interrupt logic ...

          yield* session.addEvent(event).pipe(
            // Publish each event to bus
            Stream.tap((e) => eventBus.publish(e)),
            Stream.runDrain
          )
        }
      )

      // Events stream is just the PubSub
      const events = Stream.fromPubSub(eventBus)

      return InterruptibleHandler.of({ submit, events })
    })
  )
}
```

## Use Cases

### Audit Logging

```typescript
const auditLogger = Effect.gen(function*() {
  const eventBus = yield* EventBus
  const auditLog = yield* AuditLog

  yield* Stream.fromPubSub(eventBus).pipe(
    Stream.filter(isPersistedEvent),
    Stream.runForEach((event) =>
      auditLog.write({
        timestamp: new Date(),
        eventType: event._tag,
        data: Schema.encodeSync(PersistedEvent)(event),
      })
    )
  )
})
```

### Real-Time Monitoring

```typescript
const monitor = Effect.gen(function*() {
  const eventBus = yield* EventBus
  const dashboard = yield* Dashboard

  yield* Stream.fromPubSub(eventBus).pipe(
    Stream.runForEach((event) => {
      switch (event._tag) {
        case "LLMRequestStartedEvent":
          return dashboard.incrementActiveRequests()
        case "LLMRequestCompletedEvent":
          return Effect.all([
            dashboard.decrementActiveRequests(),
            dashboard.recordLatency(event.durationMs),
          ])
        case "LLMRequestInterruptedEvent":
          return dashboard.decrementActiveRequests()
        default:
          return Effect.void
      }
    })
  )
})
```

### WebSocket Broadcasting

```typescript
const websocketBroadcaster = Effect.gen(function*() {
  const eventBus = yield* EventBus
  const connections = yield* WebSocketConnections

  yield* Stream.fromPubSub(eventBus).pipe(
    Stream.runForEach((event) =>
      connections.broadcast(JSON.stringify(Schema.encodeSync(ContextEvent)(event)))
    )
  )
})
```

## Comparison: PubSub vs Stream vs Queue

| Primitive | Use Case |
|-----------|----------|
| **PubSub** | Multiple subscribers, each gets all events |
| **Queue** | Single consumer, load balancing |
| **Stream** | Pipeline transformation, pull-based |

## Effect Pattern Alignment

From Effect source (`effect/src/PubSub.ts`):

```typescript
// Create unbounded PubSub
const pubsub = yield* PubSub.unbounded<Event>()

// Publish
yield* pubsub.publish(event)

// Subscribe (returns Queue)
const queue = yield* pubsub.subscribe

// As stream
const stream = Stream.fromPubSub(pubsub)
```

## Capacity Options

```typescript
// Unbounded (no limit)
PubSub.unbounded<Event>()

// Bounded (drops oldest when full)
PubSub.bounded<Event>(100)

// Sliding (drops oldest)
PubSub.sliding<Event>(100)

// Dropping (drops new when full)
PubSub.dropping<Event>(100)
```

For this use case, `unbounded` is fine since events are small and ephemeral.
