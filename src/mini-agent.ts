/**
 * MiniAgent - The core actor implementation.
 *
 * Key patterns:
 * - Mailbox for actor input (offer, end, toStream)
 * - Stream.broadcastDynamic for fan-out to subscribers
 * - Ref for state (events + reducedContext)
 * - Debounced processing for triggersAgentTurn events
 */

import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Either,
  Fiber,
  Mailbox,
  Option,
  Queue,
  Ref,
  type Scope,
  Stream
} from "effect"
import { AppConfig } from "./config.ts"
import {
  type AgentName,
  AgentTurnCompletedEvent,
  AgentTurnFailedEvent,
  AgentTurnInterruptedEvent,
  type AgentTurnNumber,
  AgentTurnStartedEvent,
  type ContextEvent,
  type ContextLoadError,
  type ContextName,
  type ContextSaveError,
  type EventId,
  makeEventId,
  type MiniAgent,
  MiniAgentTurn,
  ReducedContext,
  type ReducerError,
  SessionEndedEvent,
  SessionStartedEvent,
  SetLlmConfigEvent,
  SystemPromptEvent,
  withParentEventId
} from "./domain.ts"
import { EventReducer } from "./event-reducer.ts"
import { EventStore } from "./event-store.ts"
import { CurrentLlmConfig } from "./llm-config.ts"

export interface ActorState {
  readonly events: ReadonlyArray<ContextEvent>
  readonly reducedContext: ReducedContext
  /** ID of the last event added - used to form blockchain-style chain */
  readonly lastEventId: Option.Option<EventId>
}

/** Errors that can occur during agent runtime (addEvent, turns, etc.) */
type MiniAgentRuntimeError = ReducerError | ContextSaveError

/** Errors that can occur during agent creation (includes loading from store) */
type MiniAgentCreationError = ReducerError | ContextLoadError | ContextSaveError

