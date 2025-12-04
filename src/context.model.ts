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

/** Codemode execution result - persisted, included in next LLM request as user message */
export class CodemodeResultEvent extends Schema.TaggedClass<CodemodeResultEvent>()(
  "CodemodeResult",
  {
    stdout: Schema.String,
    stderr: Schema.String,
    exitCode: Schema.Number,
    endTurn: Schema.Boolean,
    data: Schema.optional(Schema.Unknown)
  }
) {
  toLLMMessage(): LLMMessage {
    const parts: Array<string> = []
    if (this.stdout) parts.push(this.stdout)
    if (this.stderr) parts.push(`stderr:\n${this.stderr}`)
    if (this.exitCode !== 0) parts.push(`(exit code: ${this.exitCode})`)
    if (this.data !== undefined) parts.push(`data: ${JSON.stringify(this.data)}`)
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
Your code will be:
1. Typechecked with strict TypeScript
2. Executed in a Bun subprocess
3. The result returned to you for the next step

## Available Tools

Your code receives a \`tools\` object with these methods:

\`\`\`typescript
interface CodemodeResult {
  /** If true, stop the agent loop. If false, you'll see the result and can continue. */
  endTurn: boolean
  /** Optional data to pass back */
  data?: unknown
}

interface Tools {
  /** Log a message (visible in output) */
  readonly log: (message: string) => Promise<void>

  /** Read a file from the filesystem */
  readonly readFile: (path: string) => Promise<string>

  /** Write a file to the filesystem */
  readonly writeFile: (path: string, content: string) => Promise<void>

  /** Execute a shell command */
  readonly exec: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>

  /** Get a secret value by name */
  readonly getSecret: (name: string) => Promise<string | undefined>
}
\`\`\`

## Code Format

Your code MUST:
- Be wrapped in \`<codemode>\` and \`</codemode>\` tags
- Export a default async function with EXPLICIT type annotations: \`(t: Tools): Promise<CodemodeResult>\`
- Use \`tools.log()\` for output the user should see

CRITICAL: Always include the type annotations. The code is typechecked with strict mode (\`noImplicitAny\`).

Example:
<codemode>
export default async function(t: Tools): Promise<CodemodeResult> {
  await t.log("Hello!")
  return { endTurn: true }
}
</codemode>

## Agent Loop

The \`endTurn\` field controls continuation:
- \`endTurn: true\` — Stop and wait for user input
- \`endTurn: false\` — You'll see the execution result and can respond again

Use \`endTurn: false\` when you need multiple steps:
<codemode>
export default async function(t: Tools): Promise<CodemodeResult> {
  const files = await t.exec("ls -la")
  await t.log("Found files:")
  await t.log(files.stdout)
  return { endTurn: false, data: { fileCount: files.stdout.split("\\n").length } }
}
</codemode>

Then in your next response, you can use that data to continue.

## Rules

1. ALWAYS output executable code — never ask clarifying questions instead of acting
2. Use \`tools.log()\` for any output the user should see
3. Return \`{ endTurn: true }\` when the task is complete
4. Return \`{ endTurn: false }\` when you need to see results and continue
5. Do NOT wrap code in markdown fences inside the codemode tags`
