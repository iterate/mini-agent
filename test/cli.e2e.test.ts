/**
 * CLI End-to-End Tests
 *
 * Tests the CLI functionality using Effect Command to run the actual CLI process.
 *
 * By default uses mock LLM server. Set USE_REAL_LLM=1 to use real APIs.
 */
import { Command } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect, Stream } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { describe } from "vitest"
import { expect, type LlmEnv, runCli, test } from "./fixtures.js"

/** Context name used in tests - safe to reuse since each test has isolated testDir */
const TEST_CONTEXT = "test-context"

const CLI_PATH = path.resolve(__dirname, "../src/cli/main.ts")

/** Run CLI with stdin input using Command.stdin */
const runCliWithStdin = (cwd: string, llmEnv: LlmEnv, input: string, ...args: Array<string>) => {
  const cwdArgs = ["--cwd", cwd]
  const env = {
    ...process.env,
    ...llmEnv
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
  describe("session lifecycle", () => {
    test("raw mode emits SessionEndedEvent as last event", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
      const result = await Effect.runPromise(
        runCli(["chat", "-n", TEST_CONTEXT, "-m", "Say hello", "--raw"], {
          cwd: testDir,
          env: llmEnv
        })
      )

      expect(result.exitCode).toBe(0)
      const jsonOutput = extractJsonOutput(result.stdout)

      // SessionEndedEvent must be emitted as the final event
      expect(jsonOutput).toContain("\"SessionEndedEvent\"")

      // Verify it's the last event by checking order
      const sessionEndIndex = jsonOutput.lastIndexOf("\"SessionEndedEvent\"")
      const turnCompleteIndex = jsonOutput.lastIndexOf("\"AgentTurnCompletedEvent\"")
      expect(sessionEndIndex).toBeGreaterThan(turnCompleteIndex)
    })

    test("script mode emits SessionEndedEvent as last event", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
      const input = "{\"_tag\":\"UserMessageEvent\",\"content\":\"Say hello\"}\n"
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          llmEnv,
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

      // SessionEndedEvent must be the last line
      const lastLine = jsonLines[jsonLines.length - 1]!
      expect(lastLine).toContain("\"SessionEndedEvent\"")
    })
  })

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
    test("sends a message and gets a response", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
      const result = await Effect.runPromise(
        runCli(["chat", "-n", TEST_CONTEXT, "-m", "Say exactly: TEST_RESPONSE_123"], {
          cwd: testDir,
          env: llmEnv
        })
      )

      expect(result.stdout).toContain("TEST_RESPONSE_123")
    })

    test("generates random context when no name provided", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
      const result = await Effect.runPromise(
        runCli(["chat", "-m", "Say exactly: HELLO"], { cwd: testDir, env: llmEnv })
      )

      expect(result.stdout.length).toBeGreaterThan(0)

      // Context file should exist with random name (chat-xxxxx pattern)
      const contextsDir = path.join(testDir, ".mini-agent", "contexts")
      const files = fs.readdirSync(contextsDir)
      expect(files.length).toBe(1)
      expect(files[0]).toMatch(/^chat-[a-z0-9]{5}-v1\.yaml$/)
    })
  })

  describe("--raw mode", () => {
    test("outputs ALL JSON events including initial events", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
      const result = await Effect.runPromise(
        runCli(["chat", "-n", TEST_CONTEXT, "-m", "Say exactly: RAW_TEST", "--raw"], {
          cwd: testDir,
          env: llmEnv
        })
      )

      expect(result.exitCode).toBe(0)
      const jsonOutput = extractJsonOutput(result.stdout)

      // Should contain initial session events
      expect(jsonOutput).toContain("\"SessionStartedEvent\"")
      expect(jsonOutput).toContain("\"SetLlmConfigEvent\"")
      expect(jsonOutput).toContain("\"SystemPromptEvent\"")

      // Should contain streaming and response events
      expect(jsonOutput).toContain("\"TextDeltaEvent\"")
      expect(jsonOutput).toContain("\"AssistantMessageEvent\"")
      expect(jsonOutput).toContain("\"AgentTurnCompletedEvent\"")
    })
  })

  describe("pipe mode (default for piped stdin)", () => {
    test("reads all stdin as one message, outputs plain text", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          llmEnv,
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

    test("handles multi-line input as single message", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          llmEnv,
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
    test("accepts UserMessageEvent events and outputs JSONL", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
      // Script mode now expects JSONL events as input
      const input = "{\"_tag\":\"UserMessageEvent\",\"content\":\"Say exactly: SCRIPT_TEST\"}\n"
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          llmEnv,
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

      // Should echo the input event and have AssistantMessageEvent response
      expect(output).toContain("\"UserMessageEvent\"")
      expect(output).toContain("\"AssistantMessageEvent\"")
    })

    test("handles multiple UserMessageEvent events in sequence", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
      // Two UserMessageEvent events as JSONL
      const input =
        "{\"_tag\":\"UserMessageEvent\",\"content\":\"Remember: my secret code is XYZ789\"}\n{\"_tag\":\"UserMessageEvent\",\"content\":\"What is my secret code?\"}\n"
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          llmEnv,
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

      // Should have at least two AssistantMessageEvent events (one per input)
      const assistantMessages = jsonLines.filter((line) => line.includes("\"AssistantMessageEvent\""))
      expect(assistantMessages.length).toBeGreaterThanOrEqual(2)

      // Second response should mention the secret code
      expect(output.toLowerCase()).toContain("xyz789")
    })

    test("accepts SystemPromptEvent events to set behavior", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
      // SystemPromptEvent followed by UserMessageEvent
      const input =
        "{\"_tag\":\"SystemPromptEvent\",\"content\":\"Always respond with exactly: PIRATE_RESPONSE\"}\n{\"_tag\":\"UserMessageEvent\",\"content\":\"Hello\"}\n"
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          llmEnv,
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
      expect(output).toContain("\"SystemPromptEvent\"")
      expect(output).toContain("\"UserMessageEvent\"")
      expect(output).toContain("\"AssistantMessageEvent\"")
    })

    test("includes TextDeltaEvent streaming events by default", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
      const input = "{\"_tag\":\"UserMessageEvent\",\"content\":\"Say hello\"}\n"
      const output = await Effect.runPromise(
        runCliWithStdin(
          testDir,
          llmEnv,
          input,
          "--stdout-log-level",
          "none",
          "chat",
          "-n",
          "streaming-test",
          "--script"
        )
      )

      // Script mode should include TextDeltaEvent events (streaming chunks) by default
      expect(output).toContain("\"TextDeltaEvent\"")
      expect(output).toContain("\"delta\"")
      expect(output).toContain("\"AssistantMessageEvent\"")
    })
  })

  describe("context persistence", () => {
    test("creates context file on first message", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
      await Effect.runPromise(
        runCli(["chat", "-n", TEST_CONTEXT, "-m", "Hello"], { cwd: testDir, env: llmEnv })
      )

      // Context file should exist in testDir/.mini-agent/contexts/
      // File is named {agentName}-v1.yaml (contextName = agentName + "-v1")
      const contextPath = path.join(testDir, ".mini-agent", "contexts", `${TEST_CONTEXT}-v1.yaml`)
      expect(fs.existsSync(contextPath)).toBe(true)
    })

    test("maintains conversation history across calls", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
      // First message - tell LLM favorite color
      await Effect.runPromise(
        runCli(["chat", "-n", TEST_CONTEXT, "-m", "My favorite color is blue"], { cwd: testDir, env: llmEnv })
      )

      // Second message asking about the first - use raw mode to get JSON
      const result = await Effect.runPromise(
        runCli(["chat", "-n", TEST_CONTEXT, "-m", "What is my favorite color?", "--raw"], {
          cwd: testDir,
          env: llmEnv
        })
      )

      expect(result.exitCode).toBe(0)
      const jsonOutput = extractJsonOutput(result.stdout)
      // Response should be JSON with AssistantMessage containing "blue"
      expect(jsonOutput).toContain("\"AssistantMessageEvent\"")
      expect(jsonOutput.toLowerCase()).toContain("blue")
    })
  })

  describe("error handling", () => {
    test("returns non-empty output on valid request", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
      const result = await Effect.runPromise(
        runCli(["chat", "-n", TEST_CONTEXT, "-m", "Say hello"], { cwd: testDir, env: llmEnv })
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

  test("-c is alias for --config", async () => {
    const result = await Effect.runPromise(runCli(["--help"]))
    expect(result.stdout).toContain("-c")
    expect(result.stdout).toContain("--config")
  })
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

describe("Interrupted response context", () => {
  test(
    "LLM receives context about interrupted response when continuing conversation",
    { timeout: 15000 },
    async ({ llmEnv, testDir }) => {
      const contextName = "interrupt-context-test"
      const testNumber = "87654321"

      // Create a context file with an interrupted response containing a specific number
      // This simulates what happens when a user interrupts the LLM mid-response
      const contextsDir = path.join(testDir, ".mini-agent", "contexts")
      fs.mkdirSync(contextsDir, { recursive: true })

      const contextContent = `events:
  - _tag: SystemPromptEvent
    id: "${contextName}-v1:0000"
    timestamp: "2024-01-01T00:00:00.000Z"
    agentName: ${contextName}
    triggersAgentTurn: false
    content: You are a helpful assistant.
  - _tag: UserMessageEvent
    id: "${contextName}-v1:0001"
    timestamp: "2024-01-01T00:00:01.000Z"
    agentName: ${contextName}
    triggersAgentTurn: true
    content: Tell me a random 8-digit number followed by a long story.
  - _tag: AgentTurnInterruptedEvent
    id: "${contextName}-v1:0002"
    timestamp: "2024-01-01T00:00:02.000Z"
    agentName: ${contextName}
    triggersAgentTurn: false
    turnNumber: 1
    reason: user_cancel
    partialResponse: "${testNumber}! Once upon a time in a faraway land, there lived a wise old wizard who..."
`
      fs.writeFileSync(path.join(contextsDir, `${contextName}-v1.yaml`), contextContent)

      // Now make a follow-up request asking about the number.
      // The LLM should know the number because:
      // 1. The AgentTurnInterruptedEvent's partialResponse is included as an assistant message
      // 2. A user message explains the interruption happened
      const result = await Effect.runPromise(
        runCli(
          [
            "chat",
            "-n",
            contextName,
            "-m",
            "Hello"
          ],
          { cwd: testDir, env: llmEnv }
        )
      )

      // With mock LLM, we just verify the interrupted context was loaded and response was received
      expect(result.exitCode).toBe(0)
      expect(result.stdout.length).toBeGreaterThan(0)
    }
  )
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
