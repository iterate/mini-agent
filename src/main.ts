/**
 * Main Entry Point
 *
 * Sets up layers and runs the CLI.
 */
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { FetchHttpClient } from "@effect/platform"
import { Effect, Config, Layer, Cause, Console } from "effect"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { cli, GenAISpanTransformerLayer } from "./cli.js"
import { ContextService } from "./context.service.js"
import { createTracingLayer } from "./tracing/index.js"

// =============================================================================
// Configuration
// =============================================================================

const OpenAiApiKey = Config.redacted("OPENAI_API_KEY")
const OpenAiModel = Config.string("OPENAI_MODEL").pipe(Config.withDefault("gpt-4o-mini"))

// =============================================================================
// Layer Setup
// =============================================================================

const makeLanguageModelLayer = (apiKey: Config.Config.Success<typeof OpenAiApiKey>, model: string) =>
  Layer.mergeAll(OpenAiLanguageModel.layer({ model }), GenAISpanTransformerLayer).pipe(
    Layer.provide(OpenAiClient.layer({ apiKey }).pipe(Layer.provide(FetchHttpClient.layer)))
  )

const LanguageModelLayer = Layer.unwrapEffect(
  Effect.gen(function*() {
    const apiKey = yield* OpenAiApiKey
    const model = yield* OpenAiModel
    return makeLanguageModelLayer(apiKey, model)
  })
)

// =============================================================================
// Main Layer Composition
// =============================================================================

// ContextService requires FileSystem + Path from BunContext
const ContextServiceLayer = ContextService.Default.pipe(
  Layer.provide(BunContext.layer)
)

const MainLayer = Layer.mergeAll(
  ContextServiceLayer,
  LanguageModelLayer,
  BunContext.layer,
  createTracingLayer("effect-cli")
)

// =============================================================================
// Run
// =============================================================================

cli(process.argv).pipe(
  Effect.provide(MainLayer),
  Effect.catchAllCause((cause) =>
    Cause.isInterruptedOnly(cause) ? Effect.void : Console.error(`Fatal error: ${Cause.pretty(cause)}`)
  ),
  BunRuntime.runMain
)

