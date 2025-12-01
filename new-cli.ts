import { Prompt as CliPrompt } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { FetchHttpClient, Terminal } from "@effect/platform"
import { Array as Arr, Effect, Console, Config, Layer, Ref, Cause, Option, pipe } from "effect"
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
// Chat Loop
// =============================================================================

/** Single conversation turn: get input, generate response, display it */
const conversationTurn = (chat: Chat.Service) =>
  Effect.gen(function* () {
    const input = yield* CliPrompt.text({ message: "You" })

    // Skip empty input
    if (input.trim() === "") return

    const response = yield* chat.generateText({ prompt: input })
    yield* Console.log(`\n${response.text}\n`)

    // Debug: log message count
    const history = yield* Ref.get(chat.history)
    yield* Effect.logDebug(`Conversation has ${history.content.length} messages`)
  })

/** Run conversation turns forever until Ctrl+C */
const conversationLoop = (chat: Chat.Service) =>
  conversationTurn(chat).pipe(
    // Only catch non-quit errors; let QuitException propagate to exit cleanly
    Effect.catchIf(
      (error) => !Terminal.isQuitException(error),
      (error) => Console.error(`Error: ${String(error)}`)
    ),
    Effect.forever
  )

/** Print trace links on exit if available */
const printTraceLinksOnExit = Effect.gen(function* () {
  const traceLinks = yield* TraceLinks
  const maybeSpan = yield* Effect.currentSpan.pipe(Effect.option)

  yield* Option.match(maybeSpan, {
    onNone: () => Effect.void,
    onSome: (span) => traceLinks.printLinks(span.traceId)
  })

  yield* Console.log("\nGoodbye!")
})

/** Main agent loop with proper cleanup */
const agentLoop = Effect.gen(function* () {
  const chat = yield* Chat.fromPrompt([
    { role: "system", content: SYSTEM_PROMPT }
  ])

  yield* conversationLoop(chat).pipe(
    Effect.catchIf(Terminal.isQuitException, () => Effect.void),
    Effect.ensuring(printTraceLinksOnExit)
  )
}).pipe(Effect.withSpan("chat-session"))

// =============================================================================
// GenAI Span Transformer (for Langfuse)
// =============================================================================

const collectText = (parts: ReadonlyArray<{ type: string; text?: string }>) => pipe(
  parts,
  Arr.filter((p): p is typeof p & { text: string } => p.type === "text" && !!p.text),
  Arr.map(p => p.text),
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
// Main Entry Point
// =============================================================================

const MainLayer = Layer.mergeAll(
  LanguageModelLayer,
  BunContext.layer,
  createTracingLayer("new-cli")
)

const main = agentLoop.pipe(
  Effect.provide(MainLayer),
  Effect.catchAllCause((cause) =>
    Cause.isInterruptedOnly(cause)
      ? Effect.void
      : Console.error(`Fatal error: ${Cause.pretty(cause)}`)
  )
)

BunRuntime.runMain(main)
