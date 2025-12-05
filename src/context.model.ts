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
 * - CodemodeBlock: A single executed codemode block (persisted)
 */
import { Schema } from "effect"
import { CodemodeBlockEvent } from "./codemode/codemode.model.ts"
import { LlmConfig } from "./llm-config.ts"

export { CodemodeBlockEvent }

/** Branded type for context names - prevents mixing with other strings */
export const ContextName = Schema.String.pipe(Schema.brand("ContextName"))
export type ContextName = typeof ContextName.Type

/** Controls whether an event triggers an LLM request */
export const TriggerAgentTurn = Schema.Literal("after-current-turn", "never")
export type TriggerAgentTurn = typeof TriggerAgentTurn.Type

/** Message format for LLM APIs and tracing */
export interface LLMMessage {
  readonly role: "system" | "user" | "assistant"
  readonly content: string
}

/** System prompt event - sets the AI's behavior */
export class SystemPromptEvent extends Schema.TaggedClass<SystemPromptEvent>()("SystemPrompt", {
  content: Schema.String
}) {
  get triggerAgentTurn(): TriggerAgentTurn {
    return "never"
  }
  toLLMMessage(): LLMMessage {
    return { role: "system", content: this.content }
  }
}

/** User message event - input from the user */
export class UserMessageEvent extends Schema.TaggedClass<UserMessageEvent>()("UserMessage", {
  content: Schema.String
}) {
  get triggerAgentTurn(): TriggerAgentTurn {
    return "after-current-turn"
  }
  toLLMMessage(): LLMMessage {
    return { role: "user", content: this.content }
  }
}

/** Assistant message event - complete response from the AI */
export class AssistantMessageEvent extends Schema.TaggedClass<AssistantMessageEvent>()("AssistantMessage", {
  content: Schema.String
}) {
  get triggerAgentTurn(): TriggerAgentTurn {
    return "never"
  }
  toLLMMessage(): LLMMessage {
    return { role: "assistant", content: this.content }
  }
}

/** Text delta event - streaming chunk (ephemeral, never persisted) */
export class TextDeltaEvent extends Schema.TaggedClass<TextDeltaEvent>()("TextDelta", {
  delta: Schema.String
}) {
  get triggerAgentTurn(): TriggerAgentTurn {
    return "never"
  }
}

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
) {
  get triggerAgentTurn(): TriggerAgentTurn {
    return "never"
  }
}

/** Sets the LLM config for this context. Added when context is created. */
export class SetLlmConfigEvent extends Schema.TaggedClass<SetLlmConfigEvent>()(
  "SetLlmConfig",
  { config: LlmConfig }
) {
  get triggerAgentTurn(): TriggerAgentTurn {
    return "never"
  }
}

/** Events that get persisted to the context file */
export const PersistedEvent = Schema.Union(
  SystemPromptEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  LLMRequestInterruptedEvent,
  FileAttachmentEvent,
  SetLlmConfigEvent,
  CodemodeBlockEvent
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
  TextDeltaEvent,
  CodemodeBlockEvent
)
export type ContextEvent = typeof ContextEvent.Type

/** Input events that can be added via addEvents */
export const InputEvent = Schema.Union(UserMessageEvent, FileAttachmentEvent, CodemodeBlockEvent, SystemPromptEvent)
export type InputEvent = typeof InputEvent.Type

export const DEFAULT_SYSTEM_PROMPT = `You are an AI agent. You ONLY communicate via executable TypeScript code.

NEVER write text outside of <codemode> tags. ALL responses must be code.

## Two Output Channels

You have two ways to output information:

1. **tools.sendMessage(text)** → User sees this. You do NOT.
2. **console.log(text)** → You see this. User does NOT. Triggers continuation.

Most interactions are single-turn: you call tools.sendMessage() to reply and you're done.
Only use console.log() when you need to SEE a result before deciding what to do next.

## Tools
\`\`\`typescript
interface Tools {
  sendMessage: (text: string) => Promise<void>  // Output to user (you DON'T see this)
  fetch: (opts: { url: string }) => Promise<string>  // Fetch URL content
  calculate: (expression: string) => Promise<{ result: number; steps: Array<string> }>
  now: () => Promise<string>
  sleep: (ms: number) => Promise<void>
}
\`\`\`

## Examples

### Simple response (most common case):
<codemode>
await tools.sendMessage("Hello! How can I help you today?")
</codemode>

### Using a tool when you know the result format:
<codemode>
const { result } = await tools.calculate("(15 * 7) + (23 * 4)")
await tools.sendMessage(\`The result is \${result}\`)
</codemode>

### Multi-turn: fetching a URL to decide what to do:
<codemode>
await tools.sendMessage("Let me fetch that page for you...")
const content = await tools.fetch({ url: "https://example.com/api/data" })
console.log(content)  // You see this, can analyze it in next turn
</codemode>
// In your next turn, you'll see the fetched content and can decide what to tell the user

### Multi-turn: checking a result before continuing:
<codemode>
const { result } = await tools.calculate("100 / 7")
console.log(\`Intermediate result: \${result}\`)  // You see this
</codemode>
// In next turn, you see "Intermediate result: 14.285..." and decide what to do

## Rules
1. NEVER write plain text outside <codemode> tags
2. Use tools.sendMessage() to talk to the user
3. Use console.log() ONLY when you need to see the output to continue
4. Valid TypeScript only (strict mode, noUncheckedIndexedAccess)`
