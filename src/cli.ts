/**
 * CLI Commands
 *
 * Defines the CLI interface for the chat application.
 */
import { type Prompt, Telemetry } from "@effect/ai"
import { Command, Options, Prompt as CliPrompt } from "@effect/cli"
import { type Error as PlatformError, Terminal } from "@effect/platform"
import { BunStream } from "@effect/platform-bun"
import { Chunk, Console, Effect, Layer, Option, Schema, Stream } from "effect"
import {
  AssistantMessageEvent,
  type ContextEvent,
  FileAttachmentEvent,
  type InputEvent,
  type PersistedEvent,
  SystemPromptEvent,
  TextDeltaEvent,
  UserMessageEvent
} from "./context.model.ts"
import { ContextService } from "./context.service.ts"
import { printTraceLinks } from "./tracing.ts"

export const configFileOption = Options.file("config").pipe(
  Options.withAlias("c"),
  Options.withDescription("Path to YAML config file"),
  Options.optional
)

export const cwdOption = Options.directory("cwd").pipe(
  Options.withDescription("Working directory override"),
  Options.optional
)

export const stdoutLogLevelOption = Options.choice("stdout-log-level", [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "none"
]).pipe(
  Options.withDescription("Stdout log level (overrides config)"),
  Options.optional
)

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

const scriptOption = Options.boolean("script").pipe(
  Options.withAlias("s"),
  Options.withDescription("Script mode: read JSONL events from stdin, output JSONL events"),
  Options.withDefault(false)
)

const imageOption = Options.text("image").pipe(
  Options.withAlias("i"),
  Options.withDescription("Path to local image file or URL to share with the AI"),
  Options.optional
)

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
}

const getMediaType = (filePath: string): string => {
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."))
  return MIME_TYPES[ext] ?? "application/octet-stream"
}

const getFileName = (filePath: string): string => {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
}

const isUrl = (input: string): boolean => input.startsWith("http://") || input.startsWith("https://")

