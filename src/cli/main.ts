/**
 * Main Entry Point
 */
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { FetchHttpClient } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Cause, Effect, Layer, Option } from "effect"
import { AgentRegistry } from "../agent-registry.ts"
import { makeHttpAgentServiceLayer } from "../agent-service-http.ts"
import {
  AppConfig,
  extractConfigPath,
  makeConfigProvider,
  MiniAgentConfig,
  type MiniAgentConfig as MiniAgentConfigType,
  resolveBaseDir
} from "../config.ts"
import { EventReducer } from "../event-reducer.ts"
import { EventStoreFileSystem } from "../event-store-fs.ts"
import { CurrentLlmConfig, getApiKey, type LlmConfig, resolveLlmConfig } from "../llm-config.ts"
import { LlmTurnLive } from "../llm-turn.ts"
import { createLoggingLayer } from "../logging.ts"
import { OpenAiChatClient, OpenAiChatLanguageModel } from "../openai-chat-completions-client.ts"
import { createTracingLayer } from "../tracing.ts"
import { cli, GenAISpanTransformerLayer } from "./commands.ts"

/** Extract --remote URL from args if present */
const extractRemoteUrl = (args: ReadonlyArray<string>): Option.Option<string> => {
  const remoteIndex = args.findIndex((arg) => arg === "--remote")
  if (remoteIndex >= 0 && remoteIndex + 1 < args.length) {
    return Option.some(args[remoteIndex + 1]!)
  }
  return Option.none()
}

const makeLanguageModelLayer = (llmConfig: LlmConfig) => {
  const apiKey = getApiKey(llmConfig)

  const baseLayer = (() => {
    switch (llmConfig.apiFormat) {
      case "openai-responses":
        return OpenAiLanguageModel.layer({ model: llmConfig.model }).pipe(
          Layer.provide(
            OpenAiClient.layer({ apiKey, apiUrl: llmConfig.baseUrl }).pipe(
              Layer.provide(FetchHttpClient.layer)
            )
          )
        )

      case "openai-chat-completions":
        return OpenAiChatLanguageModel.layer({ model: llmConfig.model }).pipe(
          Layer.provide(
            OpenAiChatClient.layer({ apiKey, apiUrl: llmConfig.baseUrl }).pipe(
              Layer.provide(FetchHttpClient.layer)
            )
          )
        )

      case "anthropic":
        return AnthropicLanguageModel.layer({ model: llmConfig.model }).pipe(
          Layer.provide(
            AnthropicClient.layer({ apiKey, apiUrl: llmConfig.baseUrl }).pipe(
              Layer.provide(FetchHttpClient.layer)
            )
          )
        )

      case "gemini":
        return GoogleLanguageModel.layer({ model: llmConfig.model }).pipe(
          Layer.provide(
            GoogleClient.layer({ apiKey, apiUrl: llmConfig.baseUrl }).pipe(
              Layer.provide(FetchHttpClient.layer)
            )
          )
        )
    }
  })()

  return Layer.mergeAll(baseLayer, GenAISpanTransformerLayer)
}

const makeLoggingLayer = (config: MiniAgentConfigType) =>
  createLoggingLayer({
    stdoutLogLevel: config.stdoutLogLevel,
    fileLogLevel: config.fileLogLevel,
    baseDir: resolveBaseDir(config)
  })

const makeMainLayer = (args: ReadonlyArray<string>) =>
  Layer.unwrapEffect(
    Effect.gen(function*() {
      const configPath = extractConfigPath(args)
      const configProvider = yield* makeConfigProvider(configPath, args)
      const config = yield* MiniAgentConfig.pipe(Effect.withConfigProvider(configProvider))
      const remoteUrl = extractRemoteUrl(args)

      const loggingLayer = makeLoggingLayer(config)

      const buildLayers = Effect.gen(function*() {
        yield* Effect.logDebug("Using config", config)

        const configProviderLayer = Layer.setConfigProvider(configProvider)
        const appConfigLayer = AppConfig.fromConfig(config)
        const tracingLayer = createTracingLayer("mini-agent")

        // Always need LLM config for local infrastructure (serve command, etc.)
        const llmConfig = yield* resolveLlmConfig.pipe(Effect.withConfigProvider(configProvider))
        yield* Effect.logDebug("Using LLM config", { provider: llmConfig.apiFormat, model: llmConfig.model })

        const llmConfigLayer = CurrentLlmConfig.fromConfig(llmConfig)
        const languageModelLayer = makeLanguageModelLayer(llmConfig)

        // Base layer with AgentRegistry (always needed for serve command)
        const baseRegistryLayer = AgentRegistry.Default.pipe(
          Layer.provideMerge(LlmTurnLive),
          Layer.provideMerge(languageModelLayer),
          Layer.provideMerge(llmConfigLayer),
          Layer.provideMerge(EventStoreFileSystem),
          Layer.provideMerge(EventReducer.Default)
        )

        // AgentService layer depends on mode
        const agentServiceLayer = Option.isSome(remoteUrl)
          ? (() => {
            // Remote mode: use HTTP client for AgentService
            const httpClientLayer = FetchHttpClient.layer
            return makeHttpAgentServiceLayer(remoteUrl.value).pipe(
              Layer.provide(httpClientLayer)
            )
          })()
          // Local mode: use in-process AgentService backed by AgentRegistry
          : AgentRegistry.InProcessAgentService.pipe(
            Layer.provide(baseRegistryLayer)
          )

        if (Option.isSome(remoteUrl)) {
          yield* Effect.logInfo("Running in remote mode", { url: remoteUrl.value })
        }

        // Combine layers - AgentRegistry for serve, AgentService for chat commands
        return agentServiceLayer.pipe(
          Layer.provideMerge(baseRegistryLayer),
          Layer.provideMerge(tracingLayer),
          Layer.provideMerge(appConfigLayer),
          Layer.provideMerge(configProviderLayer),
          Layer.provideMerge(loggingLayer),
          Layer.provideMerge(BunContext.layer)
        )
      })

      return Layer.unwrapEffect(buildLayers.pipe(Effect.provide(loggingLayer)))
    }).pipe(
      Effect.provide(BunContext.layer)
    )
  )

const args = process.argv.slice(2)

cli(process.argv).pipe(
  Effect.provide(makeMainLayer(args)),
  Effect.catchAllCause((cause) => Cause.isInterruptedOnly(cause) ? Effect.void : Effect.failCause(cause)),
  (effect) => BunRuntime.runMain(effect, { disablePrettyLogger: true })
)
