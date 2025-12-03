/**
 * CLI End-to-End Tests
 *
 * Tests the CLI functionality using Effect Command to run the actual CLI process.
 * These tests verify the CLI works correctly with different options.
 *
 * NOTE: This is actually an eval - the LLM is in the loop. Will get to proper evals later.
 */
import { Effect } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { describe } from "vitest"
import { expect, runCli, test } from "./fixtures.js"

// =============================================================================
// Test Helpers
// =============================================================================

/** Context name used in tests - safe to reuse since each test has isolated testDir */
const TEST_CONTEXT = "test-context"

/** Extract JSON objects from CLI response that contain _tag field (event objects) */
const extractJsonOutput = (output: string): string => {
  // Find all complete JSON objects with balanced braces
  const jsonObjects: string[] = []
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
        // Only include objects that have _tag field (our event objects)
        if (obj.includes("\"_tag\"")) {
          jsonObjects.push(obj)
        }
        start = -1
      }
    }
  }

  return jsonObjects.join("\n")
}

// =============================================================================
// Tests
// =============================================================================

describe("CLI", () => {
  describe("--help", () => {
    test("shows help message with chat subcommand", async () => {
      const result = await Effect.runPromise(runCli(["--help"]))
      // Root help should mention the chat subcommand
      expect(result.stdout).toContain("chat")
      expect(result.stdout).toContain("mini-agent")
      expect(result.stdout).toContain("--config")
    })

    test("shows chat-specific help", async () => {
      const result = await Effect.runPromise(runCli(["chat", "--help"]))
      // Chat subcommand help should show chat options
      expect(result.stdout).toContain("--name")
      expect(result.stdout).toContain("--message")
      expect(result.stdout).toContain("--raw")
    })

    test("shows version with --version", async () => {
      const result = await Effect.runPromise(runCli(["--version"]))
      expect(result.stdout).toContain("1.0.0")
    })
  })

  describe("non-interactive mode (-m)", () => {
    test("sends a message and gets a response", { timeout: 30000 }, async ({ testDir }) => {
      const result = await Effect.runPromise(
        runCli(["chat", "-n", TEST_CONTEXT, "-m", "Say exactly: TEST_RESPONSE_123"], { cwd: testDir })
      )

      // Should contain some response (we can't predict exact LLM output)
      expect(result.stdout.length).toBeGreaterThan(0)
    })

    test("uses 'default' context when no name provided", { timeout: 30000 }, async ({ testDir }) => {
      const result = await Effect.runPromise(
        runCli(["chat", "-m", "Say exactly: HELLO"], { cwd: testDir })
      )

      expect(result.stdout.length).toBeGreaterThan(0)
    })
  })

  describe("--raw mode", () => {
    test("outputs JSON events", { timeout: 30000 }, async ({ testDir }) => {
      const result = await Effect.runPromise(
        runCli(["chat", "-n", TEST_CONTEXT, "-m", "Say exactly: RAW_TEST", "--raw"], { cwd: testDir })
      )

      expect(result.exitCode).toBe(0)
      const jsonOutput = extractJsonOutput(result.stdout)
      // Should contain JSON with _tag field
      expect(jsonOutput).toContain("\"_tag\"")
      expect(jsonOutput).toContain("\"AssistantMessage\"")
    })

    test("includes ephemeral events with --show-ephemeral", { timeout: 30000 }, async ({ testDir }) => {
      const result = await Effect.runPromise(
        runCli(["chat", "-n", TEST_CONTEXT, "-m", "Say hello", "--raw", "--show-ephemeral"], { cwd: testDir })
      )

      expect(result.exitCode).toBe(0)
      const jsonOutput = extractJsonOutput(result.stdout)
      // Should contain TextDelta events when showing ephemeral
      expect(jsonOutput).toContain("\"TextDelta\"")
    })
  })

  describe("context persistence", () => {
    test("creates context file on first message", { timeout: 30000 }, async ({ testDir }) => {
      await Effect.runPromise(
        runCli(["chat", "-n", TEST_CONTEXT, "-m", "Hello"], { cwd: testDir })
      )

      // Context file should exist in testDir/.mini-agent/contexts/
      const contextPath = path.join(testDir, ".mini-agent", "contexts", `${TEST_CONTEXT}.yaml`)
      expect(fs.existsSync(contextPath)).toBe(true)
    })

    test("maintains conversation history across calls", { timeout: 60000 }, async ({ testDir }) => {
      // First message
      await Effect.runPromise(
        runCli(["chat", "-n", TEST_CONTEXT, "-m", "My favorite color is blue"], { cwd: testDir })
      )

      // Second message asking about the first - use raw mode to get JSON
      const result = await Effect.runPromise(
        runCli(["chat", "-n", TEST_CONTEXT, "-m", "What is my favorite color?", "--raw"], { cwd: testDir })
      )

      expect(result.exitCode).toBe(0)
      const jsonOutput = extractJsonOutput(result.stdout)
      // Response should be JSON with AssistantMessage containing "blue"
      expect(jsonOutput).toContain("\"AssistantMessage\"")
      expect(jsonOutput.toLowerCase()).toContain("blue")
    })
  })

  describe("error handling", () => {
    test("returns non-empty output on valid request", { timeout: 30000 }, async ({ testDir }) => {
      const result = await Effect.runPromise(
        runCli(["chat", "-n", TEST_CONTEXT, "-m", "Say hello"], { cwd: testDir })
      )

      // Should have some output
      expect(result.stdout.length).toBeGreaterThan(0)
    })
  })
})

