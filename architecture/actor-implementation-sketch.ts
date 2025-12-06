/**
 * Actor Implementation Sketch
 *
 * This file shows key implementation patterns for the MiniAgent service.
 * NOT runnable code - aspirational design reference only.
 *
 * Conceptual Model:
 * - ContextEvent: An event in a context (messages, config changes, lifecycle events)
 * - Context: A list of ContextEvents
 * - MiniAgent: Has agentName, context (list of events), and external interface
 *
 * Key Simplification: Actor state = events + reducedContext
 * - ActorState contains only: events (the full list) and reducedContext (derived state)
 * - ALL internal state (counters, flags, tracking) lives in reducedContext
 * - EventReducer derives reducedContext from events
 * - No manual counter management, no separate refs for processing state
 * - Parent event linking is automatic via reducedContext.agentTurnStartedAtEventId
 *
 * Key Pattern: Mailbox + broadcastDynamic
 * - Mailbox for actor mailbox semantics (offer, end, toStream)
 * - Stream.broadcastDynamic for fan-out to multiple subscribers
 * - Each execution of the `events` stream = new subscriber to internal PubSub
 *
 * IMPORTANT: broadcastDynamic is a LIVE stream:
 * - Late subscribers only receive events published AFTER they subscribe
 * - For historical events, use getEvents (reads from in-memory state)
 *
 * Philosophy: "Agent events are all you need"
 * - triggersAgentTurn property on events determines if LLM request should happen
 * - All config comes from events via ReducedContext (no separate AppConfig)
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
  Stream
} from "effect"
import type {
  AgentEvent as ContextEvent,
  AgentName,
  AgentTurnCompletedEvent,
  AgentTurnFailedEvent,
  AgentTurnStartedEvent,
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
 */
