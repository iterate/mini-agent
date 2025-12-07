/**
 * CLI Commands
 *
 * Defines the CLI interface for the chat application.
 */
import { type Prompt, Telemetry } from "@effect/ai"
import { Command, Options, Prompt as CliPrompt } from "@effect/cli"
import { type Error as PlatformError, FileSystem, HttpServer, Terminal } from "@effect/platform"
import { BunHttpServer, BunStream } from "@effect/platform-bun"
import { Chunk, Console, DateTime, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { AgentRegistry } from "../agent-registry.ts"
import { AppConfig, resolveBaseDir } from "../config.ts"
import {
  type AgentName,
  AssistantMessageEvent,
  type ContextEvent,
  makeEventId,
  TextDeltaEvent,
  UserMessageEvent
} from "../domain.ts"
import { makeRouter } from "../http-routes.ts"
import { layercodeCommand } from "../layercode/index.ts"
import { printTraceLinks } from "../tracing.ts"

export const configFileOption = Options.file("config").pipe(
  Options.withAlias("c"),
  Options.withDescription("Path to YAML config file"),
  Options.optional
)

export const cwdOption = Options.directory("cwd").pipe(
  Options.withDescription("Working directory override"),
  Options.optional
)

export const stdoutLogLevelOption = Options.choice("stdout-log-level", [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "none"
]).pipe(
  Options.withDescription("Stdout log level (overrides config)"),
  Options.optional
)

export const llmOption = Options.text("llm").pipe(
  Options.withDescription(
    "LLM provider:model (e.g., openai:gpt-4.1-mini, anthropic:claude-sonnet-4-5-20250929). " +
      "See README for full model list. Can also be set via LLM env var."
  ),
  Options.optional
)

const nameOption = Options.text("name").pipe(
  Options.withAlias("n"),
  Options.withDescription("Context name (slug identifier for the conversation)"),
  Options.optional
)

const messageOption = Options.text("message").pipe(
  Options.withAlias("m"),
  Options.withDescription("Message to send (non-interactive single-turn mode)"),
  Options.optional
)

const rawOption = Options.boolean("raw").pipe(
  Options.withAlias("r"),
  Options.withDescription("Output events as JSON objects, one per line"),
  Options.withDefault(false)
)

const showEphemeralOption = Options.boolean("show-ephemeral").pipe(
  Options.withAlias("e"),
  Options.withDescription("Include ephemeral events (streaming deltas) in output"),
  Options.withDefault(false)
)

const scriptOption = Options.boolean("script").pipe(
  Options.withAlias("s"),
  Options.withDescription("Script mode: read JSONL events from stdin, output JSONL events"),
  Options.withDefault(false)
)

interface OutputOptions {
  raw: boolean
  showEphemeral: boolean
}

/**
 * Handle a single context event based on output options.
 */
const handleEvent = (
  event: ContextEvent,
  options: OutputOptions
): Effect.Effect<void, PlatformError.PlatformError, Terminal.Terminal> =>
  Effect.gen(function*() {
    const terminal = yield* Terminal.Terminal

    if (options.raw) {
      if (Schema.is(TextDeltaEvent)(event) && !options.showEphemeral) {
        return
      }
      yield* Console.log(JSON.stringify(event))
      return
    }

    if (Schema.is(TextDeltaEvent)(event)) {
      yield* terminal.display(event.delta)
      return
    }
    if (Schema.is(AssistantMessageEvent)(event)) {
      yield* Console.log("")
      return
    }
  })

/** Run the event stream, handling each event */
const runEventStream = (
  contextName: string,
  userMessage: string,
  options: OutputOptions
) =>
  Effect.gen(function*() {
    const registry = yield* AgentRegistry
    const agent = yield* registry.getOrCreate(contextName as AgentName)

    // Get current context to build proper event
    const ctx = yield* agent.getReducedContext

    // Create user event with triggersAgentTurn=true
    const userEvent = new UserMessageEvent({
      id: makeEventId(agent.contextName, ctx.nextEventNumber),
      timestamp: DateTime.unsafeNow(),
      agentName: agent.agentName,
      parentEventId: Option.none(),
      triggersAgentTurn: true,
      content: userMessage
    })

    // Subscribe to events before adding the user event
    const eventFiber = yield* agent.events.pipe(
      Stream.takeUntil((e) => e._tag === "AgentTurnCompletedEvent" || e._tag === "AgentTurnFailedEvent"),
      Stream.runForEach((event) => handleEvent(event, options)),
      Effect.fork
    )

    // Add event to agent - triggers LLM turn
    yield* agent.addEvent(userEvent)

    // Wait for turn to complete
    yield* Fiber.join(eventFiber).pipe(Effect.catchAllCause(() => Effect.void))

    // End session
    yield* agent.endSession
  })

/** CLI interaction mode - determines how input/output is handled */
const InteractionMode = Schema.Literal("single-turn", "pipe", "script", "tty-interactive")
type InteractionMode = typeof InteractionMode.Type

const determineMode = (options: {
  message: Option.Option<string>
  script: boolean
}): InteractionMode => {
  const hasMessage = Option.isSome(options.message) &&
    Option.getOrElse(options.message, () => "").trim() !== ""

  if (hasMessage) return "single-turn"
  if (options.script) return "script"
  if (process.stdin.isTTY) return "tty-interactive"
  return "pipe"
}

const utf8Decoder = new TextDecoder("utf-8")

const readAllStdin: Effect.Effect<string> = BunStream.stdin.pipe(
  Stream.mapChunks(Chunk.map((bytes) => utf8Decoder.decode(bytes))),
  Stream.runCollect,
  Effect.map((chunks) => Chunk.join(chunks, "").trim())
)

/** Simple input message schema - accepts minimal fields */
const SimpleInputMessage = Schema.Struct({
  _tag: Schema.Union(
    Schema.Literal("UserMessage"),
    Schema.Literal("UserMessageEvent"),
    Schema.Literal("SystemPrompt"),
    Schema.Literal("SystemPromptEvent")
  ),
  content: Schema.String
})
type SimpleInputMessage = typeof SimpleInputMessage.Type

const stdinEvents = BunStream.stdin.pipe(
  Stream.mapChunks(Chunk.map((bytes) => utf8Decoder.decode(bytes))),
  Stream.splitLines,
  Stream.filter((line) => line.trim() !== ""),
  Stream.mapEffect((line) =>
    Effect.try(() => JSON.parse(line) as unknown).pipe(
      Effect.flatMap((json) => Schema.decodeUnknown(SimpleInputMessage)(json))
    )
  )
)

const scriptInteractiveLoop = (contextName: string, options: OutputOptions) =>
  Effect.gen(function*() {
    const registry = yield* AgentRegistry
    const agent = yield* registry.getOrCreate(contextName as AgentName)

    yield* stdinEvents.pipe(
      Stream.mapEffect((inputMsg) =>
        Effect.gen(function*() {
          yield* Console.log(JSON.stringify(inputMsg))

          const isUserMessage = inputMsg._tag === "UserMessage" || inputMsg._tag === "UserMessageEvent"

          if (isUserMessage) {
            // Get current context
            const ctx = yield* agent.getReducedContext

            // Create proper event with triggersAgentTurn
            const userEvent = new UserMessageEvent({
              id: makeEventId(agent.contextName, ctx.nextEventNumber),
              timestamp: DateTime.unsafeNow(),
              agentName: agent.agentName,
              parentEventId: Option.none(),
              triggersAgentTurn: true,
              content: inputMsg.content
            })

            // Subscribe to events
            const eventFiber = yield* agent.events.pipe(
              Stream.takeUntil((e) => e._tag === "AgentTurnCompletedEvent" || e._tag === "AgentTurnFailedEvent"),
              Stream.runForEach((outputEvent) => handleEvent(outputEvent, options)),
              Effect.fork
            )

            yield* agent.addEvent(userEvent)
            yield* Fiber.join(eventFiber).pipe(Effect.catchAllCause(() => Effect.void))
          } else {
            yield* Effect.logDebug("SystemPrompt events in script mode are echoed but not persisted")
          }
        })
      ),
      Stream.runDrain
    )

    yield* agent.endSession
  })

const NEW_CONTEXT_VALUE = "__new__"

const selectOrCreateContext = Effect.gen(function*() {
  const registry = yield* AgentRegistry
  const contexts = yield* registry.list

  if (contexts.length === 0) {
    yield* Console.log("No existing contexts found.")
    return yield* CliPrompt.text({ message: "Enter a name for your new context" })
  }

  const choices = [
    {
      title: "+ New context",
      value: NEW_CONTEXT_VALUE,
      description: "Start fresh with a new context"
    },
    ...contexts.map((name) => ({
      title: name,
      value: name,
      description: "Continue with this context"
    }))
  ]

  const selected = yield* CliPrompt.select({
    message: "Select context",
    choices
  })

  if (selected === NEW_CONTEXT_VALUE) {
    return yield* CliPrompt.text({ message: "Enter a name for your new conversation" })
  }

  return selected
})

const generateRandomContextName = (): string => {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  const suffix = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("")
  return `chat-${suffix}`
}

const makeChatUILayer = () =>
  Layer.unwrapEffect(
    Effect.gen(function*() {
      const { ChatUI } = yield* Effect.promise(() => import("./chat-ui.ts"))
      return ChatUI.Default
    })
  )

const runChat = (options: {
  name: Option.Option<string>
  message: Option.Option<string>
  raw: boolean
  script: boolean
  showEphemeral: boolean
}) =>
  Effect.gen(function*() {
    yield* Effect.logDebug("Starting chat session")
    const mode = determineMode(options)
    const contextName = Option.getOrElse(options.name, generateRandomContextName)

    const outputOptions: OutputOptions = {
      raw: mode === "script" || options.raw,
      showEphemeral: mode === "script" || options.showEphemeral
    }

    switch (mode) {
      case "single-turn": {
        const message = Option.getOrElse(options.message, () => "")
        yield* runEventStream(contextName, message, outputOptions)
        if (!outputOptions.raw) {
          yield* printTraceLinks
        }
        break
      }

      case "pipe": {
        const input = yield* readAllStdin
        if (input !== "") {
          yield* runEventStream(contextName, input, { raw: false, showEphemeral: false })
        }
        break
      }

      case "script": {
        yield* scriptInteractiveLoop(contextName, outputOptions)
        break
      }

      case "tty-interactive": {
        const resolvedName = Option.isSome(options.name)
          ? contextName
          : yield* selectOrCreateContext

        const { ChatUI } = yield* Effect.promise(() => import("./chat-ui.ts"))
        const chatUI = yield* ChatUI

        yield* chatUI.runChat(resolvedName).pipe(
          Effect.catchAllCause(() => Effect.void),
          Effect.ensuring(printTraceLinks.pipe(Effect.flatMap(() => Console.log("\nGoodbye!"))))
        )
        break
      }
    }
  }).pipe(
    Effect.provide(makeChatUILayer()),
    Effect.withSpan("chat-session")
  )

const collectText = (parts: ReadonlyArray<{ type: string; text?: string }>) =>
  parts
    .filter((p): p is typeof p & { text: string } => p.type === "text" && !!p.text)
    .map((p) => p.text)
    .join("")

interface CleanMessage {
  role: "system" | "user" | "assistant"
  content: string
}

const promptToCleanMessages = (prompt: Prompt.Prompt): Array<CleanMessage> => {
  const raw: Array<CleanMessage> = []
  for (const msg of prompt.content) {
    if (msg.role === "system") {
      raw.push({ role: "system", content: msg.content })
    } else if (msg.role === "user" || msg.role === "assistant") {
      const text = collectText(msg.content)
      if (text) raw.push({ role: msg.role, content: text })
    }
  }

  if (raw.length === 0) return []
  const result: Array<CleanMessage> = []
  let current = { ...raw[0]! }

  for (let i = 1; i < raw.length; i++) {
    const msg = raw[i]!
    if (msg.role === current.role) {
      current.content += msg.content
    } else {
      result.push(current)
      current = { ...msg }
    }
  }
  result.push(current)

  return result
}

const extractResponseText = (parts: ReadonlyArray<{ type: string; text?: string; delta?: string }>): string =>
  parts
    .filter((p): p is typeof p & { text: string } | typeof p & { delta: string } =>
      (p.type === "text" && !!p.text) || (p.type === "text-delta" && !!p.delta)
    )
    .map((p) => ("text" in p && p.text) ? p.text : ("delta" in p && p.delta) ? p.delta : "")
    .join("")

export const GenAISpanTransformerLayer = Layer.succeed(
  Telemetry.CurrentSpanTransformer,
  ({ prompt, response, span }) => {
    const input = promptToCleanMessages(prompt)
    const outputText = extractResponseText(response as ReadonlyArray<{ type: string; text?: string; delta?: string }>)
    const output = outputText ? [{ role: "assistant", content: outputText }] : []

    span.attribute("input", JSON.stringify(input))
    span.attribute("output", JSON.stringify(output))
  }
)

const chatCommand = Command.make(
  "chat",
  {
    name: nameOption,
    message: messageOption,
    raw: rawOption,
    script: scriptOption,
    showEphemeral: showEphemeralOption
  },
  ({ message, name, raw, script, showEphemeral }) => runChat({ message, name, raw, script, showEphemeral })
).pipe(Command.withDescription("Chat with an AI assistant using persistent context history"))

const logTestCommand = Command.make(
  "log-test",
  {},
  () =>
    Effect.gen(function*() {
      yield* Effect.logTrace("TRACE_MESSAGE")
      yield* Effect.logDebug("DEBUG_MESSAGE")
      yield* Effect.logInfo("INFO_MESSAGE")
      yield* Effect.logWarning("WARN_MESSAGE")
      yield* Effect.logError("ERROR_MESSAGE")
      yield* Console.log("LOG_TEST_DONE")
    })
).pipe(Command.withDescription("Emit test log messages at all levels (for testing logging config)"))

const traceTestCommand = Command.make(
  "trace-test",
  {},
  () =>
    Effect.gen(function*() {
      yield* Console.log("Trace-test command executed")
    }).pipe(Effect.withSpan("trace-test-command"))
).pipe(Command.withDescription("Simple command for testing tracing"))

const clearCommand = Command.make(
  "clear",
  {},
  () =>
    Effect.gen(function*() {
      const config = yield* AppConfig
      const baseDir = resolveBaseDir(config)
      const fs = yield* FileSystem.FileSystem

      const exists = yield* fs.exists(baseDir)
      if (!exists) {
        yield* Console.log(`No data directory found at ${baseDir}`)
        return
      }

      yield* fs.remove(baseDir, { recursive: true })
      yield* Console.log(`Deleted ${baseDir}`)
    })
).pipe(Command.withDescription("Delete the .mini-agent data directory"))

const portOption = Options.integer("port").pipe(
  Options.withAlias("p"),
  Options.withDescription("Port to listen on"),
  Options.optional
)

const hostOption = Options.text("host").pipe(
  Options.withDescription("Host to bind to"),
  Options.optional
)

/** Generic serve command - starts HTTP server with /agent/:agentName endpoint */
export const serveCommand = Command.make(
  "serve",
  {
    port: portOption,
    host: hostOption
  },
  ({ host, port }) =>
    Effect.gen(function*() {
      const config = yield* AppConfig
      const actualPort = Option.getOrElse(port, () => config.port)
      const actualHost = Option.getOrElse(host, () => config.host)

      yield* Console.log(`Starting HTTP server on http://${actualHost}:${actualPort}`)
      yield* Console.log("")
      yield* Console.log("Endpoints:")
      yield* Console.log("  POST /agent/:agentName")
      yield* Console.log("       Send user message, receive SSE stream of events")
      yield* Console.log("")
      yield* Console.log("  GET  /agent/:agentName/events")
      yield* Console.log("       Subscribe to agent event stream (SSE)")
      yield* Console.log("")
      yield* Console.log("  GET  /agent/:agentName/state")
      yield* Console.log("       Get current agent state")
      yield* Console.log("")
      yield* Console.log("  GET  /health")
      yield* Console.log("       Health check endpoint")
      yield* Console.log("")
      yield* Console.log("Example:")
      yield* Console.log(`  curl -X POST http://${actualHost}:${actualPort}/agent/test \\`)
      yield* Console.log(`    -H "Content-Type: application/json" \\`)
      yield* Console.log(`    -d '{"_tag":"UserMessageEvent","content":"hello"}'`)
      yield* Console.log("")

      // Create server layer with configured port/host
      const serverLayer = BunHttpServer.layer({ port: actualPort, hostname: actualHost })

      // Use Layer.launch to keep the server running
      return yield* Layer.launch(
        HttpServer.serve(makeRouter).pipe(
          Layer.provide(serverLayer)
        )
      )
    })
).pipe(
  Command.withDescription("Start generic HTTP server for agent requests")
)

const rootCommand = Command.make(
  "mini-agent",
  {
    configFile: configFileOption,
    cwd: cwdOption,
    stdoutLogLevel: stdoutLogLevelOption,
    llm: llmOption
  }
).pipe(
  Command.withSubcommands([
    chatCommand,
    serveCommand,
    layercodeCommand,
    logTestCommand,
    traceTestCommand,
    clearCommand
  ]),
  Command.withDescription("AI assistant with persistent context and comprehensive configuration")
)

export const cli = Command.run(rootCommand, {
  name: "mini-agent",
  version: "1.0.0"
})
