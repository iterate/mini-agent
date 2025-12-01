import { Args, Command, Options } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { FetchHttpClient, FileSystem, Path, Terminal } from "@effect/platform"
import { Prompt as CliPrompt } from "@effect/cli"
import { Array as Arr, Effect, Console, Config, Layer, Ref, Cause, Option, pipe, Stream } from "effect"
import { Chat, Telemetry, Prompt } from "@effect/ai"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { createTracingLayer, TraceLinks } from "./shared/tracing"

// =============================================================================
// Configuration
// =============================================================================

const OpenAiApiKey = Config.redacted("OPENAI_API_KEY")
const OpenAiModel = Config.string("OPENAI_MODEL").pipe(Config.withDefault("gpt-4o-mini"))

const SYSTEM_PROMPT = `You are a helpful, friendly assistant. 
Keep your responses concise but informative. 
Use markdown formatting when helpful.`

const AGENTS_DIR = ".agents"

// =============================================================================
// Agent History - Clean message format
// =============================================================================

interface StoredMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/** Extract text from Prompt content parts */
const collectText = (parts: ReadonlyArray<{ type: string; text?: string }>) =>
  pipe(
    parts,
    Arr.filter((p): p is typeof p & { text: string } => p.type === "text" && !!p.text),
    Arr.map((p) => p.text),
    Arr.join("")
  )

/** Extract clean messages from Prompt, merging consecutive same-role messages */
const extractMessages = (prompt: Prompt.Prompt): StoredMessage[] => {
  const raw: StoredMessage[] = []

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
  const result: StoredMessage[] = []
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

const loadAgentHistory = (agentName: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const filePath = path.join(AGENTS_DIR, `${agentName}.json`)

    const exists = yield* fs.exists(filePath)
    if (!exists) return Option.none<StoredMessage[]>()

    const content = yield* fs.readFileString(filePath).pipe(
      Effect.map((json) => JSON.parse(json) as StoredMessage[]),
      Effect.map(Option.some),
      Effect.catchAll(() => Effect.succeed(Option.none<StoredMessage[]>()))
    )
    return content
  })

const saveAgentHistory = (agentName: string, chat: Chat.Service) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const filePath = path.join(AGENTS_DIR, `${agentName}.json`)

    // Ensure directory exists
    yield* fs.makeDirectory(AGENTS_DIR, { recursive: true }).pipe(
      Effect.catchAll(() => Effect.void)
    )

    // Extract clean messages from history
    const history = yield* Ref.get(chat.history)
    const messages = extractMessages(history)
    yield* fs.writeFileString(filePath, JSON.stringify(messages, null, 2))
  })

// =============================================================================
// CLI Options
// =============================================================================

