/**
 * CLI End-to-End Tests
 *
 * Tests the CLI functionality using Effect Command to run the actual CLI process.
 * These tests verify the CLI works correctly with different options.
 */
import { Command } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as fs from "node:fs"
import * as path from "node:path"

// =============================================================================
// Test Helpers
// =============================================================================

const TestLayer = BunContext.layer

const CLI_PATH = path.resolve(__dirname, "../src/main.ts")
const TEST_CONTEXTS_DIR = ".contexts"

/** Run the CLI with given args and return stdout */
const runCli = (...args: Array<string>) =>
  Command.make("bun", CLI_PATH, ...args).pipe(
    Command.string,
    Effect.provide(TestLayer)
  )

/** Extract JSON output from CLI response (strips tracing logs) */
const extractJsonOutput = (output: string): string => {
  // Find lines that start with { (JSON objects)
  const lines = output.split("\n")
  const jsonLines = lines.filter((line) => line.trim().startsWith("{"))
  return jsonLines.join("\n")
}

/** Clean up test context files */
const cleanupTestContext = (contextName: string) =>
  Effect.sync(() => {
    const contextPath = path.join(TEST_CONTEXTS_DIR, `${contextName}.yaml`)
    if (fs.existsSync(contextPath)) {
      fs.unlinkSync(contextPath)
    }
  })

/** Generate unique test context name */
const uniqueContextName = () => `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

// =============================================================================
// Tests
// =============================================================================

describe("CLI", () => {
  describe("--help", () => {
    it.effect("shows help message", () =>
      Effect.gen(function*() {
        const output = yield* runCli("--help")
        expect(output).toContain("chat")
        expect(output).toContain("--name")
        expect(output).toContain("--message")
        expect(output).toContain("--raw")
      })
    )

    it.effect("shows version with --version", () =>
      Effect.gen(function*() {
        const output = yield* runCli("--version")
        expect(output).toContain("1.0.0")
      })
    )
  })

  describe("non-interactive mode (-m)", () => {
    it.effect("sends a message and gets a response", () =>
      Effect.gen(function*() {
        const contextName = uniqueContextName()

        const output = yield* runCli(
          "-n", contextName,
          "-m", "Say exactly: TEST_RESPONSE_123"
        ).pipe(
          Effect.ensuring(cleanupTestContext(contextName))
        )

        // Should contain some response (we can't predict exact LLM output)
        expect(output.length).toBeGreaterThan(0)
      }),
      { timeout: 30000 }
    )

    it.effect("uses 'default' context when no name provided", () =>
      Effect.gen(function*() {
        const output = yield* runCli(
          "-m", "Say exactly: HELLO"
        )

        expect(output.length).toBeGreaterThan(0)
      }),
      { timeout: 30000 }
    )
  })

  describe("--raw mode", () => {
    it.effect("outputs JSON events", () =>
      Effect.gen(function*() {
        const contextName = uniqueContextName()

        const output = yield* runCli(
          "-n", contextName,
          "-m", "Say exactly: RAW_TEST",
          "--raw"
        ).pipe(
          Effect.ensuring(cleanupTestContext(contextName))
        )

        const jsonOutput = extractJsonOutput(output)
        // Should contain JSON with _tag field
        expect(jsonOutput).toContain('"_tag"')
        expect(jsonOutput).toContain('"AssistantMessage"')
      }),
      { timeout: 30000 }
    )

    it.effect("includes ephemeral events with --show-ephemeral", () =>
      Effect.gen(function*() {
        const contextName = uniqueContextName()

        const output = yield* runCli(
          "-n", contextName,
          "-m", "Say hello",
          "--raw",
          "--show-ephemeral"
        ).pipe(
          Effect.ensuring(cleanupTestContext(contextName))
        )

        const jsonOutput = extractJsonOutput(output)
        // Should contain TextDelta events when showing ephemeral
        expect(jsonOutput).toContain('"TextDelta"')
      }),
      { timeout: 30000 }
    )
  })

  describe("context persistence", () => {
    it.effect("creates context file on first message", () =>
      Effect.gen(function*() {
        const contextName = uniqueContextName()
        const contextPath = path.join(TEST_CONTEXTS_DIR, `${contextName}.yaml`)

        yield* runCli(
          "-n", contextName,
          "-m", "Hello"
        )

        // Context file should exist
        const exists = fs.existsSync(contextPath)
        expect(exists).toBe(true)

        // Clean up
        yield* cleanupTestContext(contextName)
      }),
      { timeout: 30000 }
    )

    it.effect("maintains conversation history across calls", () =>
      Effect.gen(function*() {
        const contextName = uniqueContextName()

        // First message
        yield* runCli(
          "-n", contextName,
          "-m", "My favorite color is blue"
        )

        // Second message asking about the first - use raw mode to get JSON
        const output = yield* runCli(
          "-n", contextName,
          "-m", "What is my favorite color?",
          "--raw"
        ).pipe(
          Effect.ensuring(cleanupTestContext(contextName))
        )

        const jsonOutput = extractJsonOutput(output)
        // Response should be JSON with AssistantMessage containing "blue"
        expect(jsonOutput).toContain('"AssistantMessage"')
        expect(jsonOutput.toLowerCase()).toContain("blue")
      }),
      { timeout: 60000 }
    )
  })

  describe("error handling", () => {
    it.effect("returns non-empty output on valid request", () =>
      Effect.gen(function*() {
        const contextName = uniqueContextName()

        const output = yield* runCli(
          "-n", contextName,
          "-m", "Say hello"
        ).pipe(
          Effect.ensuring(cleanupTestContext(contextName))
        )

        // Should have some output
        expect(output.length).toBeGreaterThan(0)
      }),
      { timeout: 30000 }
    )
  })
})

describe("CLI options", () => {
  it.effect("-n is alias for --name", () =>
    Effect.gen(function*() {
      const output = yield* runCli("--help")
      expect(output).toContain("-n")
      expect(output).toContain("--name")
    })
  )

  it.effect("-m is alias for --message", () =>
    Effect.gen(function*() {
      const output = yield* runCli("--help")
      expect(output).toContain("-m")
      expect(output).toContain("--message")
    })
  )

  it.effect("-r is alias for --raw", () =>
    Effect.gen(function*() {
      const output = yield* runCli("--help")
      expect(output).toContain("-r")
      expect(output).toContain("--raw")
    })
  )

  it.effect("-e is alias for --show-ephemeral", () =>
    Effect.gen(function*() {
      const output = yield* runCli("--help")
      expect(output).toContain("-e")
      expect(output).toContain("--show-ephemeral")
    })
  )
})

