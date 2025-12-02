/**
 * CLI Commands
 *
 * Defines the CLI interface for the chat application.
 */
import { type Prompt, Telemetry } from "@effect/ai"
import { Command, Options, Prompt as CliPrompt } from "@effect/cli"
import { Terminal } from "@effect/platform"
import { Console, Effect, Layer, Option, Schema, Stream } from "effect"
import {
  AssistantMessageEvent,
  type ContextEvent,
  type PersistedEvent,
  TextDeltaEvent,
  UserMessageEvent
} from "./context.model.js"
import { ContextService } from "./context.service.js"
import { printTraceLinks } from "./tracing/index.js"

// =============================================================================
// Global CLI Options
// =============================================================================

export const configFileOption = Options.file("config").pipe(
  Options.withAlias("c"),
  Options.withDescription("Path to YAML config file"),
  Options.optional
)

export const cwdOption = Options.directory("cwd").pipe(
  Options.withDescription("Working directory override"),
  Options.optional
)

export const logLevelOption = Options.choice("log-level", ["trace", "debug", "info", "warn", "error", "none"]).pipe(
  Options.withDescription("Stdout log level"),
  Options.optional
)

// =============================================================================
// Chat Command Options
// =============================================================================

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
// Output Options
// =============================================================================

interface OutputOptions {
  raw: boolean
  showEphemeral: boolean
}

// =============================================================================
// ANSI Styling
// =============================================================================

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`
const dimCyan = (s: string) => `\x1b[38;5;66m${s}\x1b[0m`
const dimGreen = (s: string) => `\x1b[38;5;65m${s}\x1b[0m`
const assistantLabel = bold(green("Assistant:"))
const dimUserLabel = dimCyan("You:")
const dimAssistantLabel = dimGreen("Assistant:")

// =============================================================================
// Event Handling
// =============================================================================

/** Handle a single context event based on output options */
const handleEvent = (event: ContextEvent, options: OutputOptions): Effect.Effect<void> => {
  if (options.raw) {
    if (Schema.is(TextDeltaEvent)(event) && !options.showEphemeral) {
      return Effect.void
    }
    return Console.log(JSON.stringify(event, null, 2))
  }

  if (Schema.is(TextDeltaEvent)(event)) {
    return Effect.sync(() => process.stdout.write(event.delta))
  }
  if (Schema.is(AssistantMessageEvent)(event)) {
    return Console.log("")
  }
  return Effect.void
}

/** Run the event stream, handling each event */
const runEventStream = (contextName: string, userMessage: string, options: OutputOptions) =>
  Effect.gen(function*() {
    const contextService = yield* ContextService
    const userEvent = new UserMessageEvent({ content: userMessage })
    yield* contextService.addEvents(contextName, [userEvent]).pipe(
      Stream.runForEach((event) => handleEvent(event, options))
    )
  })

// =============================================================================
// History Display
// =============================================================================

/** Display previous conversation history */
const displayHistory = (events: ReadonlyArray<PersistedEvent>) =>
  Effect.gen(function*() {
    const messages = events.filter((e) => e._tag === "UserMessage" || e._tag === "AssistantMessage")
    if (messages.length === 0) return

    yield* Console.log(dim("─".repeat(50)))
    yield* Console.log(dim("Previous conversation:"))
    yield* Console.log("")

    for (const event of messages) {
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
  Effect.gen(function*() {
    for (const event of events) {
      yield* Console.log(dim(JSON.stringify(event, null, 2)))
    }
  })

// =============================================================================
// Conversation Loop
// =============================================================================

/** Single conversation turn */
const conversationTurn = (contextName: string, options: OutputOptions) =>
  Effect.gen(function*() {
    const input = yield* CliPrompt.text({ message: bold(cyan("You")) })

    if (input.trim() === "") return

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

/** Prompt user to select an existing context or create a new one */
const selectOrCreateContext = Effect.gen(function*() {
  const contextService = yield* ContextService
  const contexts = yield* contextService.list()

  if (contexts.length === 0) {
    yield* Console.log("No existing contexts found.")
    return yield* CliPrompt.text({ message: "Enter a name for your new context" })
  }

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
// Main Command Handler
// =============================================================================

const runChat = (options: {
  name: Option.Option<string>
  message: Option.Option<string>
  raw: boolean
  showEphemeral: boolean
}) =>
  Effect.gen(function*() {
    const contextService = yield* ContextService
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

      const existingEvents = yield* contextService.load(contextName)
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
const promptToCleanMessages = (prompt: Prompt.Prompt): Array<CleanMessage> => {
  const raw: Array<CleanMessage> = []
  for (const msg of prompt.content) {
    if (msg.role === "system") {
      raw.push({ role: "system", content: msg.content })
    } else if (msg.role === "user" || msg.role === "assistant") {
      const text = collectText(msg.content)
      if (text) raw.push({ role: msg.role, content: text })
    }
  }

  if (raw.length === 0) return []
  const result: Array<CleanMessage> = []
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

/** Extract text from Response parts */
const extractResponseText = (parts: ReadonlyArray<{ type: string; text?: string; delta?: string }>): string =>
  parts
    .filter((p): p is typeof p & { text: string } | typeof p & { delta: string } =>
      (p.type === "text" && !!p.text) || (p.type === "text-delta" && !!p.delta)
    )
    .map((p) => ("text" in p && p.text) ? p.text : ("delta" in p && p.delta) ? p.delta : "")
    .join("")

export const GenAISpanTransformerLayer = Layer.succeed(
  Telemetry.CurrentSpanTransformer,
  ({ prompt, response, span }) => {
    const input = promptToCleanMessages(prompt)
    const outputText = extractResponseText(response as ReadonlyArray<{ type: string; text?: string; delta?: string }>)
    const output = outputText ? [{ role: "assistant", content: outputText }] : []

    span.attribute("input", JSON.stringify(input))
    span.attribute("output", JSON.stringify(output))
  }
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
  ({ message, name, raw, showEphemeral }) => runChat({ message, name, raw, showEphemeral })
).pipe(Command.withDescription("Chat with an AI assistant using persistent context history"))

// Root command with global options
const rootCommand = Command.make(
  "mini-agent",
  {
    configFile: configFileOption,
    cwd: cwdOption,
    logLevel: logLevelOption
  }
).pipe(
  Command.withSubcommands([chatCommand]),
  Command.withDescription("AI assistant with persistent context and comprehensive configuration")
)

export const cli = Command.run(rootCommand, {
  name: "mini-agent",
  version: "1.0.0"
})
