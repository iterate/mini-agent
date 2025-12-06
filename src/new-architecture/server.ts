/**
 * HTTP Server entry point for new architecture.
 *
 * Usage: bun run src/new-architecture/server.ts [--port PORT]
 */

import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { FetchHttpClient, HttpServer } from "@effect/platform"
import { BunContext, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer, LogLevel, Option } from "effect"
import { AppConfig, type MiniAgentConfig } from "../config.ts"
import { CurrentLlmConfig, getApiKey, type LlmConfig, resolveLlmConfig } from "../llm-config.ts"
import { createLoggingLayer } from "../logging.ts"
import { OpenAiChatClient, OpenAiChatLanguageModel } from "../openai-chat-completions-client.ts"
import { AgentRegistry } from "./agent-registry.ts"
import { EventReducer } from "./event-reducer.ts"
import { EventStoreFileSystem } from "./event-store-fs.ts"
import { makeRouterV2 } from "./http.ts"
import { LlmTurnLive } from "./llm-turn.ts"

const makeLanguageModelLayer = (llmConfig: LlmConfig) => {
  const apiKey = getApiKey(llmConfig)

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
}

// Parse port from args
const port = (() => {
  const portIdx = process.argv.indexOf("--port")
  if (portIdx !== -1 && process.argv[portIdx + 1]) {
    return parseInt(process.argv[portIdx + 1]!, 10)
  }
  return 3001
})()

// Default config for server
const defaultConfig: MiniAgentConfig = {
  llm: "openai:gpt-4o-mini",
  dataStorageDir: ".mini-agent",
  configFile: "mini-agent.config.yaml",
  cwd: Option.none(),
  stdoutLogLevel: LogLevel.Warning,
  fileLogLevel: LogLevel.Debug,
  port,
  host: "0.0.0.0",
  layercodeWebhookSecret: Option.none()
}

const appConfigLayer = Layer.succeed(AppConfig, defaultConfig)

const program = Effect.gen(function*() {
  const llmConfig = yield* resolveLlmConfig
  yield* Effect.log(`Starting server on port ${port}`)
  yield* Effect.logDebug("Using LLM config", { provider: llmConfig.apiFormat, model: llmConfig.model })

  const languageModelLayer = makeLanguageModelLayer(llmConfig)
  const llmConfigLayer = CurrentLlmConfig.fromConfig(llmConfig)

  // Build the full layer stack
  const serviceLayer = AgentRegistry.Default.pipe(
    Layer.provideMerge(LlmTurnLive),
    Layer.provideMerge(languageModelLayer),
    Layer.provideMerge(llmConfigLayer),
    Layer.provideMerge(EventStoreFileSystem),
    Layer.provideMerge(EventReducer.Default),
    Layer.provideMerge(appConfigLayer),
    Layer.provideMerge(BunContext.layer)
  )

  // HTTP server layer
  const serverLayer = HttpServer.serve(makeRouterV2).pipe(
    Layer.provide(BunHttpServer.layer({ port })),
    Layer.provide(serviceLayer)
  )

  return yield* Layer.launch(serverLayer)
})

const loggingLayer = createLoggingLayer({
  stdoutLogLevel: LogLevel.Info,
  fileLogLevel: LogLevel.Debug,
  baseDir: ".mini-agent"
})

const mainLayer = Layer.mergeAll(loggingLayer, BunContext.layer)

program.pipe(
  Effect.provide(mainLayer),
  BunRuntime.runMain
)
