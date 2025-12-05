/**
 * CLI Commands
 *
 * Defines the CLI interface for the chat application.
 */
import { type Prompt, Telemetry } from "@effect/ai"
import { Command, Options, Prompt as CliPrompt } from "@effect/cli"
import { type Error as PlatformError, HttpServer, Terminal } from "@effect/platform"
import { BunHttpServer, BunStream } from "@effect/platform-bun"
import { Chunk, Console, Effect, Either, Layer, Option, Ref, Schema, Stream } from "effect"
import { CodemodeService } from "../codemode/index.ts"
import { AppConfig } from "../config.ts"
import {
  AssistantMessageEvent,
  CodemodeBlockEvent,
  type ContextEvent,
  FileAttachmentEvent,
  type InputEvent,
  SystemPromptEvent,
  TextDeltaEvent,
  UserMessageEvent
} from "../context.model.ts"
import { ContextService } from "../context.service.ts"
import { makeRouter } from "../http.ts"
import { layercodeCommand } from "../layercode/index.ts"
import { AgentServer } from "../server.service.ts"
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

const imageOption = Options.text("image").pipe(
  Options.withAlias("i"),
  Options.withDescription("Path to local image file or URL to share with the AI"),
  Options.optional
)

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
}

const getMediaType = (filePath: string): string => {
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."))
  return MIME_TYPES[ext] ?? "application/octet-stream"
}

const getFileName = (filePath: string): string => {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
}

const isUrl = (input: string): boolean => input.startsWith("http://") || input.startsWith("https://")

interface OutputOptions {
  raw: boolean
  showEphemeral: boolean
}

interface CodemodeContext {
  contextName: string
  responseNumberRef: Ref.Ref<number>
}

/** Maximum agentic loop iterations to prevent infinite loops */
const MAX_AGENTIC_ITERATIONS = 20

/**
 * Handle a single context event based on output options.
 *
 * Note: TextDelta events are NOT displayed in non-raw mode when codemode is active.
 * The codemode execution output (via sendMessage → stderr) is the user-visible output.
 * This prevents showing raw <codemode> blocks during streaming.
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

    // In non-raw mode, don't display TextDelta at all - codemode output goes via sendMessage (stderr)
    if (Schema.is(TextDeltaEvent)(event)) {
      return
    }

    if (Schema.is(CodemodeBlockEvent)(event)) {
      yield* terminal.display(event.userOutput)
      return
    }

    if (Schema.is(AssistantMessageEvent)(event)) {
      // If the response contains codemode blocks, they'll be processed separately
      // Only display the full content if there are no codemode blocks
      const hasCodemode = /<codemode>[\s\S]*?<\/codemode>/.test(event.content)
      if (!hasCodemode && event.content.trim()) {
        yield* terminal.display(event.content + "\n")
      }
      return
    }
  })

/** Result from processing codemode blocks */
interface CodemodeResult {
  needsRetry: boolean
  continueLoop: boolean
  nextEvents?: ReadonlyArray<InputEvent>
}

