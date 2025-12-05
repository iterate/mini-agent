/**
 * Context Actor Service
 *
 * Each Context is modeled as an Actor with:
 * - addEvent: fire-and-forget input (persists immediately, queues for processing)
 * - events: continuous output stream (tap into all events via PubSub subscription)
 *
 * Internal flow:
 * 1. addEvent -> persist to YAML -> Queue.offer
 * 2. Stream.fromQueue -> debounce -> process batch
 * 3. Process: reduce -> agent turn -> persist response -> PubSub.publish
 * 4. events stream: Stream.fromPubSub (subscribers get all events)
 *
 * Designed for single-process now, future-ready for @effect/cluster distribution.
 */
import { Context, DateTime, Duration, Effect, Fiber, Layer, Option, PubSub, Queue, Ref, Schedule, Stream } from "effect"
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
  /** Input queue capacity */
  readonly queueCapacity: number
  /** Retry schedule for LLM requests */
  readonly retrySchedule: Schedule.Schedule<unknown, unknown>
}

export const defaultActorConfig: ActorConfig = {
  debounceMs: 10,
  queueCapacity: 100,
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
 * Each actor encapsulates:
 * - Input queue (mailbox) for incoming events
 * - Output PubSub for broadcasting events to subscribers
 * - Background fiber for processing events
 * - State refs for events and reduced context
 */
export class ContextActor extends Context.Tag("@app/ContextActor")<
  ContextActor,
  {
    readonly contextName: ContextName
    readonly addEvent: (event: ContextEvent) => Effect.Effect<void, ContextLoadError | ContextSaveError>
    readonly events: Stream.Stream<ContextEvent, never>
    readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>
    readonly shutdown: Effect.Effect<void>
  }
>() {
  /**
   * Create an actor for a specific context.
   *
   * The actor lifecycle:
   * 1. Load existing events from storage
   * 2. Start background processing fiber
   * 3. Emit SessionStartedEvent
   * 4. Process incoming events with debouncing
   * 5. On shutdown: emit SessionEndedEvent, cleanup resources
   */
  static readonly make = (
    contextName: ContextName,
    config: ActorConfig = defaultActorConfig
  ) =>
    Layer.scoped(
      ContextActor,
      Effect.gen(function*() {
        // Dependencies would come from context in real implementation
        // For now, we'll use stubs and wire up in actor-registry

        // Input queue (mailbox) - bounded for backpressure
        const inputQueue = yield* Queue.bounded<ContextEvent>(config.queueCapacity)

        // Output PubSub - unbounded for event broadcasting
        const outputPubSub = yield* PubSub.unbounded<ContextEvent>()

        // State refs
        const stateRef = yield* Ref.make<ActorState>(initialActorState)
        const shutdownRef = yield* Ref.make(false)

        // Helper to generate event metadata
        const makeEventMeta = () => ({
          id: EventId.make(crypto.randomUUID()),
          timestamp: DateTime.unsafeNow(),
          contextName,
          parentEventId: Option.none()
        })

        // Helper to emit event (persist if needed, then publish)
        const emitEvent = (event: ContextEvent) =>
          Effect.gen(function*() {
            // Update state
            yield* Ref.update(stateRef, (s) => ({
              ...s,
              events: [...s.events, event]
            }))

            // Publish to subscribers
            yield* PubSub.publish(outputPubSub, event)
          })

        // Process a batch of events after debounce
        const processBatch = Effect.gen(function*() {
          const state = yield* Ref.get(stateRef)

          // Check if we have any user messages to process
          const hasUserMessage = state.events.some(isUserMessageEvent)
          if (!hasUserMessage) return

          // Mark as processing
          yield* Ref.update(stateRef, (s) => ({ ...s, isProcessing: true }))

          const startTime = Date.now()

          try {
            // Emit turn started
            yield* emitEvent(new AgentTurnStartedEvent(makeEventMeta()))

            // TODO: Call reducer and agent here
            // For now, just emit a placeholder
            // In real implementation:
            // const reduced = yield* reducer.reduce(initialContext, state.events)
            // yield* agent.takeTurn(reduced).pipe(
            //   Stream.tap(emitEvent),
            //   Stream.runDrain
            // )

            yield* Effect.logInfo("Processing events (agent turn would happen here)")

            // Emit turn completed
            const durationMs = Date.now() - startTime
            yield* emitEvent(
              new AgentTurnCompletedEvent({
                ...makeEventMeta(),
                durationMs
              })
            )
          } catch (error) {
            // Emit turn failed
            yield* emitEvent(
              new AgentTurnFailedEvent({
                ...makeEventMeta(),
                error: String(error)
              })
            )
          } finally {
            yield* Ref.update(stateRef, (s) => ({ ...s, isProcessing: false }))
          }
        })

        // Background processing fiber - runs until queue is shutdown
        const processingFiber = yield* Stream.fromQueue(inputQueue).pipe(
          // Debounce: wait for quiet period before processing
          Stream.debounce(Duration.millis(config.debounceMs)),
          // Process each batch
          Stream.mapEffect(() => processBatch),
          // Handle errors without stopping the stream
          Stream.catchAll((error) =>
            Stream.fromEffect(
              Effect.logError("Processing error", { error }).pipe(Effect.as(undefined))
            )
          ),
          // Stream ends when queue is shutdown
          Stream.runDrain,
          Effect.fork
        )

        // Emit session started
        yield* emitEvent(new SessionStartedEvent(makeEventMeta()))

        // Cleanup on scope close
        yield* Effect.addFinalizer(() =>
          Effect.gen(function*() {
            yield* Ref.set(shutdownRef, true)
            yield* Queue.shutdown(inputQueue)
            yield* emitEvent(new SessionEndedEvent(makeEventMeta()))
            yield* Fiber.interrupt(processingFiber)
            yield* PubSub.shutdown(outputPubSub)
          })
        )

        // Service implementation
        const addEvent = (event: ContextEvent) =>
          Effect.gen(function*() {
            // 1. Update in-memory state
            yield* Ref.update(stateRef, (s) => ({
              ...s,
              events: [...s.events, event],
              lastUserMessageId: isUserMessageEvent(event)
                ? Option.some(event.id)
                : s.lastUserMessageId
            }))

            // 2. Publish to output (subscribers see input events immediately)
            yield* PubSub.publish(outputPubSub, event)

            // 3. Offer to input queue (triggers processing via debounced stream)
            yield* Queue.offer(inputQueue, event)

            // Note: Persistence would happen here in real implementation
            // yield* repository.append(contextName, [event])
          })

        const events = Stream.fromPubSub(outputPubSub)

        const getEvents = Ref.get(stateRef).pipe(Effect.map((s) => s.events))

        const shutdown = Effect.gen(function*() {
          yield* Ref.set(shutdownRef, true)
          yield* Queue.shutdown(inputQueue)
        })

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

// =============================================================================
// ContextActorLive - Full implementation with dependencies
// =============================================================================

/**
 * Create a fully-wired ContextActor with all dependencies.
 *
 * This is the production factory that connects:
 * - ContextRepository for persistence
 * - Agent for LLM requests
 * - EventReducer for state reduction
 * - HooksService for extensibility
 */
export const makeContextActorLive = (
  contextName: ContextName,
  config: ActorConfig = defaultActorConfig
) =>
  Layer.scoped(
    ContextActor,
    Effect.gen(function*() {
      // TODO: Wire up real dependencies here
      // const repository = yield* ContextRepository
      // const agent = yield* Agent
      // const reducer = yield* EventReducer
      // const hooks = yield* HooksService

      // For now, delegate to the basic implementation
      // In production, this would be fully wired
      const actor = yield* Effect.scoped(
        Layer.build(ContextActor.make(contextName, config)).pipe(
          Effect.map((ctx) => Context.get(ctx, ContextActor))
        )
      )

      return actor
    })
  )
