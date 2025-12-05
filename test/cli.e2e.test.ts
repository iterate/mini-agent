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
import { expect, runCli, runCliWithEnv, test } from "./fixtures.js"

const llms = [
  { llm: "openai:gpt-4.1-mini" },
  { llm: "anthropic:claude-haiku-4-5" },
  { llm: "gemini:gemini-2.5-flash" }
] as const

/** Context name used in tests - safe to reuse since each test has isolated testDir */
const TEST_CONTEXT = "test-context"

const CLI_PATH = path.resolve(__dirname, "../src/main.ts")

/** Run CLI with stdin input using Command.stdin */
const runCliWithStdin = (cwd: string, input: string, ...args: Array<string>) => {
  const cwdArgs = ["--cwd", cwd]
  const env = {
    ...process.env,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-api-key"
  }

  return Command.make("bun", CLI_PATH, ...cwdArgs, ...args).pipe(
    Command.stdin(Stream.make(Buffer.from(input, "utf-8"))),
    Command.env(env),
    Command.string,
    Effect.provide(BunContext.layer)
  )
}

/** Extract JSON objects from CLI response that contain _tag field (event objects) */
const extractJsonOutput = (output: string): string => {
  // Find all complete JSON objects with balanced braces
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

/** Extract JSONL lines from CLI response (strips log messages) */
const extractJsonLines = (output: string): Array<string> => {
  // JSONL format: each line is a complete JSON object
  return output
    .split("\n")
    .filter((line) => line.trim().startsWith("{") && line.includes("\"_tag\""))
}

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

    test("generates random context when no name provided", { timeout: 30000 }, async ({ testDir }) => {
      const result = await Effect.runPromise(
        runCli(["chat", "-m", "Say exactly: HELLO"], { cwd: testDir })
      )

      expect(result.stdout.length).toBeGreaterThan(0)

      // Context file should exist with random name (chat-xxxxx pattern)
      const contextsDir = path.join(testDir, ".mini-agent", "contexts")
      const files = fs.readdirSync(contextsDir)
      expect(files.length).toBe(1)
      expect(files[0]).toMatch(/^chat-[a-z0-9]{5}\.yaml$/)
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

  describe("pipe mode (default for piped stdin)", () => {
    test("reads all stdin as one message, outputs plain text", { timeout: 30000 }, async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          "Say exactly: PIPE_TEST",
          "--stdout-log-level",
          "none",
          "chat",
          "-n",
          TEST_CONTEXT
        )
      )

      // Should output plain text, not JSONL
      expect(output.length).toBeGreaterThan(0)
      // Output should NOT be JSON (pipe mode outputs plain text)
      const jsonLines = extractJsonLines(output)
      expect(jsonLines.length).toBe(0)
    })

    test("handles multi-line input as single message", { timeout: 30000 }, async ({ testDir }) => {
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          "Line 1: Hello\nLine 2: World\nLine 3: Test",
          "--stdout-log-level",
          "none",
          "chat",
          "-n",
          TEST_CONTEXT
        )
      )

      // All lines treated as one message, plain text output
      expect(output.length).toBeGreaterThan(0)
    })
  })

  describe("script mode (--script)", () => {
    test("accepts UserMessage events and outputs JSONL", { timeout: 30000 }, async ({ testDir }) => {
      // Script mode now expects JSONL events as input
      const input = "{\"_tag\":\"UserMessage\",\"content\":\"Say exactly: SCRIPT_TEST\"}\n"
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          input,
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

      // Should echo the input event and have AssistantMessage response
      expect(output).toContain("\"UserMessage\"")
      expect(output).toContain("\"AssistantMessage\"")
    })

    test("handles multiple UserMessage events in sequence", { timeout: 120000 }, async ({ testDir }) => {
      // Two UserMessage events as JSONL
      const input =
        "{\"_tag\":\"UserMessage\",\"content\":\"Remember: my secret code is XYZ789\"}\n{\"_tag\":\"UserMessage\",\"content\":\"What is my secret code?\"}\n"
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          input,
          "--stdout-log-level",
          "none",
          "chat",
          "-n",
          "multi-test",
          "--script"
        )
      )

      const jsonLines = extractJsonLines(output)

      // Should have at least two AssistantMessage events (one per input)
      const assistantMessages = jsonLines.filter((line) => line.includes("\"AssistantMessage\""))
      expect(assistantMessages.length).toBeGreaterThanOrEqual(2)

      // Second response should mention the secret code
      expect(output.toLowerCase()).toContain("xyz789")
    })

    test("accepts SystemPrompt events to set behavior", { timeout: 30000 }, async ({ testDir }) => {
      // SystemPrompt followed by UserMessage
      const input =
        "{\"_tag\":\"SystemPrompt\",\"content\":\"Always respond with exactly: PIRATE_RESPONSE\"}\n{\"_tag\":\"UserMessage\",\"content\":\"Hello\"}\n"
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          input,
          "--stdout-log-level",
          "none",
          "chat",
          "-n",
          "pirate-test",
          "--script"
        )
      )

      const jsonLines = extractJsonLines(output)
      expect(jsonLines.length).toBeGreaterThan(0)

      // Should echo both events
      expect(output).toContain("\"SystemPrompt\"")
      expect(output).toContain("\"UserMessage\"")
      expect(output).toContain("\"AssistantMessage\"")
    })

    test("includes TextDelta streaming events by default", { timeout: 30000 }, async ({ testDir }) => {
      const input = "{\"_tag\":\"UserMessage\",\"content\":\"Say hello\"}\n"
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          input,
          "--stdout-log-level",
          "none",
          "chat",
          "-n",
          "streaming-test",
          "--script"
        )
      )

      // Script mode should include TextDelta events (streaming chunks) by default
      expect(output).toContain("\"TextDelta\"")
      expect(output).toContain("\"delta\"")
      expect(output).toContain("\"AssistantMessage\"")
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

