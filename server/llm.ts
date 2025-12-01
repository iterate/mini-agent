/**
 * LLM RPC Handlers
 * 
 * Server-side implementation of LlmRpcs from shared/schemas.ts
 */

import { Effect, Layer, Stream, Option, Redacted } from "effect"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { FetchHttpClient } from "@effect/platform"
import { LanguageModel } from "@effect/ai"

import { LlmRpcs, LlmError } from "../shared/schemas"
import { OpenAiApiKeyOption, OpenAiModel } from "../shared/config"

// =============================================================================
// Language Model Layer (memoized)
// =============================================================================

const makeLanguageModelLayer = (apiKey: Redacted.Redacted, model: string) =>
  OpenAiLanguageModel.layer({ model }).pipe(
    Layer.provide(
      OpenAiClient.layer({ apiKey }).pipe(Layer.provide(FetchHttpClient.layer))
    )
  )

// =============================================================================
// Handler Implementation
// =============================================================================

export const LlmHandlers = LlmRpcs.toLayer(
  Effect.gen(function* () {
    const apiKeyOpt = yield* OpenAiApiKeyOption
    const model = yield* OpenAiModel

    // Memoized layer - created once at handler initialization
    const languageModelLayer = Option.isSome(apiKeyOpt)
      ? makeLanguageModelLayer(apiKeyOpt.value, model)
      : null

    return {
      // Streaming text generation
      generateStream: ({ prompt }: { prompt: string }) => {
        if (!languageModelLayer) {
          return Stream.fail(new LlmError({ message: "OPENAI_API_KEY not configured" }))
        }

        return LanguageModel.streamText({ prompt }).pipe(
          Stream.map((part) => (part.type === "text-delta" ? part.delta : "")),
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
          if (!languageModelLayer) {
            return yield* Effect.fail(new LlmError({ message: "OPENAI_API_KEY not configured" }))
          }

          yield* Effect.logDebug("Generating text").pipe(
            Effect.annotateLogs({ promptLength: prompt.length })
          )

          const response = yield* LanguageModel.generateText({ prompt }).pipe(
            Effect.map((result) => result.text),
            Effect.catchAllCause((cause) =>
              Effect.fail(new LlmError({ message: String(cause) }))
            ),
            Effect.provide(languageModelLayer)
          )

          yield* Effect.logDebug("Generation complete").pipe(
            Effect.annotateLogs({ responseLength: response.length })
          )

          return response
        }).pipe(Effect.withSpan("llm.generate"))
    }
  })
)
