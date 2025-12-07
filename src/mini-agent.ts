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
  PubSub,
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

/** Errors that can occur during agent creation (includes loading from store) */
type MiniAgentCreationError = ReducerError | ContextLoadError | ContextSaveError

export interface ExecuteTurnDeps {
  readonly agentName: AgentName
  readonly contextName: ContextName
  readonly stateRef: Ref.Ref<ActorState>
  readonly addEvent: (event: ContextEvent) => Effect.Effect<void>
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

    // Track partial response text accumulated during current turn (for interrupt events)
    const currentPartialResponseRef = yield* Ref.make("")

    // Mailbox for event input
    const mailbox = yield* Mailbox.make<ContextEvent>()

    // PubSub for external subscribers - provides guaranteed subscription timing
    // When PubSub.subscribe completes, the subscription IS established
    const pubsub = yield* PubSub.unbounded<ContextEvent>()

    // Create broadcast stream from mailbox (kept for backwards compat, deprecated)
    const broadcast = yield* Stream.broadcastDynamic(
      Mailbox.toStream(mailbox),
      { capacity: "unbounded" }
    )

    // Track current turn fiber for interruption
    const turnFiberRef = yield* Ref.make<Option.Option<Fiber.RuntimeFiber<void, never>>>(Option.none())

    // Queue to serialize event processing
    const eventQueue = yield* Queue.unbounded<ContextEvent>()

