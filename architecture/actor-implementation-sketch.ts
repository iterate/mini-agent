/**
 * Actor Implementation Sketch
 *
 * This file shows key implementation patterns for the ContextActor service.
 * NOT runnable code - aspirational design reference only.
 *
 * Key Pattern: Mailbox + broadcastDynamic
 * - Mailbox for actor mailbox semantics (offer, end, toStream)
 * - Stream.broadcastDynamic for fan-out to multiple subscribers
 * - Each execution of the `events` stream = new subscriber to internal PubSub
 *
 * IMPORTANT: broadcastDynamic is a LIVE stream:
 * - Late subscribers only receive events published AFTER they subscribe
 * - For historical events, use getEvents (reads from in-memory state)
 */

import {
  Context,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Mailbox,
  Option,
  Ref,
  Schedule,
  Stream
} from "effect"
import type {
  AgentTurnCompletedEvent,
  AgentTurnFailedEvent,
  AgentTurnStartedEvent,
  ContextError,
  ContextEvent,
  ContextName,
  EventId,
  SessionEndedEvent,
  SessionStartedEvent,
  UserMessageEvent
} from "./design.ts"

// =============================================================================
// Actor Config
// =============================================================================

interface ActorConfig {
  readonly debounceMs: number
  readonly retrySchedule: Schedule.Schedule<unknown, unknown>
}

const defaultActorConfig: ActorConfig = {
  debounceMs: 100,
  retrySchedule: Schedule.exponential("100 millis").pipe(
    Schedule.intersect(Schedule.recurs(3))
  )
}

// =============================================================================
// Actor Internal State
// =============================================================================

interface ActorState {
  readonly events: ReadonlyArray<ContextEvent>
  readonly isProcessing: boolean
  readonly lastUserMessageId: Option.Option<EventId>
}

// =============================================================================
// ContextActor Implementation Pattern
// =============================================================================

/**
 * Implementation sketch for ContextActor using Mailbox + broadcastDynamic.
 *
 * Key insight: Each execution of `events` (the broadcast stream) creates
 * a new subscriber to the internal PubSub. This is the fan-out mechanism.
 */
