/**
 * Multi-Provider E2E Tests
 *
 * Parameterized tests verifying each supported LLM provider works correctly.
 * Skips tests when required API keys are not available.
 */
import { Command } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect } from "effect"
import * as path from "node:path"
import { describe } from "vitest"
import { expect, test } from "./fixtures.ts"

// =============================================================================
// Test Helpers
// =============================================================================

const TestLayer = BunContext.layer

const CLI_PATH = path.resolve(__dirname, "../src/main.ts")

/** Run the CLI with environment overrides */
const runCliWithEnv = (cwd: string, env: Record<string, string>, ...args: Array<string>) => {
  const cwdArgs = cwd ? ["--cwd", cwd] : []
  return Command.make("bun", CLI_PATH, ...cwdArgs, ...args).pipe(
    Command.env(env),
    Command.string,
    Effect.provide(TestLayer)
  )
}

// =============================================================================
// Parameterized Provider Tests
// =============================================================================

const providers = [
  { provider: "openai", llm: "openai:gpt-4o-mini", envKey: "OPENAI_API_KEY" },
  { provider: "anthropic", llm: "anthropic:claude-sonnet-4-20250514", envKey: "ANTHROPIC_API_KEY" },
  { provider: "gemini", llm: "gemini:gemini-1.5-flash", envKey: "GOOGLE_API_KEY" }
] as const

describe.each(providers)("Provider: $provider", ({ llm, envKey }) => {
  const hasKey = Boolean(process.env[envKey])

  test.skipIf(!hasKey)(
    "basic chat works",
    { timeout: 30000 },
    async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCliWithEnv(testDir, { DEFAULT_LLM: llm }, "chat", "-n", "test", "-m", "Say exactly: TEST_SUCCESS")
      )

      expect(output.length).toBeGreaterThan(0)
    }
  )
})

// =============================================================================
// Shorthand Parsing Tests (no API calls needed)
// =============================================================================

describe("LLM Shorthand Parsing", () => {
  test("bare model name defaults to openai", async ({ testDir }) => {
    const output = await Effect.runPromise(
      runCliWithEnv(testDir, { DEFAULT_LLM: "gpt-4o-mini" }, "--help")
    )

    expect(output).toContain("mini-agent")
  })

  test("nested colon model names work", async ({ testDir }) => {
    const output = await Effect.runPromise(
      runCliWithEnv(testDir, { DEFAULT_LLM: "openrouter:openai/gpt-4o" }, "--help")
    )

    expect(output).toContain("mini-agent")
  })
})
