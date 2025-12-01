/**
 * LLM CLI Commands
 * 
 * Commands for interacting with LLM via RPC
 */

import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Stream } from "effect"
import { withLlmClient } from "./client"
import { serverUrlOption } from "./options"
import { withTraceLinks } from "../shared/tracing"
import { handleError } from "./error"

// =============================================================================
// Generate Command (with streaming option)
// =============================================================================

const streamOption = Options.boolean("stream").pipe(
  Options.withAlias("s"),
  Options.withDescription("Stream the response (shows tokens as they arrive)"),
  Options.withDefault(false)
)

const generateCommand = Command.make(
  "generate",
  {
    serverUrl: serverUrlOption,
    stream: streamOption,
    prompt: Args.text({ name: "prompt" }).pipe(
      Args.withDescription("The prompt to send to the LLM")
    )
  },
  ({ serverUrl, stream, prompt }) =>
    withLlmClient(serverUrl, (client) =>
      Effect.gen(function* () {
        if (stream) {
          // Streaming mode
          const textStream = client.generateStream({ prompt })

          yield* Stream.runForEach(textStream, (chunk) =>
            Effect.sync(() => process.stdout.write(chunk))
          )
          
          yield* Console.log("") // Newline after streaming
        } else {
          // Non-streaming mode
          const result = yield* client.generate({ prompt })
          yield* Console.log(result)
        }
      })
    ).pipe(
      withTraceLinks,
      Effect.withSpan("cli.llm.generate"),
      Effect.catchAll(handleError)
    )
).pipe(Command.withDescription("Generate text with LLM"))

// =============================================================================
// Export Group Command
// =============================================================================

export const llmCommand = Command.make("llm", {}, () =>
  Console.log("LLM commands: generate\nUse 'llm generate --help' for details")
).pipe(
  Command.withDescription("LLM commands"),
  Command.withSubcommands([generateCommand])
)
