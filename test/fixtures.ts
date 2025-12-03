/**
 * Test Fixtures
 *
 * Modern Vitest 3.x fixtures using test.extend() for isolated test environments.
 * Provides suite-level and per-test temp directories with failure-only logging.
 */
import { Command } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import type { PlatformError } from "@effect/platform/Error"
import { Effect, Layer, LogLevel, Option, Redacted, Stream } from "effect"
import { mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test as baseTest } from "vitest"
import { AppConfig, type MiniAgentConfig } from "../src/config.ts"

// =============================================================================
// Test Layers
// =============================================================================

/** Test layer for AppConfig with mock values. Logging disabled for unit tests. */
export const testAppConfigLayer = Layer.succeed(
  AppConfig,
  {
    openaiApiKey: Redacted.make("test-api-key"),
    openaiModel: "gpt-4o-mini",
    dataStorageDir: ".mini-agent-test",
    configFile: "mini-agent.config.yaml",
    cwd: Option.none(),
    stdoutLogLevel: LogLevel.None,
    fileLogLevel: LogLevel.None
  } satisfies MiniAgentConfig
)

// =============================================================================
// CLI Test Helper
// =============================================================================

const CLI_PATH = resolve(__dirname, "../src/main.ts")

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

// =============================================================================
// Vitest Fixtures
// =============================================================================

export interface TestFixtures {
  /** Suite-level parent directory shared across tests in this file */
  suiteDir: string
  /** Per-test isolated directory */
  testDir: string
}

export const test = baseTest.extend<TestFixtures>({
  // File-scoped fixture: created once per test file (Vitest 3.2+)
  suiteDir: [async ({ task: _task }, use) => {
    const base = await realpath(tmpdir())
    const dir = await mkdtemp(join(base, "mini-agent-e2e-"))
    console.log(`Suite temp directory: ${dir}`)
    await use(dir)
    // No cleanup - directories preserved for inspection
  }, { scope: "file" as const }],

  // Per-test fixture: fresh directory for each test
  testDir: async ({ suiteDir, task }, use) => {
    const safeName = task.name.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)
    const dir = await mkdtemp(join(suiteDir, `${safeName}-`))

    await use(dir)

    // Only log path on test failure
    if (task.result?.state === "fail") {
      console.log(`Failed test directory: ${dir}`)
    }
  }
})

export { expect }
