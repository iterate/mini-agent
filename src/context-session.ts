/**
 * ContextSession Service (Layer 3)
 *
 * Manages a context's lifecycle - loading events, running reducers,
 * persisting new events, and handling agent turns.
 *
 * Key Interface:
 * - addEvent: Fire-and-forget event addition (returns void)
 * - events: Separate continuous stream of all output events
 *
 * Responsibilities:
 * - Load events from storage on initialize
 * - Emit lifecycle events (SessionStarted, AgentTurnStarted, etc.)
 * - Persist events immediately as they arrive
 * - Coordinate agent turns via Agent service
 * - Handle cancellation of in-flight turns
 *
 * Does NOT know about:
 * - Multiple contexts (that's ApplicationService's job)
 * - External interface (CLI/HTTP)
 */
import { FileSystem } from "@effect/platform"
import { Context, Deferred, Effect, Fiber, Layer, PubSub, Queue, Ref, Stream } from "effect"
import { Agent } from "./agent.ts"
import {
  AgentTurnCompletedEvent,
  AgentTurnFailedEvent,
  AgentTurnStartedEvent,
  type ContextEvent,
  type ContextName,
  makeBaseFields,
  type PersistedEvent,
  type ReducedContext,
  SessionEndedEvent,
  SessionStartedEvent,
  UserMessageEvent
} from "./context.model.ts"
import { ContextRepository } from "./context.repository.ts"
import { AgentError, type ContextError, ReducerError } from "./errors.ts"
import { EventReducer } from "./event-reducer.ts"
import { HooksService } from "./hooks-service.ts"

/** Union of errors that can occur during session operations */
export type SessionError = ContextError | ReducerError | AgentError

/**
 * ContextSession service - Layer 3 of the architecture.
 * Manages a single context's lifecycle and state.
 */
export class ContextSession extends Context.Tag("@app/ContextSession")<
  ContextSession,
  {
    /** Initialize session for a context (loads events, emits SessionStarted) */
    readonly initialize: (contextName: ContextName) => Effect.Effect<void, SessionError>

    /** Add an event to the session (fire-and-forget, triggers agent turn if needed) */
    readonly addEvent: (event: ContextEvent) => Effect.Effect<void, SessionError>

    /** Stream of all output events (separate from addEvent) */
    readonly events: Stream.Stream<ContextEvent, SessionError>

    /** Get all events in the current session */
    readonly getEvents: () => Effect.Effect<ReadonlyArray<ContextEvent>>

    /** Get the current context name */
    readonly getContextName: () => Effect.Effect<ContextName | undefined>

    /** Close the session (emits SessionEnded) */
    readonly close: () => Effect.Effect<void>
  }
