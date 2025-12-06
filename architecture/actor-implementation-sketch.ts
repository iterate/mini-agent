/**
 * Actor Implementation Sketch
 *
 * Implementation patterns for the MiniAgent service.
 * NOT runnable code - design reference only.
 *
 * Actor State:
 * - events: The full event list (the context)
 * - reducedContext: All derived state from EventReducer
 *
 * Key Pattern: Mailbox + broadcastDynamic
 * - Mailbox for actor input (offer, end, toStream)
 * - Stream.broadcastDynamic for fan-out to subscribers
 * - Each execution of `events` stream = new subscriber
 *
 * IMPORTANT: broadcastDynamic is a LIVE stream.
 * Late subscribers miss events. Use getEvents for historical access.
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
  Sink,
  Stream
} from "effect"
import type {
  AgentName,
  AgentTurnCompletedEvent,
  AgentTurnFailedEvent,
  AgentTurnStartedEvent,
  ContextEvent,
  EventId,
  EventReducer,
  MiniAgentError,
  ReducedContext,
  SessionEndedEvent,
  SessionStartedEvent
} from "./design.ts"

interface ActorState {
  readonly events: ReadonlyArray<ContextEvent>
  readonly reducedContext: ReducedContext
}

/**
 * Implementation sketch for MiniAgent using Mailbox + broadcastDynamic.
 *
 * Key insight: Each execution of `events` (the broadcast stream) creates
 * a new subscriber to the internal PubSub. This is the fan-out mechanism.
 *
 * Processing is triggered by events with triggersAgentTurn=true, not event type.
 * Debounce is hard-coded to 100ms.
 *
 * Note: MiniAgent uses factory pattern (not static Default layer) because it takes
 * agentName as a parameter. In actual code, MiniAgent would be defined with Effect.Service.
 */
