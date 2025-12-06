/**
 * Actor Implementation Sketch
 *
 * This file shows key implementation patterns for the MiniAgent service.
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
  AgentEvent,
  AgentName,
  AgentTurnCompletedEvent,
  AgentTurnFailedEvent,
  AgentTurnStartedEvent,
  EventId,
  MiniAgentError,
  SessionEndedEvent,
  SessionStartedEvent
} from "./design.ts"

// =============================================================================
// Actor Internal State
// =============================================================================

interface ActorState {
  readonly events: ReadonlyArray<AgentEvent>
  readonly isProcessing: boolean
  readonly lastTriggeringEventId: Option.Option<EventId>
}

// =============================================================================
// MiniAgent Implementation Pattern
// =============================================================================

/**
 * Implementation sketch for MiniAgent using Mailbox + broadcastDynamic.
 *
 * Key insight: Each execution of `events` (the broadcast stream) creates
 * a new subscriber to the internal PubSub. This is the fan-out mechanism.
 *
 * Processing is triggered by events with triggersAgentTurn=true, not event type.
 * Debounce delay comes from ReducedContext (via SetDebounceEvent).
 */
const makeMiniAgent = (agentName: AgentName) =>
  Layer.scoped(
    // MiniAgent tag - would be imported from design.ts
    Context.GenericTag<{
      readonly agentName: AgentName
      readonly addEvent: (event: AgentEvent) => Effect.Effect<void, MiniAgentError>
      readonly events: Stream.Stream<AgentEvent, never>
      readonly getEvents: Effect.Effect<ReadonlyArray<AgentEvent>>
      readonly shutdown: Effect.Effect<void>
    }>("@app/MiniAgent"),
    Effect.gen(function*() {
      // Internal state
      const stateRef = yield* Ref.make<ActorState>({
        events: [],
        isProcessing: false,
        lastTriggeringEventId: Option.none()
      })

      // Mailbox for actor input
      const mailbox = yield* Mailbox.make<AgentEvent>()

      // Default debounce (would come from ReducedContext in real impl)
      const debounceMs = 100

      // Helper to generate event metadata
      const makeEventMeta = (triggersAgentTurn = false) => ({
        id: crypto.randomUUID() as unknown as EventId,
        timestamp: DateTime.unsafeNow(),
        agentName,
        parentEventId: Option.none(),
        triggersAgentTurn
      })

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
        const hasTriggeringEvent = state.events.some((e) => e.triggersAgentTurn)
        if (!hasTriggeringEvent) return

        yield* Ref.update(stateRef, (s) => ({ ...s, isProcessing: true }))

        const startTime = Date.now()
        try {
          yield* mailbox.offer({
            _tag: "AgentTurnStartedEvent",
            ...makeEventMeta()
          } as unknown as AgentTurnStartedEvent)

          // TODO: Call reducer and agent here
          // Reducer derives config from events (SetLlmProviderConfigEvent, etc.)
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
      // Only debounce events with triggersAgentTurn=true
      const processingFiber = yield* broadcast.pipe(
        Stream.filter((e) => e.triggersAgentTurn),
        Stream.debounce(Duration.millis(debounceMs)),
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
        agentName,

        addEvent: (event: AgentEvent) =>
          Effect.gen(function*() {
            // 1. Update in-memory state
            yield* Ref.update(stateRef, (s) => ({
              ...s,
              events: [...s.events, event],
              lastTriggeringEventId: event.triggersAgentTurn
                ? Option.some(event.id)
                : s.lastTriggeringEventId
            }))

            // 2. Offer to mailbox - broadcasts to all subscribers
            yield* mailbox.offer(event)

            // 3. TODO: Persist to EventStore (not shown)
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
 * 2. TRIGGERSAGENTTURN PROPERTY
 *
 *    Processing is triggered by event.triggersAgentTurn=true, not by event type.
 *    This allows any event type to optionally trigger an LLM request.
 *    Typical usage:
 *    - UserMessageEvent: triggersAgentTurn=true
 *    - FileAttachmentEvent: triggersAgentTurn=false (attached before user sends)
 *    - SystemPromptEvent: triggersAgentTurn=false (setup phase)
 *
 * 3. SUBSCRIPTION TIMING
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
 * 4. CLEAN SHUTDOWN
 *
 *    - Emit SessionEndedEvent before ending mailbox
 *    - mailbox.end completes the broadcast stream
 *    - Interrupt processing fiber
 *    - Use Effect.addFinalizer for automatic cleanup on scope close
 *
 * 5. TESTING
 *
 *    - Tests work well for synchronous subscription scenarios
 *    - Concurrent tests (fork + add events) require careful timing
 *    - Use Deferred for coordination, not sleep/delays
 *    - Use EventStore.inMemoryLayer for tests (no disk I/O)
 */
