/**
 * Domain types for the MiniAgent actor architecture.
 *
 * Philosophy: "Agent events are all you need"
 * - Events are the fundamental unit
 * - All state derives from reducing events
 * - triggersAgentTurn on events (not event type) determines LLM requests
 */

import type { Prompt } from "@effect/ai"
import { DateTime, Effect, Option, Redacted, Schema, Stream } from "effect"

// -----------------------------------------------------------------------------
// Branded Types
// -----------------------------------------------------------------------------

export const AgentName = Schema.String.pipe(Schema.brand("AgentName"))
export type AgentName = typeof AgentName.Type

export const ContextName = Schema.String.pipe(Schema.brand("ContextName"))
export type ContextName = typeof ContextName.Type

export const EventId = Schema.String.pipe(Schema.brand("EventId"))
export type EventId = typeof EventId.Type

export const LlmProviderId = Schema.String.pipe(Schema.brand("LlmProviderId"))
export type LlmProviderId = typeof LlmProviderId.Type

export const AgentTurnNumber = Schema.Number.pipe(Schema.brand("AgentTurnNumber"))
export type AgentTurnNumber = typeof AgentTurnNumber.Type

// -----------------------------------------------------------------------------
// Event ID Generation
// -----------------------------------------------------------------------------

export const makeEventId = (contextName: ContextName, counter: number): EventId =>
  `${contextName}:${String(counter).padStart(4, "0")}` as EventId

// -----------------------------------------------------------------------------
// Base Event Fields
// -----------------------------------------------------------------------------

export const BaseEventFields = {
  id: EventId,
  timestamp: Schema.DateTimeUtc,
  agentName: AgentName,
  parentEventId: Schema.optionalWith(EventId, { as: "Option" }),
  triggersAgentTurn: Schema.Boolean
}

// -----------------------------------------------------------------------------
// Config Types
// -----------------------------------------------------------------------------

export class LlmProviderConfig extends Schema.Class<LlmProviderConfig>("LlmProviderConfig")({
  providerId: LlmProviderId,
  model: Schema.String,
  apiKey: Schema.Redacted(Schema.String),
  baseUrl: Schema.optionalWith(Schema.String, { as: "Option" })
}) {}

export class AgentConfig extends Schema.Class<AgentConfig>("AgentConfig")({
  primary: LlmProviderConfig,
  fallback: Schema.optionalWith(LlmProviderConfig, { as: "Option" }),
  timeoutMs: Schema.Number.pipe(Schema.positive())
}) {}

// Default config for initial state
export const defaultAgentConfig = new AgentConfig({
  primary: new LlmProviderConfig({
    providerId: "openai" as LlmProviderId,
    model: "gpt-4o-mini",
    apiKey: Redacted.make(""),
    baseUrl: Option.none()
  }),
  fallback: Option.none(),
  timeoutMs: 30000
})

// -----------------------------------------------------------------------------
// Event Types - Content
// -----------------------------------------------------------------------------

export class SystemPromptEvent extends Schema.TaggedClass<SystemPromptEvent>()(
  "SystemPromptEvent",
  { ...BaseEventFields, content: Schema.String }
) {}

export class UserMessageEvent extends Schema.TaggedClass<UserMessageEvent>()(
  "UserMessageEvent",
  { ...BaseEventFields, content: Schema.String }
) {}

export class AssistantMessageEvent extends Schema.TaggedClass<AssistantMessageEvent>()(
  "AssistantMessageEvent",
  { ...BaseEventFields, content: Schema.String }
) {}

export class TextDeltaEvent extends Schema.TaggedClass<TextDeltaEvent>()(
  "TextDeltaEvent",
  { ...BaseEventFields, delta: Schema.String }
) {}

// -----------------------------------------------------------------------------
// Event Types - Config
// -----------------------------------------------------------------------------

export class SetLlmConfigEvent extends Schema.TaggedClass<SetLlmConfigEvent>()(
  "SetLlmConfigEvent",
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
  { ...BaseEventFields, timeoutMs: Schema.Number }
) {}

// -----------------------------------------------------------------------------
// Event Types - Lifecycle
// -----------------------------------------------------------------------------

export const InterruptReason = Schema.Literal("user_cancel", "user_new_message", "timeout")
export type InterruptReason = typeof InterruptReason.Type

export class SessionStartedEvent extends Schema.TaggedClass<SessionStartedEvent>()(
  "SessionStartedEvent",
  { ...BaseEventFields }
) {}

export class SessionEndedEvent extends Schema.TaggedClass<SessionEndedEvent>()(
  "SessionEndedEvent",
  { ...BaseEventFields }
) {}

export class AgentTurnStartedEvent extends Schema.TaggedClass<AgentTurnStartedEvent>()(
  "AgentTurnStartedEvent",
  { ...BaseEventFields, turnNumber: AgentTurnNumber }
) {}

export class AgentTurnCompletedEvent extends Schema.TaggedClass<AgentTurnCompletedEvent>()(
  "AgentTurnCompletedEvent",
  { ...BaseEventFields, turnNumber: AgentTurnNumber, durationMs: Schema.Number }
) {}

export class AgentTurnInterruptedEvent extends Schema.TaggedClass<AgentTurnInterruptedEvent>()(
  "AgentTurnInterruptedEvent",
  {
    ...BaseEventFields,
    turnNumber: AgentTurnNumber,
    reason: InterruptReason,
    partialResponse: Schema.optionalWith(Schema.String, { as: "Option" })
  }
) {}

