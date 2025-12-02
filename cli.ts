import { Command, Options, Prompt as CliPrompt } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { FetchHttpClient, FileSystem, Terminal } from "@effect/platform"
import { Effect, Console, Config, Layer, Cause, Option, Stream } from "effect"
import { Telemetry, Prompt } from "@effect/ai"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { createTracingLayer, TraceLinks } from "./shared/tracing"
import {
  addEvents,
  loadContext,
  getDisplayableEvents
} from "./shared/context"
import {
  UserMessageEvent,
  isTextDelta,
  isAssistantMessage,
  type ContextEvent,
  type PersistedEvent
} from "./shared/schema"

// =============================================================================
// Configuration
// =============================================================================

const OpenAiApiKey = Config.redacted("OPENAI_API_KEY")
const OpenAiModel = Config.string("OPENAI_MODEL").pipe(Config.withDefault("gpt-4o-mini"))

// =============================================================================
// CLI Options
// =============================================================================

const CONTEXTS_DIR = ".contexts"

const nameOption = Options.text("name").pipe(
  Options.withAlias("n"),
  Options.withDescription("Context name (slug identifier for the conversation)"),
  Options.optional
)

const messageOption = Options.text("message").pipe(
  Options.withAlias("m"),
  Options.withDescription("Message to send (non-interactive single-turn mode)"),
  Options.optional
)


const rawOption = Options.boolean("raw").pipe(
  Options.withAlias("r"),
  Options.withDescription("Output events as JSON objects, one per line"),
  Options.withDefault(false)
)

const showEphemeralOption = Options.boolean("show-ephemeral").pipe(
  Options.withAlias("e"),
  Options.withDescription("Include ephemeral events (streaming deltas) in output"),
  Options.withDefault(false)
)


// =============================================================================
// Event Stream Handler
// =============================================================================

interface OutputOptions {
  raw: boolean
  showEphemeral: boolean
}

/** Handle a single context event based on output options */
const handleEvent = (event: ContextEvent, options: OutputOptions): Effect.Effect<void> => {
  if (options.raw) {
    // Raw mode: output as JSON, one per line
    // Skip ephemeral events unless explicitly requested
    if (isTextDelta(event) && !options.showEphemeral) {
      return Effect.void
    }
    return Console.log(JSON.stringify(event, null, 2))
  }
  
  // Normal mode: always stream text deltas, newline after complete response
  if (isTextDelta(event)) {
    return Effect.sync(() => process.stdout.write(event.delta))
  }
  if (isAssistantMessage(event)) {
    return Console.log("")
  }
  return Effect.void
}

/** Run the event stream, handling each event */
const runEventStream = (contextName: string, userMessage: string, options: OutputOptions) => {
  const userEvent = UserMessageEvent.make({ content: userMessage })
  return addEvents(contextName, [userEvent]).pipe(
    Stream.runForEach((event) => handleEvent(event, options))
  )
}

// =============================================================================
// History Display
// =============================================================================

