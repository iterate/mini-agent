/**
 * Main Entry Point
 *
 * Sets up configuration, logging, and service layers, then runs the CLI.
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { FetchHttpClient } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Cause, Console, Effect, Layer, LogLevel, Option } from "effect"
import { cli, GenAISpanTransformerLayer } from "./cli.js"
import {
  AppConfig,
  extractConfigPath,
  makeConfigProvider,
  MiniAgentConfig,
  type MiniAgentConfig as MiniAgentConfigType,
  resolveBaseDir
} from "./config.js"
import { ContextService } from "./context.service.js"
import { createLoggingLayer, type LoggingConfig } from "./logging.js"
import { createTracingLayer } from "./tracing/index.js"

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
const makeLoggingLayer = (config: MiniAgentConfigType, cliLogLevel: Option.Option<string>) => {
  // CLI log level overrides config
  const stdoutLevel = Option.match(cliLogLevel, {
    onNone: () => config.logging.stdoutLevel,
    onSome: (level) => {
      const l = level.toLowerCase()
      if (l === "none" || l === "off") return LogLevel.None
      return LogLevel.fromLiteral(l as LogLevel.Literal)
    }
  })

  const loggingConfig: LoggingConfig = {
    stdoutLevel,
    fileLogPath: config.logging.fileLogPath,
    fileLogLevel: config.logging.fileLogLevel,
    baseDir: resolveBaseDir(config)
  }

  return createLoggingLayer(loggingConfig)
}

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
      // Extract config file path from args
      const configPath = extractConfigPath(args)

      // Build composed ConfigProvider (CLI → env → YAML → defaults)
      const provider = yield* makeConfigProvider(configPath, args)
      const configLayer = Layer.setConfigProvider(provider)

      // Load and validate configuration
      const config = yield* MiniAgentConfig.pipe(
        Effect.withConfigProvider(provider)
      )

      yield* Effect.log(`Configuration loaded from: ${configPath}`)
      yield* Effect.logDebug(`Data storage directory: ${config.dataStorageDir}`)
      yield* Effect.logDebug(`OpenAI model: ${config.openaiModel}`)

      // Extract --log-level from CLI args for override
      const logLevelIdx = args.findIndex((a) => a === "--log-level")
      const nextArg = logLevelIdx >= 0 ? args[logLevelIdx + 1] : undefined
      const cliLogLevel: Option.Option<string> = nextArg !== undefined
        ? Option.some(nextArg)
        : Option.none()

      // Build layers
      const appConfigLayer = AppConfig.fromConfig(config)
      const loggingLayer = makeLoggingLayer(config, cliLogLevel)
      const languageModelLayer = makeLanguageModelLayer(config)

      // ContextService requires FileSystem + Path from BunContext
      const contextServiceLayer = ContextService.Default.pipe(
        Layer.provide(BunContext.layer),
        Layer.provide(appConfigLayer)
      )

      return Layer.mergeAll(
        configLayer,
        appConfigLayer,
        loggingLayer,
        contextServiceLayer,
        languageModelLayer,
        BunContext.layer,
        createTracingLayer("mini-agent")
      )
    }).pipe(
      // Provide BunContext for config loading (FileSystem access)
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
    Cause.isInterruptedOnly(cause) ? Effect.void : Console.error(`Fatal error: ${Cause.pretty(cause)}`)
  ),
  BunRuntime.runMain
)