/** Process codemode blocks from an assistant message */
const processCodemode = (
  content: string,
  options: OutputOptions,
  ctx: CodemodeContext
) =>
  Effect.gen(function*() {
    const codemode = yield* CodemodeService
    const terminal = yield* Terminal.Terminal

    if (!codemode.hasCodeBlocks(content)) {
      return { needsRetry: false, continueLoop: false } as CodemodeResult
    }

    const extractedBlocks = codemode.extractCodeBlocks(content)
    if (extractedBlocks.length === 0) {
      return { needsRetry: false, continueLoop: false } as CodemodeResult
    }

    yield* Effect.logDebug(`Found ${extractedBlocks.length} codemode block(s)`)

    // Get and increment response number
    const responseNumber = yield* Ref.getAndUpdate(ctx.responseNumberRef, (n) => n + 1)

    // Write response to disk
    const { blocks, dir: responseDir } = yield* codemode.writeResponse(
      ctx.contextName,
      responseNumber + 1,
      extractedBlocks
    )
    yield* Effect.logDebug(`Wrote codemode response to ${responseDir}`)

    // Typecheck all blocks
    const typecheckResult = yield* codemode.typecheck(responseDir).pipe(Effect.either)

    if (Either.isLeft(typecheckResult)) {
      const errors = typecheckResult.left.errors
      yield* Effect.logDebug("Typecheck failed, requesting fix from LLM")

      if (!options.raw) {
        yield* Console.log("\n[Typecheck failed, asking LLM to fix...]\n")
      }

      const nextEvents = [
        new UserMessageEvent({
          content: `TypeScript errors in your code:\n\`\`\`\n${errors}\`\`\`\nPlease fix these errors and try again.`
        })
      ]

      return { needsRetry: true, continueLoop: true, nextEvents } as CodemodeResult
    }

    yield* Effect.logDebug("Typecheck passed, executing code")

    // Execute all blocks (catch runtime errors)
    const executeResult = yield* codemode.execute(responseDir, blocks).pipe(Effect.either)

    if (Either.isLeft(executeResult)) {
      const error = executeResult.left
      yield* Effect.logDebug("Execution failed, requesting fix from LLM")

      if (!options.raw) {
        yield* Console.log("\n[Execution failed, asking LLM to fix...]\n")
      }

      const nextEvents = [
        new UserMessageEvent({
          content: `Runtime error executing your code:\n\`\`\`\n${
            String(error)
          }\`\`\`\nPlease fix this error and try again.`
        })
      ]

      return { needsRetry: true, continueLoop: true, nextEvents } as CodemodeResult
    }

    const blockResults = executeResult.right

    // Create and display each block event (don't persist yet - addEvents will handle that)
    const blockEvents: Array<CodemodeBlockEvent> = []
    let shouldContinue = false

    for (const result of blockResults) {
      const blockEvent = new CodemodeBlockEvent({
        code: result.code,
        blockNumber: result.blockNumber,
        responseNumber: responseNumber + 1,
        userOutput: result.userOutput,
        agentOutput: result.agentOutput,
        triggerAgentTurn: result.triggerAgentTurn
      })
      blockEvents.push(blockEvent)

      // Check if this block triggers continuation
      if (result.triggerAgentTurn === "after-current-turn") {
        shouldContinue = true
      }

      // Display each block's user output
      if (options.raw) {
        yield* Console.log(JSON.stringify(blockEvent))
      } else if (result.userOutput) {
        yield* terminal.display(result.userOutput)
      }
    }

    // If any block triggers continuation, feed it back to LLM
    if (shouldContinue) {
      yield* Effect.logDebug("Agent output detected, continuing agentic loop")
      if (!options.raw) {
        yield* Console.log("\n[Agent continuing...]\n")
      }

      return { needsRetry: false, continueLoop: true, nextEvents: blockEvents } as CodemodeResult
    }

    // No continuation needed - still need to persist the block events
    return { needsRetry: false, continueLoop: false, nextEvents: blockEvents } as CodemodeResult
  })

/** Run the event stream with codemode processing loop */
const runEventStream = (
  contextName: string,
  userMessage: string,
  options: OutputOptions,
  imageInput?: string
) =>
  Effect.gen(function*() {
    const contextService = yield* ContextService
    const inputEvents: Array<InputEvent> = []

    if (imageInput) {
      const mediaType = getMediaType(imageInput)
      const fileName = getFileName(imageInput)

      if (isUrl(imageInput)) {
        inputEvents.push(
          new FileAttachmentEvent({
            source: { type: "url", url: imageInput },
            mediaType,
            fileName
          })
        )
      } else {
        inputEvents.push(
          new FileAttachmentEvent({
            source: { type: "file", path: imageInput },
            mediaType,
            fileName
          })
        )
      }
    }

    inputEvents.push(new UserMessageEvent({ content: userMessage }))

    // Codemode context for tracking response numbers
    const responseNumberRef = yield* Ref.make(0)
    const ctx: CodemodeContext = { contextName, responseNumberRef }

    // Track the last assistant content for codemode processing
    let lastAssistantContent: string | undefined

    yield* contextService.addEvents(contextName, inputEvents).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function*() {
          yield* handleEvent(event, options)
          if (Schema.is(AssistantMessageEvent)(event)) {
            lastAssistantContent = event.content
          }
        })
      )
    )

    // Process codemode blocks with agentic loop (bounded to prevent infinite loops)
    let iterations = 0
    while (lastAssistantContent) {
      if (iterations >= MAX_AGENTIC_ITERATIONS) {
        yield* Effect.logWarning(`Agentic loop hit max iterations (${MAX_AGENTIC_ITERATIONS}), stopping`)
        if (!options.raw) {
          yield* Console.log(`\n[Agent stopped: max iterations (${MAX_AGENTIC_ITERATIONS}) reached]\n`)
        }
        break
      }
      iterations++

      const result = yield* processCodemode(lastAssistantContent, options, ctx)

      // If we have events to persist (whether continuing or not)
      if (result.nextEvents && result.nextEvents.length > 0) {
        // Continue: add events (will trigger LLM if any has triggerAgentTurn = "after-current-turn")
        lastAssistantContent = undefined
        yield* contextService.addEvents(contextName, result.nextEvents).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function*() {
              yield* handleEvent(event, options)
              if (Schema.is(AssistantMessageEvent)(event)) {
                lastAssistantContent = event.content
              }
            })
          )
        )

        // If we didn't get a new assistant message and we're supposed to continue, break
        if (!result.continueLoop) {
          break
        }
      } else {
        // No events to process, break
        break
      }
    }
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

