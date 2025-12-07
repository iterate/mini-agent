/**
 * HTTP Server End-to-End Tests
 *
 * Tests the HTTP server functionality including:
 * - Generic /context/:name endpoint
 * - LayerCode webhook endpoint
 * - Health check
 *
 * By default uses mock LLM server. Set USE_REAL_LLM=1 to use real APIs.
 */
import { Command } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { spawn } from "child_process"
import { Effect } from "effect"
import { describe } from "vitest"
import { expect, type LlmEnv, test } from "./fixtures.js"

// Resolve CLI path relative to this file
const CLI_PATH = new URL("../src/cli/main.ts", import.meta.url).pathname

/** Get a random port in ephemeral range (49152-65535) for concurrent test safety */
const getRandomPort = () => 49152 + Math.floor(Math.random() * 16383)

/** Retry a fetch request with exponential backoff */
const fetchWithRetry = async (
  url: string,
  options?: RequestInit,
  maxRetries = 3
): Promise<Response> => {
  let lastError: Error | undefined
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fetch(url, options)
    } catch (e) {
      lastError = e as Error
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)))
      }
    }
  }
  throw lastError
}

/** Start the server in background and return port + cleanup function */
const startServer = async (
  cwd: string,
  llmEnv: LlmEnv,
  subcommand: "server" | "layercode serve" = "server",
  maxRetries = 3
): Promise<{ port: number; cleanup: () => Promise<void> }> => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const port = getRandomPort()
    const args = subcommand === "server"
      ? [CLI_PATH, "--cwd", cwd, "server", "--port", String(port)]
      : [CLI_PATH, "--cwd", cwd, "layercode", "serve", "--port", String(port), "--no-tunnel"]

    const proc = spawn("bun", args, {
      cwd,
      env: {
        ...process.env,
        ...llmEnv
      },
      stdio: "ignore"
    })

    const cleanup = async () => {
      if (!proc.killed) {
        proc.kill("SIGTERM")
        // Wait for process to actually exit
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

    // Wait for server to be ready by polling health endpoint
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(`http://localhost:${port}/health`)
        if (res.ok) {
          // Small delay to ensure all routes are registered
          await new Promise((resolve) => setTimeout(resolve, 50))
          return { port, cleanup }
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    // Server didn't start on this port, cleanup and try another
    await cleanup()
  }

  throw new Error(`Server failed to start after ${maxRetries} attempts`)
}

/** Parse SSE stream from response */
const parseSSE = async (response: Response): Promise<Array<string>> => {
  const text = await response.text()
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
}

describe("HTTP Server", () => {
  describe("server command", () => {
    test("shows help with --help", async () => {
      const result = await Effect.runPromise(
        Command.make("bun", CLI_PATH, "server", "--help").pipe(
          Command.string,
          Effect.provide(BunContext.layer)
        )
      )

      expect(result).toContain("--port")
      expect(result).toContain("--host")
      expect(result).toContain("HTTP server")
    })

    test("health endpoint returns ok", { timeout: 30000 }, async ({ llmEnv, testDir }) => {
      const { cleanup, port } = await startServer(testDir, llmEnv)

      try {
        const response = await fetchWithRetry(`http://localhost:${port}/health`)
        const body = await response.json() as { status: string }

        expect(response.status).toBe(200)
        expect(body.status).toBe("ok")
      } finally {
        await cleanup()
      }
    })

    test("context endpoint processes messages", { timeout: 60000 }, async ({ llmEnv, testDir }) => {
      const { cleanup, port } = await startServer(testDir, llmEnv)

      try {
        const response = await fetchWithRetry(`http://localhost:${port}/agent/test-context`, {
          method: "POST",
          headers: { "Content-Type": "application/x-ndjson" },
          body: "{\"_tag\":\"UserMessageEvent\",\"content\":\"Say exactly: HELLO_SERVER\"}"
        })

        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/event-stream")

        const events = await parseSSE(response)
        expect(events.length).toBeGreaterThan(0)

        // Should have AssistantMessageEvent event
        const hasAssistant = events.some((e) => e.includes("\"AssistantMessageEvent\""))
        expect(hasAssistant).toBe(true)
      } finally {
        await cleanup()
      }
    })

    test("agent endpoint returns 400 for empty body", { timeout: 30000 }, async ({ llmEnv, testDir }) => {
      const { cleanup, port } = await startServer(testDir, llmEnv)

      try {
        const response = await fetchWithRetry(`http://localhost:${port}/agent/test-context`, {
          method: "POST",
          headers: { "Content-Type": "application/x-ndjson" },
          body: ""
        })

        expect(response.status).toBe(400)
      } finally {
        await cleanup()
      }
    })
  })

  describe("layercode command", () => {
    test("shows help with --help", async () => {
      const result = await Effect.runPromise(
        Command.make("bun", CLI_PATH, "layercode", "serve", "--help").pipe(
          Command.string,
          Effect.provide(BunContext.layer)
        )
      )

      expect(result).toContain("--port")
      expect(result).toContain("--welcome-message")
      expect(result).toContain("LayerCode")
    })

    test("health endpoint works with layercode serve", { timeout: 30000 }, async ({ llmEnv, testDir }) => {
      const { cleanup, port } = await startServer(testDir, llmEnv, "layercode serve")

      try {
        const response = await fetchWithRetry(`http://localhost:${port}/health`)
        const body = await response.json() as { status: string }

        expect(response.status).toBe(200)
        expect(body.status).toBe("ok")
      } finally {
        await cleanup()
      }
    })

    test("layercode webhook processes message events", { timeout: 60000 }, async ({ llmEnv, testDir }) => {
      const { cleanup, port } = await startServer(testDir, llmEnv, "layercode serve")

      try {
        const response = await fetchWithRetry(`http://localhost:${port}/layercode/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "message",
            text: "Say exactly: HELLO_LAYERCODE",
            session_id: "test-session-123",
            turn_id: "turn-1"
          })
        })

        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/event-stream")

        const events = await parseSSE(response)
        expect(events.length).toBeGreaterThan(0)

        // Should have response.tts and response.end events
        const hasTTS = events.some((e) => e.includes("\"response.tts\""))
        const hasEnd = events.some((e) => e.includes("\"response.end\""))
        expect(hasTTS).toBe(true)
        expect(hasEnd).toBe(true)
      } finally {
        await cleanup()
      }
    })

    test("layercode webhook handles session.start", { timeout: 30000 }, async ({ llmEnv, testDir }) => {
      const { cleanup, port } = await startServer(testDir, llmEnv, "layercode serve")

      try {
        const response = await fetchWithRetry(`http://localhost:${port}/layercode/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "session.start",
            session_id: "test-session-456"
          })
        })

        expect(response.status).toBe(200)

        const events = await parseSSE(response)
        // Should have response.end event at minimum
        const hasEnd = events.some((e) => e.includes("\"response.end\""))
        expect(hasEnd).toBe(true)
      } finally {
        await cleanup()
      }
    })

    test("layercode webhook handles session.end", { timeout: 30000 }, async ({ llmEnv, testDir }) => {
      const { cleanup, port } = await startServer(testDir, llmEnv, "layercode serve")

      try {
        const response = await fetchWithRetry(`http://localhost:${port}/layercode/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "session.end",
            session_id: "test-session-789"
          })
        })

        expect(response.status).toBe(200)
      } finally {
        await cleanup()
      }
    })

    test("layercode webhook returns 400 for invalid event", { timeout: 30000 }, async ({ llmEnv, testDir }) => {
      const { cleanup, port } = await startServer(testDir, llmEnv, "layercode serve")

      try {
        const response = await fetchWithRetry(`http://localhost:${port}/layercode/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "unknown_type",
            session_id: "test"
          })
        })

        expect(response.status).toBe(400)
      } finally {
        await cleanup()
      }
    })
  })
})

describe("Signature Verification", () => {
  test(
    "accepts request without signature when no secret configured",
    { timeout: 30000 },
    async ({ llmEnv, testDir }) => {
      const { cleanup, port } = await startServer(testDir, llmEnv, "layercode serve")

      try {
        // No layercode-signature header, should still work
        const response = await fetchWithRetry(`http://localhost:${port}/layercode/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "session.end",
            session_id: "test-session"
          })
        })

        expect(response.status).toBe(200)
      } finally {
        await cleanup()
      }
    }
  )
})
