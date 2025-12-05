/**
 * Actor Model Types
 *
 * Defines the core types for the actor-based event architecture.
 * Each Context is modeled as an Actor with:
 * - addEvent: fire-and-forget input
 * - events: continuous output stream
 *
 * Designed for single-process now, future-ready for @effect/cluster distribution.
 */
import { DateTime, Schema } from "effect"

// =============================================================================
// Branded Types
// =============================================================================

export const ContextName = Schema.String.pipe(Schema.brand("ContextName"))
export type ContextName = typeof ContextName.Type

export const EventId = Schema.String.pipe(Schema.brand("EventId"))
export type EventId = typeof EventId.Type

export const LlmProviderId = Schema.String.pipe(Schema.brand("LlmProviderId"))
export type LlmProviderId = typeof LlmProviderId.Type

// =============================================================================
// Base Event Fields
// =============================================================================

/**
 * All context events must have these fields.
 * Use spread: { ...BaseEventFields, myField: Schema.String }
 *
 * parentEventId enables future forking - events can reference their causal parent.
 */
export const BaseEventFields = {
  id: EventId,
  timestamp: Schema.DateTimeUtc,
  contextName: ContextName,
  parentEventId: Schema.optionalWith(EventId, { as: "Option" })
}

// Helper to generate event id and timestamp
export const makeEventMeta = (contextName: ContextName, parentEventId?: EventId) => ({
  id: EventId.make(crypto.randomUUID()),
  timestamp: DateTime.unsafeNow(),
  contextName,
  parentEventId: parentEventId ? { _tag: "Some" as const, value: parentEventId } : { _tag: "None" as const }
})

// =============================================================================
// Content Events
// =============================================================================

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

// =============================================================================
// Configuration Events
// =============================================================================

export class LlmProviderConfig extends Schema.Class<LlmProviderConfig>("LlmProviderConfig")({
  providerId: LlmProviderId,
  model: Schema.String,
  apiKey: Schema.Redacted(Schema.String),
  baseUrl: Schema.optionalWith(Schema.String, { as: "Option" })
}) {}

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

// =============================================================================
// Lifecycle Events
// =============================================================================

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
  { ...BaseEventFields }
) {}

export class AgentTurnCompletedEvent extends Schema.TaggedClass<AgentTurnCompletedEvent>()(
  "AgentTurnCompletedEvent",
  {
    ...BaseEventFields,
    durationMs: Schema.Number
  }
) {}

export class AgentTurnInterruptedEvent extends Schema.TaggedClass<AgentTurnInterruptedEvent>()(
  "AgentTurnInterruptedEvent",
  {
    ...BaseEventFields,
    reason: Schema.String
  }
) {}

export class AgentTurnFailedEvent extends Schema.TaggedClass<AgentTurnFailedEvent>()(
  "AgentTurnFailedEvent",
  {
    ...BaseEventFields,
    error: Schema.String
  }
) {}

// =============================================================================
// Event Unions
// =============================================================================

/** Events that trigger LLM processing when added */
export const TriggerEvent = Schema.Union(UserMessageEvent)
export type TriggerEvent = typeof TriggerEvent.Type

/** Events that get persisted to storage */
export const PersistedEvent = Schema.Union(
  SystemPromptEvent,
  UserMessageEvent,
  FileAttachmentEvent,
  AssistantMessageEvent,
  SetLlmProviderConfigEvent,
  SetTimeoutEvent,
  SessionStartedEvent,
  SessionEndedEvent,
  AgentTurnStartedEvent,
  AgentTurnCompletedEvent,
  AgentTurnInterruptedEvent,
  AgentTurnFailedEvent
)
export type PersistedEvent = typeof PersistedEvent.Type

/** Ephemeral events (not persisted) */
export const EphemeralEvent = Schema.Union(TextDeltaEvent)
export type EphemeralEvent = typeof EphemeralEvent.Type

/** All context events */
export const ContextEvent = Schema.Union(
  // Content events
  SystemPromptEvent,
  UserMessageEvent,
  FileAttachmentEvent,
  AssistantMessageEvent,
  TextDeltaEvent,
  // Configuration events
  SetLlmProviderConfigEvent,
  SetTimeoutEvent,
  // Lifecycle events
  SessionStartedEvent,
  SessionEndedEvent,
  AgentTurnStartedEvent,
  AgentTurnCompletedEvent,
  AgentTurnInterruptedEvent,
  AgentTurnFailedEvent
)
export type ContextEvent = typeof ContextEvent.Type

// Type guards
export const isPersistedEvent = Schema.is(PersistedEvent)
export const isTriggerEvent = Schema.is(TriggerEvent)
export const isUserMessageEvent = Schema.is(UserMessageEvent)

// =============================================================================
// Errors
// =============================================================================

export class ActorError extends Schema.TaggedError<ActorError>()(
  "ActorError",
  {
    contextName: ContextName,
    message: Schema.String,
    cause: Schema.optionalWith(Schema.Defect, { as: "Option" })
  }
) {}

export class ActorNotFoundError extends Schema.TaggedError<ActorNotFoundError>()(
  "ActorNotFoundError",
  { contextName: ContextName }
) {}

export class EventPersistError extends Schema.TaggedError<EventPersistError>()(
  "EventPersistError",
  {
    contextName: ContextName,
    message: Schema.String,
    cause: Schema.optionalWith(Schema.Defect, { as: "Option" })
  }
) {}
