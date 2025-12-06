/**
 * Codemode Run Command
 *
 * Standalone CLI command to execute a codemode block directory.
 * Called by the agent loop via subprocess for clean separation.
 *
 * Usage: mini-agent codemode run <path>
 *
 * The path should contain:
 * - index.ts: The generated code with `export default async (t: Tools) => { ... }`
 * - types.ts: Type definitions (not used at runtime, just for typecheck)
 *
 * Output channels:
 * - stdout: Agent-visible output (triggers loop continuation if non-empty)
 * - stderr: User-visible output (sendMessage writes here)
 *
 * Outputs __CODEMODE_RESULT__ marker when execution completes.
 */
import { Args, Command } from "@effect/cli"
import { Path } from "@effect/platform"
import { Console, Effect } from "effect"

/** Result marker - signals execution complete, separates output from noise */
export const CODEMODE_RESULT_MARKER = "__CODEMODE_RESULT__"

/**
 * Tools implementation provided to executed code.
 * Combines Montreal tools (readFile, writeFile, exec, fetch, getSecret)
 * with Kathmandu utilities (calculate, now, sleep).
 */
const createTools = () => ({
  // Send message to user (stderr - user sees, agent doesn't, no turn trigger)
  sendMessage: async (message: string): Promise<void> => {
    process.stderr.write(message + "\n")
  },

  // Filesystem operations
  readFile: async (path: string): Promise<string> => {
    return await Bun.file(path).text()
  },

  writeFile: async (path: string, content: string): Promise<void> => {
    await Bun.write(path, content)
  },

  // Shell execution
  exec: async (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    const proc = Bun.spawn(["sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe"
    })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    return { stdout, stderr, exitCode }
  },

  // HTTP fetch
  fetch: async (url: string): Promise<string> => {
    const response = await globalThis.fetch(url)
    return await response.text()
  },

  // Secret access (reads CODEMODE_SECRET_* env vars)
  getSecret: async (name: string): Promise<string | undefined> => {
    const envKey = "CODEMODE_SECRET_" + name.toUpperCase().replace(/-/g, "_")
    return process.env[envKey]
  },

  // Kathmandu utilities
  calculate: async (expression: string): Promise<{ result: number; steps: Array<string> }> => {
    const steps: Array<string> = []
    steps.push(`Parsing expression: ${expression}`)
    steps.push("Evaluating...")
    // Simple eval - in production use a proper math parser
    const result = Function(`"use strict"; return (${expression})`)() as number
    steps.push(`Result: ${result}`)
    return { result, steps }
  },

  now: async (): Promise<string> => {
    return new Date().toISOString()
  },

  sleep: async (ms: number): Promise<void> => {
    await new Promise((r) => setTimeout(r, ms))
  }
})

/** Execute a codemode block from a directory */
const runCodemodeBlock = (blockDir: string) =>
  Effect.gen(function*() {
    const pathService = yield* Path.Path

    const indexPath = pathService.join(blockDir, "index.ts")

    yield* Effect.logDebug("Executing codemode block", { blockDir, indexPath })

    // Import the module dynamically
    const mod = yield* Effect.tryPromise({
      try: () => import(indexPath),
      catch: (error) => new Error(`Failed to import module: ${error}`)
    })

    const main = mod.default

    if (typeof main !== "function") {
      yield* Console.error("Generated code must export a default function")
      return yield* Effect.fail(new Error("No default export function"))
    }

    // Create tools and execute
    const tools = createTools()

    yield* Effect.tryPromise({
      try: () => main(tools),
      catch: (error) => {
        // Runtime errors go to stderr for user visibility
        process.stderr.write(`Runtime error: ${error}\n`)
        return new Error(`Execution failed: ${error}`)
      }
    })

    // Output completion marker (stdout - agent sees this)
    yield* Console.log(`\n${CODEMODE_RESULT_MARKER}`)
  }).pipe(
    Effect.catchAllDefect((defect) =>
      Effect.gen(function*() {
        yield* Console.error(`Fatal error: ${defect}`)
        return yield* Effect.fail(defect)
      })
    ),
    Effect.provide(Path.layer)
  )

/** The codemode run subcommand */
export const codemodeRunCommand = Command.make(
  "run",
  {
    path: Args.directory({ name: "path" }).pipe(
      Args.withDescription("Path to codeblock directory containing index.ts")
    )
  },
  ({ path }) => runCodemodeBlock(path)
).pipe(Command.withDescription("Execute a codemode block from a directory"))

/** Parent codemode command with subcommands */
export const codemodeCommand = Command.make("codemode", {}).pipe(
  Command.withSubcommands([codemodeRunCommand]),
  Command.withDescription("Codemode execution commands")
)
