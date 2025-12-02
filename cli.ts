import { Args, Command, Options, Prompt as CliPrompt } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { FetchHttpClient, Terminal } from "@effect/platform"
import { Effect, Console, Config, Layer, Cause, Option, Stream } from "effect"
import { Telemetry, Prompt } from "@effect/ai"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { createTracingLayer, TraceLinks } from "./shared/tracing"
import {
  runWithContext,
  loadContext,
  getDisplayableEvents,
  UserMessageEvent,
  isTextDelta,
  isAssistantMessage,
  type ContextEvent,
  type PersistedEvent
} from "./shared/context"

// =============================================================================
// Configuration
// =============================================================================

const OpenAiApiKey = Config.redacted("OPENAI_API_KEY")
const OpenAiModel = Config.string("OPENAI_MODEL").pipe(Config.withDefault("gpt-4o-mini"))

// =============================================================================
// CLI Options
// =============================================================================

const contextArg = Args.text({ name: "context" }).pipe(
  Args.withDescription("Context name (slug identifier for the conversation)")
)

const interactiveOption = Options.boolean("interactive").pipe(
  Options.withAlias("i"),
  Options.withDescription("Run in interactive mode (multi-turn conversation)"),
  Options.withDefault(false)
)

const messageOption = Options.text("message").pipe(
  Options.withAlias("m"),
  Options.withDescription("Message to send to the assistant"),
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
  const isEphemeral = isTextDelta(event)
  
  // Skip ephemeral events if not requested
  if (isEphemeral && !options.showEphemeral) {
    return Effect.void
  }
  
  if (options.raw) {
    // Raw mode: output as JSON, one per line
    return Console.log(JSON.stringify(event, null, 2))
  }
  
  // Normal mode: stream text deltas, newline after complete response
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
  return runWithContext(contextName, [userEvent]).pipe(
    Stream.runForEach((event) => handleEvent(event, options))
  )
}

// =============================================================================
// History Display
// =============================================================================

/** Display previous conversation history */
const displayHistory = (events: ReadonlyArray<PersistedEvent>) =>
  Effect.gen(function* () {
    const displayable = getDisplayableEvents(events)
    if (displayable.length === 0) return

    yield* Console.log("─".repeat(50))
    yield* Console.log("Previous conversation:")
    yield* Console.log("")

    for (const event of displayable) {
      const prefix = event._tag === "UserMessage" ? "You:" : "Assistant:"
      yield* Console.log(prefix)
      yield* Console.log(event.content)
      yield* Console.log("")
    }

    yield* Console.log("─".repeat(50))
    yield* Console.log("")
  })

// =============================================================================
// Conversation Loop
// =============================================================================

/** Single conversation turn */
const conversationTurn = (contextName: string, options: OutputOptions) =>
  Effect.gen(function* () {
    const input = yield* CliPrompt.text({ message: "You" })

    // Skip empty input
    if (input.trim() === "") return

    // Stream response
    if (!options.raw) {
      yield* Effect.sync(() => process.stdout.write("\n"))
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
  context: string
  interactive: boolean
  message: Option.Option<string>
  raw: boolean
  showEphemeral: boolean
}) =>
  Effect.gen(function* () {
    const outputOptions: OutputOptions = { raw: options.raw, showEphemeral: options.showEphemeral }
    
    // Load existing context to check for history
    const existingEvents = yield* loadContext(options.context)
    const hasHistory = existingEvents.length > 1

    if (options.interactive) {
      // Interactive mode
      if (!options.raw) {
        yield* Console.log(`Context: ${options.context}`)

        if (hasHistory) {
          yield* displayHistory(existingEvents)
        } else {
          yield* Console.log("Starting new conversation. Press Ctrl+C to exit.\n")
        }
      }

      yield* conversationLoop(options.context, outputOptions).pipe(
        Effect.catchIf(Terminal.isQuitException, () => Effect.void),
        Effect.ensuring(
          options.raw 
            ? Effect.void 
            : printTraceLinks.pipe(Effect.flatMap(() => Console.log("\nGoodbye!")))
        )
      )
    } else {
      // Single message mode
      const message = Option.getOrElse(options.message, () => "")
      if (message.trim() === "") {
        yield* Console.error("Error: Please provide a message with -m or use -i for interactive mode")
        return
      }

      // Stream response
      yield* runEventStream(options.context, message, outputOptions)

      if (!options.raw) {
        yield* printTraceLinks
      }
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
    context: contextArg, 
    interactive: interactiveOption, 
    message: messageOption,
    raw: rawOption,
    showEphemeral: showEphemeralOption
  },
  ({ context, interactive, message, raw, showEphemeral }) => 
    runChat({ context, interactive, message, raw, showEphemeral })
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
