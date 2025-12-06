/**
 * CLI wrapper for new architecture.
 *
 * Simple CLI entry point demonstrating the actor-based architecture.
 * Usage: bun run src/new-architecture/cli.ts chat -n <context> -m <msg>
 */

import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Command, Options } from "@effect/cli"
import { FetchHttpClient, Terminal } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Fiber, Layer, LogLevel, Option, Stream } from "effect"
import { AppConfig, type MiniAgentConfig } from "../config.ts"
import { CurrentLlmConfig, getApiKey, type LlmConfig, resolveLlmConfig } from "../llm-config.ts"
import { createLoggingLayer } from "../logging.ts"
import { OpenAiChatClient, OpenAiChatLanguageModel } from "../openai-chat-completions-client.ts"
import { AgentRegistry } from "./agent-registry.ts"
import { type AgentName, EventBuilder } from "./domain.ts"
import { EventReducer } from "./event-reducer.ts"
import { EventStoreFileSystem } from "./event-store-fs.ts"
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

// CLI Options
const nameOption = Options.text("name").pipe(
  Options.withAlias("n"),
  Options.withDescription("Context/agent name"),
  Options.withDefault("default")
)

const messageOption = Options.text("message").pipe(
  Options.withAlias("m"),
  Options.withDescription("Message to send")
)

const rawOption = Options.boolean("raw").pipe(
  Options.withAlias("r"),
  Options.withDescription("Output raw JSON events"),
  Options.withDefault(false)
)

const cwdOption = Options.directory("cwd").pipe(
  Options.withDescription("Working directory"),
  Options.optional
)

// Chat command
const chatCommand = Command.make(
  "chat",
  { name: nameOption, message: messageOption, raw: rawOption },
  ({ message, name, raw }) =>
    Effect.gen(function*() {
      const terminal = yield* Terminal.Terminal
      const registry = yield* AgentRegistry

      const agentName = name as AgentName
      const agent = yield* registry.getOrCreate(agentName)

      // Get current context to know event number
      const ctx = yield* agent.getReducedContext

      // Subscribe to events BEFORE adding the user message
      // Fork the stream consumption so it runs in parallel
      const streamFiber = yield* agent.events.pipe(
        Stream.takeUntil((e) => e._tag === "AgentTurnCompletedEvent" || e._tag === "AgentTurnFailedEvent"),
        Stream.tap((event) => {
          if (raw) {
            return terminal.display(JSON.stringify(event) + "\n")
          } else if (event._tag === "TextDeltaEvent") {
            return terminal.display(event.delta)
          } else if (event._tag === "AssistantMessageEvent") {
            return terminal.display("\n")
          }
          return Effect.void
        }),
        Stream.runDrain,
        Effect.fork
      )

      // Add user message with triggersAgentTurn=true
      const userEvent = EventBuilder.userMessage(
        agentName,
        agent.contextName,
        ctx.nextEventNumber,
        message
      )
      yield* agent.addEvent(userEvent)

      // Wait for stream to complete
      yield* Fiber.join(streamFiber)
    })
)

// Root command
const cli = Command.make("mini-agent-v2", { cwd: cwdOption }).pipe(
  Command.withSubcommands([chatCommand])
)

const cliApp = Command.run(cli, {
  name: "mini-agent-v2",
  version: "2.0.0"
})

// Default config for CLI
const defaultConfig: MiniAgentConfig = {
  llm: "openai:gpt-4o-mini",
  dataStorageDir: ".mini-agent",
  configFile: "mini-agent.config.yaml",
  cwd: Option.none(),
  stdoutLogLevel: LogLevel.Warning,
  fileLogLevel: LogLevel.Debug,
  port: 3000,
  host: "0.0.0.0",
  layercodeWebhookSecret: Option.none()
}

const appConfigLayer = Layer.succeed(AppConfig, defaultConfig)

const program = Effect.gen(function*() {
  const llmConfig = yield* resolveLlmConfig
  yield* Effect.logDebug("Using LLM config", { provider: llmConfig.apiFormat, model: llmConfig.model })

  const languageModelLayer = makeLanguageModelLayer(llmConfig)
  const llmConfigLayer = CurrentLlmConfig.fromConfig(llmConfig)

  // Build the full layer stack
  // AgentRegistry.Default requires EventStore, EventReducer, and MiniAgentTurn
  const fullLayer = AgentRegistry.Default.pipe(
    Layer.provide(LlmTurnLive),
    Layer.provide(languageModelLayer),
    Layer.provide(llmConfigLayer),
    Layer.provide(EventStoreFileSystem),
    Layer.provide(EventReducer.Default),
    Layer.provide(appConfigLayer),
    Layer.provide(BunContext.layer)
  )

  yield* cliApp(process.argv).pipe(Effect.provide(fullLayer))
})

const loggingLayer = createLoggingLayer({
  stdoutLogLevel: LogLevel.Warning,
  fileLogLevel: LogLevel.Debug,
  baseDir: ".mini-agent"
})

const mainLayer = Layer.mergeAll(loggingLayer, BunContext.layer)

program.pipe(
  Effect.provide(mainLayer),
  BunRuntime.runMain
)
