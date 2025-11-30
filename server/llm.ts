/**
 * LLM RPC Handlers
 * 
 * Server-side implementation of LlmRpcs from shared/schemas.ts
 */

import { Effect, Layer, Stream, Config, Option } from "effect"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { FetchHttpClient } from "@effect/platform"
import { LanguageModel } from "@effect/ai"

import { LlmRpcs, LlmError } from "../shared/schemas"

// =============================================================================
// OpenAI Configuration
// =============================================================================

const OpenAiApiKey = Config.redacted("OPENAI_API_KEY")
const OpenAiApiKeyOption = Config.option(OpenAiApiKey)

// =============================================================================
// Handler Implementation
// =============================================================================

export const LlmHandlers = LlmRpcs.toLayer(
  Effect.gen(function* () {
    const apiKeyOpt = yield* OpenAiApiKeyOption

    // Create OpenAI layers (shared between handlers)
    const createLayers = () => {
      if (Option.isNone(apiKeyOpt)) {
        return null
      }
      const openAiLayer = OpenAiClient.layer({ apiKey: apiKeyOpt.value }).pipe(
        Layer.provide(FetchHttpClient.layer)
      )
      return OpenAiLanguageModel.layer({ model: "gpt-4.1" }).pipe(
        Layer.provide(openAiLayer)
      )
    }

    return {
      // Streaming text generation
      generateStream: ({ prompt }: { prompt: string }) => {
        const languageModelLayer = createLayers()
        
        if (!languageModelLayer) {
          return Stream.fail(
            new LlmError({ message: "OPENAI_API_KEY not configured" })
          )
        }

        return LanguageModel.streamText({ prompt }).pipe(
          Stream.map((part) => {
            if (part.type === "text-delta") {
              return part.delta
            }
            return ""
          }),
          Stream.filter((s) => s.length > 0),
          Stream.catchAllCause((cause) =>
            Stream.fail(new LlmError({ message: String(cause) }))
          ),
          Stream.provideLayer(languageModelLayer)
        )
      },

      // Non-streaming text generation (returns complete response)
      generate: ({ prompt }: { prompt: string }) =>
        Effect.gen(function* () {
          const languageModelLayer = createLayers()
          
          if (!languageModelLayer) {
            return yield* Effect.fail(
              new LlmError({ message: "OPENAI_API_KEY not configured" })
            )
          }

          const response = yield* LanguageModel.generateText({ prompt }).pipe(
            Effect.map((result) => result.text),
            Effect.catchAllCause((cause) =>
              Effect.fail(new LlmError({ message: String(cause) }))
            ),
            Effect.provide(languageModelLayer)
          )

          return response
        }).pipe(Effect.withSpan("llm.generate"))
    }
  })
)