interface OutputOptions {
  raw: boolean
  showEphemeral: boolean
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`
const dimCyan = (s: string) => `\x1b[38;5;66m${s}\x1b[0m`
const dimGreen = (s: string) => `\x1b[38;5;65m${s}\x1b[0m`
const assistantLabel = bold(green("Assistant:"))
const dimUserLabel = dimCyan("You:")
const dimAssistantLabel = dimGreen("Assistant:")

/**
 * Handle a single context event based on output options.
 * Uses Terminal service for output instead of direct process access.
 * See: https://effect.website/docs/platform/terminal/
 */
const handleEvent = (
  event: ContextEvent,
  options: OutputOptions
): Effect.Effect<void, PlatformError.PlatformError, Terminal.Terminal> =>
  Effect.gen(function*() {
    const terminal = yield* Terminal.Terminal

    if (options.raw) {
      if (Schema.is(TextDeltaEvent)(event) && !options.showEphemeral) {
        return
      }
      yield* Console.log(JSON.stringify(event))
      return
    }

    if (Schema.is(TextDeltaEvent)(event)) {
      yield* terminal.display(event.delta)
      return
    }
    if (Schema.is(AssistantMessageEvent)(event)) {
      yield* Console.log("")
      return
    }
  })

/** Run the event stream, handling each event */
const runEventStream = (
  contextName: string,
  userMessage: string,
  options: OutputOptions,
  imageInput?: string
) =>
  Effect.gen(function*() {
    const contextService = yield* ContextService
    const inputEvents: Array<InputEvent> = []

    if (imageInput) {
      const mediaType = getMediaType(imageInput)
      const fileName = getFileName(imageInput)

      if (isUrl(imageInput)) {
        inputEvents.push(
          new FileAttachmentEvent({
            source: { type: "url", url: imageInput },
            mediaType,
            fileName
          })
        )
      } else {
        inputEvents.push(
          new FileAttachmentEvent({
            source: { type: "file", path: imageInput },
            mediaType,
            fileName
          })
        )
      }
    }

    inputEvents.push(new UserMessageEvent({ content: userMessage }))

    yield* contextService.addEvents(contextName, inputEvents).pipe(
      Stream.runForEach((event) => handleEvent(event, options))
    )
  })

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

/** Display raw event history as JSONL */
const displayRawHistory = (events: ReadonlyArray<PersistedEvent>) =>
  Effect.gen(function*() {
    for (const event of events) {
      yield* Console.log(JSON.stringify(event))
    }
  })

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
      (error) =>
        Effect.logError("Conversation error", { error: String(error) }).pipe(
          Effect.flatMap(() => Console.error(`Error: ${String(error)}`))
        )
    ),
    Effect.forever
  )

// =============================================================================
// Interaction Mode
// =============================================================================

/** CLI interaction mode - determines how input/output is handled */
const InteractionMode = Schema.Literal("single-turn", "pipe", "script", "tty-interactive")
type InteractionMode = typeof InteractionMode.Type

const determineMode = (options: {
  message: Option.Option<string>
  script: boolean
}): InteractionMode => {
  const hasMessage = Option.isSome(options.message) &&
    Option.getOrElse(options.message, () => "").trim() !== ""

  if (hasMessage) return "single-turn"
  if (options.script) return "script"
  if (process.stdin.isTTY) return "tty-interactive"
  return "pipe" // Default for piped stdin: read all as one message, output plain text
}

/** Shared UTF-8 decoder for stdin processing */
const utf8Decoder = new TextDecoder("utf-8")

/** Read all stdin as a single string (for pipe mode) */
const readAllStdin: Effect.Effect<string> = BunStream.stdin.pipe(
  Stream.mapChunks(Chunk.map((bytes) => utf8Decoder.decode(bytes))),
  Stream.runCollect,
  Effect.map((chunks) => Chunk.join(chunks, "").trim())
)

/** Script mode input events - UserMessage or SystemPrompt for dynamic injection */
const ScriptInputEvent = Schema.Union(UserMessageEvent, SystemPromptEvent)
type ScriptInputEvent = typeof ScriptInputEvent.Type

/** Read JSONL events from stdin (for script mode) */
const stdinEvents = BunStream.stdin.pipe(
  Stream.mapChunks(Chunk.map((bytes) => utf8Decoder.decode(bytes))),
  Stream.splitLines,
  Stream.filter((line) => line.trim() !== ""),
  Stream.mapEffect((line) =>
    Effect.try(() => JSON.parse(line) as unknown).pipe(
      Effect.flatMap((json) => Schema.decodeUnknown(ScriptInputEvent)(json))
    )
  )
)

/** Script interactive loop - read JSONL events, process, output JSONL */
const scriptInteractiveLoop = (contextName: string, options: OutputOptions) =>
  Effect.gen(function*() {
    const contextService = yield* ContextService

    yield* stdinEvents.pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function*() {
          // Echo input event
          yield* Console.log(JSON.stringify(event))

          // Process through context service - convert to InputEvent for addEvents
          // SystemPrompt needs special handling since addEvents expects InputEvent
          if (Schema.is(UserMessageEvent)(event)) {
            yield* contextService.addEvents(contextName, [event]).pipe(
              Stream.runForEach((outputEvent) => handleEvent(outputEvent, options))
            )
          } else if (Schema.is(SystemPromptEvent)(event)) {
            // For SystemPrompt, we need to create a new context with this prompt
            // This is a limitation - script mode can only set system prompt at context creation
            yield* Effect.logDebug("SystemPrompt events in script mode are echoed but not persisted")
          }
        })
      ),
      Stream.runDrain
    )
  })

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

const runChat = (options: {
  name: Option.Option<string>
  message: Option.Option<string>
  image: Option.Option<string>
  raw: boolean
  script: boolean
  showEphemeral: boolean
}) =>
  Effect.gen(function*() {
    yield* Effect.logDebug("Starting chat session")
    const contextService = yield* ContextService
    const mode = determineMode(options)
    const contextName = Option.getOrElse(options.name, () => "default")
    const imagePath = Option.getOrNull(options.image) ?? undefined

    // Script mode always uses raw output
    const outputOptions: OutputOptions = {
      raw: mode === "script" || options.raw,
      showEphemeral: options.showEphemeral
    }

    switch (mode) {
      case "single-turn": {
        const message = Option.getOrElse(options.message, () => "")
        yield* runEventStream(contextName, message, outputOptions, imagePath)
        if (!outputOptions.raw) {
          yield* printTraceLinks
        }
        break
      }

      case "pipe": {
        // Read all stdin as one message, output plain text
        const input = yield* readAllStdin
        if (input !== "") {
          yield* runEventStream(contextName, input, { raw: false, showEphemeral: false }, imagePath)
        }
        break
      }

      case "script": {
        // JSONL events in, JSONL events out
        yield* scriptInteractiveLoop(contextName, outputOptions)
        break
      }

      case "tty-interactive": {
        const resolvedName = Option.isSome(options.name)
          ? contextName
          : yield* selectOrCreateContext

        const existingEvents = yield* contextService.load(resolvedName)
        const hasHistory = existingEvents.length > 1

        if (outputOptions.raw) {
          if (hasHistory) {
            yield* displayRawHistory(existingEvents)
          }
        } else {
          yield* Console.log(`\nContext name: ${resolvedName}`)

          if (hasHistory) {
            yield* displayHistory(existingEvents)
          } else {
            yield* Console.log("Starting new conversation. Press Ctrl+C to exit.\n")
          }
        }

        yield* conversationLoop(resolvedName, outputOptions).pipe(
          Effect.catchIf(Terminal.isQuitException, () => Effect.void),
          Effect.ensuring(
            outputOptions.raw
              ? Effect.void
              : printTraceLinks.pipe(Effect.flatMap(() => Console.log("\nGoodbye!")))
          )
        )
        break
      }
    }
  }).pipe(Effect.withSpan("chat-session"))

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

const chatCommand = Command.make(
  "chat",
  {
    name: nameOption,
    message: messageOption,
    image: imageOption,
    raw: rawOption,
    script: scriptOption,
    showEphemeral: showEphemeralOption
  },
  ({ image, message, name, raw, script, showEphemeral }) =>
    runChat({ image, message, name, raw, script, showEphemeral })
).pipe(Command.withDescription("Chat with an AI assistant using persistent context history"))

/**
 * Log-test command that emits log messages at all levels.
 * Used for testing logging configuration.
 */
const logTestCommand = Command.make(
  "log-test",
  {},
  () =>
    Effect.gen(function*() {
      yield* Effect.logTrace("TRACE_MESSAGE")
      yield* Effect.logDebug("DEBUG_MESSAGE")
      yield* Effect.logInfo("INFO_MESSAGE")
      yield* Effect.logWarning("WARN_MESSAGE")
      yield* Effect.logError("ERROR_MESSAGE")
      yield* Console.log("LOG_TEST_DONE")
    })
).pipe(Command.withDescription("Emit test log messages at all levels (for testing logging config)"))

/**
 * Trace-test command for testing tracing. Produces a span and exits.
 */
const traceTestCommand = Command.make(
  "trace-test",
  {},
  () =>
    Effect.gen(function*() {
      yield* Effect.log("Trace-test command executed")
    }).pipe(Effect.withSpan("trace-test-command"))
).pipe(Command.withDescription("Simple command for testing tracing"))

// Root command with global options
const rootCommand = Command.make(
  "mini-agent",
  {
    configFile: configFileOption,
    cwd: cwdOption,
    stdoutLogLevel: stdoutLogLevelOption
  }
).pipe(
  Command.withSubcommands([chatCommand, logTestCommand, traceTestCommand]),
  Command.withDescription("AI assistant with persistent context and comprehensive configuration")
)

export const cli = Command.run(rootCommand, {
  name: "mini-agent",
  version: "1.0.0"
})