    // Process events sequentially from the queue
    // Use forkScoped to attach fiber to the agent's Scope (not the request scope)
    const eventProcessorFiber = yield* Stream.fromQueue(eventQueue).pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function*() {
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

          // 3. Track partial response for interrupt events
          if (chainedEvent._tag === "AgentTurnStartedEvent") {
            yield* Ref.set(currentPartialResponseRef, "")
          } else if (chainedEvent._tag === "TextDeltaEvent") {
            yield* Ref.update(currentPartialResponseRef, (text) => text + chainedEvent.delta)
          }

          // 4. Broadcast FIRST (before persistence) so subscribers get events immediately
          yield* mailbox.offer(chainedEvent)
          yield* PubSub.publish(pubsub, chainedEvent)

          // 5. Persist asynchronously (exclude TextDeltaEvent - ephemeral streaming data)
          // Fire-and-forget: don't block on persistence
          if (chainedEvent._tag !== "TextDeltaEvent") {
            yield* store.append(contextName, [chainedEvent]).pipe(
              Effect.catchAll((error) => Effect.logWarning("Persist failed", { error })),
              Effect.forkScoped
            )
          }
        }).pipe(
          Effect.catchAll((error) => Effect.logWarning("Event processing failed", { error }))
        )
      ),
      Stream.runDrain,
      Effect.forkScoped
    )

    // Helper: Add event to queue (fire-and-forget, returns immediately)
    const addEventInternal = (event: ContextEvent): Effect.Effect<void, never> =>
      Queue.offer(eventQueue, event).pipe(Effect.asVoid)

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
      // triggeringEvent is the event (e.g., UserMessageEvent) that triggered a new turn
      Stream.mapEffect((triggeringEvent) =>
        Effect.gen(function*() {
          // Cancel any existing turn and emit interrupt event
          const existingFiber = yield* Ref.get(turnFiberRef)
          const state = yield* Ref.get(stateRef)

          if (Option.isSome(existingFiber) && ReducedContext.isAgentTurnInProgress(state.reducedContext)) {
            yield* Fiber.interrupt(existingFiber.value)

            // Get accumulated partial response before creating interrupt event
            const partialText = yield* Ref.get(currentPartialResponseRef)
            const partialResponse = partialText.length > 0 ? Option.some(partialText) : Option.none()

            const interruptEvent = new AgentTurnInterruptedEvent({
              id: makeEventId(contextName, state.reducedContext.nextEventNumber),
              timestamp: DateTime.unsafeNow(),
              agentName,
              parentEventId: state.reducedContext.agentTurnStartedAtEventId,
              triggersAgentTurn: false,
              turnNumber: state.reducedContext.currentTurnNumber,
              reason: "user_new_message",
              partialResponse,
              // Track which event caused the interruption so UI can reorder display
              interruptedByEventId: Option.some(triggeringEvent.id)
            })
            yield* addEventInternal(interruptEvent).pipe(Effect.catchAll(() => Effect.void))
          }

          turnCounter++
          const turnNumber = turnCounter as AgentTurnNumber

          // Start new turn
          const fiber = yield* executeTurn(turnNumber).pipe(
            Effect.catchAll((error) => Effect.logWarning("Turn execution failed", { error })),
            Effect.forkScoped
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
      Effect.forkScoped
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

        // Get accumulated partial response before creating interrupt event
        const partialText = yield* Ref.get(currentPartialResponseRef)
        const partialResponse = partialText.length > 0 ? Option.some(partialText) : Option.none()

        const interruptEvent = new AgentTurnInterruptedEvent({
          id: makeEventId(contextName, state.reducedContext.nextEventNumber),
          timestamp: DateTime.unsafeNow(),
          agentName,
          parentEventId: state.reducedContext.agentTurnStartedAtEventId,
          triggersAgentTurn: false,
          turnNumber: state.reducedContext.currentTurnNumber,
          reason: "session_ended",
          partialResponse,
          // No specific event caused this interruption - session ended gracefully
          interruptedByEventId: Option.none()
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

      // Wait for the SessionEndedEvent to be processed (addEventInternal is fire-and-forget)
      yield* Effect.iterate(0, {
        while: () => true,
        body: () =>
          Effect.gen(function*() {
            const events = yield* Ref.get(stateRef).pipe(Effect.map((s) => s.events))
            if (events.some((e) => e._tag === "SessionEndedEvent")) {
              return Effect.fail("found" as const)
            }
            yield* Effect.sleep("5 millis")
            return Effect.succeed(0)
          }).pipe(Effect.flatten)
      }).pipe(
        Effect.catchAll(() => Effect.void),
        Effect.timeout("1 second"),
        Effect.orDie
      )

      // Now signal completion to all subscribers:
      yield* PubSub.shutdown(pubsub) // Signal to PubSub subscribers that stream is done
      yield* mailbox.end // Signal to deprecated .events subscribers
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

        // Broadcast directly to both mailbox and pubsub
        yield* mailbox.offer(sessionEndEvent).pipe(Effect.catchAll(() => Effect.void))
        yield* PubSub.publish(pubsub, sessionEndEvent).pipe(Effect.catchAll(() => Effect.void))
      }

      // Signal completion to all subscribers
      yield* PubSub.shutdown(pubsub).pipe(Effect.catchAll(() => Effect.void))
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

    // Wait for startup events to be processed before returning
    // This prevents race conditions where getEvents returns empty before events are processed
    yield* Effect.iterate(0, {
      while: () => true,
      body: () =>
        Effect.gen(function*() {
          const events = yield* Ref.get(stateRef).pipe(Effect.map((s) => s.events))
          if (events.some((e) => e._tag === "SessionStartedEvent")) {
            return Effect.fail("found" as const)
          }
          yield* Effect.sleep("5 millis")
          return Effect.succeed(0)
        }).pipe(Effect.flatten)
    }).pipe(
      Effect.catchAll(() => Effect.void),
      Effect.timeout("1 second"),
      Effect.orDie
    )

    // Cleanup on scope close
    yield* Effect.addFinalizer(() => performShutdown)

    // Interrupt current turn without starting a new one
    const interruptTurnEffect = Effect.gen(function*() {
      const fiber = yield* Ref.get(turnFiberRef)
      const state = yield* Ref.get(stateRef)

      if (Option.isSome(fiber) && ReducedContext.isAgentTurnInProgress(state.reducedContext)) {
        yield* Fiber.interrupt(fiber.value)
        yield* Ref.set(turnFiberRef, Option.none())

        // Get accumulated partial response before creating interrupt event
        const partialText = yield* Ref.get(currentPartialResponseRef)
        const partialResponse = partialText.length > 0 ? Option.some(partialText) : Option.none()

        const interruptEvent = new AgentTurnInterruptedEvent({
          id: makeEventId(contextName, state.reducedContext.nextEventNumber),
          timestamp: DateTime.unsafeNow(),
          agentName,
          parentEventId: state.reducedContext.agentTurnStartedAtEventId,
          triggersAgentTurn: false,
          turnNumber: state.reducedContext.currentTurnNumber,
          reason: "user_cancel",
          partialResponse,
          // User manually cancelled without sending a new message
          interruptedByEventId: Option.none()
        })
        yield* addEventInternal(interruptEvent).pipe(Effect.catchAll(() => Effect.void))
      }
    })

    // Return the MiniAgent interface
    const agent: MiniAgent = {
      agentName,
      contextName,

      addEvent: (event) => addEventInternal(event),

      subscribe: Effect.gen(function*() {
        // PubSub.subscribe guarantees subscription is established when this effect completes
        const dequeue = yield* PubSub.subscribe(pubsub)
        return Stream.fromQueue(dequeue)
      }),

      events: broadcast,

      getEvents: Ref.get(stateRef).pipe(Effect.map((s) => s.events)),

      getReducedContext: Ref.get(stateRef).pipe(Effect.map((s) => s.reducedContext)),

      endSession: endSessionEffect,

      isIdle: isIdleEffect,

      interruptTurn: interruptTurnEffect,

      shutdown: performShutdown
    }

    return agent
  })
