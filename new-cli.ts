import { Command, Options } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { FetchHttpClient, Terminal } from "@effect/platform"
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

// =============================================================================
// CLI Options
// =============================================================================

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
// Chat Handlers
// =============================================================================

/** Stream a single message and print response */
const streamSingleMessage = (chat: Chat.Service, message: string) =>
  Effect.gen(function* () {
    yield* chat.streamText({ prompt: message }).pipe(
      Stream.runForEach((part) =>
        part.type === "text-delta"
          ? Effect.sync(() => process.stdout.write(part.delta))
          : Effect.void
      )
    )
    yield* Console.log("") // Final newline
  })

/** Single conversation turn: get input, stream response */
const conversationTurn = (chat: Chat.Service) =>
  Effect.gen(function* () {
    const input = yield* CliPrompt.text({ message: "You" })

    // Skip empty input
    if (input.trim() === "") return

    // Stream response to stdout
    yield* Effect.sync(() => process.stdout.write("\n"))
    yield* chat.streamText({ prompt: input }).pipe(
      Stream.runForEach((part) =>
        part.type === "text-delta"
          ? Effect.sync(() => process.stdout.write(part.delta))
          : Effect.void
      )
    )
    yield* Console.log("\n")

    // Debug: log message count
    const history = yield* Ref.get(chat.history)
    yield* Effect.logDebug(`Conversation has ${history.content.length} messages`)
  })

/** Run conversation turns forever until Ctrl+C */
const conversationLoop = (chat: Chat.Service) =>
  conversationTurn(chat).pipe(
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

const runChat = (options: { interactive: boolean; message: Option.Option<string> }) =>
  Effect.gen(function* () {
    const chat = yield* Chat.fromPrompt([
      { role: "system", content: SYSTEM_PROMPT }
    ])

    if (options.interactive) {
      // Interactive mode: multi-turn conversation
      yield* Console.log("Interactive mode. Press Ctrl+C to exit.\n")
      yield* conversationLoop(chat).pipe(
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

      yield* streamSingleMessage(chat, message).pipe(
        Effect.ensuring(printTraceLinks)
      )
    }
  }).pipe(Effect.withSpan("chat-session"))

// =============================================================================
// GenAI Span Transformer (for Langfuse/OTEL)
// =============================================================================

const collectText = (parts: ReadonlyArray<{ type: string; text?: string; delta?: string }>) => pipe(
  parts,
  Arr.filter((p): p is typeof p & { text: string } | typeof p & { delta: string } =>
    (p.type === "text" && !!p.text) || (p.type === "text-delta" && !!p.delta)
  ),
  Arr.map(p => p.text ?? p.delta ?? ""),
  Arr.join("")
)

const GenAISpanTransformerLayer = Layer.succeed(
  Telemetry.CurrentSpanTransformer,
  ({ prompt, span, response }) => {
    const input = pipe(
      prompt.content,
      Arr.filter((m): m is Prompt.SystemMessage | Prompt.UserMessage | Prompt.AssistantMessage => m.role !== "tool"),
      Arr.map(m => ({ role: m.role, content: m.role === "system" ? m.content : collectText(m.content) })),
      Arr.filter(m => !!m.content)
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
  Layer.mergeAll(
    OpenAiLanguageModel.layer({ model }),
    GenAISpanTransformerLayer
  ).pipe(
    Layer.provide(
      OpenAiClient.layer({ apiKey }).pipe(
        Layer.provide(FetchHttpClient.layer)
      )
    )
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
  { interactive: interactiveOption, message: messageOption },
  ({ interactive, message }) => runChat({ interactive, message })
).pipe(Command.withDescription("Chat with an AI assistant"))

const cli = Command.run(chatCommand, {
  name: "chat",
  version: "1.0.0"
})

// =============================================================================
// Main Entry Point
// =============================================================================

const MainLayer = Layer.mergeAll(
  LanguageModelLayer,
  BunContext.layer,
  createTracingLayer("new-cli")
)

cli(process.argv).pipe(
  Effect.provide(MainLayer),
  Effect.catchAllCause((cause) =>
    Cause.isInterruptedOnly(cause)
      ? Effect.void
      : Console.error(`Fatal error: ${Cause.pretty(cause)}`)
  ),
  BunRuntime.runMain
)
