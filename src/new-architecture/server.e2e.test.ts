/**
 * Server E2E Tests for new architecture.
 *
 * Tests the HTTP server functionality.
 */
import { spawn } from "child_process"
import * as path from "node:path"
import { describe } from "vitest"
import { expect, test } from "../../test/fixtures.js"

const SERVER_PATH = path.resolve(__dirname, "./server.ts")

// Port counter to avoid conflicts
let portCounter = 5000 + Math.floor(Math.random() * 1000)
const getNextPort = () => portCounter++

/** Start the server in background */
const startServer = async (
  cwd: string
): Promise<{ port: number; cleanup: () => Promise<void> }> => {
  const port = getNextPort()

  const proc = spawn("bun", [SERVER_PATH, "--port", String(port)], {
    cwd,
    env: {
      ...process.env,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-api-key"
    },
    stdio: "ignore"
  })

  const cleanup = async () => {
    if (!proc.killed) {
      proc.kill("SIGTERM")
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          proc.kill("SIGKILL")
          resolve()
        }, 2000)
        proc.on("exit", () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }
  }

  // Wait for server to be ready
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/health`)
      if (res.ok) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return { port, cleanup }
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  await cleanup()
  throw new Error(`Server failed to start on port ${port}`)
}

/** Parse SSE stream from response */
const parseSSE = async (response: Response): Promise<Array<string>> => {
  const text = await response.text()
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
}

describe("New Architecture Server", () => {
  test("health endpoint returns ok", { timeout: 30000 }, async ({ testDir }) => {
    const { cleanup, port } = await startServer(testDir)

    try {
      const response = await fetch(`http://localhost:${port}/health`)
      const body = (await response.json()) as { status: string }

      expect(response.status).toBe(200)
      expect(body.status).toBe("ok")
    } finally {
      await cleanup()
    }
  })

  test("agent endpoint processes message", { timeout: 60000 }, async ({ testDir }) => {
    const { cleanup, port } = await startServer(testDir)

    try {
      const response = await fetch(`http://localhost:${port}/agent/test-agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _tag: "UserMessage", content: "Say exactly: HELLO_V2" })
      })

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")

      const events = await parseSSE(response)
      expect(events.length).toBeGreaterThan(0)

      // Should have AssistantMessageEvent
      const hasAssistant = events.some((e) => e.includes("\"AssistantMessageEvent\""))
      expect(hasAssistant).toBe(true)
    } finally {
      await cleanup()
    }
  })

  test("agent endpoint returns 400 for empty body", { timeout: 30000 }, async ({ testDir }) => {
    const { cleanup, port } = await startServer(testDir)

    try {
      const response = await fetch(`http://localhost:${port}/agent/test-agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: ""
      })

      expect(response.status).toBe(400)
    } finally {
      await cleanup()
    }
  })

  test("agent endpoint returns 400 for invalid JSON", { timeout: 30000 }, async ({ testDir }) => {
    const { cleanup, port } = await startServer(testDir)

    try {
      const response = await fetch(`http://localhost:${port}/agent/test-agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json"
      })

      expect(response.status).toBe(400)
    } finally {
      await cleanup()
    }
  })

  test("maintains conversation history across requests", { timeout: 90000 }, async ({ testDir }) => {
    const { cleanup, port } = await startServer(testDir)

    try {
      // First message
      await fetch(`http://localhost:${port}/agent/history-agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _tag: "UserMessage", content: "Remember: my code is XYZ789" })
      })

      // Second message
      const response = await fetch(`http://localhost:${port}/agent/history-agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _tag: "UserMessage", content: "What is my code?" })
      })

      const events = await parseSSE(response)
      const fullResponse = events.join("")

      expect(fullResponse.toLowerCase()).toContain("xyz789")
    } finally {
      await cleanup()
    }
  })
})
