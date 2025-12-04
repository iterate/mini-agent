/**
 * Code Executor Service
 *
 * Executes generated TypeScript code via bun subprocess.
 * Streams stdout/stderr as events for real-time feedback.
 */
import { Command, CommandExecutor } from "@effect/platform"
import type { Error as PlatformError } from "@effect/platform"
import type { Scope } from "effect"
import { Context, Effect, Layer, pipe, Stream } from "effect"
import { ExecutionCompleteEvent, ExecutionOutputEvent, ExecutionStartEvent, type ResponseId } from "./codemode.model.ts"

/** Union of execution events for streaming */
export type ExecutionEvent = ExecutionStartEvent | ExecutionOutputEvent | ExecutionCompleteEvent

/** Interface for code executor */
interface CodeExecutorInterface {
  /**
   * Execute a TypeScript file via bun subprocess.
   * Streams execution events: start, output chunks, complete.
   */
  readonly execute: (
    indexPath: string,
    responseId: ResponseId
  ) => Stream.Stream<ExecutionEvent, PlatformError.PlatformError, Scope.Scope>
}

export class CodeExecutor extends Context.Tag("@app/CodeExecutor")<
  CodeExecutor,
  CodeExecutorInterface
>() {
  static readonly layer = Layer.effect(
    CodeExecutor,
    Effect.gen(function*() {
      const executor = yield* CommandExecutor.CommandExecutor

      const execute = (
        indexPath: string,
        responseId: ResponseId
      ): Stream.Stream<ExecutionEvent, PlatformError.PlatformError, Scope.Scope> =>
        pipe(
          Stream.make(new ExecutionStartEvent({ responseId })),
          Stream.concat(
            Stream.unwrap(
              Effect.gen(function*() {
                // Create runner code that imports and executes the generated module
                const runnerCode = `
const indexPath = ${JSON.stringify(indexPath)};
const mod = await import(indexPath);
const main = mod.default;

if (typeof main !== "function") {
  console.error("Generated code must export a default function");
  process.exit(1);
}

// Simple tools implementation
const tools = {
  log: async (message) => console.log(message),
  readFile: async (path) => await Bun.file(path).text(),
  writeFile: async (path, content) => await Bun.write(path, content),
  exec: async (command) => {
    const proc = Bun.spawn(["sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }
};

await main(tools);
`

                const cmd = Command.make("bun", "-e", runnerCode)
                const process = yield* executor.start(cmd)

                // Stream stdout and stderr
                const stdoutStream = pipe(
                  process.stdout,
                  Stream.decodeText(),
                  Stream.map(
                    (data) =>
                      new ExecutionOutputEvent({
                        responseId,
                        stream: "stdout",
                        data
                      })
                  )
                )

                const stderrStream = pipe(
                  process.stderr,
                  Stream.decodeText(),
                  Stream.map(
                    (data) =>
                      new ExecutionOutputEvent({
                        responseId,
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
                        return new ExecutionCompleteEvent({ responseId, exitCode })
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
      execute: (_indexPath, responseId) =>
        Stream.make(
          new ExecutionStartEvent({ responseId }),
          new ExecutionOutputEvent({
            responseId,
            stream: "stdout",
            data: "mock execution output\n"
          }),
          new ExecutionCompleteEvent({ responseId, exitCode: 0 })
        )
    })
  )
}
