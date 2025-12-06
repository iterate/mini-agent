/**
 * CLI E2E Tests for new architecture.
 *
 * Tests the new actor-based CLI functionality.
 */
import { Command } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect, Stream } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { describe } from "vitest"
import { expect, test } from "../../test/fixtures.js"

const CLI_PATH = path.resolve(__dirname, "./cli.ts")

interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Run CLI with full control over env and output capture */
const runCli = (
  args: Array<string>,
  options: { cwd?: string; env?: Record<string, string> } = {}
): Effect.Effect<CliResult, never, never> => {
  const cwdArgs = options.cwd ? ["--cwd", options.cwd] : []
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
  ).pipe(
    Effect.provide(BunContext.layer),
    Effect.catchAll((e) => Effect.succeed({ stdout: "", stderr: String(e), exitCode: 1 }))
  )
}

/** Extract JSON objects from CLI response */
const extractJsonOutput = (output: string): string => {
  const jsonObjects: Array<string> = []
  let depth = 0
  let start = -1

  for (let i = 0; i < output.length; i++) {
    if (output[i] === "{") {
      if (depth === 0) start = i
      depth++
    } else if (output[i] === "}") {
      depth--
      if (depth === 0 && start !== -1) {
        const obj = output.slice(start, i + 1)
        if (obj.includes("\"_tag\"")) {
          jsonObjects.push(obj)
        }
        start = -1
      }
    }
  }

  return jsonObjects.join("\n")
}

describe("New Architecture CLI", () => {
  describe("--help", () => {
    test("shows help message", async () => {
      const result = await Effect.runPromise(runCli(["--help"]))
      expect(result.stdout).toContain("mini-agent-v2")
      expect(result.stdout).toContain("chat")
    })

    test("shows chat help", async () => {
      const result = await Effect.runPromise(runCli(["chat", "--help"]))
      expect(result.stdout).toContain("--name")
      expect(result.stdout).toContain("--message")
      expect(result.stdout).toContain("--raw")
    })
  })

  describe("chat command", () => {
    test("sends a message and gets a response", { timeout: 60000 }, async ({ testDir }) => {
      const result = await Effect.runPromise(
        runCli(["chat", "-n", "test-context", "-m", "Say exactly: TEST_V2_RESPONSE"], { cwd: testDir })
      )

      expect(result.stdout.length).toBeGreaterThan(0)
      expect(result.exitCode).toBe(0)
    })

    test("outputs JSON in raw mode", { timeout: 60000 }, async ({ testDir }) => {
      const result = await Effect.runPromise(
        runCli(["chat", "-n", "raw-test", "-m", "Say exactly: RAW_TEST", "--raw"], { cwd: testDir })
      )

      expect(result.exitCode).toBe(0)
      const jsonOutput = extractJsonOutput(result.stdout)
      expect(jsonOutput).toContain("\"_tag\"")
      expect(jsonOutput).toContain("\"AssistantMessageEvent\"")
    })

    test("creates context file", { timeout: 60000 }, async ({ testDir }) => {
      await Effect.runPromise(
        runCli(["chat", "-n", "persist-test", "-m", "Hello"], { cwd: testDir })
      )

      // Context file should exist in v2 contexts dir
      const contextsDir = path.join(testDir, ".mini-agent", "contexts-v2")
      expect(fs.existsSync(contextsDir)).toBe(true)

      const files = fs.readdirSync(contextsDir)
      expect(files.some((f) => f.includes("persist-test"))).toBe(true)
    })

    test("maintains conversation history", { timeout: 90000 }, async ({ testDir }) => {
      // First message
      await Effect.runPromise(
        runCli(["chat", "-n", "history-test", "-m", "Remember: my secret code is ABC123"], { cwd: testDir })
      )

      // Second message
      const result = await Effect.runPromise(
        runCli(["chat", "-n", "history-test", "-m", "What is my secret code?", "--raw"], { cwd: testDir })
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout.toLowerCase()).toContain("abc123")
    })
  })
})

describe("Multi-LLM", () => {
  const llms = [
    { llm: "openai:gpt-4.1-mini" },
    { llm: "anthropic:claude-haiku-4-5" }
  ] as const

  describe.each(llms)("LLM: $llm", ({ llm }) => {
    test(
      "basic chat works",
      { timeout: 60000 },
      async ({ testDir }) => {
        const result = await Effect.runPromise(
          runCli(["chat", "-n", "llm-test", "-m", "Say exactly: SUCCESS"], { cwd: testDir, env: { LLM: llm } })
        )
        expect(result.stdout.length).toBeGreaterThan(0)
        expect(result.exitCode).toBe(0)
      }
    )
  })
})
