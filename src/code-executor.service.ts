/**
 * Code Executor Service
 *
 * Executes generated TypeScript code via the `mini-agent codemode run` CLI command.
 * Streams stdout/stderr as events for real-time feedback.
 *
 * The CLI command handles:
 * - Loading and executing the generated module
 * - Providing tools (sendMessage, readFile, writeFile, exec, fetch, etc.)
 * - Outputting __CODEMODE_RESULT__ marker on completion
 */
import { Command, CommandExecutor, Path } from "@effect/platform"
import type { Error as PlatformError } from "@effect/platform"
import { Context, Effect, Layer, pipe, Stream } from "effect"
import { CODEMODE_RESULT_MARKER } from "./codemode-run.ts"
import {
  type CodeblockId,
  ExecutionCompleteEvent,
  ExecutionOutputEvent,
  ExecutionStartEvent,
  type RequestId
} from "./codemode.model.ts"

// Compute absolute path to main.ts from this module's location
// This allows calling the CLI without relying on package.json scripts
const MAIN_PATH = (() => {
  const thisFile = new URL(import.meta.url).pathname
  const srcDir = thisFile.substring(0, thisFile.lastIndexOf("/"))
  return `${srcDir}/main.ts`
})()

/** Union of execution events for streaming */
export type ExecutionEvent = ExecutionStartEvent | ExecutionOutputEvent | ExecutionCompleteEvent

/** Interface for code executor */
interface CodeExecutorInterface {
  /**
   * Execute a TypeScript file via the codemode run CLI command.
   * Streams execution events: start, output chunks, complete.
   * Note: Scope is managed internally - stream is self-scoped.
   */
  readonly execute: (
    indexPath: string,
    requestId: RequestId,
    codeblockId: CodeblockId
  ) => Stream.Stream<ExecutionEvent, PlatformError.PlatformError, never>
}

export class CodeExecutor extends Context.Tag("@app/CodeExecutor")<
  CodeExecutor,
  CodeExecutorInterface
>() {
  static readonly layer = Layer.effect(
    CodeExecutor,
    Effect.gen(function*() {
      const executor = yield* CommandExecutor.CommandExecutor
      const pathService = yield* Path.Path

      const execute = (
        indexPath: string,
        requestId: RequestId,
        codeblockId: CodeblockId
      ): Stream.Stream<ExecutionEvent, PlatformError.PlatformError, never> =>
        pipe(
          Stream.make(new ExecutionStartEvent({ requestId, codeblockId })),
          Stream.concat(
            // Use unwrapScoped to manage subprocess lifecycle internally
            Stream.unwrapScoped(
              Effect.gen(function*() {
                // Get the directory containing index.ts
                const blockDir = pathService.dirname(indexPath)

                // Call the CLI command: bun <main.ts> codemode run <dir>
                // Using absolute path to main.ts to avoid relying on package.json scripts
                const cmd = Command.make("bun", MAIN_PATH, "codemode", "run", blockDir)
                const process = yield* executor.start(cmd)

                // Stream stdout and stderr
                // Note: stdout may contain __CODEMODE_RESULT__ marker - we filter it out
                const stdoutStream = pipe(
                  process.stdout,
                  Stream.decodeText(),
                  Stream.map((data) => {
                    // Remove the result marker from output
                    const cleaned = data.replace(new RegExp(`\\n?${CODEMODE_RESULT_MARKER}\\n?`, "g"), "")
                    return new ExecutionOutputEvent({
                      requestId,
                      codeblockId,
                      stream: "stdout",
                      data: cleaned
                    })
                  }),
                  // Filter out empty chunks after marker removal
                  Stream.filter((event) => event.data.length > 0)
                )

                const stderrStream = pipe(
                  process.stderr,
                  Stream.decodeText(),
                  Stream.map(
                    (data) =>
                      new ExecutionOutputEvent({
                        requestId,
                        codeblockId,
                        stream: "stderr",
                        data
                      })
                  )
                )

                // Merge streams and append completion event
                return pipe(
                  Stream.merge(stdoutStream, stderrStream),
                  Stream.concat(
                    Stream.fromEffect(
                      Effect.gen(function*() {
                        const exitCode = yield* process.exitCode
                        return new ExecutionCompleteEvent({ requestId, codeblockId, exitCode })
                      })
                    )
                  )
                )
              })
            )
          )
        )

      return CodeExecutor.of({ execute })
    })
  )

  static readonly testLayer = Layer.succeed(
    CodeExecutor,
    CodeExecutor.of({
      execute: (_indexPath, requestId, codeblockId) =>
        Stream.make(
          new ExecutionStartEvent({ requestId, codeblockId }),
          new ExecutionOutputEvent({
            requestId,
            codeblockId,
            stream: "stdout",
            data: "mock execution output\n"
          }),
          new ExecutionCompleteEvent({ requestId, codeblockId, exitCode: 0 })
        )
    })
  )
}