const agentArg = Args.text({ name: "agent" }).pipe(
  Args.withDescription("Agent name (slug identifier for the conversation)")
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

// =============================================================================
// History Display
// =============================================================================

/** Display stored messages */
const displayHistory = (messages: StoredMessage[]) =>
  Effect.gen(function* () {
    const userAssistant = messages.filter((m) => m.role === "user" || m.role === "assistant")
    if (userAssistant.length === 0) return

    yield* Console.log("─".repeat(50))
    yield* Console.log("Previous conversation:")
    yield* Console.log("")

    for (const msg of userAssistant) {
      const prefix = msg.role === "user" ? "You:" : "Assistant:"
      yield* Console.log(prefix)
      yield* Console.log(msg.content)
      yield* Console.log("")
    }

    yield* Console.log("─".repeat(50))
    yield* Console.log("")
  })

// =============================================================================
// Chat Handlers
// =============================================================================

/** Stream a message to stdout (Chat automatically records to history) */
const streamMessage = (chat: Chat.Service, message: string) =>
  chat.streamText({ prompt: message }).pipe(
    Stream.runForEach((part) =>
      part.type === "text-delta"
        ? Effect.sync(() => process.stdout.write(part.delta))
        : Effect.void
    ),
    Effect.andThen(Console.log("")) // Final newline
  )

/** Single conversation turn with history persistence */
const conversationTurn = (chat: Chat.Service, agentName: string) =>
  Effect.gen(function* () {
    const input = yield* CliPrompt.text({ message: "You" })

    // Skip empty input
    if (input.trim() === "") return

    // Stream response (Chat automatically updates history)
    yield* Effect.sync(() => process.stdout.write("\n"))
    yield* streamMessage(chat, input)
    yield* Console.log("")

    // Save updated history
    yield* saveAgentHistory(agentName, chat)
  })

/** Run conversation turns forever until Ctrl+C */
const conversationLoop = (chat: Chat.Service, agentName: string) =>
  conversationTurn(chat, agentName).pipe(
    Effect.catchIf(
      (error) => !Terminal.isQuitException(error),
      (error) => Console.error(`Error: ${String(error)}`)
    ),
    Effect.forever
  )

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

const runChat = (options: { agent: string; interactive: boolean; message: Option.Option<string> }) =>
  Effect.gen(function* () {
    // Try to load existing history
    const savedMessages = yield* loadAgentHistory(options.agent)

    // Convert stored messages to Prompt format for Chat initialization
    const initialPrompt = Option.match(savedMessages, {
      onNone: () => [{ role: "system" as const, content: SYSTEM_PROMPT }],
      onSome: (messages) => messages.map((m) =>
        m.role === "system"
          ? { role: "system" as const, content: m.content }
          : { role: m.role, content: [{ type: "text" as const, text: m.content }] }
      )
    })

    const chat = yield* Chat.fromPrompt(initialPrompt)
    const hasHistory = Option.isSome(savedMessages) && savedMessages.value.length > 1

    if (options.interactive) {
      // Interactive mode
      yield* Console.log(`Agent: ${options.agent}`)

      if (hasHistory) {
        yield* displayHistory(savedMessages.value)
      } else {
        yield* Console.log("Starting new conversation. Press Ctrl+C to exit.\n")
      }

      yield* conversationLoop(chat, options.agent).pipe(
        Effect.catchIf(Terminal.isQuitException, () => Effect.void),
        Effect.ensuring(
          printTraceLinks.pipe(Effect.flatMap(() => Console.log("\nGoodbye!")))
        )
      )
    } else {
      // Single message mode
      const message = Option.getOrElse(options.message, () => "")
      if (message.trim() === "") {
        yield* Console.error("Error: Please provide a message with -m or use -i for interactive mode")
        return
      }

      // Stream response (Chat updates history automatically)
      yield* streamMessage(chat, message)

      // Save updated history
      yield* saveAgentHistory(options.agent, chat)

      yield* printTraceLinks
    }
  }).pipe(Effect.withSpan("chat-session"))

// =============================================================================
// GenAI Span Transformer (for Langfuse/OTEL)
// =============================================================================

const GenAISpanTransformerLayer = Layer.succeed(
  Telemetry.CurrentSpanTransformer,
  ({ prompt, span, response }) => {
    const input = pipe(
      prompt.content,
      Arr.filter((m): m is Prompt.SystemMessage | Prompt.UserMessage | Prompt.AssistantMessage => m.role !== "tool"),
      Arr.map((m) => ({ role: m.role, content: m.role === "system" ? m.content : collectText(m.content) })),
      Arr.filter((m) => !!m.content)
    )
    const output = collectText(response)

    span.attribute("input", JSON.stringify(input))
    span.attribute("output", JSON.stringify(output ? [{ role: "assistant", content: output }] : []))
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
  { agent: agentArg, interactive: interactiveOption, message: messageOption },
  ({ agent, interactive, message }) => runChat({ agent, interactive, message })
).pipe(Command.withDescription("Chat with an AI assistant using persistent agent history"))

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
