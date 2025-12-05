/**
 * CLI Commands
 *
 * Defines the CLI interface for the chat application.
 */
import { type Prompt, Telemetry } from "@effect/ai"
import { Command, Options, Prompt as CliPrompt } from "@effect/cli"
import { Console, Effect, Layer, Option } from "effect"
import { ContextService } from "../context.service.ts"
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

const nameOption = Options.text("name").pipe(
  Options.withAlias("n"),
  Options.withDescription("Context name (slug identifier for the conversation)"),
  Options.optional
)

const NEW_CONTEXT_VALUE = "__new__"

/** Prompt user to select an existing context or create a new one */
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

/** Extract text from Prompt content parts */
const collectText = (parts: ReadonlyArray<{ type: string; text?: string }>) =>
  parts
    .filter((p): p is typeof p & { text: string } => p.type === "text" && !!p.text)
    .map((p) => p.text)
    .join("")

interface CleanMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/** Convert prompt to clean messages, merging consecutive same-role messages */
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

/** Extract text from Response parts */
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

const makeChatUILayer = () =>
  Layer.unwrapEffect(
    Effect.gen(function*() {
      const { ChatUI } = yield* Effect.promise(() => import("./chat-ui.ts"))
      return ChatUI.layer
    })
  )

const chatCommand = Command.make(
  "chat",
  { name: nameOption },
  ({ name }) =>
    Effect.gen(function*() {
      const { ChatUI } = yield* Effect.promise(() => import("./chat-ui.ts"))
      const chatUI = yield* ChatUI

      const contextName = Option.isSome(name)
        ? Option.getOrElse(name, () => "")
        : yield* selectOrCreateContext

      yield* chatUI.runChat(contextName).pipe(
        Effect.catchAllCause(() => Effect.void),
        Effect.ensuring(printTraceLinks.pipe(Effect.flatMap(() => Console.log("\nGoodbye!"))))
      )
    }).pipe(
      Effect.provide(makeChatUILayer()),
      Effect.withSpan("chat-session")
    )
).pipe(Command.withDescription("Interactive chat with AI assistant"))

/**
 * Log-test command that emits log messages at all levels.
 * Used for testing logging configuration.
 */
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

/**
 * Trace-test command for testing tracing. Produces a span and exits.
 */
const traceTestCommand = Command.make(
  "trace-test",
  {},
  () =>
    Effect.gen(function*() {
      yield* Console.log("Trace-test command executed")
    }).pipe(Effect.withSpan("trace-test-command"))
).pipe(Command.withDescription("Simple command for testing tracing"))

// Root command with global options
const rootCommand = Command.make(
  "mini-agent",
  {
    configFile: configFileOption,
    cwd: cwdOption,
    stdoutLogLevel: stdoutLogLevelOption
  }
).pipe(
  Command.withSubcommands([chatCommand, logTestCommand, traceTestCommand]),
  Command.withDescription("AI assistant with persistent context and comprehensive configuration")
)

export const cli = Command.run(rootCommand, {
  name: "mini-agent",
  version: "1.0.0"
})
