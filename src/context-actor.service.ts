/**
 * Context Actor Service
 *
 * Each Context is modeled as an Actor with:
 * - addEvent: fire-and-forget input via Mailbox
 * - events: broadcast stream (each execution = new subscriber)
 *
 * Uses Mailbox + Stream.broadcastDynamic for clean fan-out to multiple subscribers.
 *
 * Designed for single-process now, future-ready for @effect/cluster distribution.
 */
import { Context, DateTime, Duration, Effect, Fiber, Layer, Mailbox, Option, Ref, Schedule, Stream } from "effect"
import {
  AgentTurnCompletedEvent,
  AgentTurnFailedEvent,
  AgentTurnStartedEvent,
  type ContextEvent,
  type ContextName,
  EventId,
  isUserMessageEvent,
  SessionEndedEvent,
  SessionStartedEvent
} from "./actor.model.ts"
import type { ContextLoadError, ContextSaveError } from "./errors.ts"

// =============================================================================
// Actor Configuration
// =============================================================================

export interface ActorConfig {
  /** Debounce delay before processing events (ms) */
  readonly debounceMs: number
  /** Mailbox capacity */
  readonly capacity: number
  /** Retry schedule for LLM requests */
  readonly retrySchedule: Schedule.Schedule<unknown, unknown>
}

export const defaultActorConfig: ActorConfig = {
  debounceMs: 10,
  capacity: 100,
  retrySchedule: Schedule.exponential(Duration.millis(100)).pipe(
    Schedule.jittered,
    Schedule.intersect(Schedule.recurs(3))
  )
}

// =============================================================================
// Actor State
// =============================================================================

interface ActorState {
  readonly events: ReadonlyArray<ContextEvent>
  readonly isProcessing: boolean
  readonly lastUserMessageId: Option.Option<EventId>
}

const initialActorState: ActorState = {
  events: [],
  isProcessing: false,
  lastUserMessageId: Option.none()
}

// =============================================================================
// ContextActor Service
// =============================================================================

/**
 * ContextActor represents a single context as an actor.
 *
 * Uses:
 * - Mailbox for input (actor mailbox pattern)
 * - Stream.broadcastDynamic for fan-out to multiple subscribers
 *
 * Each execution of `events` stream creates a new subscriber.
 */
export class ContextActor extends Context.Tag("@app/ContextActor")<
  ContextActor,
  {
    readonly contextName: ContextName
    readonly addEvent: (event: ContextEvent) => Effect.Effect<void, ContextLoadError | ContextSaveError>
    /**
     * Event stream - each execution creates a new subscriber.
     * All subscribers receive the same events (fan-out via internal PubSub).
     */
    readonly events: Stream.Stream<ContextEvent, never>
    readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>
    readonly shutdown: Effect.Effect<void>
  }
>() {
  /**
   * Create an actor for a specific context.
   *
   * The actor lifecycle:
   * 1. Create mailbox for input events
   * 2. Set up broadcastDynamic for fan-out
   * 3. Start background processing fiber
   * 4. Emit SessionStartedEvent
   * 5. On shutdown: emit SessionEndedEvent, cleanup resources
   */
  static readonly make = (
    contextName: ContextName,
    config: ActorConfig = defaultActorConfig
  ) =>
    Layer.scoped(
      ContextActor,
      Effect.gen(function*() {
        // Input mailbox - events go in here
        const mailbox = yield* Mailbox.make<ContextEvent>({ capacity: config.capacity })

        // State refs
        const stateRef = yield* Ref.make<ActorState>(initialActorState)

        // Helper to generate event metadata
        const makeEventMeta = () => ({
          id: EventId.make(crypto.randomUUID()),
          timestamp: DateTime.unsafeNow(),
          contextName,
          parentEventId: Option.none()
        })

        // Convert mailbox to stream, then broadcast to multiple subscribers
        // broadcastDynamic creates internal PubSub, returns a Stream
        // Each execution of the returned Stream = new subscriber
        const broadcast = yield* Stream.broadcastDynamic(Mailbox.toStream(mailbox), {
          capacity: "unbounded"
        })

        // Process events when user message detected
        const processBatch = Effect.gen(function*() {
          const state = yield* Ref.get(stateRef)

          const hasUserMessage = state.events.some(isUserMessageEvent)
          if (!hasUserMessage) return

          yield* Ref.update(stateRef, (s) => ({ ...s, isProcessing: true }))

          const startTime = Date.now()

          try {
            yield* mailbox.offer(new AgentTurnStartedEvent(makeEventMeta()))

            // TODO: Call reducer and agent here
            yield* Effect.logInfo("Processing events (agent turn would happen here)")

            const durationMs = Date.now() - startTime
            yield* mailbox.offer(
              new AgentTurnCompletedEvent({ ...makeEventMeta(), durationMs })
            )
          } catch (error) {
            yield* mailbox.offer(
              new AgentTurnFailedEvent({ ...makeEventMeta(), error: String(error) })
            )
          } finally {
            yield* Ref.update(stateRef, (s) => ({ ...s, isProcessing: false }))
          }
        })

        // Background processing fiber - subscribes to broadcast for debouncing
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
        yield* mailbox.offer(new SessionStartedEvent(makeEventMeta()))

        // Cleanup on scope close
        yield* Effect.addFinalizer((_exit) =>
          Effect.gen(function*() {
            yield* mailbox.offer(new SessionEndedEvent(makeEventMeta()))
            yield* mailbox.end
            yield* Fiber.interrupt(processingFiber)
          })
        )

        // Service implementation
        const addEvent = (event: ContextEvent) =>
          Effect.gen(function*() {
            // Update in-memory state
            yield* Ref.update(stateRef, (s) => ({
              ...s,
              events: [...s.events, event],
              lastUserMessageId: isUserMessageEvent(event)
                ? Option.some(event.id)
                : s.lastUserMessageId
            }))

            // Offer to mailbox - broadcasts to all subscribers
            yield* mailbox.offer(event)
          })

        // Each execution of this stream creates a new subscriber
        const events = broadcast

        const getEvents = Ref.get(stateRef).pipe(Effect.map((s) => s.events))

        const shutdown = mailbox.end.pipe(Effect.asVoid)

        return ContextActor.of({
          contextName,
          addEvent,
          events,
          getEvents,
          shutdown
        })
      })
    )

  /**
   * Test layer with mock implementation.
   */
  static readonly testLayer = Layer.sync(ContextActor, () => {
    const events: Array<ContextEvent> = []
    const contextName = "test" as ContextName

    return ContextActor.of({
      contextName,
      addEvent: (event) =>
        Effect.sync(() => {
          events.push(event)
        }),
      events: Stream.empty,
      getEvents: Effect.succeed(events),
      shutdown: Effect.void
    })
  })
}
