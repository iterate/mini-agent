/**
 * Multi-Provider E2E Tests
 */
import { Command } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect } from "effect"
import * as path from "node:path"
import { describe } from "vitest"
import { expect, test } from "./fixtures.ts"

const TestLayer = BunContext.layer
const CLI_PATH = path.resolve(__dirname, "../src/main.ts")

const runCliWithEnv = (cwd: string, env: Record<string, string>, ...args: Array<string>) => {
  const cwdArgs = cwd ? ["--cwd", cwd] : []
  return Command.make("bun", CLI_PATH, ...cwdArgs, ...args).pipe(
    Command.env(env),
    Command.string,
    Effect.provide(TestLayer)
  )
}

const providers = [
  { provider: "openai", llm: "openai:gpt-4o-mini", envKey: "OPENAI_API_KEY" },
  { provider: "anthropic", llm: "anthropic:claude-sonnet-4-20250514", envKey: "ANTHROPIC_API_KEY" },
  { provider: "gemini", llm: "gemini:gemini-1.5-flash", envKey: "GEMINI_API_KEY" }
] as const

describe.each(providers)("Provider: $provider", ({ envKey, llm }) => {
  const hasKey = Boolean(process.env[envKey])

  test.skipIf(!hasKey)(
    "basic chat works",
    { timeout: 30000 },
    async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCliWithEnv(testDir, { LLM: llm }, "chat", "-n", "test", "-m", "Say exactly: TEST_SUCCESS")
      )

      expect(output.length).toBeGreaterThan(0)
    }
  )
})

describe("LLM Shorthand Parsing", () => {
  test("bare model name defaults to openai", async ({ testDir }) => {
    const output = await Effect.runPromise(
      runCliWithEnv(testDir, { LLM: "gpt-4o-mini" }, "--help")
    )

    expect(output).toContain("mini-agent")
  })

  test("nested colon model names work", async ({ testDir }) => {
    const output = await Effect.runPromise(
      runCliWithEnv(testDir, { LLM: "openrouter:openai/gpt-4o" }, "--help")
    )

    expect(output).toContain("mini-agent")
  })
})