const makeContextActor = (
  contextName: ContextName,
  config: ActorConfig = defaultActorConfig
) =>
  Layer.scoped(
    // ContextActor tag - would be imported from design.ts
    Context.GenericTag<{
      readonly contextName: ContextName
      readonly addEvent: (event: ContextEvent) => Effect.Effect<void, ContextError>
      readonly events: Stream.Stream<ContextEvent, never>
      readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>
      readonly shutdown: Effect.Effect<void>
    }>("@app/ContextActor"),
    Effect.gen(function*() {
      // Internal state
      const stateRef = yield* Ref.make<ActorState>({
        events: [],
        isProcessing: false,
        lastUserMessageId: Option.none()
      })

      // Mailbox for actor input
      const mailbox = yield* Mailbox.make<ContextEvent>()

      // Helper to generate event metadata
      const makeEventMeta = () => ({
        id: crypto.randomUUID() as unknown as EventId,
        timestamp: DateTime.unsafeNow(),
        contextName,
        parentEventId: Option.none()
      })

      // Convert mailbox to broadcast stream
      // KEY: broadcastDynamic creates internal PubSub, returns Stream
      // Each execution of the stream = new subscriber (fan-out)
      const broadcast = yield* Stream.broadcastDynamic(Mailbox.toStream(mailbox), {
        capacity: "unbounded"
      })

      // Background processing fiber - subscribes to broadcast for debouncing
      const processBatch = Effect.gen(function*() {
        const state = yield* Ref.get(stateRef)
        const hasUserMessage = state.events.some((e) => e._tag === "UserMessageEvent")
        if (!hasUserMessage) return

        yield* Ref.update(stateRef, (s) => ({ ...s, isProcessing: true }))

        const startTime = Date.now()
        try {
          yield* mailbox.offer({
            _tag: "AgentTurnStartedEvent",
            ...makeEventMeta()
          } as unknown as AgentTurnStartedEvent)

          // TODO: Call reducer and agent here
          yield* Effect.logInfo("Processing events (agent turn would happen here)")

          const durationMs = Date.now() - startTime
          yield* mailbox.offer({
            _tag: "AgentTurnCompletedEvent",
            ...makeEventMeta(),
            durationMs
          } as unknown as AgentTurnCompletedEvent)
        } catch (error) {
          yield* mailbox.offer({
            _tag: "AgentTurnFailedEvent",
            ...makeEventMeta(),
            error: String(error)
          } as unknown as AgentTurnFailedEvent)
        } finally {
          yield* Ref.update(stateRef, (s) => ({ ...s, isProcessing: false }))
        }
      })

      // Start background processing fiber
      const processingFiber = yield* broadcast.pipe(
        Stream.debounce(Duration.millis(config.debounceMs)),
        Stream.mapEffect(() => processBatch),
        Stream.catchAll((error) =>
          Stream.fromEffect(
            Effect.logError("Processing error", { error }).pipe(Effect.as(undefined))
          )
        ),
        Stream.runDrain,
        Effect.fork
      )

      // Emit session started
      yield* mailbox.offer({
        _tag: "SessionStartedEvent",
        ...makeEventMeta()
      } as unknown as SessionStartedEvent)

      // Cleanup on scope close
      yield* Effect.addFinalizer((_exit) =>
        Effect.gen(function*() {
          yield* mailbox.offer({
            _tag: "SessionEndedEvent",
            ...makeEventMeta()
          } as unknown as SessionEndedEvent)
          yield* mailbox.end
          yield* Fiber.interrupt(processingFiber)
        })
      )

      // Service implementation
      return {
        contextName,

        addEvent: (event: ContextEvent) =>
          Effect.gen(function*() {
            // 1. Update in-memory state
            yield* Ref.update(stateRef, (s) => ({
              ...s,
              events: [...s.events, event],
              lastUserMessageId:
                event._tag === "UserMessageEvent"
                  ? Option.some((event as unknown as UserMessageEvent).id)
                  : s.lastUserMessageId
            }))

            // 2. Offer to mailbox - broadcasts to all subscribers
            yield* mailbox.offer(event)

            // 3. TODO: Persist to YAML (not shown)
          }),

        // KEY: `events` is the broadcast stream
        // Each execution creates a new subscriber to internal PubSub
        events: broadcast,

        getEvents: Ref.get(stateRef).pipe(Effect.map((s) => s.events)),

        shutdown: Effect.gen(function*() {
          yield* mailbox.offer({
            _tag: "SessionEndedEvent",
            ...makeEventMeta()
          } as unknown as SessionEndedEvent)
          yield* mailbox.end
          yield* Fiber.interrupt(processingFiber)
        })
      }
    })
  )

// =============================================================================
// Key Learnings
// =============================================================================

/**
 * 1. LIVE STREAM BEHAVIOR
 *
 *    broadcastDynamic doesn't replay events to late subscribers.
 *    Subscribers only receive events published AFTER they subscribe.
 *
 *    For historical events, use getEvents which returns from in-memory state.
 *
 * 2. SUBSCRIPTION TIMING
 *
 *    For tests or code that needs to ensure a subscriber is connected
 *    before events are added, either:
 *    - Subscribe synchronously (in same Effect.gen block) before adding events
 *    - Use a Deferred to signal when subscription is ready
 *
 *    Example with Deferred:
 *    ```typescript
 *    const ready = yield* Deferred.make<void>()
 *    const fiber = yield* actor.events.pipe(
 *      Stream.tap(() => Deferred.succeed(ready, void 0)),
 *      Stream.take(2),
 *      Stream.runCollect,
 *      Effect.fork
 *    )
 *    yield* Deferred.await(ready)
 *    yield* actor.addEvent(event)
 *    ```
 *
 * 3. CLEAN SHUTDOWN
 *
 *    - Emit SessionEndedEvent before ending mailbox
 *    - mailbox.end completes the broadcast stream
 *    - Interrupt processing fiber
 *    - Use Effect.addFinalizer for automatic cleanup on scope close
 *
 * 4. TESTING
 *
 *    - Tests work well for synchronous subscription scenarios
 *    - Concurrent tests (fork + add events) require careful timing
 *    - Use Deferred for coordination, not sleep/delays
 */
