/**
 * Complete type definitions for the MiniAgent Architecture.
 *
 * Uses Effect.Service pattern for singleton services.
 * MiniAgent is NOT a service - it's an interface for agent instances managed by AgentRegistry.
 *
 * Philosophy: "Agent events are all you need"
 * - Everything the agent does is driven by events
 * - Events reduce to state, state drives the agent
 * - Configuration comes from events (SetLlmConfigEvent, etc.)
 *
 * Key design decisions:
 * - All events share BaseEventFields (id, timestamp, agentName, triggersAgentTurn, parentEventId)
 * - triggersAgentTurn property on ALL events determines if LLM request should happen
 * - parentEventId enables proper event linking (MVP feature, not future)
 * - Uses @effect/ai Prompt.Message for LLM messages (not custom types)
 * - Single ContextEvent union - no InputEvent/StreamEvent distinction
 *
 * Services (Effect.Service singletons):
 * - MiniAgentTurn: Executes LLM requests
 * - EventReducer: Folds events into ReducedContext
 * - EventStore: Persists events
 * - AgentRegistry: Creates/manages MiniAgent instances
 *
 * MiniAgent (interface, not service):
 * - Represents a single agent instance with its own event log
 * - Created by AgentRegistry.getOrCreate()
 * - Has agentName, addEvent, events stream, getEvents, shutdown
 */

import type { Prompt } from "@effect/ai"
import { Duration, Effect, Fiber, Option, Redacted, Schema, Stream } from "effect"

/** Identity of an agent (e.g., "chat", "assistant") */
export const AgentName = Schema.String.pipe(Schema.brand("AgentName"))
export type AgentName = typeof AgentName.Type

/**
 * Identity of an event log (e.g., "chat-v1", "chat-2024-01-15").
 * A Context is a named, ordered list of events.
 * Agents can switch contexts without callers knowing (see future: context bricking).
 */
export const ContextName = Schema.String.pipe(Schema.brand("ContextName"))
export type ContextName = typeof ContextName.Type

export const LlmProviderId = Schema.String.pipe(Schema.brand("LlmProviderId"))
export type LlmProviderId = typeof LlmProviderId.Type

/**
 * Globally unique event identifier with format: {contextName}:{counter}
 * Examples: "chat-v1:0001", "chat-v1:0002"
 * Counter is sequential within each context.
 */
export const EventId = Schema.String.pipe(Schema.brand("EventId"))
export type EventId = typeof EventId.Type

export const makeEventId = (contextName: ContextName, counter: number): EventId =>
  `${contextName}:${String(counter).padStart(4, "0")}` as EventId

export const AgentTurnNumber = Schema.Number.pipe(Schema.brand("AgentTurnNumber"))
export type AgentTurnNumber = typeof AgentTurnNumber.Type

/** Reason for agent turn interruption (matches current LLMRequestInterruptedEvent) */
export const InterruptReason = Schema.Literal("user_cancel", "user_new_message", "timeout")
export type InterruptReason = typeof InterruptReason.Type

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

/** Agent configuration derived from config events */
export class AgentConfig extends Schema.Class<AgentConfig>("AgentConfig")({
  primary: LlmProviderConfig,
  fallback: Schema.optionalWith(LlmProviderConfig, { as: "Option" }),
  timeoutMs: Schema.Number.pipe(Schema.positive())
}) {}

/**
 * ALL actor state derived from events.
 *
 * Includes LLM messages, config from events, and internal state (counters, flags).
 * The actor stores events + reducedContext only - no separate refs.
 */
export interface ReducedContext {
  readonly messages: ReadonlyArray<Prompt.Message>
  readonly config: AgentConfig
  readonly nextEventNumber: number
  readonly currentTurnNumber: AgentTurnNumber
  /** Some = turn in progress (started at that event), None = no turn in progress */
  readonly agentTurnStartedAtEventId: Option.Option<EventId>
}

