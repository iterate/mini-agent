/**
 * HTTP Server entry point.
 *
 * Usage: bun run src/server.ts [--port PORT]
 */

import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { FetchHttpClient, HttpServer } from "@effect/platform"
import { BunContext, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { ConfigProvider, Effect, Layer, LogLevel, Option } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import { AgentService } from "./agent-service.ts"
import { AppConfig, type MiniAgentConfig } from "./config.ts"
import { EventReducer } from "./event-reducer.ts"
import { EventStoreFileSystem } from "./event-store-fs.ts"
import { makeRouter } from "./http-routes.ts"
import { CurrentLlmConfig, getApiKey, type LlmConfig, resolveLlmConfig } from "./llm-config.ts"
import { LlmTurnLive } from "./llm-turn.ts"
import { createLoggingLayer } from "./logging.ts"
import { OpenAiChatClient, OpenAiChatLanguageModel } from "./openai-chat-completions-client.ts"

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
  systemPrompt: "You are a helpful assistant.",
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
  const llmConfig = yield* resolveLlmConfig.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv()))
  yield* Effect.log(`Starting server on port ${port}`)
  yield* Effect.logDebug("Using LLM config", { provider: llmConfig.apiFormat, model: llmConfig.model })

  const languageModelLayer = makeLanguageModelLayer(llmConfig)
  const llmConfigLayer = CurrentLlmConfig.fromConfig(llmConfig)

  // Build the full layer stack
  // AgentRegistry.Default requires EventStore, EventReducer, and MiniAgentTurn
  const registryLayer = AgentRegistry.Default.pipe(
    Layer.provide(LlmTurnLive),
    Layer.provide(languageModelLayer),
    Layer.provide(llmConfigLayer),
    Layer.provide(EventStoreFileSystem),
    Layer.provide(EventReducer.Default),
    Layer.provide(appConfigLayer),
    Layer.provide(BunContext.layer)
  )

  // Provide AgentService using in-process implementation
  const serviceLayer = AgentService.InProcess.pipe(Layer.provide(registryLayer))

  // HTTP server layer
  // Set idleTimeout high for SSE streaming - Bun defaults to 10s which kills long-running streams
  const serverLayer = HttpServer.serve(makeRouter).pipe(
    Layer.provide(BunHttpServer.layer({ port, idleTimeout: 120 })),
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
