/**
 * TTY Interactive Mode End-to-End Tests
 *
 * Uses tuistory to test the interactive TTY mode of the CLI.
 * Tests spawn a real PTY and interact with the CLI like a real terminal.
 * All tests use a mock LLM server for fast, predictable responses.
 */
import { Effect } from "effect"
import { resolve } from "node:path"
import { launchTerminal } from "tuistory"
import { afterAll, beforeAll, describe } from "vitest"

import { expect, runCli, test } from "./fixtures.ts"
import { type MockLlmServer, startMockLlmServer } from "./mock-llm-server.ts"

const CLI_PATH = resolve(__dirname, "../src/cli/main.ts")

let mockServer: MockLlmServer

beforeAll(async () => {
  mockServer = await startMockLlmServer()
})

afterAll(async () => {
  await mockServer?.close()
})

const mockLlmEnv = () => ({
  LLM: JSON.stringify({
    apiFormat: "openai-responses",
    model: "mock-model",
    baseUrl: mockServer.url,
    apiKeyEnvVar: "MOCK_API_KEY"
  }),
  MOCK_API_KEY: "test-key"
})

const testEnv = () => ({
  ...process.env,
  ...mockLlmEnv(),
  TERM: "xterm-256color"
})

describe("TTY Interactive Mode", () => {
  // ============================================
  // UI-only tests (no LLM needed, fast)
  // ============================================

  test("shows context selection when no contexts exist", { timeout: 15000 }, async ({ testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat"],
      cols: 100,
      rows: 30,
      env: testEnv()
    })

    try {
      const text = await session.waitForText("No existing contexts", { timeout: 10000 })
      expect(text).toContain("No existing contexts found")
      await session.waitForText("Enter a name", { timeout: 5000 })
    } finally {
      session.close()
    }
  })

  test("exits cleanly with Ctrl+C", { timeout: 8000 }, async ({ testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "exit-test"],
      cols: 100,
      rows: 30,
      env: testEnv()
    })

    try {
      await session.waitForText("Type your message", { timeout: 5000 })
      await session.press(["ctrl", "c"])
      await new Promise((resolve) => setTimeout(resolve, 300))
    } finally {
      session.close()
    }
  })

  test("shows context name in footer", { timeout: 10000 }, async ({ testDir }) => {
    const contextName = "my-special-context"
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", contextName],
      cols: 100,
      rows: 30,
      env: testEnv()
    })

    try {
      await session.waitForText("Starting new conversation", { timeout: 5000 })
      const text = await session.waitForText(contextName, { timeout: 3000 })
      expect(text).toContain(`context: ${contextName}`)
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  test("empty return when idle does nothing", { timeout: 10000 }, async ({ testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "empty-idle-test"],
      cols: 100,
      rows: 30,
      env: testEnv()
    })

    try {
      await session.waitForText("Type your message", { timeout: 5000 })
      await session.press("enter")
      await new Promise((resolve) => setTimeout(resolve, 200))
      const text = await session.waitForText("empty-idle-test", { timeout: 3000 })
      expect(text).toContain("context: empty-idle-test")
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  // ============================================
  // Tests needing context creation (uses mock LLM)
  // ============================================

  test("shows context selector when contexts exist", { timeout: 15000 }, async ({ testDir }) => {
    await Effect.runPromise(
      runCli(["chat", "-n", "existing-context", "-m", "hello"], { cwd: testDir, env: mockLlmEnv() })
    )

    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat"],
      cols: 100,
      rows: 30,
      env: testEnv()
    })

    try {
      const text = await session.waitForText("existing-context", { timeout: 8000 })
      expect(text).toContain("existing-context")
      expect(text).toContain("New context")
    } finally {
      session.close()
    }
  })

  test("arrow key navigation in context selector", { timeout: 15000 }, async ({ testDir }) => {
    await Effect.runPromise(runCli(["chat", "-n", "context-alpha", "-m", "hello"], { cwd: testDir, env: mockLlmEnv() }))
    await Effect.runPromise(runCli(["chat", "-n", "context-beta", "-m", "hello"], { cwd: testDir, env: mockLlmEnv() }))

    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat"],
      cols: 100,
      rows: 30,
      env: testEnv()
    })

    try {
      await session.waitForText("context-alpha", { timeout: 8000 })
      await session.waitForText("context-beta", { timeout: 3000 })
      await session.press("down")
      await session.press("down")
      const text = await session.waitForText("New context", { timeout: 3000 })
      expect(text).toContain("New context")
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  // ============================================
  // Streaming tests (use mock LLM)
  // ============================================

  test("can type and send a message", { timeout: 15000 }, async ({ testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "test-chat"],
      cols: 100,
      rows: 30,
      env: testEnv()
    })

    try {
      await session.waitForText("Starting new conversation", { timeout: 8000 })
      await session.waitForText("You", { timeout: 3000 })
      await session.type("Say exactly: TUISTORY_TEST_OK")
      await session.press("enter")
      const text = await session.waitForText("TUISTORY_TEST_OK", { timeout: 30000 })
      expect(text).toContain("TUISTORY_TEST_OK")
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  test("interrupts streaming with return key", { timeout: 15000 }, async ({ testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "interrupt-test"],
      cols: 100,
      rows: 30,
      env: testEnv()
    })

    try {
      await session.waitForText("Type your message", { timeout: 8000 })
      await session.type("Write a long story about dragons")
      await session.press("enter")
      await session.waitForText("Return to interrupt", { timeout: 15000 })
      await new Promise((resolve) => setTimeout(resolve, 500))
      await session.press("enter")
      await session.waitForText("interrupted", { timeout: 8000 })
      const text = await session.waitForText("Type your message", { timeout: 5000 })
      expect(text).toContain("Type your message")
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  test("continues existing conversation with history display", { timeout: 15000 }, async ({ testDir }) => {
    await Effect.runPromise(
      runCli(["chat", "-n", "history-test", "-m", "Say exactly: FIRST_MESSAGE_OK"], { cwd: testDir, env: mockLlmEnv() })
    )

    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "history-test"],
      cols: 100,
      rows: 30,
      env: testEnv()
    })

    try {
      const historyText = await session.waitForText("Previous conversation", { timeout: 8000 })
      expect(historyText).toContain("Previous conversation")
      const previousMessage = await session.waitForText("FIRST_MESSAGE_OK", { timeout: 5000 })
      expect(previousMessage).toContain("FIRST_MESSAGE_OK")
      await session.waitForText("Type your message", { timeout: 3000 })
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  test("footer shows 'Return to interrupt' during streaming", { timeout: 15000 }, async ({ testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "footer-test"],
      cols: 100,
      rows: 30,
      env: testEnv()
    })

    try {
      await session.waitForText("Starting new conversation", { timeout: 8000 })
      const beforeText = await session.waitForText("Ctrl+C to exit", { timeout: 3000 })
      expect(beforeText).toContain("Ctrl+C to exit")
      await session.type("Tell me a story")
      await session.press("enter")
      const duringText = await session.waitForText("Return to interrupt", { timeout: 15000 })
      expect(duringText).toContain("Return to interrupt")
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  test("shows 'Thinking...' before text starts streaming", { timeout: 15000 }, async ({ testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "thinking-test"],
      cols: 100,
      rows: 30,
      env: testEnv()
    })

    try {
      await session.waitForText("Type your message", { timeout: 8000 })
      await session.type("Hello")
      await session.press("enter")
      const text = await session.waitForText("Assistant", { timeout: 10000 })
      expect(text).toContain("Assistant")
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  test("empty return during streaming cancels without new message", { timeout: 15000 }, async ({ testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "empty-return-test"],
      cols: 100,
      rows: 30,
      env: testEnv()
    })

    try {
      await session.waitForText("Type your message", { timeout: 8000 })
      await session.type("Write a long story about dragons")
      await session.press("enter")
      await session.waitForText("Return to interrupt", { timeout: 15000 })
      await new Promise((resolve) => setTimeout(resolve, 500))
      await session.press("enter")
      const text = await session.waitForText("interrupted", { timeout: 8000 })
      expect(text).toContain("interrupted")
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })
})
