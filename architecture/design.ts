/**
 * Complete type definitions for the MiniAgent Architecture.
 * Service interfaces only - no implementations.
 *
 * Philosophy: "Agent events are all you need"
 * - Everything the agent does is driven by events
 * - Events reduce to state, state drives the agent
 * - Configuration comes from events (SetLlmProviderConfigEvent, etc.)
 * - Future: tools, workflows, everything defined via events
 *
 * Key design decisions:
 * - All events share BaseEventFields (id, timestamp, agentName, triggersAgentTurn, parentEventId)
 * - triggersAgentTurn property on ALL events determines if LLM request should happen
 * - parentEventId enables proper event linking (MVP feature, not future)
 * - Uses @effect/ai Prompt.Message for LLM messages (not custom types)
 * - Single ContextEvent union - no InputEvent/StreamEvent distinction
 *
 * Conceptual Model:
 * - ContextEvent: An event in a context (unit of state change)
 * - Context: A list of ContextEvents (the event log)
 * - ReducedContext: ALL actor state derived from events (messages, config, internal state)
 * - MiniAgent: Has agentName, stores events, runs reducer, calls Agent when needed
 */

import type { Prompt } from "@effect/ai"
import { Context, Duration, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"

export const AgentName = Schema.String.pipe(Schema.brand("AgentName"))
export type AgentName = typeof AgentName.Type

export const LlmProviderId = Schema.String.pipe(Schema.brand("LlmProviderId"))
export type LlmProviderId = typeof LlmProviderId.Type

/**
 * Globally unique event identifier with format: {agentName}:{counter}
 * Examples: "chat:0001", "chat:0002", "assistant:0001"
 *
 * This enables globally unique event references across all agents.
 * The counter is sequential within each agent.
 */
export const EventId = Schema.String.pipe(Schema.brand("EventId"))
export type EventId = typeof EventId.Type

export const makeEventId = (agentName: AgentName, counter: number): EventId =>
  `${agentName}:${String(counter).padStart(4, "0")}` as EventId

export const AgentTurnNumber = Schema.Number.pipe(Schema.brand("AgentTurnNumber"))
export type AgentTurnNumber = typeof AgentTurnNumber.Type

/**
 * All agent events must have these fields.
 * Use spread: { ...BaseEventFields, myField: Schema.String }
 *
 * triggersAgentTurn: Whether this event should trigger an LLM request.
 * This is a property of EVERY event - not hardcoded to specific event types.
 *
 * parentEventId: Links events causally (MVP feature).
 * Used to track which event triggered a response or workflow.
 * First events have Option.none(), responses link to their triggering event.
 */
export const BaseEventFields = {
  id: EventId,
  timestamp: Schema.DateTimeUtc,
  agentName: AgentName,
  parentEventId: Schema.optionalWith(EventId, { as: "Option" }),
  /** Whether adding this event should trigger an agent turn (LLM request) */
  triggersAgentTurn: Schema.Boolean
}

export class LlmProviderConfig extends Schema.Class<LlmProviderConfig>("LlmProviderConfig")({
  providerId: LlmProviderId,
  model: Schema.String,
  apiKey: Schema.Redacted(Schema.String),
  baseUrl: Schema.optionalWith(Schema.String, { as: "Option" })
}) {}

/**
 * Agent configuration derived from events.
 * This is part of ReducedContext, built by the reducer from config events.
 */
export class AgentConfig extends Schema.Class<AgentConfig>("AgentConfig")({
  primary: LlmProviderConfig,
  fallback: Schema.optionalWith(LlmProviderConfig, { as: "Option" }),
  timeoutMs: Schema.Number.pipe(Schema.positive())
}) {}

/**
 * ALL actor state derived from events.
 * The reducer derives this from the event log - no separate refs needed in the actor.
 *
 * This includes:
 * - Content for LLM (messages)
 * - Configuration from events (config)
 * - Actor internal state (counters, flags, etc.)
 *
 * The actor only needs:
 * 1. events (the event log)
 * 2. reducedContext (derived from events via reducer)
 *
 * No separate counters, flags, or state refs.
 */
export interface ReducedContext {
  readonly messages: ReadonlyArray<Prompt.Message>
  readonly config: AgentConfig
  readonly nextEventNumber: number
  readonly currentTurnNumber: AgentTurnNumber
  /** Some = turn in progress (started at that event), None = no turn in progress */
  readonly agentTurnStartedAtEventId: Option.Option<EventId>
}

export class SystemPromptEvent extends Schema.TaggedClass<SystemPromptEvent>()(
  "SystemPromptEvent",
  {
    ...BaseEventFields,
    content: Schema.String
  }
) {}

export class UserMessageEvent extends Schema.TaggedClass<UserMessageEvent>()(
  "UserMessageEvent",
  {
    ...BaseEventFields,
    content: Schema.String
  }
) {}

export class FileAttachmentEvent extends Schema.TaggedClass<FileAttachmentEvent>()(
  "FileAttachmentEvent",
  {
    ...BaseEventFields,
    source: Schema.String,
    mimeType: Schema.String,
    content: Schema.String
  }
) {}

export class AssistantMessageEvent extends Schema.TaggedClass<AssistantMessageEvent>()(
  "AssistantMessageEvent",
  {
    ...BaseEventFields,
    content: Schema.String
  }
) {}

export class TextDeltaEvent extends Schema.TaggedClass<TextDeltaEvent>()(
  "TextDeltaEvent",
  {
    ...BaseEventFields,
    delta: Schema.String
  }
) {}

export class SetLlmProviderConfigEvent extends Schema.TaggedClass<SetLlmProviderConfigEvent>()(
  "SetLlmProviderConfigEvent",
  {
    ...BaseEventFields,
    providerId: LlmProviderId,
    model: Schema.String,
    apiKey: Schema.Redacted(Schema.String),
    baseUrl: Schema.optionalWith(Schema.String, { as: "Option" }),
    asFallback: Schema.Boolean
  }
) {}

export class SetTimeoutEvent extends Schema.TaggedClass<SetTimeoutEvent>()(
  "SetTimeoutEvent",
  {
    ...BaseEventFields,
    timeoutMs: Schema.Number
  }
) {}

export class SessionStartedEvent extends Schema.TaggedClass<SessionStartedEvent>()(
  "SessionStartedEvent",
  {
    ...BaseEventFields
  }
) {}

export class SessionEndedEvent extends Schema.TaggedClass<SessionEndedEvent>()(
  "SessionEndedEvent",
  {
    ...BaseEventFields
  }
) {}

export class AgentTurnStartedEvent extends Schema.TaggedClass<AgentTurnStartedEvent>()(
  "AgentTurnStartedEvent",
  {
    ...BaseEventFields,
    turnNumber: AgentTurnNumber
  }
) {}

export class AgentTurnCompletedEvent extends Schema.TaggedClass<AgentTurnCompletedEvent>()(
  "AgentTurnCompletedEvent",
  {
    ...BaseEventFields,
    turnNumber: AgentTurnNumber,
    durationMs: Schema.Number
  }
) {}

export class AgentTurnInterruptedEvent extends Schema.TaggedClass<AgentTurnInterruptedEvent>()(
  "AgentTurnInterruptedEvent",
  {
    ...BaseEventFields,
    turnNumber: AgentTurnNumber,
    reason: Schema.String
  }
) {}

export class AgentTurnFailedEvent extends Schema.TaggedClass<AgentTurnFailedEvent>()(
  "AgentTurnFailedEvent",
  {
    ...BaseEventFields,
    turnNumber: AgentTurnNumber,
    error: Schema.String
  }
) {}

/**
 * Events that can occur in a context. There's no distinction between
 * "input" and "output" events - they're all just events that flow through
 * the system and get streamed to consumers.
 *
 * A list of ContextEvents IS a context (the event log).
 *
 * Every event has triggersAgentTurn to indicate if it should start an LLM request.
 */
export const ContextEvent = Schema.Union(
  SystemPromptEvent,
  UserMessageEvent,
  FileAttachmentEvent,
  AssistantMessageEvent,
  TextDeltaEvent,
  SetLlmProviderConfigEvent,
  SetTimeoutEvent,
  SessionStartedEvent,
  SessionEndedEvent,
  AgentTurnStartedEvent,
  AgentTurnCompletedEvent,
  AgentTurnInterruptedEvent,
  AgentTurnFailedEvent
)
export type ContextEvent = typeof ContextEvent.Type

export class AgentError extends Schema.TaggedError<AgentError>()(
  "AgentError",
  {
    message: Schema.String,
    provider: LlmProviderId,
    cause: Schema.optionalWith(Schema.Defect, { as: "Option" })
  }
) {}

export class ReducerError extends Schema.TaggedError<ReducerError>()(
  "ReducerError",
  {
    message: Schema.String,
    event: Schema.optionalWith(ContextEvent, { as: "Option" })
  }
) {}

export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()(
  "AgentNotFoundError",
  {
    agentName: AgentName
  }
) {}

export class AgentLoadError extends Schema.TaggedError<AgentLoadError>()(
  "AgentLoadError",
  {
    agentName: AgentName,
    message: Schema.String,
    cause: Schema.optionalWith(Schema.Defect, { as: "Option" })
  }
) {}

export class AgentSaveError extends Schema.TaggedError<AgentSaveError>()(
  "AgentSaveError",
  {
    agentName: AgentName,
    message: Schema.String,
    cause: Schema.optionalWith(Schema.Defect, { as: "Option" })
  }
) {}

export const MiniAgentError = Schema.Union(AgentNotFoundError, AgentLoadError, AgentSaveError)
export type MiniAgentError = typeof MiniAgentError.Type

/**
 * Agent service - makes LLM requests with retry and fallback.
 *
 * takeTurn: Execute an agent turn using config from ReducedContext.
 * Returns a stream of events during the turn.
 */
export class Agent extends Context.Tag("@app/Agent")<
  Agent,
  {
    readonly takeTurn: (ctx: ReducedContext) => Stream.Stream<ContextEvent, AgentError>
  }
>() {
  static readonly layer: Layer.Layer<Agent> = undefined as never
}

/**
 * EventReducer folds events into a ReducedContext ready for an agent turn.
 *
 * The reducer derives ALL actor state from events - no separate refs needed.
 *
 * It looks at event types to update state:
 * - SetLlmProviderConfigEvent → config.primary or config.fallback
 * - SetTimeoutEvent → config.timeoutMs
 * - SystemPromptEvent, UserMessageEvent, etc. → messages array
 * - AgentTurnStartedEvent → agentTurnStartedAtEventId=Some(eventId), increment currentTurnNumber
 * - AgentTurnCompletedEvent/FailedEvent → agentTurnStartedAtEventId=None
 * - Any event → increment nextEventNumber
 *
 * Everything the actor needs is in ReducedContext.
 * The actor just stores events, runs reducer, calls Agent when needed.
 */
export class EventReducer extends Context.Tag("@app/EventReducer")<
  EventReducer,
  {
    readonly reduce: (
      current: ReducedContext,
      newEvents: ReadonlyArray<ContextEvent>
    ) => Effect.Effect<ReducedContext, ReducerError>

    readonly initialReducedContext: ReducedContext
  }
>() {
  /** Default reducer - keeps all messages, no truncation */
  static readonly layer: Layer.Layer<EventReducer> = undefined as never
}

/**
 * EventStore handles persistence of agent events.
 *
 * This is a pluggable interface - implementations can be:
 * - YamlFileStore: Persists to YAML files on disk
 * - InMemoryStore: For tests (no disk I/O)
 * - PostgresStore: For future distributed deployment
 */
export class EventStore extends Context.Tag("@app/EventStore")<
  EventStore,
  {
    readonly load: (name: AgentName) => Effect.Effect<ReadonlyArray<ContextEvent>, AgentLoadError>
    readonly append: (name: AgentName, events: ReadonlyArray<ContextEvent>) => Effect.Effect<void, AgentSaveError>
    readonly exists: (name: AgentName) => Effect.Effect<boolean>
  }
>() {
  /** YAML file storage - persists to .mini-agent/<agentName>.yaml */
  static readonly yamlFileLayer: Layer.Layer<EventStore> = undefined as never

  /** In-memory storage - for tests, no disk I/O */
  static readonly inMemoryLayer: Layer.Layer<EventStore> = undefined as never

  static readonly testLayer = EventStore.inMemoryLayer
}

/**
 * MiniAgent represents a single agent as an actor.
 *
 * Each agent encapsulates:
 * - agentName: The agent's unique identifier
 * - Internal state is ONLY:
 *   1. events (context): List of ContextEvents (the event log)
 *   2. reducedContext: ALL derived state from reducer
 * - No separate counters or flags - all derived via reducer
 *
 * Actor behavior:
 * - Stores events (event log)
 * - Runs reducer to get current state
 * - Calls Agent service when event has triggersAgentTurn=true (with 100ms debounce)
 * - Broadcasts events to subscribers
 *
 * The agent is scoped - when the scope closes, the agent shuts down gracefully.
 *
 * IMPLEMENTATION NOTE: Use Effect's Mailbox + Stream.broadcastDynamic pattern:
 * - Mailbox.make<ContextEvent>() for input
 * - Stream.broadcastDynamic(Mailbox.toStream(mailbox), { capacity: "unbounded" })
 * - Each execution of the `events` stream creates a new subscriber (fan-out)
 * - Late subscribers miss events (live stream, not replay/event-sourcing)
 * - For historical events, use getEvents
 *
 * Processing is triggered by events with triggersAgentTurn=true, not by event type.
 */
export class MiniAgent extends Context.Tag("@app/MiniAgent")<
  MiniAgent,
  {
    /** The agent name this instance manages */
    readonly agentName: AgentName

    /**
     * Add an event to the agent (fire and forget).
     *
     * Flow:
     * 1. Persist event immediately via EventStore
     * 2. Update in-memory events list
     * 3. Run reducer to update reducedContext
     * 4. Offer to mailbox (broadcasts to all subscribers)
     * 5. If event.triggersAgentTurn, starts 100ms debounce timer for processing
     */
    readonly addEvent: (event: ContextEvent) => Effect.Effect<void, MiniAgentError>

    /**
     * Event stream - each execution creates a new subscriber.
     *
     * Uses Stream.broadcastDynamic internally which maintains a PubSub.
     * Multiple subscribers each receive all events (fan-out).
     *
     * NOTE: This is a LIVE stream - late subscribers only receive events
     * published AFTER they subscribe. For historical events, use getEvents.
     */
    readonly events: Stream.Stream<ContextEvent, never>

    /**
     * Get all events currently in the agent (from in-memory state).
     * Use this for historical events since `events` stream is live-only.
     */
    readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>

    /**
     * Gracefully shutdown the agent.
     * Completes any in-flight processing, emits SessionEndedEvent, closes streams.
     */
    readonly shutdown: Effect.Effect<void>
  }
>() {
  /**
   * Create an agent instance.
   * Returns a scoped layer that manages the agent's lifecycle.
   *
   * The EventStore is injected - use different implementations for prod vs test:
   * - EventStore.yamlFileLayer for production (persists to disk)
   * - EventStore.inMemoryLayer for tests (no disk I/O)
   */
  static readonly make: (
    agentName: AgentName
  ) => Layer.Layer<MiniAgent, MiniAgentError, Agent | EventReducer | EventStore> =
    undefined as never
}

/**
 * AgentRegistry manages multiple MiniAgent instances.
 *
 * Responsibilities:
 * - Create agents on demand (lazy initialization)
 * - Cache agents by name
 * - Route events to correct agent
 * - Graceful shutdown of all agents
 *
 * In the future, this could be replaced by @effect/cluster Sharding.
 */
export class AgentRegistry extends Context.Tag("@app/AgentRegistry")<
  AgentRegistry,
  {
    /**
     * Get or create an agent.
     * Agents are cached - subsequent calls return the same instance.
     */
    readonly getOrCreate: (agentName: AgentName) => Effect.Effect<MiniAgent, MiniAgentError>

    /**
     * Get an existing agent (fails if not found).
     */
    readonly get: (agentName: AgentName) => Effect.Effect<MiniAgent, AgentNotFoundError>

    /**
     * List all active agent names.
     */
    readonly list: Effect.Effect<ReadonlyArray<AgentName>>

    /**
     * Shutdown a specific agent.
     */
    readonly shutdownAgent: (agentName: AgentName) => Effect.Effect<void, AgentNotFoundError>

    /**
     * Shutdown all agents gracefully.
     */
    readonly shutdownAll: Effect.Effect<void>
  }
>() {
  static readonly layer: Layer.Layer<AgentRegistry, never, Agent | EventReducer | EventStore> =
    undefined as never
}

export const sampleProgram = Effect.gen(function*() {
  const registry = yield* AgentRegistry
  const agentName = AgentName.make("chat")

  // Get or create agent
  const agent = yield* registry.getOrCreate(agentName)

  // Subscribe to event stream
  const streamFiber = yield* agent.events.pipe(
    Stream.tap((event) => Effect.log(`Event: ${event._tag}`)),
    Stream.runDrain,
    Effect.fork
  )

  // First event has no parent
  const firstEvent = new UserMessageEvent({
    id: makeEventId(agentName, 0),
    timestamp: new Date() as never, // DateTime.unsafeNow() in real code
    agentName,
    parentEventId: Option.none(),
    triggersAgentTurn: true, // This triggers the LLM request
    content: "Hello, how are you?"
  })
  yield* agent.addEvent(firstEvent)

  // Agent will respond with events linking back to the first event
  // For example, the AssistantMessageEvent would have:
  // parentEventId: Option.some(firstEvent.id)

  // Wait for response events...
  yield* Effect.sleep(Duration.seconds(5))

  // Add another message - links to previous message for context
  const secondEvent = new UserMessageEvent({
    id: makeEventId(agentName, 5), // Assuming events 1-4 were generated by agent
    timestamp: new Date() as never,
    agentName,
    parentEventId: Option.some(firstEvent.id), // Links to what we're responding to
    triggersAgentTurn: true,
    content: "Tell me more"
  })
  yield* agent.addEvent(secondEvent)

  yield* Effect.sleep(Duration.seconds(5))

  // Graceful shutdown
  yield* registry.shutdownAll()
  yield* Fiber.await(streamFiber)
})

/**
 * FUTURE: Everything driven by events
 *
 * The philosophy is "Agent events are all you need":
 * - LLM config: SetLlmProviderConfigEvent (already implemented)
 * - Timeouts: SetTimeoutEvent (already implemented)
 * - Retry config: SetRetryConfigEvent (future - will define Schedule via event)
 * - Tools: DefineToolEvent (future - will define callable tools)
 * - Workflows: DefineWorkflowEvent (future - will define multi-step workflows)
 * - Memory: SetMemoryConfigEvent (future - vector store, summarization)
 *
 * All these reduce to ReducedContext which drives the agent.
 *
 * FUTURE: Agent Forking
 *
 * The parentEventId field enables agent forking - where an agent can branch
 * into multiple parallel execution paths. For example:
 * - Event A (parentEventId: none)
 *   - Event B (parentEventId: A) → continues main path
 *   - Event C (parentEventId: A) → forks to explore alternative
 *
 * This allows exploring multiple reasoning paths, A/B testing responses,
 * or running speculative computations in parallel.
 *
 * FUTURE: @effect/cluster Distribution
 *
 * To distribute in the future:
 * 1. Replace MiniAgent with Entity
 * 2. Replace AgentRegistry with Sharding
 * 3. Use persistent EventStore (Postgres/Redis)
 * 4. Configure cluster nodes and discovery
 */
