/**
 * TTY Interactive Mode End-to-End Tests
 *
 * Uses tuistory to test the interactive TTY mode of the CLI.
 * These tests spawn a real PTY and interact with the CLI like a real terminal.
 */
import { Effect } from "effect"
import { resolve } from "node:path"
import { launchTerminal } from "tuistory"
import { describe } from "vitest"

import { expect, runCli, test } from "./fixtures.ts"

const CLI_PATH = resolve(__dirname, "../src/main.ts")

describe("TTY Interactive Mode", () => {
  test("shows context selection when no contexts exist", { timeout: 15000 }, async ({ testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat"],
      cols: 100,
      rows: 30,
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-key",
        TERM: "xterm-256color"
      }
    })

    try {
      // Wait for the "No existing contexts found" message
      const text = await session.waitForText("No existing contexts", { timeout: 10000 })
      expect(text).toContain("No existing contexts found")

      // Should prompt for new context name
      await session.waitForText("Enter a name", { timeout: 5000 })
    } finally {
      session.close()
    }
  })

  test("shows context selector when contexts exist", { timeout: 30000 }, async ({ testDir }) => {
    // First, create a context by sending a message in single-turn mode
    await Effect.runPromise(
      runCli(["chat", "-n", "existing-context", "-m", "hello"], { cwd: testDir })
    )

    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat"],
      cols: 100,
      rows: 30,
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-key",
        TERM: "xterm-256color"
      }
    })

    try {
      // Should show the context selector with the existing context
      const text = await session.waitForText("existing-context", { timeout: 10000 })
      expect(text).toContain("existing-context")
      expect(text).toContain("New context")
    } finally {
      session.close()
    }
  })

  test("can type and send a message", { timeout: 60000 }, async ({ testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "test-chat"],
      cols: 100,
      rows: 30,
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-key",
        TERM: "xterm-256color"
      }
    })

    try {
      // Wait for the conversation prompt
      await session.waitForText("Starting new conversation", { timeout: 10000 })

      // Wait for the "You" prompt (input prompt)
      await session.waitForText("You", { timeout: 5000 })

      // Type a message asking for a specific response
      await session.type("Say exactly: TUISTORY_TEST_OK")
      await session.press("enter")

      // Wait for the LLM response containing our requested text
      const text = await session.waitForText("TUISTORY_TEST_OK", { timeout: 45000 })
      expect(text).toContain("TUISTORY_TEST_OK")
    } finally {
      // Exit with Ctrl+C and close
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  test("displays Goodbye on exit", { timeout: 30000 }, async ({ testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "exit-test"],
      cols: 100,
      rows: 30,
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-key",
        TERM: "xterm-256color"
      }
    })

    try {
      // Wait for the conversation to start
      await session.waitForText("Starting new conversation", { timeout: 10000 })

      // Exit with Ctrl+C
      await session.press(["ctrl", "c"])

      // Should show goodbye message
      const text = await session.waitForText("Goodbye", { timeout: 5000 })
      expect(text).toContain("Goodbye")
    } finally {
      session.close()
    }
  })

  test("interrupts streaming with return key", { timeout: 60000 }, async ({ testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "interrupt-test"],
      cols: 100,
      rows: 30,
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-key",
        TERM: "xterm-256color"
      }
    })

    try {
      await session.waitForText("Starting new conversation", { timeout: 10000 })
      await session.waitForText("You", { timeout: 5000 })

      // Ask for a long response so we have time to interrupt
      await session.type("Write a very long essay about artificial intelligence history")
      await session.press("enter")

      // Wait for streaming to start (Thinking... or actual text)
      await session.waitForText("Assistant", { timeout: 15000 })

      // Interrupt with return key (empty return during streaming = cancel)
      await session.press("enter")

      // Should show interrupted marker
      const text = await session.waitForText("interrupted", { timeout: 10000 })
      expect(text).toContain("interrupted")
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  test("continues existing conversation with history display", { timeout: 60000 }, async ({ testDir }) => {
    // First, create a context with a conversation
    await Effect.runPromise(
      runCli(["chat", "-n", "history-test", "-m", "Say exactly: FIRST_MESSAGE_OK"], { cwd: testDir })
    )

    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "history-test"],
      cols: 100,
      rows: 30,
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-key",
        TERM: "xterm-256color"
      }
    })

    try {
      // Should show "Previous conversation" header
      const historyText = await session.waitForText("Previous conversation", { timeout: 10000 })
      expect(historyText).toContain("Previous conversation")

      // Should show the previous message from history
      const previousMessage = await session.waitForText("FIRST_MESSAGE_OK", { timeout: 5000 })
      expect(previousMessage).toContain("FIRST_MESSAGE_OK")

      // Should be ready for new input
      await session.waitForText("Type your message", { timeout: 5000 })
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  test("shows context name in footer", { timeout: 30000 }, async ({ testDir }) => {
    const contextName = "my-special-context"
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", contextName],
      cols: 100,
      rows: 30,
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-key",
        TERM: "xterm-256color"
      }
    })

    try {
      await session.waitForText("Starting new conversation", { timeout: 10000 })

      // Footer should display the context name
      const text = await session.waitForText(contextName, { timeout: 5000 })
      expect(text).toContain(`context: ${contextName}`)
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  test("footer shows 'Return to interrupt' during streaming", { timeout: 60000 }, async ({ testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "footer-test"],
      cols: 100,
      rows: 30,
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-key",
        TERM: "xterm-256color"
      }
    })

    try {
      await session.waitForText("Starting new conversation", { timeout: 10000 })

      // Before sending, should show "Return to exit"
      const beforeText = await session.waitForText("Return to exit", { timeout: 5000 })
      expect(beforeText).toContain("Return to exit")

      await session.type("Tell me a story")
      await session.press("enter")

      // During streaming, should show "Return to interrupt"
      const duringText = await session.waitForText("Return to interrupt", { timeout: 15000 })
      expect(duringText).toContain("Return to interrupt")
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  test("shows 'Thinking...' before text starts streaming", { timeout: 60000 }, async ({ testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "thinking-test"],
      cols: 100,
      rows: 30,
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-key",
        TERM: "xterm-256color"
      }
    })

    try {
      await session.waitForText("Starting new conversation", { timeout: 10000 })
      await session.waitForText("You", { timeout: 5000 })

      await session.type("Hello")
      await session.press("enter")

      // Should show "Thinking..." while waiting for first token
      const text = await session.waitForText("Thinking", { timeout: 10000 })
      expect(text).toContain("Thinking")
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  test("arrow key navigation in context selector", { timeout: 30000 }, async ({ testDir }) => {
    // Create multiple contexts
    await Effect.runPromise(
      runCli(["chat", "-n", "context-alpha", "-m", "hello"], { cwd: testDir })
    )
    await Effect.runPromise(
      runCli(["chat", "-n", "context-beta", "-m", "hello"], { cwd: testDir })
    )

    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat"],
      cols: 100,
      rows: 30,
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-key",
        TERM: "xterm-256color"
      }
    })

    try {
      // Wait for selector to appear with both contexts
      await session.waitForText("context-alpha", { timeout: 10000 })
      await session.waitForText("context-beta", { timeout: 5000 })

      // Navigate with arrow keys (should move highlight)
      await session.press("down")
      await session.press("down")

      // Selector should still be visible (we're navigating, not selecting yet)
      const text = await session.waitForText("New context", { timeout: 5000 })
      expect(text).toContain("New context")
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })

  test("empty return during streaming cancels without new message", { timeout: 60000 }, async ({ testDir }) => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI_PATH, "--cwd", testDir, "chat", "-n", "empty-return-test"],
      cols: 100,
      rows: 30,
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-key",
        TERM: "xterm-256color"
      }
    })

    try {
      await session.waitForText("Starting new conversation", { timeout: 10000 })
      await session.waitForText("You", { timeout: 5000 })

      await session.type("Write a long story about dragons")
      await session.press("enter")

      // Wait for streaming to start
      await session.waitForText("Assistant", { timeout: 15000 })

      // Hit return with no text (empty interrupt = cancel, no follow-up)
      await session.press("enter")

      // Should show interrupted and still be in chat (not exited)
      await session.waitForText("interrupted", { timeout: 10000 })

      // Should be ready for more input (still in the chat loop)
      const text = await session.waitForText("Type your message", { timeout: 5000 })
      expect(text).toContain("Type your message")
    } finally {
      await session.press(["ctrl", "c"])
      session.close()
    }
  })
})