describe("CLI options", () => {
  test("-n is alias for --name", async ({ testDir }) => {
    const result = await Effect.runPromise(runCli(["chat", "--help"], { cwd: testDir }))
    expect(result.stdout).toContain("-n")
    expect(result.stdout).toContain("--name")
  })

  test("-m is alias for --message", async ({ testDir }) => {
    const result = await Effect.runPromise(runCli(["chat", "--help"], { cwd: testDir }))
    expect(result.stdout).toContain("-m")
    expect(result.stdout).toContain("--message")
  })

  test("-r is alias for --raw", async ({ testDir }) => {
    const result = await Effect.runPromise(runCli(["chat", "--help"], { cwd: testDir }))
    expect(result.stdout).toContain("-r")
    expect(result.stdout).toContain("--raw")
  })

  test("-e is alias for --show-ephemeral", async ({ testDir }) => {
    const result = await Effect.runPromise(runCli(["chat", "--help"], { cwd: testDir }))
    expect(result.stdout).toContain("-e")
    expect(result.stdout).toContain("--show-ephemeral")
  })

  test("-c is alias for --config", async () => {
    const result = await Effect.runPromise(runCli(["--help"]))
    expect(result.stdout).toContain("-c")
    expect(result.stdout).toContain("--config")
  })
})

// =============================================================================
// Image Input Tests
// =============================================================================

describe("image input", () => {
  test(
    "recognizes letter in image",
    { timeout: 30000 },
    async ({ testDir }) => {
      // Path to test image: white "i" on black background
      const imagePath = path.resolve(__dirname, "fixtures/letter-i.png")

      const result = await Effect.runPromise(
        runCli(
          ["chat", "-n", "image-test", "-i", imagePath, "-m", "What letter does this image show? Respond with just the lowercase letter."],
          { cwd: testDir }
        )
      )

      // The LLM should respond with "i"
      expect(result.stdout.trim().toLowerCase()).toContain("i")
    }
  )

  test("-i is alias for --image", async () => {
    const result = await Effect.runPromise(runCli(["chat", "--help"]))
    expect(result.stdout).toContain("-i")
    expect(result.stdout).toContain("--image")
  })
})

// =============================================================================
// Logging Tests
// =============================================================================

describe("Logging", () => {
  describe("stdout log level filtering", () => {
    test("debug messages hidden at info level (default)", async ({ testDir }) => {
      const result = await Effect.runPromise(runCli(["log-test"], { cwd: testDir }))

      expect(result.stdout).toContain("LOG_TEST_DONE")
      expect(result.stdout).toContain("INFO_MESSAGE")
      expect(result.stdout).not.toContain("DEBUG_MESSAGE")
    })

    test("debug messages shown at debug level", async ({ testDir }) => {
      const result = await Effect.runPromise(
        runCli(["--stdout-log-level", "debug", "log-test"], { cwd: testDir })
      )

      expect(result.stdout).toContain("LOG_TEST_DONE")
      expect(result.stdout).toContain("DEBUG_MESSAGE")
      expect(result.stdout).toContain("INFO_MESSAGE")
    })

    test("no log messages at error level (only errors shown)", async ({ testDir }) => {
      const result = await Effect.runPromise(
        runCli(["--stdout-log-level", "error", "log-test"], { cwd: testDir })
      )

      expect(result.stdout).toContain("LOG_TEST_DONE")
      expect(result.stdout).toContain("ERROR_MESSAGE")
      expect(result.stdout).not.toContain("INFO_MESSAGE")
      expect(result.stdout).not.toContain("DEBUG_MESSAGE")
    })

    test("no log messages when stdout logging disabled", async ({ testDir }) => {
      const result = await Effect.runPromise(
        runCli(["--stdout-log-level", "none", "log-test"], { cwd: testDir })
      )

      expect(result.stdout).toContain("LOG_TEST_DONE")
      expect(result.stdout).not.toContain("INFO_MESSAGE")
      expect(result.stdout).not.toContain("DEBUG_MESSAGE")
      expect(result.stdout).not.toContain("ERROR_MESSAGE")
    })
  })

  describe("file logging", () => {
    test("creates log file with debug messages", async ({ testDir }) => {
      await Effect.runPromise(runCli(["log-test"], { cwd: testDir }))

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
