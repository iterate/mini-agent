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
import { Effect, Stream } from "effect"
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

/** Extract JSONL lines from CLI response (strips log messages) */
const extractJsonLines = (output: string): Array<string> => {
  // JSONL format: each line is a complete JSON object
  return output
    .split("\n")
    .filter((line) => line.trim().startsWith("{") && line.includes("\"_tag\""))
}

/** Run CLI with stdin input using Command.stdin */
const runCliWithStdin = (cwd: string, input: string, ...args: Array<string>) => {
  const cwdArgs = ["--cwd", cwd]
  return Command.make("bun", CLI_PATH, ...cwdArgs, ...args).pipe(
    Command.stdin(Stream.make(Buffer.from(input, "utf-8"))),
    Command.string,
    Effect.provide(TestLayer)
  )
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
    test("outputs JSONL events (one per line)", { timeout: 30000 }, async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCli(testDir, "chat", "-n", TEST_CONTEXT, "-m", "Say exactly: RAW_TEST", "--raw")
      )

      const jsonLines = extractJsonLines(output)
      expect(jsonLines.length).toBeGreaterThan(0)

      // Each line should be valid JSON with _tag
      for (const line of jsonLines) {
        const parsed = JSON.parse(line)
        expect(parsed).toHaveProperty("_tag")
      }

      // Should have AssistantMessage event
      expect(output).toContain("\"AssistantMessage\"")
    })

    test("includes ephemeral events with --show-ephemeral", { timeout: 30000 }, async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCli(testDir, "chat", "-n", TEST_CONTEXT, "-m", "Say hello", "--raw", "--show-ephemeral")
      )

      const jsonLines = extractJsonLines(output)
      // Should contain TextDelta events when showing ephemeral
      const hasTextDelta = jsonLines.some((line) => line.includes("\"TextDelta\""))
      expect(hasTextDelta).toBe(true)
    })
  })

  describe("script mode (--script)", () => {
    test("reads stdin and outputs JSONL", { timeout: 30000 }, async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          "Say exactly: SCRIPT_TEST\n",
          "--stdout-log-level",
          "none",
          "chat",
          "-n",
          TEST_CONTEXT,
          "--script"
        )
      )

      const jsonLines = extractJsonLines(output)
      expect(jsonLines.length).toBeGreaterThan(0)

      // Each line should be valid JSON with _tag
      for (const line of jsonLines) {
        const parsed = JSON.parse(line)
        expect(parsed).toHaveProperty("_tag")
      }

      // Should have AssistantMessage event
      expect(output).toContain("\"AssistantMessage\"")
    })

    test("handles multiple messages in sequence", { timeout: 60000 }, async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          "Remember: my secret code is XYZ789\nWhat is my secret code?\n",
          "--stdout-log-level",
          "none",
          "chat",
          "-n",
          "multi-test",
          "--script"
        )
      )

      const jsonLines = extractJsonLines(output)

      // Should have at least two AssistantMessage events (one per input line)
      const assistantMessages = jsonLines.filter((line) => line.includes("\"AssistantMessage\""))
      expect(assistantMessages.length).toBeGreaterThanOrEqual(2)

      // Second response should mention the secret code
      expect(output.toLowerCase()).toContain("xyz789")
    })

    test("auto-detects script mode when piped (no TTY)", { timeout: 30000 }, async ({ testDir }) => {
      // When stdin is piped (not TTY), script mode should be auto-detected
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          "Say hello\n",
          "--stdout-log-level",
          "none",
          "chat",
          "-n",
          TEST_CONTEXT
        )
      )

      // Output should be JSONL (script mode auto-detected)
      const jsonLines = extractJsonLines(output)
      expect(jsonLines.length).toBeGreaterThan(0)
      expect(output).toContain("\"AssistantMessage\"")
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

      // Second message asking about the first - use raw mode to get JSONL
      const output = await Effect.runPromise(
        runCli(testDir, "chat", "-n", TEST_CONTEXT, "-m", "What is my favorite color?", "--raw")
      )

      // Response should be JSONL with AssistantMessage containing "blue"
      expect(output).toContain("\"AssistantMessage\"")
      expect(output.toLowerCase()).toContain("blue")
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
    test("info and debug messages hidden at warn level (default)", async ({ testDir }) => {
      const output = await Effect.runPromise(runCli(testDir, "log-test"))

      expect(output).toContain("LOG_TEST_DONE")
      expect(output).toContain("WARN_MESSAGE")
      expect(output).toContain("ERROR_MESSAGE")
      expect(output).not.toContain("INFO_MESSAGE")
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

      // File logger should capture DEBUG even when stdout is WARN
      expect(logContent).toContain("DEBUG_MESSAGE")
      expect(logContent).toContain("INFO_MESSAGE")
    })
  })
})
