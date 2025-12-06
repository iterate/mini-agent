/**
 * MiniAgent - The core actor implementation.
 *
 * Key patterns:
 * - Mailbox for actor input (offer, end, toStream)
 * - Stream.broadcastDynamic for fan-out to subscribers
 * - Ref for state (events + reducedContext)
 * - Debounced processing for triggersAgentTurn events
 */

import { DateTime, Duration, Effect, Either, Fiber, Mailbox, Option, Queue, Ref, type Scope, Stream } from "effect"
import {
  type AgentName,
  AgentTurnCompletedEvent,
  AgentTurnFailedEvent,
  type AgentTurnNumber,
  AgentTurnStartedEvent,
  type ContextEvent,
  type ContextName,
  type ContextSaveError,
  makeEventId,
  type MiniAgent,
  MiniAgentTurn,
  type ReducedContext,
  type ReducerError,
  SessionEndedEvent,
  SessionStartedEvent
} from "./domain.ts"
import { EventReducer } from "./event-reducer.ts"
import { EventStore } from "./event-store.ts"

export interface ActorState {
  readonly events: ReadonlyArray<ContextEvent>
  readonly reducedContext: ReducedContext
}

type MiniAgentError = ReducerError | ContextSaveError

export interface ExecuteTurnDeps {
  readonly agentName: AgentName
  readonly contextName: ContextName
  readonly stateRef: Ref.Ref<ActorState>
  readonly addEvent: (event: ContextEvent) => Effect.Effect<void, MiniAgentError>
  readonly turnService: MiniAgentTurn
}

export const makeExecuteTurn = (deps: ExecuteTurnDeps) => (turnNumber: AgentTurnNumber) =>
  Effect.gen(function*() {
    const { addEvent, agentName, contextName, stateRef, turnService } = deps
    const state = yield* Ref.get(stateRef)

    const startEvent = new AgentTurnStartedEvent({
      id: makeEventId(contextName, state.reducedContext.nextEventNumber),
      timestamp: DateTime.unsafeNow(),
      agentName,
      parentEventId: Option.none(),
      triggersAgentTurn: false,
      turnNumber
    })
    yield* addEvent(startEvent)

    const startTime = Date.now()

    const ctx = yield* Ref.get(stateRef).pipe(Effect.map((s) => s.reducedContext))

    const turnOutcome = yield* turnService.execute(ctx).pipe(
      Stream.tap(addEvent),
      Stream.runDrain,
      Effect.either
    )

    const durationMs = Date.now() - startTime
    const endState = yield* Ref.get(stateRef)

    if (Either.isLeft(turnOutcome)) {
      const error = turnOutcome.left
      yield* Effect.logWarning("Turn failed", { error })
      const failureEvent = new AgentTurnFailedEvent({
        id: makeEventId(contextName, endState.reducedContext.nextEventNumber),
        timestamp: DateTime.unsafeNow(),
        agentName,
        parentEventId: Option.some(startEvent.id),
        triggersAgentTurn: false,
        turnNumber,
        error: error instanceof Error ? error.message : String(error)
      })
      yield* addEvent(failureEvent)
    } else {
      const completeEvent = new AgentTurnCompletedEvent({
        id: makeEventId(contextName, endState.reducedContext.nextEventNumber),
        timestamp: DateTime.unsafeNow(),
        agentName,
        parentEventId: Option.some(startEvent.id),
        triggersAgentTurn: false,
        turnNumber,
        durationMs
      })
      yield* addEvent(completeEvent)
    }
  })

/**
 * Create a MiniAgent instance.
 *
 * The agent is scoped - it will be cleaned up when the scope closes.
 * Returns a MiniAgent interface for interacting with the actor.
 */
export const makeMiniAgent = (
  agentName: AgentName,
  contextName: ContextName
): Effect.Effect<
  MiniAgent,
  MiniAgentError,
  EventReducer | EventStore | MiniAgentTurn | Scope.Scope