>() {
  /**
   * Production layer - scoped to ensure cleanup on scope close.
   */
  static readonly layer: Layer.Layer<
    ContextSession,
    never,
    Agent | EventReducer | ContextRepository | HooksService | FileSystem.FileSystem
  > = Layer.scoped(
    ContextSession,
    Effect.gen(function*() {
      const agent = yield* Agent
      const reducer = yield* EventReducer
      const repository = yield* ContextRepository
      const hooks = yield* HooksService

      // Internal state
      const contextNameRef = yield* Ref.make<ContextName | undefined>(undefined)
      const eventsRef = yield* Ref.make<Array<ContextEvent>>([])
      const reducedContextRef = yield* Ref.make<ReducedContext>(reducer.initialReducedContext)
      const currentTurnFiberRef = yield* Ref.make<Fiber.Fiber<void, SessionError> | undefined>(
        undefined
      )

      // PubSub for broadcasting events to subscribers
      const eventPubSub = yield* PubSub.unbounded<ContextEvent>()

      // Queue for incoming events to process
      const inputQueue = yield* Queue.unbounded<ContextEvent>()

      // Shutdown signal
      const shutdownDeferred = yield* Deferred.make<void, never>()

      /** Persist an event if it's a persisted event type */
      const persistEvent = (event: ContextEvent, contextName: ContextName) =>
        Effect.gen(function*() {
          // Only persist non-ephemeral events
          if (event._tag !== "TextDelta") {
            const currentEvents = yield* Ref.get(eventsRef)
            const newEvents = [...currentEvents, event] as Array<PersistedEvent>
            yield* repository.save(contextName as string, newEvents)
          }
        })

      /** Emit an event (persist + publish + hook) */
      const emitEvent = (event: ContextEvent, contextName: ContextName) =>
        Effect.gen(function*() {
          yield* Ref.update(eventsRef, (events) => [...events, event])
          yield* persistEvent(event, contextName)
          yield* PubSub.publish(eventPubSub, event)
          yield* hooks.onEvent(event)
        })

      /** Run an agent turn */
      const runAgentTurn = (contextName: ContextName) =>
        Effect.gen(function*() {
          const startTime = Date.now()

          // Emit turn started
          yield* emitEvent(
            new AgentTurnStartedEvent({ ...makeBaseFields(contextName) }),
            contextName
          )

          // Get current reduced context and apply hooks
          const reducedContext = yield* Ref.get(reducedContextRef)
          const hookedContext = yield* hooks.beforeTurn(reducedContext)

          // Run the agent turn
          yield* agent.takeTurn(hookedContext, contextName).pipe(
            Stream.tap((event) =>
              Effect.gen(function*() {
                // Apply afterTurn hook for non-delta events
                if (event._tag !== "TextDelta") {
                  const hookedEvents = yield* hooks.afterTurn(event)
                  for (const e of hookedEvents) {
                    yield* emitEvent(e, contextName)
                    // Update reduced context with the event
                    const current = yield* Ref.get(reducedContextRef)
                    const updated = yield* reducer.reduce(current, [e])
                    yield* Ref.set(reducedContextRef, updated)
                  }
                } else {
                  // Emit deltas directly (ephemeral)
                  yield* PubSub.publish(eventPubSub, event)
                  yield* hooks.onEvent(event)
                }
              })
            ),
            Stream.runDrain
          )

          // Emit turn completed
          const durationMs = Date.now() - startTime
          yield* emitEvent(
            new AgentTurnCompletedEvent({
              ...makeBaseFields(contextName),
              durationMs
            }),
            contextName
          )
        }).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function*() {
              const contextName = yield* Ref.get(contextNameRef)
              if (contextName) {
                yield* emitEvent(
                  new AgentTurnFailedEvent({
                    ...makeBaseFields(contextName),
                    error: error instanceof Error ? error.message : String(error)
                  }),
                  contextName
                )
              }
            })
          )
        )

      /** Process events from the input queue */
      const processInputQueue = Effect.gen(function*() {
        const contextName = yield* Ref.get(contextNameRef)
        if (!contextName) return

        while (true) {
          const event = yield* Queue.take(inputQueue)

          // If it's a user message, cancel any in-flight turn
          if (event._tag === "UserMessage") {
            const currentFiber = yield* Ref.get(currentTurnFiberRef)
            if (currentFiber) {
              yield* Fiber.interrupt(currentFiber)
              yield* Ref.set(currentTurnFiberRef, undefined)
            }
          }

          // Emit the event
          yield* emitEvent(event, contextName)

          // Update reduced context
          const current = yield* Ref.get(reducedContextRef)
          const updated = yield* reducer.reduce(current, [event])
          yield* Ref.set(reducedContextRef, updated)

          // If it's a user message, start a new agent turn
          if (event._tag === "UserMessage") {
            const fiber = yield* Effect.fork(runAgentTurn(contextName))
            yield* Ref.set(currentTurnFiberRef, fiber)
          }
        }
      }).pipe(
        Effect.interruptible,
        Effect.catchAll(() => Effect.void)
      )

      // Start the input queue processor
      const processorFiber = yield* Effect.fork(processInputQueue)

      // Cleanup on scope close
      yield* Effect.addFinalizer(() =>
        Effect.gen(function*() {
          yield* Fiber.interrupt(processorFiber)
          const currentFiber = yield* Ref.get(currentTurnFiberRef)
          if (currentFiber) {
            yield* Fiber.interrupt(currentFiber)
          }
          yield* Deferred.succeed(shutdownDeferred, undefined)
        })
      )

      return ContextSession.of({
        initialize: (contextName) =>
          Effect.gen(function*() {
            yield* Ref.set(contextNameRef, contextName)

            // Load existing events
            const existingEvents = yield* repository.loadOrCreate(contextName as string)

            // Store events
            yield* Ref.set(eventsRef, existingEvents as Array<ContextEvent>)

            // Reduce to get current state
            const reduced = yield* reducer.reduce(reducer.initialReducedContext, existingEvents)
            yield* Ref.set(reducedContextRef, reduced)

            // Emit session started
            yield* emitEvent(
              new SessionStartedEvent({ ...makeBaseFields(contextName) }),
              contextName
            )
          }),

        addEvent: (event) =>
          Effect.gen(function*() {
            yield* Queue.offer(inputQueue, event)
          }),

        events: Stream.fromPubSub(eventPubSub).pipe(
          Stream.interruptWhen(Deferred.await(shutdownDeferred))
        ),

        getEvents: () => Ref.get(eventsRef),

        getContextName: () => Ref.get(contextNameRef),

        close: () =>
          Effect.gen(function*() {
            const contextName = yield* Ref.get(contextNameRef)
            if (contextName) {
              yield* emitEvent(
                new SessionEndedEvent({ ...makeBaseFields(contextName) }),
                contextName
              )
            }
            yield* Deferred.succeed(shutdownDeferred, undefined)
          })
      })
    })
  )

  /** Test layer with in-memory storage */
  static readonly testLayer: Layer.Layer<ContextSession> = Layer.sync(ContextSession, () => {
    const events: Array<ContextEvent> = []
    let contextName: ContextName | undefined

    return ContextSession.of({
      initialize: (name) =>
        Effect.sync(() => {
          contextName = name
        }),
      addEvent: (event) =>
        Effect.sync(() => {
          events.push(event)
        }),
      events: Stream.empty,
      getEvents: () => Effect.succeed(events),
      getContextName: () => Effect.succeed(contextName),
      close: () => Effect.void
    })
  })
}
