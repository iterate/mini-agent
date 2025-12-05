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
})
