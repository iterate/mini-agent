/**
 * LLM RPC Handlers
 * 
 * Server-side implementation of LlmRpcs from shared/schemas.ts
 */

import { Effect, Layer, Stream, Option, Redacted } from "effect"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { FetchHttpClient } from "@effect/platform"
import { LanguageModel, Telemetry } from "@effect/ai"

import { LlmRpcs, LlmError } from "../shared/schemas"
import { OpenAiApiKeyOption, OpenAiModel } from "../shared/config"

// =============================================================================
// Span Transformer for GenAI Telemetry
// =============================================================================

/**
 * Helper to extract text from message parts
 */
const extractTextFromParts = (parts: ReadonlyArray<{ type: string; text?: string }>): string => {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
}

/**
 * Custom span transformer that adds prompt/completion content as span attributes.
 * 
 * Langfuse expects input/output as span ATTRIBUTES in specific formats:
 * - `input` / `output` as JSON-stringified message arrays
 * - Content type hints via `input_content_type` / `output_content_type`
 * 
 * @see https://github.com/langfuse/langfuse/blob/ea96debdde6a9dd3b8f0c8c43b22f0d7eff3798a/web/src/__tests__/server/api/otel/otelMapping.servertest.ts
 */
const GenAISpanTransformer: Telemetry.SpanTransformer = (options) => {
  const { prompt, span, response } = options

  // Build input messages array in OpenAI chat format (renders nicely in Langfuse)
  const inputMessages: Array<{ role: string; content: string }> = []
  
  for (const message of prompt.content) {
    switch (message.role) {
      case "system": {
        inputMessages.push({
          role: "system",
          content: message.content
        })
        break
      }
      case "user": {
        const textContent = extractTextFromParts(message.content as ReadonlyArray<{ type: string; text?: string }>)
        inputMessages.push({
          role: "user", 
          content: textContent
        })
        break
      }
      case "assistant": {
        const textContent = extractTextFromParts(message.content as ReadonlyArray<{ type: string; text?: string }>)
        if (textContent) {
          inputMessages.push({
            role: "assistant",
            content: textContent
          })
        }
        break
      }
    }
  }

  // Build output from response
  const outputText = extractTextFromParts(response as ReadonlyArray<{ type: string; text?: string }>)

  // Input: array of messages (no wrapper, no index)
  // Output: array with single assistant message (matching input format)
  const outputMessages = outputText 
    ? [{ role: "assistant", content: outputText }]
    : []

  const inputJson = JSON.stringify(inputMessages)
  const outputJson = JSON.stringify(outputMessages)

  // ==========================================================================
  // Set span attributes in formats Langfuse expects
  // ==========================================================================

  // Mark this as a "generation" observation type for Langfuse
  span.attribute("langfuse.observation.type", "generation")

  // Langfuse SDK format (highest priority)
  span.attribute("langfuse.observation.input", inputJson)
  span.attribute("langfuse.observation.output", outputJson)

  // Generic format
  span.attribute("input", inputJson)
  span.attribute("output", outputJson)

  // OpenInference format
  span.attribute("input.value", inputJson)
  span.attribute("input.mime_type", "application/json")
  span.attribute("output.value", outputJson)
  span.attribute("output.mime_type", "application/json")
}

/**
 * Layer that provides the GenAI span transformer
 */
const GenAISpanTransformerLayer = Layer.succeed(
  Telemetry.CurrentSpanTransformer,
  GenAISpanTransformer
)

// =============================================================================
// Language Model Layer (memoized)
// =============================================================================

const makeLanguageModelLayer = (apiKey: Redacted.Redacted, model: string) =>
  Layer.mergeAll(
    OpenAiLanguageModel.layer({ model }),
    GenAISpanTransformerLayer
  ).pipe(
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