> =>
  Effect.gen(function*() {
    const reducer = yield* EventReducer
    const store = yield* EventStore
    const turnService = yield* MiniAgentTurn

    // Load existing events from store and replay them
    const existingEvents = yield* store.load(contextName).pipe(
      Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<ContextEvent>))
    )

    // Replay events to build initial state
    const initialReducedContext = existingEvents.length > 0
      ? yield* reducer.reduce(reducer.initialReducedContext, existingEvents)
      : reducer.initialReducedContext

    const initialState: ActorState = {
      events: existingEvents,
      reducedContext: initialReducedContext
    }
    const stateRef = yield* Ref.make(initialState)

    // Mailbox for event input
    const mailbox = yield* Mailbox.make<ContextEvent>()

    // Create broadcast stream from mailbox
    const broadcast = yield* Stream.broadcastDynamic(
      Mailbox.toStream(mailbox),
      { capacity: "unbounded" }
    )

    // Track current turn fiber for interruption
    const turnFiberRef = yield* Ref.make<Option.Option<Fiber.RuntimeFiber<void, never>>>(Option.none())

    // Queue to serialize event processing and prevent race conditions
    const eventQueue = yield* Queue.unbounded<{
      event: ContextEvent
      complete: (result: Effect.Effect<void, MiniAgentError>) => void
    }>()

    // Process events sequentially from the queue
    const eventProcessorFiber = yield* Stream.fromQueue(eventQueue).pipe(
      Stream.mapEffect(({ complete, event }) =>
        Effect.gen(function*() {
          const result = yield* Effect.gen(function*() {
            // 1. Update state atomically
            const state = yield* Ref.get(stateRef)
            const newEvents = [...state.events, event]
            const newReducedContext = yield* reducer.reduce(state.reducedContext, [event])
            yield* Ref.set(stateRef, { events: newEvents, reducedContext: newReducedContext })

            // 2. Persist
            yield* store.append(contextName, [event])

            // 3. Broadcast
            yield* mailbox.offer(event)
          }).pipe(Effect.either)

          if (result._tag === "Left") {
            complete(Effect.fail(result.left))
          } else {
            complete(Effect.void)
          }
        })
      ),
      Stream.runDrain,
      Effect.forkDaemon
    )

    // Helper: Add event to state and broadcast (via queue for serialization)
    const addEventInternal = (event: ContextEvent): Effect.Effect<void, MiniAgentError> =>
      Effect.async<void, MiniAgentError>((resume) => {
        const complete = (result: Effect.Effect<void, MiniAgentError>) => {
          resume(result)
        }
        Effect.runSync(Queue.offer(eventQueue, { event, complete }))
      })

    const executeTurn = makeExecuteTurn({
      agentName,
      contextName,
      stateRef,
      addEvent: addEventInternal,
      turnService
    })

    // Process triggering events with debounce
    let turnCounter = 0
    const processingFiber = yield* broadcast.pipe(
      Stream.filter((e) => e.triggersAgentTurn),
      Stream.debounce(Duration.millis(100)),
      Stream.mapEffect(() =>
        Effect.gen(function*() {
          turnCounter++
          const turnNumber = turnCounter as AgentTurnNumber

          // Cancel any existing turn
          const existingFiber = yield* Ref.get(turnFiberRef)
          if (Option.isSome(existingFiber)) {
            yield* Fiber.interrupt(existingFiber.value)
          }

          // Start new turn
          const fiber = yield* executeTurn(turnNumber).pipe(
            Effect.catchAll((error) => Effect.logWarning("Turn execution failed", { error })),
            Effect.fork
          )
          yield* Ref.set(turnFiberRef, Option.some(fiber))
        })
      ),
      Stream.catchAll((error) =>
        Stream.fromEffect(
          Effect.logError("Processing error", { error }).pipe(Effect.as(undefined))
        )
      ),
      Stream.runDrain,
      Effect.forkDaemon
    )

    // Track if shutdown has been called to prevent duplicate cleanup
    const isShutdownRef = yield* Ref.make(false)

    // Internal shutdown logic - only runs once
    const performShutdown = Effect.gen(function*() {
      const alreadyShutdown = yield* Ref.getAndSet(isShutdownRef, true)
      if (alreadyShutdown) {
        return
      }

      // Cancel any in-flight turn
      const fiber = yield* Ref.get(turnFiberRef)
      if (Option.isSome(fiber)) {
        yield* Fiber.interrupt(fiber.value)
      }

      // Emit session ended and persist it
      const state = yield* Ref.get(stateRef)
      const sessionEndEvent = new SessionEndedEvent({
        id: makeEventId(contextName, state.reducedContext.nextEventNumber),
        timestamp: DateTime.unsafeNow(),
        agentName,
        parentEventId: Option.none(),
        triggersAgentTurn: false
      })

      // Persist the session ended event directly (not through queue since we're shutting down)
      yield* store.append(contextName, [sessionEndEvent]).pipe(
        Effect.catchAll(() => Effect.void)
      )

      // Broadcast the event
      yield* mailbox.offer(sessionEndEvent).pipe(
        Effect.catchAll(() => Effect.void)
      )

      // Shutdown the event queue
      yield* Queue.shutdown(eventQueue)

      // End mailbox
      yield* mailbox.end

      // Cancel fibers
      yield* Fiber.interrupt(eventProcessorFiber)
      yield* Fiber.interrupt(processingFiber)
    })

    // Emit session started (use current nextEventNumber to avoid collision with loaded events)
    const state = yield* Ref.get(stateRef)
    const sessionStartEvent = new SessionStartedEvent({
      id: makeEventId(contextName, state.reducedContext.nextEventNumber),
      timestamp: DateTime.unsafeNow(),
      agentName,
      parentEventId: Option.none(),
      triggersAgentTurn: false
    })
    yield* addEventInternal(sessionStartEvent)

    // Cleanup on scope close
    yield* Effect.addFinalizer(() => performShutdown)

    // Return the MiniAgent interface
    const agent: MiniAgent = {
      agentName,
      contextName,

      addEvent: (event) => addEventInternal(event),

      events: broadcast,

      getEvents: Ref.get(stateRef).pipe(Effect.map((s) => s.events)),

      getReducedContext: Ref.get(stateRef).pipe(Effect.map((s) => s.reducedContext)),

      shutdown: performShutdown
    }

    return agent
  })
