import { Schema } from "effect"

// =============================================================================
// Event Schemas (using TaggedStruct for idiomatic tagged unions)
// =============================================================================

/** System prompt event - sets the AI's behavior */
export const SystemPromptEvent = Schema.TaggedStruct("SystemPrompt", {
  content: Schema.String
})
export type SystemPromptEvent = typeof SystemPromptEvent.Type

/** User message event - input from the user */
export const UserMessageEvent = Schema.TaggedStruct("UserMessage", {
  content: Schema.String
})
export type UserMessageEvent = typeof UserMessageEvent.Type

/** Assistant message event - complete response from the AI */
export const AssistantMessageEvent = Schema.TaggedStruct("AssistantMessage", {
  content: Schema.String
})
export type AssistantMessageEvent = typeof AssistantMessageEvent.Type

/** Text delta event - streaming chunk (ephemeral, never persisted) */
export const TextDeltaEvent = Schema.TaggedStruct("TextDelta", {
  delta: Schema.String
})
export type TextDeltaEvent = typeof TextDeltaEvent.Type

// =============================================================================
// Union Types
// =============================================================================

/** Schema for persisted events (non-ephemeral) */
export const PersistedEvent = Schema.Union(
  SystemPromptEvent,
  UserMessageEvent,
  AssistantMessageEvent
)
export type PersistedEvent = typeof PersistedEvent.Type

/** All possible context events */
export type ContextEvent = PersistedEvent | TextDeltaEvent

// =============================================================================
// Type Guards (using Schema.is for type-safe schema-based checking)
// =============================================================================

export const isTextDelta = Schema.is(TextDeltaEvent)
export const isAssistantMessage = Schema.is(AssistantMessageEvent)
export const isPersisted = Schema.is(PersistedEvent)

