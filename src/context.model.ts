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

/** Controls whether an event triggers an agent turn after it's processed */
export const TriggerAgentTurn = Schema.Literal("after-current-turn", "never")
export type TriggerAgentTurn = typeof TriggerAgentTurn.Type

/** Message format for LLM APIs and tracing */
export interface LLMMessage {
  readonly role: "system" | "user" | "assistant"
  readonly content: string
}

/** System prompt event - sets the AI's behavior */
export class SystemPromptEvent extends Schema.TaggedClass<SystemPromptEvent>()("SystemPrompt", {
  content: Schema.String,
  triggerAgentTurn: Schema.optionalWith(TriggerAgentTurn, { default: () => "never" as const })
}) {
  toLLMMessage(): LLMMessage {
    return { role: "system", content: this.content }
  }
}

/** User message event - input from the user */
export class UserMessageEvent extends Schema.TaggedClass<UserMessageEvent>()("UserMessage", {
  content: Schema.String,
  triggerAgentTurn: Schema.optionalWith(TriggerAgentTurn, { default: () => "after-current-turn" as const })
}) {
  toLLMMessage(): LLMMessage {
    return { role: "user", content: this.content }
  }
}

/** Assistant message event - complete response from the AI */
export class AssistantMessageEvent extends Schema.TaggedClass<AssistantMessageEvent>()("AssistantMessage", {
  content: Schema.String,
  triggerAgentTurn: Schema.optionalWith(TriggerAgentTurn, { default: () => "never" as const })
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
    fileName: Schema.optional(Schema.String),
    triggerAgentTurn: Schema.optionalWith(TriggerAgentTurn, { default: () => "never" as const })
  }
) {}

/** Sets the LLM config for this context. Added when context is created. */
export class SetLlmConfigEvent extends Schema.TaggedClass<SetLlmConfigEvent>()(
  "SetLlmConfig",
  {
    config: LlmConfig,
    triggerAgentTurn: Schema.optionalWith(TriggerAgentTurn, { default: () => "never" as const })
  }
) {}

/** Codemode execution result - persisted, included in next LLM request as user message */
export class CodemodeResultEvent extends Schema.TaggedClass<CodemodeResultEvent>()(
  "CodemodeResult",
  {
    stdout: Schema.String,
    stderr: Schema.String,
    exitCode: Schema.Number,
    triggerAgentTurn: TriggerAgentTurn
  }
) {
  toLLMMessage(): LLMMessage {
    const parts: Array<string> = []
    if (this.stdout) parts.push(this.stdout)
    if (this.stderr) parts.push(`stderr:\n${this.stderr}`)
    if (this.exitCode !== 0) parts.push(`(exit code: ${this.exitCode})`)
    const output = parts.join("\n") || "(no output)"
    return {
      role: "user",
      content: `Code execution result:\n\`\`\`\n${output}\n\`\`\``
    }
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
  CodemodeResultEvent
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
  CodemodeResultEvent,
  TextDeltaEvent
)
export type ContextEvent = typeof ContextEvent.Type

/** Input events that can be added via addEvents */
export const InputEvent = Schema.Union(UserMessageEvent, FileAttachmentEvent, SystemPromptEvent)
export type InputEvent = typeof InputEvent.Type

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful, friendly assistant.
Keep your responses concise but informative.
Use markdown formatting when helpful.`

export const CODEMODE_SYSTEM_PROMPT = `You are a coding assistant that executes TypeScript code to accomplish tasks.

## How Codemode Works

When you need to perform an action, you MUST write TypeScript code wrapped in codemode tags.
Your code will be typechecked and executed in a Bun subprocess.

## Available Tools

Your code receives a \`t\` object with these methods:

\`\`\`typescript
interface Tools {
  /** Send a message to the USER. They see this. Does NOT trigger another turn. */
  readonly sendMessage: (message: string) => Promise<void>

  /** Read a file from the filesystem */
  readonly readFile: (path: string) => Promise<string>

  /** Write a file to the filesystem */
  readonly writeFile: (path: string, content: string) => Promise<void>

  /** Execute a shell command */
  readonly exec: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>

  /** Fetch a URL and return its content */
  readonly fetch: (url: string) => Promise<string>

  /** Get a secret value by name */
  readonly getSecret: (name: string) => Promise<string | undefined>
}
\`\`\`

## What the User Sees vs What You See

- **User sees**: Only what you pass to \`t.sendMessage()\`
- **You see**: Only what you \`console.log()\` — this triggers another turn

Most tasks complete in ONE turn: do the work, call \`t.sendMessage()\` with the result, done.

## Code Format

Your code MUST:
- Be wrapped in \`<codemode>\` and \`</codemode>\` tags
- Export a default async function with EXPLICIT type annotations: \`(t: Tools): Promise<void>\`
- Do NOT add import statements — \`Tools\` is automatically available

CRITICAL: Always include the type annotations. The code is typechecked with strict mode (\`noImplicitAny\`).

## Examples

### Single-turn (most common)
User asks: "What is 2+2?"
<codemode>
export default async function(t: Tools): Promise<void> {
  await t.sendMessage("2+2 = 4")
}
</codemode>

### Multi-turn (when you need to see data first)
User asks: "Summarize today's news"
<codemode>
export default async function(t: Tools): Promise<void> {
  await t.sendMessage("Stand by - fetching news...")
  const html = await t.fetch("https://news.ycombinator.com")
  console.log(html) // You'll see this and can summarize in next turn
}
</codemode>

Then in your next turn, you see the fetched content and can respond with a summary.

## Rules

1. ALWAYS output executable code — never ask clarifying questions instead of acting
2. Use \`t.sendMessage()\` for messages the USER should see
3. Use \`console.log()\` only when YOU need to see data for a follow-up turn
4. Do NOT wrap code in markdown fences inside the codemode tags`
