/**
 * Test Fixtures
 *
 * Vitest 3.x fixtures for isolated test environments with temp directories.
 *
 * LLM Mode:
 * - Default: Uses mock LLM server for fast (~31s), predictable responses
 * - Set USE_REAL_LLM=1 to use real LLM APIs:
 *   - Requires valid API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)
 *   - Optionally set LLM env var to specify provider (e.g., LLM=anthropic:claude-haiku-4-5)
 *   - Example: USE_REAL_LLM=1 doppler run -- bun vitest run
 */
import { Command } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import type { PlatformError } from "@effect/platform/Error"
import { Effect, Layer, LogLevel, Option, Stream } from "effect"
import { mkdir, mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test as baseTest } from "vitest"
import { AppConfig, type MiniAgentConfig } from "../src/config.ts"
import { type MockLlmServer, startMockLlmServer } from "./mock-llm-server.ts"

/** Whether to use real LLM APIs instead of mock server */
export const useRealLlm = process.env.USE_REAL_LLM === "1"

const CLI_PATH = resolve(__dirname, "../src/cli/main.ts")

export interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface RunCliOptions {
  cwd?: string
  env?: Record<string, string>
}

/** Run CLI with full control over env and output capture using Effect Command */
export const runCli = (
  args: Array<string>,
  options: RunCliOptions = {}
): Effect.Effect<CliResult, PlatformError, never> => {
  const cwdArgs = options.cwd ? ["--cwd", options.cwd] : []

  // Inherit parent env (for Doppler-injected secrets), then apply defaults and overrides
  // Default OPENAI_API_KEY only used if not already in environment (e.g., local dev without Doppler)
  const env = {
    ...process.env,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-api-key",
    ...options.env
  }

  let cmd = Command.make("bun", CLI_PATH, ...cwdArgs, ...args)
  if (options.cwd) cmd = Command.workingDirectory(cmd, options.cwd)
  cmd = Command.env(cmd, env)

  return Effect.scoped(
    Effect.gen(function*() {
      const proc = yield* Command.start(cmd)

      const [stdout, stderr, exitCode] = yield* Effect.all([
        proc.stdout.pipe(Stream.decodeText(), Stream.mkString),
        proc.stderr.pipe(Stream.decodeText(), Stream.mkString),
        proc.exitCode
      ])

      return { stdout, stderr, exitCode }
    })
  ).pipe(Effect.provide(BunContext.layer))
}

/** Run CLI with custom environment variables (for multi-LLM testing) */
export const runCliWithEnv = (
  cwd: string,
  env: Record<string, string>,
  ...args: Array<string>
): Effect.Effect<CliResult, PlatformError, never> => runCli(args, { cwd, env })

export const testAppConfigLayer = Layer.succeed(
  AppConfig,
  {
    llm: "openai:gpt-4o-mini",
    dataStorageDir: ".mini-agent-test",
    configFile: "mini-agent.config.yaml",
    cwd: Option.none(),
    stdoutLogLevel: LogLevel.None,
    fileLogLevel: LogLevel.None,
    port: 3000,
    host: "0.0.0.0",
    layercodeWebhookSecret: Option.none()
  } satisfies MiniAgentConfig
)

/** LLM environment variables for tests - compatible with Record<string, string> */
export type LlmEnv = Record<string, string>

export interface TestFixtures {
  suiteDir: string
  testDir: string
  /** LLM config env vars - empty when USE_REAL_LLM=1, mock server config otherwise */
  llmEnv: LlmEnv
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
  },

  // eslint-disable-next-line no-empty-pattern
  llmEnv: [async ({}, use) => {
    if (useRealLlm) {
      // Use real LLM - no overrides needed, inherit from environment
      console.log("Using real LLM (USE_REAL_LLM=1)")
      await use({})
      return
    }

    // Start mock LLM server for this test file
    let mockServer: MockLlmServer | undefined
    try {
      mockServer = await startMockLlmServer()
      console.log(`Mock LLM server: ${mockServer.url}`)

      const env: LlmEnv = {
        LLM: JSON.stringify({
          apiFormat: "openai-responses",
          model: "mock-model",
          baseUrl: mockServer.url,
          apiKeyEnvVar: "MOCK_API_KEY"
        }),
        MOCK_API_KEY: "test-key"
      }

      await use(env)
    } finally {
      await mockServer?.close()
    }
  }, { scope: "file" as const }]
})

export { expect }
