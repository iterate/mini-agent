/**
 * Test Fixtures
 *
 * Vitest 3.x fixtures for isolated test environments with temp directories.
 */
import { Command, type Error as PlatformErr } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import { Chunk, Effect, Layer, LogLevel, Option, Stream } from "effect"
import { mkdir, mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test as baseTest } from "vitest"
import { AppConfig, type MiniAgentConfig } from "../src/config.ts"

const CLI_PATH = resolve(__dirname, "../src/main.ts")
const TestLayer = BunContext.layer

export interface CliResult {
  readonly output: string
  readonly exitCode: number
}

/** Run CLI command and return both output and exit code */
const runCliCommand = (
  cmd: Command.Command
): Effect.Effect<CliResult, PlatformErr.PlatformError, CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function*() {
      const process = yield* Command.start(cmd)

      // Collect stdout into string
      const chunks = yield* Stream.runCollect(process.stdout)
      const decoder = new TextDecoder()
      const output = Chunk.toReadonlyArray(chunks)
        .map((chunk) => decoder.decode(chunk))
        .join("")

      const exitCode = yield* process.exitCode
      return { output, exitCode }
    })
  )

/** Run the CLI with given args and return { output, exitCode } */
export const runCli = (cwd: string | undefined, ...args: Array<string>) => {
  const cwdArgs = cwd ? ["--cwd", cwd] : []
  const cmd = Command.make("bun", CLI_PATH, ...cwdArgs, ...args)
  return runCliCommand(cmd).pipe(Effect.provide(TestLayer))
}

/** Run the CLI with custom environment variables */
export const runCliWithEnv = (
  cwd: string,
  env: Record<string, string>,
  ...args: Array<string>
) => {
  const cwdArgs = cwd ? ["--cwd", cwd] : []
  const cmd = Command.make("bun", CLI_PATH, ...cwdArgs, ...args).pipe(Command.env(env))
  return runCliCommand(cmd).pipe(Effect.provide(TestLayer))
}

export const testAppConfigLayer = Layer.succeed(
  AppConfig,
  {
    llm: "openai:gpt-4o-mini",
    dataStorageDir: ".mini-agent-test",
    configFile: "mini-agent.config.yaml",
    cwd: Option.none(),
    stdoutLogLevel: LogLevel.None,
    fileLogLevel: LogLevel.None
  } satisfies MiniAgentConfig
)

export interface TestFixtures {
  suiteDir: string
  testDir: string
}

const sanitizeName = (name: string): string => {
  return name.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").slice(0, 40)
}

/** Walk up the suite hierarchy to get all ancestor names (root first) */
const getSuiteChain = (task: { suite?: { name?: string; suite?: unknown } }): Array<string> => {
  const names: Array<string> = []
  let current = task.suite
  while (current) {
    if (current.name) names.unshift(current.name)
    current = current.suite as typeof current
  }
  return names
}

export const test = baseTest.extend<TestFixtures>({
  suiteDir: [async ({ task: _task }, use) => {
    const base = await realpath(tmpdir())
    const dir = await mkdtemp(join(base, "mini-agent-e2e-"))
    console.log(`Suite temp directory: ${dir}`)
    await use(dir)
  }, { scope: "file" as const }],

  testDir: async ({ suiteDir, task }, use) => {
    const suiteChain = getSuiteChain(task)
    const testName = sanitizeName(task.name)

    // Build nested folder path: suiteDir/DescribeName/TestName-xxx
    let currentDir = suiteDir
    for (const suiteName of suiteChain) {
      currentDir = join(currentDir, sanitizeName(suiteName))
    }
    await mkdir(currentDir, { recursive: true })

    const dir = await mkdtemp(join(currentDir, `${testName}-`))

    await use(dir)

    if (task.result?.state === "fail") {
      console.log(`Failed test directory: ${dir}`)
    }
  }
})

export { expect }
