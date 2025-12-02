/**
 * CLI End-to-End Tests
 *
 * Tests the CLI functionality using Effect Command to run the actual CLI process.
 * These tests verify the CLI works correctly with different options.
 *
 * NOTE: This is actually an eval - the LLM is in the loop. Will get to proper evals later.
 */
import { Command } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { describe } from "vitest"
import { expect, test } from "./fixtures.js"

// =============================================================================
// Test Helpers
// =============================================================================

const TestLayer = BunContext.layer

const CLI_PATH = path.resolve(__dirname, "../src/main.ts")

/** Context name used in tests - safe to reuse since each test has isolated testDir */
const TEST_CONTEXT = "test-context"

/** Run the CLI with given args and return stdout. Pass cwd to isolate file output. */
const runCli = (cwd: string | undefined, ...args: Array<string>) => {
  const cwdArgs = cwd ? ["--cwd", cwd] : []
  return Command.make("bun", CLI_PATH, ...cwdArgs, ...args).pipe(
    Command.string,
    Effect.provide(TestLayer)
  )
}

/** Extract JSON output from CLI response (strips tracing logs and other output) */
const extractJsonOutput = (output: string): string => {
  // Extract JSON objects that contain _tag field (event objects)
  // The JSON is pretty-printed across multiple lines
  const jsonPattern = /^\{[^{}]*"_tag"[^{}]*\}$/gm
  const matches = output.match(jsonPattern)
  if (matches) {
    return matches.join("\n")
  }
  // Fallback: extract all text between first { and last } that contains _tag
  const startIdx = output.indexOf("{")
  const endIdx = output.lastIndexOf("}")
  if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
    const jsonSection = output.slice(startIdx, endIdx + 1)
    if (jsonSection.includes("\"_tag\"")) {
      return jsonSection
    }
  }
  return ""
}

// =============================================================================
// Tests
// =============================================================================

describe("CLI", () => {
  describe("--help", () => {
    test("shows help message with chat subcommand", async () => {
      const output = await Effect.runPromise(runCli(undefined, "--help"))
      // Root help should mention the chat subcommand
      expect(output).toContain("chat")
      expect(output).toContain("mini-agent")
      expect(output).toContain("--config")
    })

    test("shows chat-specific help", async () => {
      const output = await Effect.runPromise(runCli(undefined, "chat", "--help"))
      // Chat subcommand help should show chat options
      expect(output).toContain("--name")
      expect(output).toContain("--message")
      expect(output).toContain("--raw")
    })

    test("shows version with --version", async () => {
      const output = await Effect.runPromise(runCli(undefined, "--version"))
      expect(output).toContain("1.0.0")
    })
  })

  describe("non-interactive mode (-m)", () => {
    test("sends a message and gets a response", { timeout: 30000 }, async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCli(testDir, "chat", "-n", TEST_CONTEXT, "-m", "Say exactly: TEST_RESPONSE_123")
      )

      // Should contain some response (we can't predict exact LLM output)
      expect(output.length).toBeGreaterThan(0)
    })

    test("uses 'default' context when no name provided", { timeout: 30000 }, async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCli(testDir, "chat", "-m", "Say exactly: HELLO")
      )

      expect(output.length).toBeGreaterThan(0)
    })
  })

  describe("--raw mode", () => {
    test("outputs JSON events", { timeout: 30000 }, async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCli(testDir, "chat", "-n", TEST_CONTEXT, "-m", "Say exactly: RAW_TEST", "--raw")
      )

      const jsonOutput = extractJsonOutput(output)
      // Should contain JSON with _tag field
      expect(jsonOutput).toContain("\"_tag\"")
      expect(jsonOutput).toContain("\"AssistantMessage\"")
    })

    test("includes ephemeral events with --show-ephemeral", { timeout: 30000 }, async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCli(testDir, "chat", "-n", TEST_CONTEXT, "-m", "Say hello", "--raw", "--show-ephemeral")
      )

      const jsonOutput = extractJsonOutput(output)
      // Should contain TextDelta events when showing ephemeral
      expect(jsonOutput).toContain("\"TextDelta\"")
    })
  })

  describe("context persistence", () => {
    test("creates context file on first message", { timeout: 30000 }, async ({ testDir }) => {
      await Effect.runPromise(
        runCli(testDir, "chat", "-n", TEST_CONTEXT, "-m", "Hello")
      )

      // Context file should exist in testDir/.mini-agent/contexts/
      const contextPath = path.join(testDir, ".mini-agent", "contexts", `${TEST_CONTEXT}.yaml`)
      expect(fs.existsSync(contextPath)).toBe(true)
    })

    test("maintains conversation history across calls", { timeout: 60000 }, async ({ testDir }) => {
      // First message
      await Effect.runPromise(
        runCli(testDir, "chat", "-n", TEST_CONTEXT, "-m", "My favorite color is blue")
      )

      // Second message asking about the first - use raw mode to get JSON
      const output = await Effect.runPromise(
        runCli(testDir, "chat", "-n", TEST_CONTEXT, "-m", "What is my favorite color?", "--raw")
      )

      const jsonOutput = extractJsonOutput(output)
      // Response should be JSON with AssistantMessage containing "blue"
      expect(jsonOutput).toContain("\"AssistantMessage\"")
      expect(jsonOutput.toLowerCase()).toContain("blue")
    })
  })

  describe("error handling", () => {
    test("returns non-empty output on valid request", { timeout: 30000 }, async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCli(testDir, "chat", "-n", TEST_CONTEXT, "-m", "Say hello")
      )

      // Should have some output
      expect(output.length).toBeGreaterThan(0)
    })
  })
})

