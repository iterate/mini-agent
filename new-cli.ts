/**
 * Simple Agent Loop using @effect/ai Chat
 * 
 * A terminal chat application with alternating user/assistant messages.
 * Uses @effect/cli for interactive prompts and @effect/ai Chat for stateful conversation.
 */

import { Prompt as CliPrompt } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { FetchHttpClient } from "@effect/platform"
import { Effect, Console, Config, Layer, Ref } from "effect"
import { Chat } from "@effect/ai"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"

// =============================================================================
// Configuration
// =============================================================================

const OpenAiApiKey = Config.redacted("OPENAI_API_KEY")
const OpenAiModel = Config.string("OPENAI_MODEL").pipe(Config.withDefault("gpt-4o-mini"))

// =============================================================================
// System Prompt
// =============================================================================

const SYSTEM_PROMPT = `You are a helpful, friendly assistant. 
Keep your responses concise but informative. 
Use markdown formatting when helpful.`

// =============================================================================
// Display Helpers
// =============================================================================

const formatAssistantResponse = (text: string): string => `\n${text}\n`

// =============================================================================
// Agent Loop
// =============================================================================

const agentLoop = Effect.gen(function* () {
  // Create a chat instance with system prompt
  const chat = yield* Chat.fromPrompt([
    { role: "system", content: SYSTEM_PROMPT }
  ])

  // Main conversation loop
  while (true) {
    // Get user input
    const userInput = yield* CliPrompt.text({
      message: "You",
    })

    // Check for exit commands
    const trimmedInput = userInput.trim().toLowerCase()
    if (trimmedInput === "exit" || trimmedInput === "quit" || trimmedInput === "q") {
      yield* Console.log("Goodbye!")
      break
    }

    // Skip empty inputs
    if (trimmedInput === "") {
      continue
    }

    // Generate response - Chat automatically manages history
    const response = yield* chat.generateText({
      prompt: userInput
    }).pipe(
      Effect.catchAll((error) => 
        Effect.succeed({ text: `Error: ${String(error)}`, content: [] } as { text: string; content: readonly unknown[] })
      )
    )

    // Display response
    yield* Console.log(formatAssistantResponse(response.text))

    // Log conversation stats (debug)
    const history = yield* Ref.get(chat.history)
    yield* Effect.logDebug(`Conversation has ${history.content.length} messages`)
  }
})

// =============================================================================
// Layer Setup
// =============================================================================

const makeLanguageModelLayer = (apiKey: Config.Config.Success<typeof OpenAiApiKey>, model: string) =>
  OpenAiLanguageModel.layer({ model }).pipe(
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
  BunContext.layer
)

const main = agentLoop.pipe(
  Effect.provide(MainLayer),
  Effect.catchAllDefect((defect) => 
    Console.error(`Fatal error: ${String(defect)}`)
  )
)

BunRuntime.runMain(main)
