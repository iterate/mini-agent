/**
 * HTTP Server End-to-End Tests
 *
 * Tests the HTTP server functionality including:
 * - Generic /context/:name endpoint
 * - LayerCode webhook endpoint
 * - Health check
 */
import { Command } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { type ChildProcess, spawn } from "child_process"
import { Effect } from "effect"
import { describe } from "vitest"
import { expect, test } from "./fixtures.js"

// Resolve CLI path relative to this file
const CLI_PATH = new URL("../src/cli/main.ts", import.meta.url).pathname

/** Start the server in background */
const startServer = async (
  cwd: string,
  port: number,
  subcommand: "serve" | "layercode serve" = "serve"
): Promise<ChildProcess> => {
  const args = subcommand === "serve"
    ? [CLI_PATH, "--cwd", cwd, "serve", "--port", String(port)]
    : [CLI_PATH, "--cwd", cwd, "layercode", "serve", "--port", String(port), "--no-tunnel"]

  const proc = spawn("bun", args, {
    cwd,
    env: {
      ...process.env,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-api-key"
    },
    stdio: "ignore"
  })

  // Wait for server to be ready by polling health endpoint
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/health`)
      if (res.ok) return proc
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  proc.kill()
  throw new Error(`Server failed to start on port ${port} after 10 seconds`)
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
  describe("serve command", () => {
    test("shows help with --help", async () => {
      const result = await Effect.runPromise(
        Command.make("bun", CLI_PATH, "serve", "--help").pipe(
          Command.string,
          Effect.provide(BunContext.layer)
        )
      )

      expect(result).toContain("--port")
      expect(result).toContain("--host")
      expect(result).toContain("HTTP server")
    })

    test("health endpoint returns ok", { timeout: 30000 }, async ({ testDir }) => {
      const port = 3100 + Math.floor(Math.random() * 100)
      const proc = await startServer(testDir, port)

      try {
        const response = await fetch(`http://localhost:${port}/health`)
        const body = await response.json() as { status: string }

        expect(response.status).toBe(200)
        expect(body.status).toBe("ok")
      } finally {
        proc.kill()
      }
    })

    test("context endpoint processes messages", { timeout: 60000 }, async ({ testDir }) => {
      const port = 3200 + Math.floor(Math.random() * 100)
      const proc = await startServer(testDir, port)

      try {
        const response = await fetch(`http://localhost:${port}/context/test-context`, {
          method: "POST",
          headers: { "Content-Type": "application/x-ndjson" },
          body: "{\"_tag\":\"UserMessage\",\"content\":\"Say exactly: HELLO_SERVER\"}"
        })

        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/event-stream")

        const events = await parseSSE(response)
        expect(events.length).toBeGreaterThan(0)

        // Should have AssistantMessage event
        const hasAssistant = events.some((e) => e.includes("\"AssistantMessage\""))
        expect(hasAssistant).toBe(true)
      } finally {
        proc.kill()
      }
    })

    test("context endpoint returns 400 for empty body", { timeout: 30000 }, async ({ testDir }) => {
      const port = 3300 + Math.floor(Math.random() * 100)
      const proc = await startServer(testDir, port)

      try {
        const response = await fetch(`http://localhost:${port}/context/test-context`, {
          method: "POST",
          headers: { "Content-Type": "application/x-ndjson" },
          body: ""
        })

        expect(response.status).toBe(400)
      } finally {
        proc.kill()
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

    test("health endpoint works with layercode serve", { timeout: 30000 }, async ({ testDir }) => {
      const port = 3400 + Math.floor(Math.random() * 100)
      const proc = await startServer(testDir, port, "layercode serve")

      try {
        const response = await fetch(`http://localhost:${port}/health`)
        const body = await response.json() as { status: string }

        expect(response.status).toBe(200)
        expect(body.status).toBe("ok")
      } finally {
        proc.kill()
      }
    })

    test("layercode webhook processes message events", { timeout: 60000 }, async ({ testDir }) => {
      const port = 3500 + Math.floor(Math.random() * 100)
      const proc = await startServer(testDir, port, "layercode serve")

      try {
        const response = await fetch(`http://localhost:${port}/layercode/webhook`, {
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
        proc.kill()
      }
    })

    test("layercode webhook handles session.start", { timeout: 30000 }, async ({ testDir }) => {
      const port = 3600 + Math.floor(Math.random() * 100)
      const proc = await startServer(testDir, port, "layercode serve")

      try {
        const response = await fetch(`http://localhost:${port}/layercode/webhook`, {
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
        proc.kill()
      }
    })

    test("layercode webhook handles session.end", { timeout: 30000 }, async ({ testDir }) => {
      const port = 3700 + Math.floor(Math.random() * 100)
      const proc = await startServer(testDir, port, "layercode serve")

      try {
        const response = await fetch(`http://localhost:${port}/layercode/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "session.end",
            session_id: "test-session-789"
          })
        })

        expect(response.status).toBe(200)
      } finally {
        proc.kill()
      }
    })

    test("layercode webhook returns 400 for invalid event", { timeout: 30000 }, async ({ testDir }) => {
      const port = 3800 + Math.floor(Math.random() * 100)
      const proc = await startServer(testDir, port, "layercode serve")

      try {
        const response = await fetch(`http://localhost:${port}/layercode/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "unknown_type",
            session_id: "test"
          })
        })

        expect(response.status).toBe(400)
      } finally {
        proc.kill()
      }
    })
  })
})

describe("Signature Verification", () => {
  test("accepts request without signature when no secret configured", { timeout: 30000 }, async ({ testDir }) => {
    const port = 3900 + Math.floor(Math.random() * 100)
    const proc = await startServer(testDir, port, "layercode serve")

    try {
      // No layercode-signature header, should still work
      const response = await fetch(`http://localhost:${port}/layercode/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "session.end",
          session_id: "test-session"
        })
      })

      expect(response.status).toBe(200)
    } finally {
      proc.kill()
    }
  })
})