// ANSI styling helpers
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`
const dimCyan = (s: string) => `\x1b[38;5;66m${s}\x1b[0m`
const dimGreen = (s: string) => `\x1b[38;5;65m${s}\x1b[0m`
const assistantLabel = bold(green("Assistant:"))
const dimUserLabel = dimCyan("You:")
const dimAssistantLabel = dimGreen("Assistant:")

/** Display previous conversation history */
const displayHistory = (events: ReadonlyArray<PersistedEvent>) =>
  Effect.gen(function* () {
    const displayable = getDisplayableEvents(events)
    if (displayable.length === 0) return

    yield* Console.log(dim("─".repeat(50)))
    yield* Console.log(dim("Previous conversation:"))
    yield* Console.log("")

    for (const event of displayable) {
      const prefix = event._tag === "UserMessage" ? dimUserLabel : dimAssistantLabel
      yield* Console.log(prefix)
      yield* Console.log(dim(event.content))
      yield* Console.log("")
    }

    yield* Console.log(dim("─".repeat(50)))
    yield* Console.log("")
  })

/** Display raw event history as JSON */
const displayRawHistory = (events: ReadonlyArray<PersistedEvent>) =>
  Effect.gen(function* () {
    for (const event of events) {
      yield* Console.log(dim(JSON.stringify(event, null, 2)))
    }
  })

// =============================================================================
// Conversation Loop
// =============================================================================

/** Single conversation turn */
const conversationTurn = (contextName: string, options: OutputOptions) =>
  Effect.gen(function* () {
    const input = yield* CliPrompt.text({ message: bold(cyan("You")) })

    // Skip empty input
    if (input.trim() === "") return

    // Stream response
    if (!options.raw) {
      yield* Console.log(`\n${assistantLabel}`)
    }
    yield* runEventStream(contextName, input, options)
    if (!options.raw) {
      yield* Console.log("")
    }
  })

/** Run conversation turns forever until Ctrl+C */
const conversationLoop = (contextName: string, options: OutputOptions) =>
  conversationTurn(contextName, options).pipe(
    Effect.catchIf(
      (error) => !Terminal.isQuitException(error),
      (error) => Console.error(`Error: ${String(error)}`)
    ),
    Effect.forever
  )

// =============================================================================
// Context Selection
// =============================================================================

const NEW_CONTEXT_VALUE = "__new__"

/** List all existing context files */
const listContexts = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs.exists(CONTEXTS_DIR)
  if (!exists) return []
  
  const entries = yield* fs.readDirectory(CONTEXTS_DIR)
  return entries
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => name.replace(/\.yaml$/, ""))
    .sort()
})

/** Prompt user to select an existing context or create a new one */
const selectOrCreateContext = Effect.gen(function* () {
  const contexts = yield* listContexts
  
  if (contexts.length === 0) {
    // No existing contexts, prompt for new name
    yield* Console.log("No existing contexts found.")
    return yield* CliPrompt.text({ message: "Enter a name for your new context" })
  }
  
  // Build choices: "Create new" option first, then existing contexts
  const choices = [
    {
      title: "➕ New context",
      value: NEW_CONTEXT_VALUE,
      description: "Start fresh with a new context"
    },
    ...contexts.map((name) => ({
      title: name,
      value: name,
      description: "Continue with this context"
    }))
  ]
  
  const selected = yield* CliPrompt.select({
    message: "Select context",
    choices
  })
  
  if (selected === NEW_CONTEXT_VALUE) {
    return yield* CliPrompt.text({ message: "Enter a name for your new conversation" })
  }
  
  return selected
})

// =============================================================================
// Trace Links
// =============================================================================

/** Print trace links on exit if available */
const printTraceLinks = Effect.gen(function* () {
  const traceLinks = yield* TraceLinks
  const maybeSpan = yield* Effect.currentSpan.pipe(Effect.option)

  yield* Option.match(maybeSpan, {
    onNone: () => Effect.void,
    onSome: (span) => traceLinks.printLinks(span.traceId)
  })
})

// =============================================================================
// Main Command Handler
// =============================================================================

const runChat = (options: { 
  name: Option.Option<string>
  message: Option.Option<string>
  raw: boolean
  showEphemeral: boolean
}) =>
  Effect.gen(function* () {
    const outputOptions: OutputOptions = { raw: options.raw, showEphemeral: options.showEphemeral }
    const hasMessage = Option.isSome(options.message) && Option.getOrElse(options.message, () => "").trim() !== ""
    const isTTY = process.stdin.isTTY === true

    if (hasMessage) {
      // Non-interactive: single message mode
      const contextName = Option.isSome(options.name)
        ? Option.getOrElse(options.name, () => "")
        : "default"
      
      const message = Option.getOrElse(options.message, () => "")
      yield* runEventStream(contextName, message, outputOptions)

      if (!options.raw) {
        yield* printTraceLinks
      }
    } else if (isTTY) {
      // Interactive mode
      const contextName = Option.isSome(options.name)
        ? Option.getOrElse(options.name, () => "")
        : yield* selectOrCreateContext
      
      const existingEvents = yield* loadContext(contextName)
      const hasHistory = existingEvents.length > 1

      if (options.raw) {
        if (hasHistory) {
          yield* displayRawHistory(existingEvents)
        }
      } else {
        yield* Console.log(`\nContext: ${contextName}`)

        if (hasHistory) {
          yield* displayHistory(existingEvents)
        } else {
          yield* Console.log("Starting new conversation. Press Ctrl+C to exit.\n")
        }
      }

      yield* conversationLoop(contextName, outputOptions).pipe(
        Effect.catchIf(Terminal.isQuitException, () => Effect.void),
        Effect.ensuring(
          options.raw 
            ? Effect.void 
            : printTraceLinks.pipe(Effect.flatMap(() => Console.log("\nGoodbye!")))
        )
      )
    } else {
      // Not a TTY and no message - explain
      yield* Console.error("Error: No TTY detected. Use -m <message> for non-interactive mode.")
    }
  }).pipe(Effect.withSpan("chat-session"))

// =============================================================================
// GenAI Span Transformer (for Langfuse/OTEL)
// =============================================================================

/** Extract text from Prompt content parts */
const collectText = (parts: ReadonlyArray<{ type: string; text?: string }>) =>
  parts
    .filter((p): p is typeof p & { text: string } => p.type === "text" && !!p.text)
    .map((p) => p.text)
    .join("")

interface CleanMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/** Convert prompt to clean messages, merging consecutive same-role messages */
const promptToCleanMessages = (prompt: Prompt.Prompt): CleanMessage[] => {
  const raw: CleanMessage[] = []
  for (const msg of prompt.content) {
    if (msg.role === "system") {
      raw.push({ role: "system", content: msg.content })
    } else if (msg.role === "user" || msg.role === "assistant") {
      const text = collectText(msg.content)
      if (text) raw.push({ role: msg.role, content: text })
    }
  }

  // Merge consecutive same-role messages
  if (raw.length === 0) return []
  const result: CleanMessage[] = []
  let current = { ...raw[0]! }

  for (let i = 1; i < raw.length; i++) {
    const msg = raw[i]!
    if (msg.role === current.role) {
      current.content += msg.content
    } else {
      result.push(current)
      current = { ...msg }
    }
  }
  result.push(current)

  return result
}

/** Extract text from Response parts (handles both text and text-delta) */
const extractResponseText = (parts: ReadonlyArray<{ type: string; text?: string; delta?: string }>): string =>
  parts
    .filter((p): p is typeof p & { text: string } | typeof p & { delta: string } =>
      (p.type === "text" && !!p.text) || (p.type === "text-delta" && !!p.delta)
    )
    .map((p) => ("text" in p && p.text) ? p.text : ("delta" in p && p.delta) ? p.delta : "")
    .join("")

const GenAISpanTransformerLayer = Layer.succeed(
  Telemetry.CurrentSpanTransformer,
  ({ prompt, span, response }) => {
    const input = promptToCleanMessages(prompt)
    const outputText = extractResponseText(response as ReadonlyArray<{ type: string; text?: string; delta?: string }>)
    const output = outputText ? [{ role: "assistant", content: outputText }] : []

    span.attribute("input", JSON.stringify(input))
    span.attribute("output", JSON.stringify(output))
  }
)

// =============================================================================
// Layer Setup
// =============================================================================

const makeLanguageModelLayer = (apiKey: Config.Config.Success<typeof OpenAiApiKey>, model: string) =>
  Layer.mergeAll(OpenAiLanguageModel.layer({ model }), GenAISpanTransformerLayer).pipe(
    Layer.provide(OpenAiClient.layer({ apiKey }).pipe(Layer.provide(FetchHttpClient.layer)))
  )

const LanguageModelLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const apiKey = yield* OpenAiApiKey
    const model = yield* OpenAiModel
    return makeLanguageModelLayer(apiKey, model)
  })
)

// =============================================================================
// CLI Definition
// =============================================================================

const chatCommand = Command.make(
  "chat",
  { 
    name: nameOption, 
    message: messageOption,
    raw: rawOption,
    showEphemeral: showEphemeralOption
  },
  ({ name, message, raw, showEphemeral }) => 
    runChat({ name, message, raw, showEphemeral })
).pipe(Command.withDescription("Chat with an AI assistant using persistent context history"))

const cli = Command.run(chatCommand, {
  name: "chat",
  version: "1.0.0"
})

// =============================================================================
// Main Entry Point
// =============================================================================

const MainLayer = Layer.mergeAll(LanguageModelLayer, BunContext.layer, createTracingLayer("new-cli"))

cli(process.argv).pipe(
  Effect.provide(MainLayer),
  Effect.catchAllCause((cause) =>
    Cause.isInterruptedOnly(cause) ? Effect.void : Console.error(`Fatal error: ${Cause.pretty(cause)}`)
  ),
  BunRuntime.runMain
)