export interface ExecuteTurnDeps {
  readonly agentName: AgentName
  readonly contextName: ContextName
  readonly stateRef: Ref.Ref<ActorState>
  readonly addEvent: (event: ContextEvent) => Effect.Effect<void, MiniAgentRuntimeError>
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
      Stream.map((event) => withParentEventId(event, Option.some(startEvent.id))),
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
  MiniAgentCreationError,
  EventReducer | EventStore | MiniAgentTurn | Scope.Scope
> =>
  Effect.gen(function*() {
    const reducer = yield* EventReducer
    const store = yield* EventStore
    const turnService = yield* MiniAgentTurn

    // Load existing events from store and replay them
    const existingEvents = yield* store.load(contextName)

    // Replay events to build initial state
    const initialReducedContext = existingEvents.length > 0
      ? yield* reducer.reduce(reducer.initialReducedContext, existingEvents)
      : reducer.initialReducedContext

    // For blockchain chain: lastEventId is the ID of the last existing event (if any)
    const lastEventId = existingEvents.length > 0
      ? Option.some(existingEvents[existingEvents.length - 1]!.id)
      : Option.none()

    const initialState: ActorState = {
      events: existingEvents,
      reducedContext: initialReducedContext,
      lastEventId
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
      complete: (result: Effect.Effect<void, MiniAgentRuntimeError>) => void
    }>()

    // Process events sequentially from the queue
    const eventProcessorFiber = yield* Stream.fromQueue(eventQueue).pipe(
      Stream.mapEffect(({ complete, event }) =>
        Effect.gen(function*() {
          const result = yield* Effect.gen(function*() {
            // 1. Get current state and set parentEventId to form blockchain chain
            const state = yield* Ref.get(stateRef)
            const chainedEvent = withParentEventId(event, state.lastEventId)

            // 2. Update state atomically (including lastEventId for chain)
            const newEvents = [...state.events, chainedEvent]
            const newReducedContext = yield* reducer.reduce(state.reducedContext, [chainedEvent])
            yield* Ref.set(stateRef, {
              events: newEvents,
              reducedContext: newReducedContext,
              lastEventId: Option.some(chainedEvent.id)
            })

            // 3. Persist (exclude TextDeltaEvent - ephemeral streaming data)
            if (chainedEvent._tag !== "TextDeltaEvent") {
              yield* store.append(contextName, [chainedEvent])
            }

            // 4. Broadcast the chained event
            yield* mailbox.offer(chainedEvent)
          }).pipe(Effect.either)

          if (result._tag === "Left") {
            complete(Effect.fail(result.left))
          } else {
            complete(Effect.void)
          }
        })
      ),
      Stream.runDrain,
      Effect.fork
    )

    // Helper: Add event to state and broadcast (via queue for serialization)
    const addEventInternal = (event: ContextEvent): Effect.Effect<void, MiniAgentRuntimeError> =>
      Effect.async<void, MiniAgentRuntimeError>((resume) => {
        const complete = (result: Effect.Effect<void, MiniAgentRuntimeError>) => {
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

    // Signal for when processingFiber has subscribed to broadcast
    // This prevents a race condition where events could be missed if broadcast
    // happens before the subscription is established
    const processingReady = yield* Deferred.make<void>()

    // Process triggering events with debounce
    let turnCounter = 0
    const processingFiber = yield* Stream.make(void 0).pipe(
      Stream.tap(() => Deferred.succeed(processingReady, void 0)),
      Stream.flatMap(() => broadcast),
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
      Effect.fork
    )

    // Wait for processingFiber to subscribe before continuing
    yield* Deferred.await(processingReady)

    // Track if session has ended to prevent duplicate events
    const isSessionEndedRef = yield* Ref.make(false)

    // Check if agent is currently processing a turn
    const isIdleEffect = Ref.get(stateRef).pipe(
      Effect.map((s) => !ReducedContext.isAgentTurnInProgress(s.reducedContext))
    )

    // End session gracefully: emit AgentTurnInterruptedEvent if mid-turn, then SessionEndedEvent
    const endSessionEffect = Effect.gen(function*() {
      const alreadyEnded = yield* Ref.getAndSet(isSessionEndedRef, true)
      if (alreadyEnded) {
        return
      }

      const state = yield* Ref.get(stateRef)

      // If mid-turn, interrupt it and emit AgentTurnInterruptedEvent
      const fiber = yield* Ref.get(turnFiberRef)
      if (Option.isSome(fiber) && ReducedContext.isAgentTurnInProgress(state.reducedContext)) {
        yield* Fiber.interrupt(fiber.value)

        const interruptEvent = new AgentTurnInterruptedEvent({
          id: makeEventId(contextName, state.reducedContext.nextEventNumber),
          timestamp: DateTime.unsafeNow(),
          agentName,
          parentEventId: state.reducedContext.agentTurnStartedAtEventId,
          triggersAgentTurn: false,
          turnNumber: state.reducedContext.currentTurnNumber,
          reason: "session_ended",
          partialResponse: Option.none()
        })
        yield* addEventInternal(interruptEvent).pipe(Effect.catchAll(() => Effect.void))
      }

      // Get updated state after potential interrupt event
      const stateAfterInterrupt = yield* Ref.get(stateRef)

      // Emit SessionEndedEvent through normal event flow
      const sessionEndEvent = new SessionEndedEvent({
        id: makeEventId(contextName, stateAfterInterrupt.reducedContext.nextEventNumber),
        timestamp: DateTime.unsafeNow(),
        agentName,
        parentEventId: Option.none(),
        triggersAgentTurn: false
      })
      yield* addEventInternal(sessionEndEvent).pipe(Effect.catchAll(() => Effect.void))

      // Small delay to ensure event is broadcast before closing mailbox
      yield* Effect.sleep(Duration.millis(50))

      // End mailbox to signal stream completion
      yield* mailbox.end
    })

    // Internal shutdown for scope cleanup - bypasses queue to avoid deadlock
    const performShutdown = Effect.gen(function*() {
      const alreadyEnded = yield* Ref.getAndSet(isSessionEndedRef, true)

      // Cancel fibers first to stop processing
      yield* Fiber.interrupt(processingFiber).pipe(Effect.catchAll(() => Effect.void))
      yield* Fiber.interrupt(eventProcessorFiber).pipe(Effect.catchAll(() => Effect.void))

      // Cancel any in-flight turn
      const fiber = yield* Ref.get(turnFiberRef)
      if (Option.isSome(fiber)) {
        yield* Fiber.interrupt(fiber.value).pipe(Effect.catchAll(() => Effect.void))
      }

      // Shutdown the event queue
      yield* Queue.shutdown(eventQueue)

      // Only emit SessionEndedEvent if not already ended (via endSession)
      if (!alreadyEnded) {
        const state = yield* Ref.get(stateRef)
        const sessionEndEvent = new SessionEndedEvent({
          id: makeEventId(contextName, state.reducedContext.nextEventNumber),
          timestamp: DateTime.unsafeNow(),
          agentName,
          parentEventId: state.lastEventId, // Chain to previous event
          triggersAgentTurn: false
        })

        // Persist directly (not through queue since it's shutdown)
        yield* store.append(contextName, [sessionEndEvent]).pipe(Effect.catchAll(() => Effect.void))

        // Broadcast directly to mailbox
        yield* mailbox.offer(sessionEndEvent).pipe(Effect.catchAll(() => Effect.void))
      }

      // End mailbox
      yield* mailbox.end
    })

    // Try to get config and LLM config (optional - may not be available in tests)
    const appConfigOption = yield* Effect.serviceOption(AppConfig)
    const llmConfigOption = yield* Effect.serviceOption(CurrentLlmConfig)

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

    // Emit LLM config event if available
    if (Option.isSome(llmConfigOption)) {
      const llmConfig = llmConfigOption.value
      const stateAfterLlm = yield* Ref.get(stateRef)
      const llmConfigEvent = new SetLlmConfigEvent({
        id: makeEventId(contextName, stateAfterLlm.reducedContext.nextEventNumber),
        timestamp: DateTime.unsafeNow(),
        agentName,
        parentEventId: Option.none(),
        triggersAgentTurn: false,
        apiFormat: llmConfig.apiFormat,
        model: llmConfig.model,
        baseUrl: llmConfig.baseUrl,
        apiKeyEnvVar: llmConfig.apiKeyEnvVar
      })
      yield* addEventInternal(llmConfigEvent)
    }

    // Emit system prompt event if config available
    if (Option.isSome(appConfigOption)) {
      const appConfig = appConfigOption.value
      const stateAfterConfig = yield* Ref.get(stateRef)
      const systemPromptEvent = new SystemPromptEvent({
        id: makeEventId(contextName, stateAfterConfig.reducedContext.nextEventNumber),
        timestamp: DateTime.unsafeNow(),
        agentName,
        parentEventId: Option.none(),
        triggersAgentTurn: false,
        content: appConfig.systemPrompt
      })
      yield* addEventInternal(systemPromptEvent)
    }

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

      endSession: endSessionEffect,

      isIdle: isIdleEffect,

      shutdown: performShutdown
    }

    return agent
  })
