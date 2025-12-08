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
import { LocalAgentServiceLive } from "../agent-service-local.ts"
import { makeRemoteAgentServiceLive } from "../agent-service-remote.ts"
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

/** Extract --remote value from args */
const extractRemoteUrl = (args: ReadonlyArray<string>): Option.Option<string> => {
  const remoteIdx = args.indexOf("--remote")
  if (remoteIdx !== -1 && args[remoteIdx + 1]) {
    return Option.some(args[remoteIdx + 1]!)
  }
  return Option.none()
}

const makeMainLayer = (args: ReadonlyArray<string>) =>
  Layer.unwrapEffect(
    Effect.gen(function*() {
      const configPath = extractConfigPath(args)
      const configProvider = yield* makeConfigProvider(configPath, args)
      const config = yield* MiniAgentConfig.pipe(Effect.withConfigProvider(configProvider))

      const loggingLayer = makeLoggingLayer(config)
      const remoteUrl = extractRemoteUrl(args)

      const buildLayers = Effect.gen(function*() {
        yield* Effect.logDebug("Using config", config)

        const llmConfig = yield* resolveLlmConfig.pipe(Effect.withConfigProvider(configProvider))
        yield* Effect.logDebug("Using LLM config", { provider: llmConfig.apiFormat, model: llmConfig.model })

        const configProviderLayer = Layer.setConfigProvider(configProvider)
        const appConfigLayer = AppConfig.fromConfig(config)
        const tracingLayer = createTracingLayer("mini-agent")
        const llmConfigLayer = CurrentLlmConfig.fromConfig(llmConfig)
        const languageModelLayer = makeLanguageModelLayer(llmConfig)

        // AgentRegistry is always needed (for serve command)
        // AgentRegistry.Default requires EventStore, EventReducer, and MiniAgentTurn
        const agentRegistryLayer = AgentRegistry.Default.pipe(
          Layer.provide(LlmTurnLive),
          Layer.provide(languageModelLayer),
          Layer.provide(llmConfigLayer),
          Layer.provide(EventStoreFileSystem),
          Layer.provide(EventReducer.Default),
          Layer.provide(appConfigLayer),
          Layer.provide(BunContext.layer)
        )

        // EventStore layer (also used by LocalAgentServiceLive for list())
        const eventStoreLayer = EventStoreFileSystem.pipe(
          Layer.provide(appConfigLayer),
          Layer.provide(BunContext.layer)
        )

        // AgentService: use remote or local implementation based on --remote flag
        const agentServiceLayer = Option.isSome(remoteUrl)
          ? (() => {
            void Effect.logDebug("Using remote AgentService", { url: remoteUrl.value }).pipe(
              Effect.provide(loggingLayer),
              Effect.runPromise
            )
            return makeRemoteAgentServiceLive({ baseUrl: remoteUrl.value }).pipe(
              Layer.provide(FetchHttpClient.layer)
            )
          })()
          : LocalAgentServiceLive.pipe(
            Layer.provide(agentRegistryLayer),
            Layer.provide(eventStoreLayer)
          )

        return agentServiceLayer.pipe(
          Layer.provideMerge(agentRegistryLayer), // Always provide AgentRegistry (for serve command)
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
  Effect.scoped,
  Effect.provide(makeMainLayer(args)),
  Effect.catchAllCause((cause) => Cause.isInterruptedOnly(cause) ? Effect.void : Effect.failCause(cause)),
  (effect) => BunRuntime.runMain(effect, { disablePrettyLogger: true })
)
