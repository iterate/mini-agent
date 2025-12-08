/**
 * Domain types for the MiniAgent actor architecture.
 *
 * Philosophy: "Agent events are all you need"
 * - Events are the fundamental unit
 * - All state derives from reducing events
 * - triggersAgentTurn on events (not event type) determines LLM requests
 */

import type { Prompt } from "@effect/ai"
import { DateTime, Effect, Option, Schema, type Scope, Stream } from "effect"

// -----------------------------------------------------------------------------
// Branded Types
// -----------------------------------------------------------------------------

export const AgentName = Schema.String.pipe(Schema.brand("AgentName"))
export type AgentName = typeof AgentName.Type

export const ContextName = Schema.String.pipe(Schema.brand("ContextName"))
export type ContextName = typeof ContextName.Type

export const EventId = Schema.String.pipe(Schema.brand("EventId"))
export type EventId = typeof EventId.Type

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
  /**
   * Forms a blockchain-style chain where each event points to its predecessor.
   * The first event (genesis) has parentEventId = None.
   * Future: forking will allow multiple events to share the same parent.
   */
  parentEventId: Schema.optionalWith(EventId, { as: "Option" }),
  triggersAgentTurn: Schema.Boolean
}

// -----------------------------------------------------------------------------
// Config Types
// -----------------------------------------------------------------------------

export const ApiFormat = Schema.Literal("openai-responses", "openai-chat-completions", "anthropic", "gemini")
export type ApiFormat = typeof ApiFormat.Type

/**
 * LLM configuration - stored on ReducedContext.
 * Uses apiKeyEnvVar (env var name) not actual keys.
 */
export class LlmConfig extends Schema.Class<LlmConfig>("LlmConfig")({
  apiFormat: ApiFormat,
  model: Schema.String,
  baseUrl: Schema.String,
  apiKeyEnvVar: Schema.String
}) {}

// -----------------------------------------------------------------------------
// Event Types - Content
// -----------------------------------------------------------------------------

export class SystemPromptEvent extends Schema.TaggedClass<SystemPromptEvent>()(
  "SystemPromptEvent",
  { ...BaseEventFields, content: Schema.String }
) {}

export class UserMessageEvent extends Schema.TaggedClass<UserMessageEvent>()(
  "UserMessageEvent",
  {
    ...BaseEventFields,
    content: Schema.String,
    /** Optional array of image data URIs or URLs */
    images: Schema.optional(Schema.Array(Schema.String))
  }
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
    apiFormat: ApiFormat,
    model: Schema.String,
    baseUrl: Schema.String,
    apiKeyEnvVar: Schema.String
  }
) {}

// -----------------------------------------------------------------------------
// Event Types - Lifecycle
// -----------------------------------------------------------------------------

export const InterruptReason = Schema.Literal("user_cancel", "user_new_message", "timeout", "session_ended")
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
    partialResponse: Schema.optionalWith(Schema.String, { as: "Option" }),
    /**
     * When reason is "user_new_message", this holds the ID of the UserMessageEvent
     * that caused the interruption. Used by the UI to reorder display so the
     * interrupted assistant response appears before the interrupting user message.
     */
    interruptedByEventId: Schema.optionalWith(EventId, { as: "Option" })
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
  readonly llmConfig: Option.Option<LlmConfig>
  readonly nextEventNumber: number
  readonly currentTurnNumber: AgentTurnNumber
  readonly agentTurnStartedAtEventId: Option.Option<EventId>
}

export const ReducedContext = {
  isAgentTurnInProgress: (ctx: ReducedContext): boolean => Option.isSome(ctx.agentTurnStartedAtEventId),

  canMakeLlmCalls: (ctx: ReducedContext): boolean => Option.isSome(ctx.llmConfig),

  nextEventId: (ctx: ReducedContext, contextName: ContextName): EventId =>
    makeEventId(contextName, ctx.nextEventNumber),

  initial: (llmConfig: Option.Option<LlmConfig> = Option.none()): ReducedContext => ({
    messages: [],
    llmConfig,
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
    apiFormat: Schema.optionalWith(ApiFormat, { as: "Option" }),
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
          apiFormat: Option.none(),
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
  /** Fire-and-forget: queues event for processing and returns immediately */
  readonly addEvent: (event: ContextEvent) => Effect.Effect<void>
  /**
   * Tap the live event stream. When the returned Effect completes, the subscription
   * is established and ready to receive events emitted after that point.
   */
  readonly tapEventStream: Effect.Effect<Stream.Stream<ContextEvent, never>, never, Scope.Scope>
  readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>
  readonly getState: Effect.Effect<ReducedContext>
  /** Gracefully end session: emit SessionEndedEvent (with AgentTurnInterruptedEvent if mid-turn), then close mailbox */
  readonly endSession: Effect.Effect<void>
  /** True when no LLM turn is in progress */
  readonly isIdle: Effect.Effect<boolean>
  /** Interrupt the current turn if one is in progress. Emits AgentTurnInterruptedEvent with reason user_cancel. */
  readonly interruptTurn: Effect.Effect<void>
  /** @deprecated Use endSession instead. Kept for internal cleanup. */
  readonly shutdown: Effect.Effect<void>
}

// -----------------------------------------------------------------------------
// Event Field Helpers
// -----------------------------------------------------------------------------

/** Creates the common base fields for all events */
export const makeBaseEventFields = (
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
})

/**
 * Set parentEventId on a ContextEvent.
 * Schema.TaggedClass uses _tag for discrimination (not instanceof), so spread is safe.
 */
export const withParentEventId = <E extends ContextEvent>(
  event: E,
  parentEventId: Option.Option<EventId>
): E => ({ ...event, parentEventId }) as E
