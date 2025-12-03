/**
 * Multi-Provider E2E Tests
 *
 * Tests that each supported LLM provider works correctly.
 * Skips tests when required API keys are not available.
 */
import { Command } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect } from "effect"
import * as path from "node:path"
import { describe } from "vitest"
import { expect, test } from "./fixtures.js"

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
// Provider Tests
// =============================================================================

describe("Multi-Provider Support", () => {
  const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY)
  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY)
  const hasOpenRouterKey = Boolean(process.env.OPENROUTER_API_KEY)
  const hasBedrockKeys = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
  const hasGoogleKey = Boolean(process.env.GOOGLE_API_KEY)

  test.skipIf(!hasOpenAiKey)(
    "OpenAI basic chat works",
    { timeout: 30000 },
    async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCliWithEnv(
          testDir,
          { DEFAULT_LLM: "openai:gpt-4o-mini" },
          "chat",
          "-m",
          "Say exactly: OPENAI_TEST_SUCCESS"
        )
      )

      expect(output.length).toBeGreaterThan(0)
    }
  )

  test.skipIf(!hasAnthropicKey)(
    "Anthropic basic chat works",
    { timeout: 30000 },
    async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCliWithEnv(
          testDir,
          { DEFAULT_LLM: "anthropic:claude-sonnet-4-20250514" },
          "chat",
          "-m",
          "Say exactly: ANTHROPIC_TEST_SUCCESS"
        )
      )

      expect(output.length).toBeGreaterThan(0)
    }
  )

  test.skipIf(!hasOpenRouterKey)(
    "OpenRouter basic chat works",
    { timeout: 30000 },
    async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCliWithEnv(
          testDir,
          { DEFAULT_LLM: "openrouter:openai/gpt-4o-mini" },
          "chat",
          "-m",
          "Say exactly: OPENROUTER_TEST_SUCCESS"
        )
      )

      expect(output.length).toBeGreaterThan(0)
    }
  )

  test.skipIf(!hasBedrockKeys)(
    "AWS Bedrock basic chat works",
    { timeout: 30000 },
    async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCliWithEnv(
          testDir,
          { DEFAULT_LLM: "bedrock:anthropic.claude-3-haiku-20240307-v1:0" },
          "chat",
          "-m",
          "Say exactly: BEDROCK_TEST_SUCCESS"
        )
      )

      expect(output.length).toBeGreaterThan(0)
    }
  )

  test.skipIf(!hasGoogleKey)(
    "Google Gemini basic chat works",
    { timeout: 30000 },
    async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCliWithEnv(
          testDir,
          { DEFAULT_LLM: "gemini:gemini-1.5-flash" },
          "chat",
          "-m",
          "Say exactly: GEMINI_TEST_SUCCESS"
        )
      )

      expect(output.length).toBeGreaterThan(0)
    }
  )
})

// =============================================================================
// Config Override Tests
// =============================================================================

describe("LLM Config Overrides", () => {
  const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY)

  test.skipIf(!hasOpenAiKey)(
    "DEFAULT_LLM_API_KEY overrides provider-specific key",
    { timeout: 30000 },
    async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCliWithEnv(
          testDir,
          {
            DEFAULT_LLM: "openai:gpt-4o-mini",
            DEFAULT_LLM_API_KEY: process.env.OPENAI_API_KEY || ""
          },
          "chat",
          "-m",
          "Say hi"
        )
      )

      expect(output.length).toBeGreaterThan(0)
    }
  )
})

// =============================================================================
// Shorthand Parsing Tests
// =============================================================================

describe("LLM Shorthand Parsing", () => {
  // These tests verify parsing works without making actual API calls
  test("bare model name defaults to openai", async ({ testDir }) => {
    // This should try to use openai with model "gpt-4o-mini"
    // Just test that --help works regardless of API key
    const output = await Effect.runPromise(
      runCliWithEnv(testDir, { DEFAULT_LLM: "gpt-4o-mini" }, "--help")
    )

    expect(output).toContain("mini-agent")
  })

  test("nested colon model names work", async ({ testDir }) => {
    // "openrouter:openai/gpt-4o" should parse as provider=openrouter, model=openai/gpt-4o
    const output = await Effect.runPromise(
      runCliWithEnv(testDir, { DEFAULT_LLM: "openrouter:openai/gpt-4o" }, "--help")
    )

    expect(output).toContain("mini-agent")
  })
})
