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
import {
  type CodeblockId,
  ExecutionCompleteEvent,
  ExecutionOutputEvent,
  ExecutionStartEvent,
  type RequestId
} from "./codemode.model.ts"

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
    requestId: RequestId,
    codeblockId: CodeblockId
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
        requestId: RequestId,
        codeblockId: CodeblockId
      ): Stream.Stream<ExecutionEvent, PlatformError.PlatformError, Scope.Scope> =>
        pipe(
          Stream.make(new ExecutionStartEvent({ requestId, codeblockId })),
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

// Secret store - implementation hidden from LLM
const SECRETS = {
  "demo-secret": "The secret value is: SUPERSECRET42",
  "api-key": "sk-test-1234567890abcdef"
};

// Tools implementation
// - sendMessage: writes to stderr (user sees, agent doesn't, no turn trigger)
// - console.log: writes to stdout (agent sees, triggers another turn)
const tools = {
  sendMessage: async (message) => console.error(message),
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
  },
  fetch: async (url) => {
    const response = await globalThis.fetch(url);
    return await response.text();
  },
  getSecret: async (name) => SECRETS[name]
};

// Execute - no return value expected
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
                        requestId,
                        codeblockId,
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