const ScriptInputEvent = Schema.Union(UserMessageEvent, SystemPromptEvent)

const stdinEvents = BunStream.stdin.pipe(
  Stream.mapChunks(Chunk.map((bytes) => utf8Decoder.decode(bytes))),
  Stream.splitLines,
  Stream.filter((line) => line.trim() !== ""),
  Stream.mapEffect((line) =>
    Effect.try(() => JSON.parse(line) as unknown).pipe(
      Effect.flatMap((json) => Schema.decodeUnknown(ScriptInputEvent)(json))
    )
  )
)

const scriptInteractiveLoop = (contextName: string, options: OutputOptions) =>
  Effect.gen(function*() {
    const contextService = yield* ContextService

    yield* stdinEvents.pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function*() {
          yield* Console.log(JSON.stringify(event))

          if (Schema.is(UserMessageEvent)(event)) {
            yield* contextService.addEvents(contextName, [event]).pipe(
              Stream.runForEach((outputEvent) => handleEvent(outputEvent, options))
            )
          } else if (Schema.is(SystemPromptEvent)(event)) {
            yield* Effect.logDebug("SystemPrompt events in script mode are echoed but not persisted")
          }
        })
      ),
      Stream.runDrain
    )
  })

const NEW_CONTEXT_VALUE = "__new__"

const selectOrCreateContext = Effect.gen(function*() {
  const contextService = yield* ContextService
  const contexts = yield* contextService.list()

  if (contexts.length === 0) {
    yield* Console.log("No existing contexts found.")
    return yield* CliPrompt.text({ message: "Enter a name for your new context" })
  }

  const choices = [
    {
      title: "➕ New context",
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
      return ChatUI.layer
    })
  )

const runChat = (options: {
  name: Option.Option<string>
  message: Option.Option<string>
  image: Option.Option<string>
  raw: boolean
  script: boolean
  showEphemeral: boolean
}) =>
  Effect.gen(function*() {
    yield* Effect.logDebug("Starting chat session")
    const mode = determineMode(options)
    const contextName = Option.getOrElse(options.name, generateRandomContextName)
    const imagePath = Option.getOrNull(options.image) ?? undefined

    const outputOptions: OutputOptions = {
      raw: mode === "script" || options.raw,
      showEphemeral: mode === "script" || options.showEphemeral
    }

    switch (mode) {
      case "single-turn": {
        const message = Option.getOrElse(options.message, () => "")
        yield* runEventStream(contextName, message, outputOptions, imagePath)
        if (!outputOptions.raw) {
          yield* printTraceLinks
        }
        break
      }

      case "pipe": {
        const input = yield* readAllStdin
        if (input !== "") {
          yield* runEventStream(contextName, input, { raw: false, showEphemeral: false }, imagePath)
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
    image: imageOption,
    raw: rawOption,
    script: scriptOption,
    showEphemeral: showEphemeralOption
  },
  ({ image, message, name, raw, script, showEphemeral }) =>
    runChat({ image, message, name, raw, script, showEphemeral })
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

const portOption = Options.integer("port").pipe(
  Options.withAlias("p"),
  Options.withDescription("Port to listen on"),
  Options.optional
)

const hostOption = Options.text("host").pipe(
  Options.withDescription("Host to bind to"),
  Options.optional
)

/** Generic serve command - starts HTTP server with /context/:name endpoint */
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
      yield* Console.log("  POST /context/:contextName")
      yield* Console.log("       Send JSONL events, receive SSE stream")
      yield* Console.log("       Content-Type: application/x-ndjson")
      yield* Console.log("")
      yield* Console.log("  GET  /health")
      yield* Console.log("       Health check endpoint")
      yield* Console.log("")
      yield* Console.log("Example:")
      yield* Console.log(`  curl -X POST http://${actualHost}:${actualPort}/context/test \\`)
      yield* Console.log(`    -H "Content-Type: application/x-ndjson" \\`)
      yield* Console.log(`    -d '{"_tag":"UserMessage","content":"hello"}'`)
      yield* Console.log("")

      // Create server layer with configured port/host
      const serverLayer = BunHttpServer.layer({ port: actualPort, hostname: actualHost })

      // Create layers for the server
      const layers = Layer.mergeAll(
        serverLayer,
        AgentServer.layer
      )

      // Use Layer.launch to keep the server running
      return yield* Layer.launch(
        HttpServer.serve(makeRouter).pipe(
          Layer.provide(layers)
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
  Command.withSubcommands([chatCommand, serveCommand, layercodeCommand, logTestCommand, traceTestCommand]),
  Command.withDescription("AI assistant with persistent context and comprehensive configuration")
)

export const cli = Command.run(rootCommand, {
  name: "mini-agent",
  version: "1.0.0"
})