/** Helper methods for ReducedContext */
export const ReducedContext = {
  /** Check if an agent turn is currently in progress */
  isAgentTurnInProgress: (ctx: ReducedContext): boolean =>
    Option.isSome(ctx.agentTurnStartedAtEventId),

  /** Get the next EventId for this context */
  nextEventId: (ctx: ReducedContext, contextName: ContextName): EventId =>
    makeEventId(contextName, ctx.nextEventNumber),

  /** Get parent event ID for new events (links to turn start) */
  parentEventId: (ctx: ReducedContext): Option.Option<EventId> =>
    ctx.agentTurnStartedAtEventId
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

/** Attachment source - local file path or remote URL (matches current implementation) */
export const AttachmentSource = Schema.Union(
  Schema.Struct({ type: Schema.Literal("file"), path: Schema.String }),
  Schema.Struct({ type: Schema.Literal("url"), url: Schema.String })
)
export type AttachmentSource = typeof AttachmentSource.Type

export class FileAttachmentEvent extends Schema.TaggedClass<FileAttachmentEvent>()(
  "FileAttachmentEvent",
  {
    ...BaseEventFields,
    source: AttachmentSource,
    mediaType: Schema.String,
    fileName: Schema.optionalWith(Schema.String, { as: "Option" })
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

/**
 * LLM configuration event - flattened structure for event sourcing.
 * Current implementation uses nested LlmConfig object; this uses flat fields.
 * asFallback=true sets this as the fallback provider.
 */
export class SetLlmConfigEvent extends Schema.TaggedClass<SetLlmConfigEvent>()(
  "SetLlmConfig",
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
    reason: InterruptReason,
    /** Partial response generated before interruption (if any) */
    partialResponse: Schema.optionalWith(Schema.String, { as: "Option" })
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
  SetLlmConfigEvent,
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

export class ContextLoadError extends Schema.TaggedError<ContextLoadError>()(
  "ContextLoadError",
  {
    contextName: ContextName,
    message: Schema.String,
    cause: Schema.optionalWith(Schema.Defect, { as: "Option" })
  }
) {}

export class ContextSaveError extends Schema.TaggedError<ContextSaveError>()(
  "ContextSaveError",
  {
    contextName: ContextName,
    message: Schema.String,
    cause: Schema.optionalWith(Schema.Defect, { as: "Option" })
  }
) {}

export const MiniAgentError = Schema.Union(AgentNotFoundError, ContextLoadError, ContextSaveError)
export type MiniAgentError = typeof MiniAgentError.Type

/**
 * MiniAgentTurn executes a single agent turn (LLM request).
 * Takes ReducedContext, returns stream of events (TextDelta, AssistantMessage).
 * Handles retry with exponential backoff and fallback to secondary provider.
 */
export class MiniAgentTurn extends Effect.Service<MiniAgentTurn>()("@mini-agent/MiniAgentTurn", {
  succeed: {
    execute: (_ctx: ReducedContext): Stream.Stream<ContextEvent, AgentError> =>
      Stream.fail(new AgentError({ message: "MiniAgentTurn not implemented", provider: "none" as LlmProviderId, cause: Option.none() }))
  },
  accessors: true
}) {}

/** Default stub config for design-time type checking */
const stubLlmProviderConfig = new LlmProviderConfig({
  providerId: "stub" as LlmProviderId,
  model: "stub-model",
  apiKey: Redacted.make("stub-api-key"),
  baseUrl: Option.none()
})

const stubAgentConfig = new AgentConfig({
  primary: stubLlmProviderConfig,
  fallback: Option.none(),
  timeoutMs: 30000
})

const stubReducedContext: ReducedContext = {
  messages: [],
  config: stubAgentConfig,
  nextEventNumber: 0,
  currentTurnNumber: 1 as AgentTurnNumber,
  agentTurnStartedAtEventId: Option.none()
}

/**
 * EventReducer folds events into ReducedContext.
 *
 * Updates state based on event types:
 * - Config events (SetLlmConfigEvent, SetTimeoutEvent) → config
 * - Message events (SystemPromptEvent, UserMessageEvent, etc.) → messages
 * - Turn events (AgentTurnStartedEvent, AgentTurnCompletedEvent) → agentTurnStartedAtEventId, currentTurnNumber
 * - All events → increment nextEventNumber
 *
 * Real implementation provides EventReducer.Default layer.
 */
export class EventReducer extends Effect.Service<EventReducer>()("@mini-agent/EventReducer", {
  succeed: {
    reduce: (
      current: ReducedContext,
      _newEvents: ReadonlyArray<ContextEvent>
    ): Effect.Effect<ReducedContext, ReducerError> => Effect.succeed(current),
    initialReducedContext: stubReducedContext
  },
  accessors: true
}) {}

/**
 * EventStore persists context events.
 * A context is a named list of events - the store deals in ContextName, not AgentName.
 * Pluggable: YamlFileStore (disk), InMemoryStore (tests), PostgresStore (future).
 */
export class EventStore extends Effect.Service<EventStore>()("@mini-agent/EventStore", {
  succeed: {
    load: (_contextName: ContextName): Effect.Effect<ReadonlyArray<ContextEvent>, ContextLoadError> =>
      Effect.succeed([]),
    append: (_contextName: ContextName, _events: ReadonlyArray<ContextEvent>): Effect.Effect<void, ContextSaveError> =>
      Effect.void,
    exists: (_contextName: ContextName): Effect.Effect<boolean> =>
      Effect.succeed(false)
  },
  accessors: true
}) {}

/**
 * MiniAgent is a single agent instance (NOT a service).
 * Created and managed by AgentRegistry.getOrCreate().
 *
 * Has agentName (identity) and contextName (where events are stored).
 * These are separate so agents can switch contexts (see future: context bricking).
 *
 * Implementation uses: Mailbox for input, Stream.broadcastDynamic for fan-out.
 * Late subscribers miss historical events (use getEvents for history).
 */
export interface MiniAgent {
  readonly agentName: AgentName
  readonly contextName: ContextName

  /** Add event: persist → update state → broadcast → maybe trigger turn (100ms debounce) */
  readonly addEvent: (event: ContextEvent) => Effect.Effect<void, MiniAgentError>

  /** LIVE event stream - each call creates new subscriber. Late subscribers miss history. */
  readonly tapEventStream: Effect.Effect<Stream.Stream<ContextEvent, never>, never, Scope.Scope>

  /** Get all events from in-memory state (for historical events) */
  readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>

  /** Get current derived state */
  readonly getState: Effect.Effect<ReducedContext>

  /** Gracefully shutdown: complete in-flight work, emit SessionEndedEvent, close streams */
  readonly shutdown: Effect.Effect<void>
}

/**
 * AgentRegistry manages MiniAgent instances.
 * Creates agents on demand, caches them, handles graceful shutdown.
 * Future: replace with @effect/cluster Sharding.
 *
 * Dependencies: MiniAgentTurn, EventReducer, EventStore
 */
export class AgentRegistry extends Effect.Service<AgentRegistry>()("@mini-agent/AgentRegistry", {
  succeed: {
    getOrCreate: (agentName: AgentName): Effect.Effect<MiniAgent, MiniAgentError> =>
      Effect.fail(new ContextLoadError({
        contextName: `${agentName}-v1` as ContextName,
        message: "AgentRegistry stub - not implemented",
        cause: Option.none()
      })),
    get: (agentName: AgentName): Effect.Effect<MiniAgent, AgentNotFoundError> =>
      Effect.fail(new AgentNotFoundError({ agentName })),
    list: Effect.succeed([]),
    shutdownAgent: (agentName: AgentName): Effect.Effect<void, AgentNotFoundError> =>
      Effect.fail(new AgentNotFoundError({ agentName })),
    shutdownAll: Effect.void
  },
  accessors: true
}) {}

export const sampleProgram = Effect.gen(function*() {
  const registry = yield* AgentRegistry
  const agentName = "chat" as AgentName

  // Get or create agent - contextName is assigned by registry (e.g., "chat-v1")
  const agent = yield* registry.getOrCreate(agentName)

  // Subscribe to event stream
  const eventStream = yield* agent.tapEventStream
  const streamFiber = yield* eventStream.pipe(
    Stream.tap((event) => Effect.log(`Event: ${event._tag}`)),
    Stream.runDrain,
    Effect.fork
  )

  // First event has no parent, uses agent's contextName for EventId
  const firstEvent = new UserMessageEvent({
    id: makeEventId(agent.contextName, 0),
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
    id: makeEventId(agent.contextName, 5), // Assuming events 1-4 were generated by agent
    timestamp: new Date() as never,
    agentName,
    parentEventId: Option.some(firstEvent.id), // Links to what we're responding to
    triggersAgentTurn: true,
    content: "Tell me more"
  })
  yield* agent.addEvent(secondEvent)

  yield* Effect.sleep(Duration.seconds(5))

  // Graceful shutdown
  yield* registry.shutdownAll
  yield* Fiber.await(streamFiber)
})

/**
 * FUTURE: Everything driven by events
 *
 * The philosophy is "Agent events are all you need":
 * - LLM config: SetLlmConfigEvent (already implemented)
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