describe.each(llms)("LLM: $llm", ({ llm }) => {
  test(
    "basic chat works",
    { timeout: 30000 },
    async ({ testDir }) => {
      const result = await Effect.runPromise(
        runCliWithEnv(testDir, { LLM: llm }, "chat", "-n", "test", "-m", "Say exactly: TEST_SUCCESS")
      )
      expect(result.stdout.length).toBeGreaterThan(0)
      expect(result.exitCode).toBe(0)
    }
  )

  test(
    "recognizes letter in image",
    { timeout: 30000 },
    async ({ testDir }) => {
      // Path to test image: white "i" on black background
      const imagePath = path.resolve(__dirname, "fixtures/letter-i.png")

      const result = await Effect.runPromise(
        runCliWithEnv(
          testDir,
          { LLM: llm },
          "chat",
          "-n",
          "image-test",
          "-i",
          imagePath,
          "-m",
          "What letter does this image show? Respond with just the lowercase letter."
        )
      )

      expect(result.stdout.trim().toLowerCase()).toEqual("i")
      expect(result.exitCode).toBe(0)
    }
  )
})

describe("CLI option aliases", () => {
  test("-i is alias for --image", async () => {
    const result = await Effect.runPromise(runCli(["chat", "--help"]))
    expect(result.stdout).toContain("-i")
    expect(result.stdout).toContain("--image")
  })

  test("-s is alias for --script", async () => {
    const result = await Effect.runPromise(runCli(["chat", "--help"]))
    expect(result.stdout).toContain("-s")
    expect(result.stdout).toContain("--script")
  })
})

describe("Logging", () => {
  describe("stdout log level filtering", () => {
    test("info and debug messages hidden at warn level (default)", async ({ testDir }) => {
      const result = await Effect.runPromise(runCli(["log-test"], { cwd: testDir }))

      expect(result.stdout).toContain("LOG_TEST_DONE")
      expect(result.stdout).toContain("WARN_MESSAGE")
      expect(result.stdout).toContain("ERROR_MESSAGE")
      expect(result.stdout).not.toContain("INFO_MESSAGE")
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

      // File logger should capture DEBUG even when stdout is WARN
      expect(logContent).toContain("DEBUG_MESSAGE")
      expect(logContent).toContain("INFO_MESSAGE")
    })
  })
})
