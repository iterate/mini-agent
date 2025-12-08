/**
 * Main Entry Point
 */
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { FetchHttpClient } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Cause, Effect, Layer } from "effect"
import { AgentRegistry } from "../agent-registry.ts"
import { AgentService, HttpAgentService, InProcessAgentService } from "../agent-service.ts"
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

/** Extract remote URL from CLI args (--remote or REMOTE env var) */
const extractRemoteUrl = (args: ReadonlyArray<string>): string | null => {
  // Check env var first
  if (process.env.MINI_AGENT_REMOTE) {
    return process.env.MINI_AGENT_REMOTE
  }

  // Check CLI args for --remote
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--remote" && i + 1 < args.length) {
      return args[i + 1] ?? null
    } else if (arg?.startsWith("--remote=")) {
      return arg.slice("--remote=".length) || null
    }
  }

  return null
}

const makeMainLayer = (args: ReadonlyArray<string>) =>
  Layer.unwrapEffect(
    Effect.gen(function*() {
      const configPath = extractConfigPath(args)
      const configProvider = yield* makeConfigProvider(configPath, args)
      const config = yield* MiniAgentConfig.pipe(Effect.withConfigProvider(configProvider))

      const loggingLayer = makeLoggingLayer(config)

      const buildLayers = Effect.gen(function*() {
        yield* Effect.logDebug("Using config", config)

        const llmConfig = yield* resolveLlmConfig.pipe(Effect.withConfigProvider(configProvider))
        yield* Effect.logDebug("Using LLM config", { provider: llmConfig.apiFormat, model: llmConfig.model })

        const configProviderLayer = Layer.setConfigProvider(configProvider)
        const appConfigLayer = AppConfig.fromConfig(config)
        const llmConfigLayer = CurrentLlmConfig.fromConfig(llmConfig)
        const languageModelLayer = makeLanguageModelLayer(llmConfig)
        const tracingLayer = createTracingLayer("mini-agent")

        // Check for remote mode
        const remoteUrl = extractRemoteUrl(args)

        // AgentRegistry.Default requires EventStore, EventReducer, and MiniAgentTurn
        const agentRegistryLayer = AgentRegistry.Default.pipe(
          Layer.provideMerge(LlmTurnLive),
          Layer.provideMerge(languageModelLayer),
          Layer.provideMerge(llmConfigLayer),
          Layer.provideMerge(EventStoreFileSystem),
          Layer.provideMerge(EventReducer.Default),
          Layer.provideMerge(tracingLayer),
          Layer.provideMerge(appConfigLayer),
          Layer.provideMerge(configProviderLayer),
          Layer.provideMerge(loggingLayer),
          Layer.provideMerge(BunContext.layer)
        )

        // Provide AgentService - either in-process or HTTP client
        if (remoteUrl) {
          yield* Effect.log(`Using remote agent service: ${remoteUrl}`)
          const httpServiceLayer = HttpAgentService.fromUrl(remoteUrl)
          // Map HttpAgentService to AgentService interface
          const agentServiceLayer = Layer.effect(
            AgentService,
            Effect.gen(function*() {
              const httpService = yield* HttpAgentService
              return {
                addEvents: httpService.addEvents,
                tapEventStream: httpService.tapEventStream,
                getEvents: httpService.getEvents,
                getState: httpService.getState
              }
            })
          ).pipe(Layer.provide(httpServiceLayer))
          return Layer.mergeAll(httpServiceLayer, agentServiceLayer)
        } else {
          const inProcessServiceLayer = InProcessAgentService.Default.pipe(Layer.provide(agentRegistryLayer))
          // Map InProcessAgentService to AgentService interface
          const agentServiceLayer = Layer.effect(
            AgentService,
            Effect.gen(function*() {
              const inProcessService = yield* InProcessAgentService
              return {
                addEvents: inProcessService.addEvents,
                tapEventStream: inProcessService.tapEventStream,
                getEvents: inProcessService.getEvents,
                getState: inProcessService.getState
              }
            })
          ).pipe(Layer.provide(inProcessServiceLayer))
          return Layer.mergeAll(agentRegistryLayer, inProcessServiceLayer, agentServiceLayer)
        }
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