describe("CLI options", () => {
  test("-n is alias for --name", async () => {
    const output = await Effect.runPromise(runCli(undefined, "chat", "--help"))
    expect(output).toContain("-n")
    expect(output).toContain("--name")
  })

  test("-m is alias for --message", async () => {
    const output = await Effect.runPromise(runCli(undefined, "chat", "--help"))
    expect(output).toContain("-m")
    expect(output).toContain("--message")
  })

  test("-r is alias for --raw", async () => {
    const output = await Effect.runPromise(runCli(undefined, "chat", "--help"))
    expect(output).toContain("-r")
    expect(output).toContain("--raw")
  })

  test("-e is alias for --show-ephemeral", async () => {
    const output = await Effect.runPromise(runCli(undefined, "chat", "--help"))
    expect(output).toContain("-e")
    expect(output).toContain("--show-ephemeral")
  })

  test("-c is alias for --config", async () => {
    const output = await Effect.runPromise(runCli(undefined, "--help"))
    expect(output).toContain("-c")
    expect(output).toContain("--config")
  })
})

// =============================================================================
// Logging Tests
// =============================================================================

describe("Logging", () => {
  describe("stdout log level filtering", () => {
    test("debug messages hidden at info level (default)", async ({ testDir }) => {
      const output = await Effect.runPromise(runCli(testDir, "log-test"))

      expect(output).toContain("LOG_TEST_DONE")
      expect(output).toContain("INFO_MESSAGE")
      expect(output).not.toContain("DEBUG_MESSAGE")
    })

    test("debug messages shown at debug level", async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCli(testDir, "--stdout-log-level", "debug", "log-test")
      )

      expect(output).toContain("LOG_TEST_DONE")
      expect(output).toContain("DEBUG_MESSAGE")
      expect(output).toContain("INFO_MESSAGE")
    })

    test("no log messages at error level (only errors shown)", async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCli(testDir, "--stdout-log-level", "error", "log-test")
      )

      expect(output).toContain("LOG_TEST_DONE")
      expect(output).toContain("ERROR_MESSAGE")
      expect(output).not.toContain("INFO_MESSAGE")
      expect(output).not.toContain("DEBUG_MESSAGE")
    })

    test("no log messages when stdout logging disabled", async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCli(testDir, "--stdout-log-level", "none", "log-test")
      )

      expect(output).toContain("LOG_TEST_DONE")
      expect(output).not.toContain("INFO_MESSAGE")
      expect(output).not.toContain("DEBUG_MESSAGE")
      expect(output).not.toContain("ERROR_MESSAGE")
    })
  })

  describe("file logging", () => {
    test("creates log file with debug messages", async ({ testDir }) => {
      await Effect.runPromise(runCli(testDir, "log-test"))

      // Wait for file logger to flush (batchWindow is 100ms)
      await new Promise((resolve) => setTimeout(resolve, 200))

      // Log file should be created in testDir/.mini-agent/logs/
      const logsDir = path.join(testDir, ".mini-agent", "logs")
      expect(fs.existsSync(logsDir)).toBe(true)

      const logFiles = fs.readdirSync(logsDir)
      expect(logFiles.length).toBeGreaterThan(0)

      // Read the log file and verify it contains debug messages
      const logPath = path.join(logsDir, logFiles[0]!)
      const logContent = fs.readFileSync(logPath, "utf-8")

      // File logger should capture DEBUG even when stdout is INFO
      expect(logContent).toContain("DEBUG_MESSAGE")
      expect(logContent).toContain("INFO_MESSAGE")
    })
  })
})
