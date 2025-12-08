/**
 * CLI Commands
 *
 * Defines the CLI interface for the chat application.
 */
import { type Prompt, Telemetry } from "@effect/ai"
import { Command, Options, Prompt as CliPrompt } from "@effect/cli"
import { type Error as PlatformError, FileSystem, HttpServer, type Terminal } from "@effect/platform"
import { BunHttpServer, BunStream } from "@effect/platform-bun"
import { Chunk, Console, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { contextNameFromAgent } from "../agent-registry.ts"
import { AgentService, type AgentServiceApi } from "../agent-service.ts"
import { AppConfig, resolveBaseDir } from "../config.ts"
import {
  type AgentName,
  type AssistantMessageEvent,
  ContextEvent,
  makeBaseEventFields,
  SessionEndedEvent,
  type TextDeltaEvent,
  UserMessageEvent
} from "../domain.ts"
import { EventStore } from "../event-store.ts"
import { makeRouter } from "../http-routes.ts"
import { layercodeCommand } from "../layercode/index.ts"
import { printTraceLinks } from "../tracing.ts"

const encodeEvent = Schema.encodeSync(ContextEvent)

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

const remoteUrlOption = Options.text("remote-url").pipe(
  Options.withAlias("R"),
  Options.withDescription("Base URL of a running mini-agent server (enables remote mode)"),
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

const imageOption = Options.file("image").pipe(
  Options.withAlias("i"),
  Options.withDescription("Path to an image file to include with the message"),
  Options.repeated
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
    if (options.raw) {
      // Raw mode outputs all events as JSON (no filtering)
      yield* Console.log(JSON.stringify(encodeEvent(event)))
      return
    }

    // Non-raw mode: output streaming deltas and final message
    // Use _tag check directly since events from stream may be plain objects
    if (event._tag === "TextDeltaEvent") {
      yield* Console.log((event as TextDeltaEvent).delta)
      return
    }
    if (event._tag === "AssistantMessageEvent") {
      yield* Console.log((event as AssistantMessageEvent).content)
      return
    }
  })

const streamTurn = (
  agentService: AgentServiceApi,
  agentName: AgentName,
  options: OutputOptions,
  run: Effect.Effect<void>
) =>
  Effect.gen(function*() {
    const turnFiber = yield* Effect.scoped(
      Effect.gen(function*() {
        const stream = yield* agentService.tapEventStream({ agentName })
        return yield* stream.pipe(
          Stream.takeUntil(
            (event) => event._tag === "AgentTurnCompletedEvent" || event._tag === "AgentTurnFailedEvent"
          ),
          Stream.runForEach((event) => handleEvent(event, options))
        )
      })
    ).pipe(Effect.fork)

    yield* run
    yield* Fiber.join(turnFiber).pipe(Effect.catchAllCause(() => Effect.void))
  })

const appendSessionEnd = (agentService: AgentServiceApi, agentName: AgentName) =>
  Effect.gen(function*() {
    const events = yield* agentService.getEvents({ agentName })
    const contextName = contextNameFromAgent(agentName)
    const sessionEnd = new SessionEndedEvent({
      ...makeBaseEventFields(agentName, contextName, events.length, false)
    })
    yield* agentService.addEvents({ agentName, events: [sessionEnd] })
    return sessionEnd as ContextEvent
  })

/** Run the event stream, handling each event */
const runEventStream = (
  agentNameInput: string,
  userMessage: string,
  options: OutputOptions,
  images: ReadonlyArray<string> = []
) =>
  Effect.gen(function*() {
    const agentService = yield* AgentService
    const agentName = agentNameInput as AgentName
    const existingEvents = yield* agentService.getEvents({ agentName })
    for (const event of existingEvents) {
      yield* handleEvent(event, options)
    }

    const contextName = contextNameFromAgent(agentName)
    const nextEventNumber = existingEvents.length
    const userEvent = new UserMessageEvent({
      ...makeBaseEventFields(agentName, contextName, nextEventNumber, true),
      content: userMessage,
      images: images.length > 0 ? images : undefined
    })

    yield* streamTurn(agentService, agentName, options, agentService.addEvents({ agentName, events: [userEvent] }))
    const sessionEndedEvent = yield* appendSessionEnd(agentService, agentName)
    yield* handleEvent(sessionEndedEvent, options)
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

const scriptInteractiveLoop = (agentNameInput: string, options: OutputOptions) =>
  Effect.gen(function*() {
    const agentService = yield* AgentService
    const agentName = agentNameInput as AgentName
    const existingEvents = yield* agentService.getEvents({ agentName })
    for (const event of existingEvents) {
      yield* handleEvent(event, options)
    }

    yield* stdinEvents.pipe(
      Stream.mapEffect((inputMsg) =>
        Effect.gen(function*() {
          yield* Console.log(JSON.stringify(inputMsg))

          const isUserMessage = inputMsg._tag === "UserMessage" || inputMsg._tag === "UserMessageEvent"

          if (isUserMessage) {
            const events = yield* agentService.getEvents({ agentName })
            const nextEventNumber = events.length
            const context = contextNameFromAgent(agentName)
            const userEvent = new UserMessageEvent({
              ...makeBaseEventFields(agentName, context, nextEventNumber, true),
              content: inputMsg.content
            })

            yield* streamTurn(
              agentService,
              agentName,
              options,
              agentService.addEvents({ agentName, events: [userEvent] })
            )
          } else {
            yield* Effect.logDebug("SystemPrompt events in script mode are echoed but not persisted")
          }
        })
      ),
      Stream.runDrain
    )

    const sessionEndedEvent = yield* appendSessionEnd(agentService, agentName)
    yield* handleEvent(sessionEndedEvent, options)
  })

const NEW_CONTEXT_VALUE = "__new__"

const selectOrCreateAgentName = Effect.gen(function*() {
  const store = yield* EventStore
  const contextNames = yield* store.list()
  // Convert context names (e.g. "my-agent-v1") to agent names (e.g. "my-agent")
  const agentNames = contextNames
    .map((name) => name.replace(/-v1$/, ""))
    .filter((name, index, arr) => arr.indexOf(name) === index) as Array<AgentName>

  if (agentNames.length === 0) {
    yield* Console.log("No existing contexts found.")
    return yield* CliPrompt.text({ message: "Enter a name for your new context" })
  }

  const choices = [
    {
      title: "+ New context",
      value: NEW_CONTEXT_VALUE,
      description: "Start fresh with a new context"
    },
    ...agentNames.map((name) => ({
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

const generateRandomAgentName = (): string => {
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

/** Read an image file and return as base64 data URI */
const readImageAsDataUri = (imagePath: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const data = yield* fs.readFile(imagePath)

    // Detect media type from extension
    const ext = imagePath.toLowerCase().split(".").pop() ?? ""
    const mediaType = ext === "png" ?
      "image/png"
      : ext === "gif" ?
      "image/gif"
      : ext === "webp" ?
      "image/webp"
      : "image/jpeg"

    // Convert to base64
    const base64 = Buffer.from(data).toString("base64")
    return `data:${mediaType};base64,${base64}`
  })

const runChat = (options: {
  name: Option.Option<string>
  message: Option.Option<string>
  raw: boolean
  script: boolean
  showEphemeral: boolean
  images: ReadonlyArray<string>
}) =>
  Effect.gen(function*() {
    yield* Effect.logDebug("Starting chat session")
    const mode = determineMode(options)
    const agentName = Option.getOrElse(options.name, generateRandomAgentName)

    const outputOptions: OutputOptions = {
      raw: mode === "script" || options.raw,
      showEphemeral: mode === "script" || options.showEphemeral
    }

    // Convert image paths to data URIs
    const imageDataUris = options.images.length > 0
      ? yield* Effect.all(options.images.map(readImageAsDataUri))
      : []

    switch (mode) {
      case "single-turn": {
        const message = Option.getOrElse(options.message, () => "")
        yield* runEventStream(agentName, message, outputOptions, imageDataUris)
        if (!outputOptions.raw) {
          yield* printTraceLinks
        }
        break
      }

      case "pipe": {
        const input = yield* readAllStdin
        if (input !== "") {
          yield* runEventStream(agentName, input, { raw: false, showEphemeral: false }, imageDataUris)
          yield* printTraceLinks
        }
        break
      }

      case "script": {
        yield* scriptInteractiveLoop(agentName, outputOptions)
        break
      }

      case "tty-interactive": {
        const resolvedName = Option.isSome(options.name)
          ? agentName
          : yield* selectOrCreateAgentName

        const { ChatUI } = yield* Effect.promise(() => import("./chat-ui.ts"))
        const chatUI = yield* ChatUI

        yield* chatUI.runChat(resolvedName).pipe(
          Effect.catchAllCause(() => Effect.void),
          Effect.ensuring(
            Effect.all(
              [
                printTraceLinks.pipe(Effect.catchAll(() => Effect.void)),
                Console.log("\nGoodbye!")
              ],
              { discard: true }
            )
          )
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
    showEphemeral: showEphemeralOption,
    images: imageOption
  },
  ({ images, message, name, raw, script, showEphemeral }) =>
    runChat({ images, message, name, raw, script, showEphemeral })
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
      yield* Console.log("  POST /agent/:agentName/events")
      yield* Console.log("       Append pre-built events (JSON body)")
      yield* Console.log("")
      yield* Console.log("  GET  /agent/:agentName/events")
      yield* Console.log("       Subscribe to agent event stream (SSE)")
      yield* Console.log("")
      yield* Console.log("  GET  /agent/:agentName/log")
      yield* Console.log("       Fetch full event log as JSON")
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
      // Set idleTimeout high for SSE streaming - Bun defaults to 10s which kills long-running streams
      const serverLayer = BunHttpServer.layer({ port: actualPort, hostname: actualHost, idleTimeout: 120 })

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
    llm: llmOption,
    remoteUrl: remoteUrlOption
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
