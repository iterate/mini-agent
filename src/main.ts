/**
 * Main Entry Point
 *
 * Sets up configuration, logging, and service layers, then runs the CLI.
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { FetchHttpClient } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Cause, Effect, Layer } from "effect"
import { cli, GenAISpanTransformerLayer } from "./cli.ts"
import {
  AppConfig,
  extractConfigPath,
  makeConfigProvider,
  MiniAgentConfig,
  type MiniAgentConfig as MiniAgentConfigType,
  resolveBaseDir
} from "./config.ts"
import { ContextRepository } from "./context.repository.ts"
import { ContextService } from "./context.service.ts"
import { createLoggingLayer } from "./logging.ts"
import { createTracingLayer } from "./tracing/index.ts"

// =============================================================================
// Layer Factories
// =============================================================================

/**
 * Create the OpenAI language model layer from configuration.
 */
const makeLanguageModelLayer = (config: MiniAgentConfigType) =>
  Layer.mergeAll(
    OpenAiLanguageModel.layer({ model: config.openaiModel }),
    GenAISpanTransformerLayer
  ).pipe(
    Layer.provide(
      OpenAiClient.layer({ apiKey: config.openaiApiKey }).pipe(
        Layer.provide(FetchHttpClient.layer)
      )
    )
  )

/**
 * Create the logging layer from configuration.
 */
const makeLoggingLayer = (config: MiniAgentConfigType) =>
  createLoggingLayer({
    stdoutLogLevel: config.stdoutLogLevel,
    fileLogLevel: config.fileLogLevel,
    baseDir: resolveBaseDir(config)
  })

// =============================================================================
// Main Layer Composition
// =============================================================================

/**
 * Build the main application layer from CLI arguments.
 * Handles config loading, provider composition, and layer construction.
 */
const makeMainLayer = (args: ReadonlyArray<string>) =>
  Layer.unwrapEffect(
    Effect.gen(function*() {
      // Phase 1: Load config (no logging yet)
      const configPath = extractConfigPath(args)
      const configProvider = yield* makeConfigProvider(configPath, args)
      const config = yield* MiniAgentConfig.pipe(Effect.withConfigProvider(configProvider))

      // Build logging layer for both construction and runtime
      const loggingLayer = makeLoggingLayer(config)

      // Phase 2: Build layers with logging available for debug output
      const buildLayers = Effect.gen(function*() {
        yield* Effect.logDebug("Using config", config)

        // Store layer references for memoization (effect-solutions pattern)
        const configProviderLayer = Layer.setConfigProvider(configProvider)
        const appConfigLayer = AppConfig.fromConfig(config)
        const languageModelLayer = makeLanguageModelLayer(config)
        const tracingLayer = createTracingLayer("mini-agent")

        // Compose using Layer.provideMerge chain (effect-solutions pattern)
        // Dependencies are resolved from layers later in the chain
        return ContextService.layer.pipe(
          Layer.provideMerge(ContextRepository.layer),
          Layer.provideMerge(languageModelLayer),
          Layer.provideMerge(tracingLayer),
          Layer.provideMerge(appConfigLayer),
          Layer.provideMerge(configProviderLayer),
          Layer.provideMerge(loggingLayer),
          Layer.provideMerge(BunContext.layer)
        )
      })

      // Build with logging for Effect.logDebug
      return Layer.unwrapEffect(buildLayers.pipe(Effect.provide(loggingLayer)))
    }).pipe(
      Effect.provide(BunContext.layer)
    )
  )

// =============================================================================
// Run
// =============================================================================

const args = process.argv.slice(2)

cli(process.argv).pipe(
  Effect.provide(makeMainLayer(args)),
  Effect.catchAllCause((cause) =>
    Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError(`Fatal error: ${Cause.pretty(cause)}`)
  ),
  (effect) => BunRuntime.runMain(effect, { disablePrettyLogger: true })
)
