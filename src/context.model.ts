/**
 * Context Event Schemas
 *
 * A Context is a named, append-only event log. All events share BaseEventFields
 * (id, timestamp, contextName, parentEventId) enabling tracing and future forking.
 *
 * Event Categories:
 * - Content: SystemPrompt, UserMessage, AssistantMessage, FileAttachment, TextDelta
 * - Configuration: SetLlmConfig, SetTimeout
 * - Lifecycle: SessionStarted, SessionEnded, AgentTurnStarted, AgentTurnCompleted, etc.
 */
import type { Prompt } from "@effect/ai"
import { DateTime, Option, Schema } from "effect"
import type { LlmConfig } from "./llm-config.ts"

/** Branded type for context names */
export const ContextName = Schema.String.pipe(Schema.brand("ContextName"))
export type ContextName = typeof ContextName.Type

/** Branded type for event IDs */
export const EventId = Schema.String.pipe(Schema.brand("EventId"))
export type EventId = typeof EventId.Type

/** Generate a new event ID */
export const makeEventId = (): EventId => crypto.randomUUID() as EventId

/**
 * Base fields shared by ALL events.
 * parentEventId enables future forking - events can reference their causal parent.
 */
export const BaseEventFields = {
  id: EventId,
  timestamp: Schema.DateTimeUtc,
  contextName: ContextName,
  parentEventId: Schema.optionalWith(EventId, { as: "Option" })
}

/** Helper to create base event fields */
export const makeBaseFields = (contextName: ContextName, parentEventId?: EventId) => ({
  id: makeEventId(),
  timestamp: DateTime.unsafeNow(),
  contextName,
  parentEventId: parentEventId ? Option.some(parentEventId) : Option.none()
})

/** System prompt event - sets the AI's behavior */
export class SystemPromptEvent extends Schema.TaggedClass<SystemPromptEvent>()(
  "SystemPrompt",
  {
    ...BaseEventFields,
    content: Schema.String
  }
) {}

/** User message event - input from the user */
export class UserMessageEvent extends Schema.TaggedClass<UserMessageEvent>()(
  "UserMessage",
  {
    ...BaseEventFields,
    content: Schema.String
  }
) {}

/** Assistant message event - complete response from the AI */
export class AssistantMessageEvent extends Schema.TaggedClass<AssistantMessageEvent>()(
  "AssistantMessage",
  {
    ...BaseEventFields,
    content: Schema.String
  }
) {}

/** Text delta event - streaming chunk (ephemeral, not persisted) */
export class TextDeltaEvent extends Schema.TaggedClass<TextDeltaEvent>()(
  "TextDelta",
  {
    ...BaseEventFields,
    delta: Schema.String
  }
) {}

/** Attachment source - local file path or remote URL */
export const AttachmentSource = Schema.Union(
  Schema.Struct({ type: Schema.Literal("file"), path: Schema.String }),
  Schema.Struct({ type: Schema.Literal("url"), url: Schema.String })
)
export type AttachmentSource = typeof AttachmentSource.Type

/** File attachment event - image or other file shared with AI */
export class FileAttachmentEvent extends Schema.TaggedClass<FileAttachmentEvent>()(
  "FileAttachment",
  {
    ...BaseEventFields,
    source: AttachmentSource,
    mediaType: Schema.String,
    fileName: Schema.optional(Schema.String)
  }
) {}

/** Sets the LLM config for this context */
export class SetLlmConfigEvent extends Schema.TaggedClass<SetLlmConfigEvent>()(
  "SetLlmConfig",
  {
    ...BaseEventFields,
    apiFormat: Schema.String,
    model: Schema.String,
    baseUrl: Schema.String,
    apiKeyEnvVar: Schema.String
  }
) {}

/** Sets the timeout for agent turns */
export class SetTimeoutEvent extends Schema.TaggedClass<SetTimeoutEvent>()(
  "SetTimeout",
  {
    ...BaseEventFields,
    timeoutMs: Schema.Number.pipe(Schema.positive())
  }
) {}

/** Session started - emitted when a context session is initialized */
export class SessionStartedEvent extends Schema.TaggedClass<SessionStartedEvent>()(
  "SessionStarted",
  { ...BaseEventFields }
) {}

/** Session ended - emitted when a context session is closed */
export class SessionEndedEvent extends Schema.TaggedClass<SessionEndedEvent>()(
  "SessionEnded",
  { ...BaseEventFields }
) {}

/** Agent turn started - emitted when an agent turn begins */
export class AgentTurnStartedEvent extends Schema.TaggedClass<AgentTurnStartedEvent>()(
  "AgentTurnStarted",
  { ...BaseEventFields }
) {}

/** Agent turn completed - emitted when an agent turn finishes successfully */
export class AgentTurnCompletedEvent extends Schema.TaggedClass<AgentTurnCompletedEvent>()(
  "AgentTurnCompleted",
  {
    ...BaseEventFields,
    durationMs: Schema.Number
  }
) {}

/** Agent turn interrupted - emitted when a turn is cancelled (e.g., new user input) */
export class AgentTurnInterruptedEvent extends Schema.TaggedClass<AgentTurnInterruptedEvent>()(
  "AgentTurnInterrupted",
  {
    ...BaseEventFields,
    reason: Schema.String,
    partialResponse: Schema.optional(Schema.String)
  }
) {}

/** Agent turn failed - emitted when an agent turn fails */
export class AgentTurnFailedEvent extends Schema.TaggedClass<AgentTurnFailedEvent>()(
  "AgentTurnFailed",
  {
    ...BaseEventFields,
    error: Schema.String
  }
) {}

/** Events that get persisted to the context file */
export const PersistedEvent = Schema.Union(
  // Content events
  SystemPromptEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  FileAttachmentEvent,
  // Configuration events
  SetLlmConfigEvent,
  SetTimeoutEvent,
  // Lifecycle events
  SessionStartedEvent,
  SessionEndedEvent,
  AgentTurnStartedEvent,
  AgentTurnCompletedEvent,
  AgentTurnInterruptedEvent,
  AgentTurnFailedEvent
)
export type PersistedEvent = typeof PersistedEvent.Type

/** All possible context events (persisted + ephemeral) */
export const ContextEvent = Schema.Union(
  // Content events
  SystemPromptEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  FileAttachmentEvent,
  TextDeltaEvent,
  // Configuration events
  SetLlmConfigEvent,
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

/** Input events that can be added by users */
export const InputEvent = Schema.Union(UserMessageEvent, FileAttachmentEvent)
export type InputEvent = typeof InputEvent.Type

/**
 * ReducedContext - the output of the reducer, input to the Agent.
 * Uses @effect/ai Prompt.Message for LLM messages.
 */
export interface ReducedContext {
  readonly messages: ReadonlyArray<Prompt.Message>
  readonly llmConfig: LlmConfig
  readonly timeoutMs: number
}

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful, friendly assistant.
Keep your responses concise but informative.
Use markdown formatting when helpful.`

export const DEFAULT_TIMEOUT_MS = 60000
