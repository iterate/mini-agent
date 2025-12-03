/**
 * Context Event Schemas
 *
 * A Context is a named, ordered list of events representing conversation turns
 * plus system configuration like LLM selection.
 */
import { Schema } from "effect"
import { LlmConfig } from "./llm-config.ts"

export const ContextName = Schema.String.pipe(Schema.brand("ContextName"))
export type ContextName = typeof ContextName.Type

export interface LLMMessage {
  readonly role: "system" | "user" | "assistant"
  readonly content: string
}

export class SystemPromptEvent extends Schema.TaggedClass<SystemPromptEvent>()("SystemPrompt", {
  content: Schema.String
}) {
  toLLMMessage(): LLMMessage {
    return { role: "system", content: this.content }
  }
}

export class UserMessageEvent extends Schema.TaggedClass<UserMessageEvent>()("UserMessage", {
  content: Schema.String
}) {
  toLLMMessage(): LLMMessage {
    return { role: "user", content: this.content }
  }
}

export class AssistantMessageEvent extends Schema.TaggedClass<AssistantMessageEvent>()("AssistantMessage", {
  content: Schema.String
}) {
  toLLMMessage(): LLMMessage {
    return { role: "assistant", content: this.content }
  }
}

export class TextDeltaEvent extends Schema.TaggedClass<TextDeltaEvent>()("TextDelta", {
  delta: Schema.String
}) {}

export const AttachmentSource = Schema.Union(
  Schema.Struct({ type: Schema.Literal("file"), path: Schema.String }),
  Schema.Struct({ type: Schema.Literal("url"), url: Schema.String })
)
export type AttachmentSource = typeof AttachmentSource.Type

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

export const PersistedEvent = Schema.Union(
  SystemPromptEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  FileAttachmentEvent,
  SetLlmConfigEvent
)
export type PersistedEvent = typeof PersistedEvent.Type

export const ContextEvent = Schema.Union(
  SystemPromptEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  FileAttachmentEvent,
  SetLlmConfigEvent,
  TextDeltaEvent
)
export type ContextEvent = typeof ContextEvent.Type

export const InputEvent = Schema.Union(UserMessageEvent, FileAttachmentEvent)
export type InputEvent = typeof InputEvent.Type

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful, friendly assistant.
Keep your responses concise but informative.
Use markdown formatting when helpful.`