export class AgentTurnFailedEvent extends Schema.TaggedClass<AgentTurnFailedEvent>()(
  "AgentTurnFailedEvent",
  { ...BaseEventFields, turnNumber: AgentTurnNumber, error: Schema.String }
) {}

// -----------------------------------------------------------------------------
// Event Union
// -----------------------------------------------------------------------------

export const ContextEvent = Schema.Union(
  SystemPromptEvent,
  UserMessageEvent,
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

// -----------------------------------------------------------------------------
// Reduced Context
// -----------------------------------------------------------------------------

export interface ReducedContext {
  readonly messages: ReadonlyArray<Prompt.Message>
  readonly config: AgentConfig
  readonly nextEventNumber: number
  readonly currentTurnNumber: AgentTurnNumber
  readonly agentTurnStartedAtEventId: Option.Option<EventId>
}

export const ReducedContext = {
  isAgentTurnInProgress: (ctx: ReducedContext): boolean => Option.isSome(ctx.agentTurnStartedAtEventId),

  nextEventId: (ctx: ReducedContext, contextName: ContextName): EventId =>
    makeEventId(contextName, ctx.nextEventNumber),

  initial: (config: AgentConfig = defaultAgentConfig): ReducedContext => ({
    messages: [],
    config,
    nextEventNumber: 0,
    currentTurnNumber: 0 as AgentTurnNumber,
    agentTurnStartedAtEventId: Option.none()
  })
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

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
    eventTag: Schema.optionalWith(Schema.String, { as: "Option" })
  }
) {}

export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()(
  "AgentNotFoundError",
  { agentName: AgentName }
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

// -----------------------------------------------------------------------------
// Service Interfaces
// -----------------------------------------------------------------------------

/**
 * MiniAgentTurn executes a single LLM request.
 * Takes ReducedContext, returns stream of events.
 */
export class MiniAgentTurn extends Effect.Service<MiniAgentTurn>()("@mini-agent/MiniAgentTurn", {
  succeed: {
    execute: (_ctx: ReducedContext): Stream.Stream<ContextEvent, AgentError> =>
      Stream.fail(
        new AgentError({
          message: "MiniAgentTurn not implemented",
          provider: "none" as LlmProviderId,
          cause: Option.none()
        })
      )
  },
  accessors: true
}) {}

/**
 * MiniAgent interface - not a service, created by AgentRegistry.
 */
export interface MiniAgent {
  readonly agentName: AgentName
  readonly contextName: ContextName
  readonly addEvent: (event: ContextEvent) => Effect.Effect<void, ReducerError | ContextSaveError>
  readonly events: Stream.Stream<ContextEvent, never>
  readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>
  readonly getReducedContext: Effect.Effect<ReducedContext>
  readonly shutdown: Effect.Effect<void>
}

// -----------------------------------------------------------------------------
// Event Builders
// -----------------------------------------------------------------------------

export const EventBuilder = {
  makeBase: (
    agentName: AgentName,
    contextName: ContextName,
    nextEventNumber: number,
    triggersAgentTurn: boolean,
    parentEventId: Option.Option<EventId> = Option.none()
  ) => ({
    id: makeEventId(contextName, nextEventNumber),
    timestamp: DateTime.unsafeNow(),
    agentName,
    parentEventId,
    triggersAgentTurn
  }),

  userMessage: (
    agentName: AgentName,
    contextName: ContextName,
    nextEventNumber: number,
    content: string,
    triggersAgentTurn = true
  ) =>
    new UserMessageEvent({
      ...EventBuilder.makeBase(agentName, contextName, nextEventNumber, triggersAgentTurn),
      content
    }),

  systemPrompt: (
    agentName: AgentName,
    contextName: ContextName,
    nextEventNumber: number,
    content: string
  ) =>
    new SystemPromptEvent({
      ...EventBuilder.makeBase(agentName, contextName, nextEventNumber, false),
      content
    }),

  assistantMessage: (
    agentName: AgentName,
    contextName: ContextName,
    nextEventNumber: number,
    content: string,
    parentEventId: Option.Option<EventId> = Option.none()
  ) =>
    new AssistantMessageEvent({
      ...EventBuilder.makeBase(agentName, contextName, nextEventNumber, false, parentEventId),
      content
    }),

  sessionStarted: (
    agentName: AgentName,
    contextName: ContextName,
    nextEventNumber: number
  ) =>
    new SessionStartedEvent({
      ...EventBuilder.makeBase(agentName, contextName, nextEventNumber, false)
    }),

  sessionEnded: (
    agentName: AgentName,
    contextName: ContextName,
    nextEventNumber: number
  ) =>
    new SessionEndedEvent({
      ...EventBuilder.makeBase(agentName, contextName, nextEventNumber, false)
    }),

  agentTurnStarted: (
    agentName: AgentName,
    contextName: ContextName,
    nextEventNumber: number,
    turnNumber: AgentTurnNumber
  ) =>
    new AgentTurnStartedEvent({
      ...EventBuilder.makeBase(agentName, contextName, nextEventNumber, false),
      turnNumber
    }),

  agentTurnCompleted: (
    agentName: AgentName,
    contextName: ContextName,
    nextEventNumber: number,
    turnNumber: AgentTurnNumber,
    durationMs: number,
    parentEventId: Option.Option<EventId> = Option.none()
  ) =>
    new AgentTurnCompletedEvent({
      ...EventBuilder.makeBase(agentName, contextName, nextEventNumber, false, parentEventId),
      turnNumber,
      durationMs
    })
}
