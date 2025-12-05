/**
 * Context Event Schemas
 *
 * A Context is the central concept in this codebase: a named, ordered list of events.
 * Events represent conversation turns between user and assistant, plus system configuration.
 *
 * Event Types:
 * - SystemPrompt: Initial AI behavior configuration (persisted)
 * - UserMessage: Input from the user (persisted)
 * - AssistantMessage: Complete response from the AI (persisted)
 * - TextDelta: Streaming chunk (ephemeral, never persisted)
 * - SetLlmConfig: LLM configuration for this context (persisted)
 */
import { Schema } from "effect"
import { LlmConfig } from "./llm-config.ts"

/** Branded type for context names - prevents mixing with other strings */
export const ContextName = Schema.String.pipe(Schema.brand("ContextName"))
export type ContextName = typeof ContextName.Type

/** Message format for LLM APIs and tracing */
export interface LLMMessage {
  readonly role: "system" | "user" | "assistant"
  readonly content: string
}

/** System prompt event - sets the AI's behavior */
export class SystemPromptEvent extends Schema.TaggedClass<SystemPromptEvent>()("SystemPrompt", {
  content: Schema.String
}) {
  toLLMMessage(): LLMMessage {
    return { role: "system", content: this.content }
  }
}

/** User message event - input from the user */
export class UserMessageEvent extends Schema.TaggedClass<UserMessageEvent>()("UserMessage", {
  content: Schema.String
}) {
  toLLMMessage(): LLMMessage {
    return { role: "user", content: this.content }
  }
}

/** Assistant message event - complete response from the AI */
export class AssistantMessageEvent extends Schema.TaggedClass<AssistantMessageEvent>()("AssistantMessage", {
  content: Schema.String
}) {
  toLLMMessage(): LLMMessage {
    return { role: "assistant", content: this.content }
  }
}

/** Text delta event - streaming chunk (ephemeral, never persisted) */
export class TextDeltaEvent extends Schema.TaggedClass<TextDeltaEvent>()("TextDelta", {
  delta: Schema.String
}) {}

/** Reason for LLM request interruption */
export const InterruptReason = Schema.Literal("user_cancel", "user_new_message", "timeout")
export type InterruptReason = typeof InterruptReason.Type

/** Emitted when LLM request is interrupted - persisted because it contains partial response */
export class LLMRequestInterruptedEvent
  extends Schema.TaggedClass<LLMRequestInterruptedEvent>()("LLMRequestInterrupted", {
    requestId: Schema.String,
    reason: InterruptReason,
    partialResponse: Schema.String
  })
{
  toLLMMessage(): LLMMessage {
    return { role: "assistant", content: this.partialResponse }
  }
}

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
    source: AttachmentSource,
    mediaType: Schema.String,
    fileName: Schema.optional(Schema.String)
  }
) {}

/** Sets the LLM config for this context. Added when context is created. */
export class SetLlmConfigEvent extends Schema.TaggedClass<SetLlmConfigEvent>()(
  "SetLlmConfig",
  { config: LlmConfig }
) {}

/** Events that get persisted to the context file */
export const PersistedEvent = Schema.Union(
  SystemPromptEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  LLMRequestInterruptedEvent,
  FileAttachmentEvent,
  SetLlmConfigEvent
)
export type PersistedEvent = typeof PersistedEvent.Type

/** All possible context events (persisted + ephemeral) */
export const ContextEvent = Schema.Union(
  SystemPromptEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  LLMRequestInterruptedEvent,
  FileAttachmentEvent,
  SetLlmConfigEvent,
  TextDeltaEvent
)
export type ContextEvent = typeof ContextEvent.Type

/** Input events that can be added via addEvents */
export const InputEvent = Schema.Union(UserMessageEvent, FileAttachmentEvent)
export type InputEvent = typeof InputEvent.Type

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful, friendly assistant.
Keep your responses concise but informative.
Use markdown formatting when helpful.`