const makeMiniAgent = (agentName: AgentName) =>
  Layer.scoped(
    // MiniAgent interface - would be defined in design.ts
    Context.GenericTag<{
      readonly agentName: AgentName
      readonly addEvent: (event: ContextEvent) => Effect.Effect<void, MiniAgentError>
      readonly events: Stream.Stream<ContextEvent, never>
      readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>
      readonly shutdown: Effect.Effect<void>
    }>("@mini-agent/MiniAgent"),
    Effect.gen(function*() {
      // Dependencies (would be Effect.Service in actual implementation)
      const reducer = yield* EventReducer
      const eventStore = yield* Context.GenericTag<{
        readonly append: (
          agentName: AgentName,
          events: ReadonlyArray<ContextEvent>
        ) => Effect.Effect<void>
      }>("@mini-agent/EventStore")

      // Initial reduced context (would come from EventReducer.init)
      const initialReducedContext = {
        nextEventNumber: 0,
        currentTurnNumber: 0,
        agentTurnStartedAtEventId: Option.none() as Option.Option<EventId>
        // ... other reducer state
      } as ReducedContext

      // Internal state: just events + reducedContext
      const stateRef = yield* Ref.make<ActorState>({
        events: [],
        reducedContext: initialReducedContext
      })

      // Mailbox for actor input
      const mailbox = yield* Mailbox.make<ContextEvent>()

      // Helper to generate event metadata with agent-prefixed IDs
      // Uses reducedContext for counter and parent linking
      const makeEventMeta = (state: ActorState, triggersAgentTurn = false) => {
        const id = `${agentName}:${String(state.reducedContext.nextEventNumber).padStart(4, "0")}` as EventId
        return {
          id,
          timestamp: DateTime.unsafeNow(),
          agentName,
          parentEventId: state.reducedContext.agentTurnStartedAtEventId,
          triggersAgentTurn
        }
      }

      // Convert mailbox to broadcast stream
      // KEY: broadcastDynamic creates internal PubSub, returns Stream
      // Each execution of the stream = new subscriber (fan-out)
      // Bounded + sliding: TextDelta can drop, final AssistantMessage preserved
      const broadcast = yield* Stream.broadcastDynamic(Mailbox.toStream(mailbox), {
        capacity: 256,
        strategy: "sliding"
      })

      // Background processing fiber - subscribes to broadcast for debouncing
      // Only processes when an event with triggersAgentTurn=true has been added
      const processBatch = Effect.gen(function*() {
        const state = yield* Ref.get(stateRef)

        // Check if we should process (from reduced state)
        if (Option.isSome(state.reducedContext.agentTurnStartedAtEventId)) return

        // Get turn number from reduced context
        const turnNumber = state.reducedContext.currentTurnNumber

        const startTime = Date.now()
        try {
          // Create and add AgentTurnStartedEvent
          const startMeta = makeEventMeta(state)
          const startEvent = {
            _tag: "AgentTurnStartedEvent",
            ...startMeta,
            turnNumber
          } as unknown as AgentTurnStartedEvent

          // Add start event through normal flow (updates reducer)
          yield* addEventInternal(startEvent)

          // TODO: Call agent with reduced context here
          // Reducer has already derived config from events (SetLlmConfigEvent, etc.)
          yield* Effect.logInfo("Processing events (agent turn would happen here)")

          // Create and add AgentTurnCompletedEvent
          const updatedState = yield* Ref.get(stateRef)
          const durationMs = Date.now() - startTime
          const completeMeta = makeEventMeta(updatedState)
          const completeEvent = {
            _tag: "AgentTurnCompletedEvent",
            ...completeMeta,
            turnNumber,
            durationMs
          } as unknown as AgentTurnCompletedEvent

          yield* addEventInternal(completeEvent)
        } catch (error) {
          // Create and add AgentTurnFailedEvent
          const updatedState = yield* Ref.get(stateRef)
          const failMeta = makeEventMeta(updatedState)
          const failEvent = {
            _tag: "AgentTurnFailedEvent",
            ...failMeta,
            turnNumber,
            error: String(error)
          } as unknown as AgentTurnFailedEvent

          yield* addEventInternal(failEvent)
        }
      })

      // Internal helper to add event (used by both public API and internal flows)
      const addEventInternal = (event: ContextEvent) =>
        Effect.gen(function*() {
          const state = yield* Ref.get(stateRef)

          // 1. Add to events list
          const newEvents = [...state.events, event]

          // 2. Run reducer to get new reduced context
          const newReducedContext = yield* reducer.reduce(state.reducedContext, [event])

          // 3. Update state atomically
          yield* Ref.set(stateRef, { events: newEvents, reducedContext: newReducedContext })

          // 4. Broadcast to subscribers
          yield* mailbox.offer(event)

          // 5. Persist to event store
          yield* eventStore.append(agentName, [event])
        })

      // Start background processing fiber
      // aggregateWithin guarantees max 500ms wait (no starvation under continuous events)
      // Sink.last takes latest event, Schedule.fixed sets max wait
      const processingFiber = yield* broadcast.pipe(
        Stream.filter((e) => e.triggersAgentTurn),
        Stream.aggregateWithin(
          Sink.last<ContextEvent>(),
          Schedule.fixed(Duration.millis(500))
        ),
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
      const initialState = yield* Ref.get(stateRef)
      const sessionStartMeta = makeEventMeta(initialState)
      const sessionStartEvent = {
        _tag: "SessionStartedEvent",
        ...sessionStartMeta
      } as unknown as SessionStartedEvent
      yield* addEventInternal(sessionStartEvent)

      // Cleanup on scope close
      yield* Effect.addFinalizer((_exit) =>
        Effect.gen(function*() {
          const state = yield* Ref.get(stateRef)
          const sessionEndMeta = makeEventMeta(state)
          const sessionEndEvent = {
            _tag: "SessionEndedEvent",
            ...sessionEndMeta
          } as unknown as SessionEndedEvent
          yield* mailbox.offer(sessionEndEvent)
          yield* mailbox.end
          yield* Fiber.interrupt(processingFiber)
        })
      )

      // Service implementation
      return {
        agentName,

        addEvent: addEventInternal,

        // KEY: `events` is the broadcast stream
        // Each execution creates a new subscriber to internal PubSub
        events: broadcast,

        getEvents: Ref.get(stateRef).pipe(Effect.map((s) => s.events)),

        shutdown: Effect.gen(function*() {
          const state = yield* Ref.get(stateRef)
          const shutdownMeta = makeEventMeta(state)
          const shutdownEvent = {
            _tag: "SessionEndedEvent",
            ...shutdownMeta
          } as unknown as SessionEndedEvent
          yield* mailbox.offer(shutdownEvent)
          yield* mailbox.end
          yield* Fiber.interrupt(processingFiber)
        })
      }
    })
  )

/**
 * Implementation Notes
 *
 * ACTOR STATE
 * ActorState = { events, reducedContext }. All derived state lives in reducedContext
 * (nextEventNumber, currentTurnNumber, agentTurnStartedAtEventId). The reducer
 * computes reducedContext from events - deterministic and testable.
 *
 * ATOMICITY
 * Use Ref.modify() for atomic read-modify-write (EventId generation, state updates).
 * JS is single-threaded, so Ref.modify's core.sync() guarantees atomicity.
 *
 * EVENT IDS
 * Format: {agentName}:{counter} e.g. "chat:0001". Counter from reducedContext.nextEventNumber.
 *
 * TURN TRACKING
 * agentTurnStartedAtEventId: Option<EventId> serves dual purpose:
 * - Option.isSome = turn in progress
 * - The EventId = parent for new events (automatic causal linking)
 * Reducer sets to Some on AgentTurnStartedEvent, resets to None on Completed/Failed.
 *
 * BROADCAST
 * broadcastDynamic(256, "sliding") bounds memory. TextDelta can drop without
 * data loss since final AssistantMessage contains complete response.
 *
 * BATCHING
 * aggregateWithin(Sink.last(), Schedule.fixed(500ms)) replaces debounce.
 * Guarantees max 500ms wait even under continuous events (no starvation).
 *
 * LIVE STREAMS
 * broadcastDynamic doesn't replay. Late subscribers miss events.
 * Use getEvents for historical access.
 *
 * SUBSCRIPTION TIMING
 * For tests: subscribe before adding events, or use Deferred for coordination.
 * ```typescript
 * const ready = yield* Deferred.make<void>()
 * const fiber = yield* agent.events.pipe(
 *   Stream.tap(() => Deferred.succeed(ready, void 0)),
 *   Stream.runCollect, Effect.fork
 * )
 * yield* Deferred.await(ready)
 * yield* agent.addEvent(event)
 * ```
 *
 * SHUTDOWN
 * Coordinated: end → await(5s timeout) → shutdown.
 * Ensures SessionEndedEvent is received before forced termination.
 */
