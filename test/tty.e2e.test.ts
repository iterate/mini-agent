/**
 * TTY Interactive Mode End-to-End Tests
 *
 * Uses tuistory to test the interactive TTY mode of the CLI.
 * Tests spawn a real PTY and interact with the CLI like a real terminal.
 *
 * By default uses mock LLM server. Set USE_REAL_LLM=1 to use real APIs.
 *
 * NOTE: Uses describe.sequential because PTY sessions cannot run concurrently -
 * they compete for terminal resources and cause flaky failures.
 */
import { Effect } from "effect"
import { resolve } from "node:path"
import { launchTerminal } from "tuistory"
import { describe } from "vitest"

import { expect, type LlmEnv, runCli, test } from "./fixtures.ts"

const CLI_PATH = resolve(__dirname, "../src/cli/main.ts")

/** Build env for TTY session with LLM config and terminal settings */
const testEnv = (llmEnv: LlmEnv) => ({
  ...process.env,
  ...llmEnv,
  TERM: "xterm-256color"
})

describe.sequential("TTY Interactive Mode", () => {
  // ============================================
  // Config display tests
  // ============================================

  test(
    "shows LLM config and system prompt events on session start",
    { timeout: 15000 },
    async ({ llmEnv, testDir }) => {
      const session = await launchTerminal({
        command: "bun",
        args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "config-events-test"],
        cols: 100,
        rows: 30,
        env: testEnv(llmEnv)
      })

      try {
        // Should show LlmConfig event with model info
        const text = await session.waitForText("SystemPrompt", { timeout: 10000 })
        expect(text).toContain("LlmConfig")
        expect(text).toContain("mock-model")
        // Should show SystemPrompt event
        expect(text).toContain("SystemPrompt")
        expect(text).toContain("helpful assistant")
      } finally {
        await session.press(["ctrl", "c"])
        session.close()
      }
    }
  )

  // ============================================
  // UI-only tests (no LLM needed, fast)
  // ============================================

  test("shows context selection when no contexts exist", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat"],
      cols: 100,
      rows: 30,
      env: testEnv(llmEnv)
    })

    try {
      const text = await session.waitForText("No existing contexts", { timeout: 10000 })
      expect(text).toContain("No existing contexts found")
      await session.waitForText("Enter a name", { timeout: 5000 })
    } finally {
      session.close()
    }
  })

  test("exits cleanly with Ctrl+C", { timeout: 8000 }, async ({ llmEnv, testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "exit-test"],
      cols: 100,
      rows: 30,
      env: testEnv(llmEnv)
    })

    try {
      await session.waitForText("Type your message", { timeout: 5000 })
      await session.press(["ctrl", "c"])
      await new Promise((resolve) => setTimeout(resolve, 300))
    } finally {
      session.close()
    }
  })

  test("shows context name in footer", { timeout: 10000 }, async ({ llmEnv, testDir }) => {
    const agentName = "my-special-context"
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", agentName],
      cols: 100,
      rows: 30,
      env: testEnv(llmEnv)
    })

    try {
      await session.waitForText("Starting new conversation", { timeout: 5000 })
      const text = await session.waitForText(agentName, { timeout: 3000 })
      expect(text).toContain(`Agent: ${agentName}`)
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  test("empty return when idle does nothing", { timeout: 10000 }, async ({ llmEnv, testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "empty-idle-test"],
      cols: 100,
      rows: 30,
      env: testEnv(llmEnv)
    })

    try {
      await session.waitForText("Type your message", { timeout: 5000 })
      await session.press("enter")
      await new Promise((resolve) => setTimeout(resolve, 200))
      const text = await session.waitForText("empty-idle-test", { timeout: 3000 })
      expect(text).toContain("Agent: empty-idle-test")
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  // ============================================
  // Tests needing context creation (uses mock LLM)
  // ============================================

  test("shows context selector when contexts exist", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
    await Effect.runPromise(
      runCli(["chat", "-n", "existing-context", "-m", "hello"], { cwd: testDir, env: llmEnv })
    )

    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat"],
      cols: 100,
      rows: 30,
      env: testEnv(llmEnv)
    })

    try {
      const text = await session.waitForText("existing-context", { timeout: 8000 })
      expect(text).toContain("existing-context")
      expect(text).toContain("New context")
    } finally {
      session.close()
    }
  })

  test("arrow key navigation in context selector", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
    await Effect.runPromise(runCli(["chat", "-n", "context-alpha", "-m", "hello"], { cwd: testDir, env: llmEnv }))
    await Effect.runPromise(runCli(["chat", "-n", "context-beta", "-m", "hello"], { cwd: testDir, env: llmEnv }))

    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat"],
      cols: 100,
      rows: 30,
      env: testEnv(llmEnv)
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

  test("can type and send a message", { timeout: 30000 }, async ({ llmEnv, testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "test-chat"],
      cols: 100,
      rows: 30,
      env: testEnv(llmEnv)
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

  test("interrupts streaming with return key", { timeout: 30000 }, async ({ llmEnv, testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "interrupt-test"],
      cols: 100,
      rows: 30,
      env: testEnv(llmEnv)
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

  test("continues existing conversation with history display", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
    await Effect.runPromise(
      runCli(["chat", "-n", "history-test", "-m", "Say exactly: FIRST_MESSAGE_OK"], { cwd: testDir, env: llmEnv })
    )

    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "history-test"],
      cols: 100,
      rows: 30,
      env: testEnv(llmEnv)
    })

    try {
      // Verify the previous conversation content is shown (first session + new session events)
      const previousMessage = await session.waitForText("FIRST_MESSAGE_OK", { timeout: 8000 })
      expect(previousMessage).toContain("FIRST_MESSAGE_OK")
      await session.waitForText("Type your message", { timeout: 3000 })
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  test("footer shows 'Return to interrupt' during streaming", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "footer-test"],
      cols: 100,
      rows: 30,
      env: testEnv(llmEnv)
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

  test("shows 'Thinking...' before text starts streaming", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "thinking-test"],
      cols: 100,
      rows: 30,
      env: testEnv(llmEnv)
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

  test("never shows 'Invalid Date' in UI", { timeout: 15000 }, async ({ llmEnv, testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "invalid-date-test"],
      cols: 100,
      rows: 30,
      env: testEnv(llmEnv)
    })

    try {
      // Wait for UI to fully render with timestamps
      await session.waitForText("Type your message", { timeout: 8000 })
      // Give time for all lifecycle events to render
      await new Promise((resolve) => setTimeout(resolve, 500))
      const text = await session.text()
      expect(text).not.toContain("Invalid Date")
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  // TODO: This test is flaky - sometimes the enter key is not received by the TUI during streaming.
  // The interrupt mechanism works (see "interrupts streaming with return key" test), but this specific
  // test for empty-return interrupt has timing issues with tuistory terminal emulator.
  test.skip(
    "empty return during streaming cancels without new message",
    { timeout: 30000 },
    async ({ llmEnv, testDir }) => {
      const session = await launchTerminal({
        command: "bun",
        args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "empty-return-test"],
        cols: 100,
        rows: 30,
        env: testEnv(llmEnv)
      })

      try {
        await session.waitForText("Type your message", { timeout: 8000 })
        await session.type("Write a long story about dragons")
        await session.press("enter")
        await session.waitForText("Return to interrupt", { timeout: 15000 })
        await new Promise((resolve) => setTimeout(resolve, 500))
        await session.press("enter")
        // UI shows "(interrupted)" for user_cancel reason
        const text = await session.waitForText("interrupted", { timeout: 8000 })
        expect(text).toContain("interrupted")
      } finally {
        await session.press(["ctrl", "c"])
        session.close()
      }
    }
  )
})