const makeMiniAgent = (agentName: AgentName) =>
  Layer.scoped(
    // MiniAgent tag - would be imported from design.ts
    Context.GenericTag<{
      readonly agentName: AgentName
      readonly addEvent: (event: ContextEvent) => Effect.Effect<void, MiniAgentError>
      readonly events: Stream.Stream<ContextEvent, never>
      readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>
      readonly shutdown: Effect.Effect<void>
    }>("@app/MiniAgent"),
    Effect.gen(function*() {
      // Dependencies
      const reducer = yield* EventReducer
      const eventStore = yield* Context.GenericTag<{
        readonly append: (
          agentName: AgentName,
          events: ReadonlyArray<ContextEvent>
        ) => Effect.Effect<void>
      }>("@app/EventStore")

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
      const broadcast = yield* Stream.broadcastDynamic(Mailbox.toStream(mailbox), {
        capacity: "unbounded"
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
          // Reducer has already derived config from events (SetLlmProviderConfigEvent, etc.)
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
      // Only debounce events with triggersAgentTurn=true
      const processingFiber = yield* broadcast.pipe(
        Stream.filter((e) => e.triggersAgentTurn),
        Stream.debounce(Duration.millis(100)),
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
 * KEY LEARNINGS
 *
 * 1. ACTOR STATE SIMPLIFICATION
 *
 *    ActorState contains ONLY:
 *    - events: The full event list
 *    - reducedContext: Derived state from EventReducer
 *
 *    ALL internal state lives in reducedContext:
 *    - nextEventNumber: Counter for generating event IDs
 *    - currentTurnNumber: Current agent turn number
 *    - agentTurnStartedAtEventId: Option<EventId> - tracks if turn is in progress
 *                                 and serves as parent event for linking
 *
 *    This eliminates manual counter management and separate refs.
 *
 * 2. EVENT ID FORMAT
 *
 *    EventIds use format: {agentName}:{counter}
 *    Example: "chat:0001", "chat:0002", etc.
 *
 *    Generated inline using reducedContext.nextEventNumber:
 *    `${agentName}:${String(state.reducedContext.nextEventNumber).padStart(4, "0")}`
 *
 *    This allows:
 *    - Easy identification of which agent created the event
 *    - Sequential ordering within an agent's context
 *    - Debugging and tracing across multiple agents
 *
 * 3. TURN NUMBERING
 *
 *    Each agent turn (LLM request) has a turnNumber from reducedContext.currentTurnNumber.
 *    Turn events (AgentTurnStartedEvent, AgentTurnCompletedEvent, AgentTurnFailedEvent)
 *    include the turnNumber for tracking and correlation.
 *
 *    EventReducer increments currentTurnNumber when AgentTurnStartedEvent is reduced.
 *
 *    This enables:
 *    - Correlating all events within a single agent turn
 *    - Measuring turn duration and performance
 *    - Debugging multi-turn conversations
 *
 * 4. AGENT TURN TRACKING (SINGLE FIELD)
 *
 *    agentTurnStartedAtEventId: Option<EventId> serves dual purpose:
 *    - Option.isSome = agent turn is in progress
 *    - The EventId value = parent event for automatic linking
 *
 *    When an event with triggersAgentTurn=true is added, reducer sets this to Option.some(eventId).
 *    When AgentTurnStartedEvent is added, reducer stores its ID here.
 *    When AgentTurnCompletedEvent/AgentTurnFailedEvent is added, reducer resets to Option.none().
 *
 *    All events have parentEventId populated from this field, creating automatic causal chains.
 *
 *    This enables:
 *    - Single field for turn state + parent linking (no redundancy)
 *    - Automatic causal relationship tracking
 *    - Future branching/forking from specific events
 *    - Building event trees rather than linear lists
 *    - No manual parent tracking needed
 *
 * 5. REDUCER-DRIVEN ARCHITECTURE
 *
 *    EventReducer is the single source of truth for derived state.
 *    Flow: events → reducer → reducedContext → behavior
 *
 *    Benefits:
 *    - Deterministic state (same events = same state)
 *    - Easy testing (pure function)
 *    - Replay capability
 *    - No state synchronization bugs
 *
 * 6. LIVE STREAM BEHAVIOR
 *
 *    broadcastDynamic doesn't replay events to late subscribers.
 *    Subscribers only receive events published AFTER they subscribe.
 *
 *    For historical events, use getEvents which returns from in-memory state.
 *
 * 7. TRIGGERSAGENTTURN PROPERTY
 *
 *    Processing is triggered by event.triggersAgentTurn=true, not by event type.
 *    This allows any event type to optionally trigger an LLM request.
 *    Typical usage:
 *    - UserMessageEvent: triggersAgentTurn=true
 *    - FileAttachmentEvent: triggersAgentTurn=false (attached before user sends)
 *    - SystemPromptEvent: triggersAgentTurn=false (setup phase)
 *
 * 8. HARD-CODED DEBOUNCE
 *
 *    Debounce is hard-coded to 100ms for simplicity.
 *    Stream.debounce(Duration.millis(100)) delays processing until 100ms after
 *    the last triggering event.
 *
 *    This prevents multiple rapid-fire events from triggering multiple agent turns.
 *
 * 9. SUBSCRIPTION TIMING
 *
 *    For tests or code that needs to ensure a subscriber is connected
 *    before events are added, either:
 *    - Subscribe synchronously (in same Effect.gen block) before adding events
 *    - Use a Deferred to signal when subscription is ready
 *
 *    Example with Deferred:
 *    ```typescript
 *    const ready = yield* Deferred.make<void>()
 *    const fiber = yield* agent.events.pipe(
 *      Stream.tap(() => Deferred.succeed(ready, void 0)),
 *      Stream.take(2),
 *      Stream.runCollect,
 *      Effect.fork
 *    )
 *    yield* Deferred.await(ready)
 *    yield* agent.addEvent(event)
 *    ```
 *
 * 10. CLEAN SHUTDOWN
 *
 *     - Emit SessionEndedEvent before ending mailbox
 *     - mailbox.end completes the broadcast stream
 *     - Interrupt processing fiber
 *     - Use Effect.addFinalizer for automatic cleanup on scope close
 *
 * 11. TESTING
 *
 *     - Tests work well for synchronous subscription scenarios
 *     - Concurrent tests (fork + add events) require careful timing
 *     - Use Deferred for coordination, not sleep/delays
 *     - Use EventStore.inMemoryLayer for tests (no disk I/O)
 *     - Test EventReducer independently as pure function
 */
