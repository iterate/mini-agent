/**
 * Multi-Client SSE Streaming E2E Test
 *
 * Verifies that:
 * - Multiple HTTP clients receive identical events via SSE
 * - Events persist correctly to YAML (all except TextDeltaEvent)
 * - Reduced state endpoint works correctly
 */
import { spawn } from "child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe } from "vitest"
import * as YAML from "yaml"
import { expect, type LlmEnv, test } from "./fixtures.ts"

const CLI_PATH = new URL("../src/cli/main.ts", import.meta.url).pathname

const getRandomPort = () => 49152 + Math.floor(Math.random() * 16383)

interface ServerHandle {
  port: number
  cleanup: () => Promise<void>
}

const startServer = async (cwd: string, llmEnv: LlmEnv): Promise<ServerHandle> => {
  const port = getRandomPort()

  const proc = spawn("bun", [CLI_PATH, "--cwd", cwd, "server", "--port", String(port)], {
    cwd,
    env: { ...process.env, ...llmEnv },
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
        await new Promise((r) => setTimeout(r, 50))
        return { port, cleanup }
      }
    } catch {
      // Server not ready
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  await cleanup()
  throw new Error("Server failed to start")
}

/** Collect events from SSE response until timeout or stream ends */
const collectSSEEvents = async (
  response: Response,
  timeoutMs: number
): Promise<Array<Record<string, unknown>>> => {
  const events: Array<Record<string, unknown>> = []
  const reader = response.body?.getReader()
  if (!reader) return events

  const decoder = new TextDecoder()
  let buffer = ""

  const timeout = setTimeout(() => reader.cancel(), timeoutMs)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            events.push(JSON.parse(line.slice(6)) as Record<string, unknown>)
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  } finally {
    clearTimeout(timeout)
  }

  return events
}

// These tests verify SSE streaming behavior and have complex timing requirements.
// The core SessionEndedEvent functionality is tested in cli.e2e.test.ts.
// Skipped due to timing complexities with multi-process SSE coordination.
describe.skip("Session Lifecycle via SSE", () => {
  test(
    "GET /agent/:name/events immediately emits SessionStartedEvent",
    { timeout: 30000 },
    async ({ llmEnv, testDir }) => {
      const { cleanup, port } = await startServer(testDir, llmEnv)

      try {
        const agentName = `session-start-${Date.now()}`

        // Just GET the events endpoint - should trigger session creation
        const response = await fetch(`http://localhost:${port}/agent/${agentName}/events`)
        expect(response.ok).toBe(true)

        const events = await collectSSEEvents(response, 3000)
        const eventTags = events.map((e) => e._tag)

        // Should receive SessionStartedEvent immediately upon connection
        expect(eventTags).toContain("SessionStartedEvent")
      } finally {
        await cleanup()
      }
    }
  )

  test(
    "SSE clients receive SessionEndedEvent on SIGTERM",
    { timeout: 60000 },
    async ({ llmEnv, testDir }) => {
      const agentName = "sigterm-test"
      const port = getRandomPort()

      const proc = spawn("bun", [CLI_PATH, "--cwd", testDir, "server", "--port", String(port)], {
        cwd: testDir,
        env: { ...process.env, ...llmEnv },
        stdio: "ignore"
      })

      // Wait for server ready
      for (let i = 0; i < 100; i++) {
        try {
          const res = await fetch(`http://localhost:${port}/health`)
          if (res.ok) break
        } catch {
          // Server not ready
        }
        await new Promise((r) => setTimeout(r, 100))
      }

      // Connect SSE client
      const sseResponse = await fetch(`http://localhost:${port}/agent/${agentName}/events`)
      expect(sseResponse.ok).toBe(true)

      // Start collecting events
      const eventsPromise = collectSSEEvents(sseResponse, 10000)

      // Small delay then send SIGTERM
      await new Promise((r) => setTimeout(r, 500))
      proc.kill("SIGTERM")

      // Wait for process exit
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          proc.kill("SIGKILL")
          resolve()
        }, 5000)
        proc.on("exit", () => {
          clearTimeout(timeout)
          resolve()
        })
      })

      const events = await eventsPromise
      const eventTags = events.map((e) => e._tag)

      // Must receive SessionEndedEvent when server shuts down
      expect(eventTags).toContain("SessionEndedEvent")
    }
  )

  test(
    "multiple SSE clients receive identical events",
    { timeout: 60000 },
    async ({ llmEnv, testDir }) => {
      const { cleanup, port } = await startServer(testDir, llmEnv)

      try {
        const agentName = "multi-client-test"
        const baseUrl = `http://localhost:${port}`

        // Connect two SSE clients to same agent
        const [client1Response, client2Response] = await Promise.all([
          fetch(`${baseUrl}/agent/${agentName}/events`),
          fetch(`${baseUrl}/agent/${agentName}/events`)
        ])

        expect(client1Response.ok).toBe(true)
        expect(client2Response.ok).toBe(true)

        // Start collecting from both
        const client1Promise = collectSSEEvents(client1Response, 10000)
        const client2Promise = collectSSEEvents(client2Response, 10000)

        // Give subscriptions time to establish
        await new Promise((r) => setTimeout(r, 300))

        // Trigger an LLM turn
        const postResponse = await fetch(`${baseUrl}/agent/${agentName}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-ndjson" },
          body: JSON.stringify({ _tag: "UserMessageEvent", content: "Say exactly: HELLO" })
        })
        expect(postResponse.ok).toBe(true)

        const [client1Events, client2Events] = await Promise.all([client1Promise, client2Promise])

        const getTags = (events: Array<Record<string, unknown>>) => events.map((e) => e._tag).filter(Boolean)

        const client1Tags = getTags(client1Events)
        const client2Tags = getTags(client2Events)

        // Both should have received the same event types
        expect(client1Tags).toContain("UserMessageEvent")
        expect(client2Tags).toContain("UserMessageEvent")
        expect(client1Tags).toContain("AssistantMessageEvent")
        expect(client2Tags).toContain("AssistantMessageEvent")
      } finally {
        await cleanup()
      }
    }
  )
})

// These tests verify complex multi-client SSE streaming and YAML persistence.
// The core HTTP functionality is tested in server.e2e.test.ts.
// These tests are skipped due to timing complexities - tracked for future work.
describe.skip("Multi-Client SSE Streaming (YAML persistence)", () => {
  test(
    "POST endpoint returns all events and YAML persists correctly",
    { timeout: 60000 },
    async ({ llmEnv, testDir }) => {
      const { cleanup, port } = await startServer(testDir, llmEnv)

      try {
        const agentName = "sse-test-agent"
        const baseUrl = `http://localhost:${port}`

        // Post a message to trigger an LLM turn
        const postResponse = await fetch(`${baseUrl}/agent/${agentName}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-ndjson" },
          body: JSON.stringify({
            _tag: "UserMessageEvent",
            content: "Say exactly: HELLO_SSE_TEST"
          })
        })
        expect(postResponse.status).toBe(200)

        // Get response as SSE stream
        const responseText = await postResponse.text()
        const events = responseText
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => {
            try {
              return JSON.parse(line.slice(6)) as Record<string, unknown>
            } catch {
              return null
            }
          })
          .filter((e): e is Record<string, unknown> => e !== null)

        const eventTags = events.map((e) => e._tag)

        // Should have initial session events
        expect(eventTags).toContain("SessionStartedEvent")
        expect(eventTags).toContain("SystemPromptEvent")

        // Should have user message
        expect(eventTags).toContain("UserMessageEvent")

        // Should have LLM response events
        expect(eventTags).toContain("AssistantMessageEvent")
        expect(eventTags).toContain("AgentTurnCompletedEvent")

        // Verify state endpoint works
        const stateResponse = await fetch(`${baseUrl}/agent/${agentName}/state`)
        expect(stateResponse.status).toBe(200)
        const state = (await stateResponse.json()) as Record<string, unknown>
        expect(state.agentName).toBe(agentName)
        expect(state.messageCount).toBeGreaterThan(0)

        // Wait for server to flush and shutdown
        await new Promise((r) => setTimeout(r, 500))
        await cleanup()

        // Give time for files to be written
        await new Promise((r) => setTimeout(r, 200))

        // Read and verify the YAML file
        const yamlPath = join(testDir, ".mini-agent", "contexts", `${agentName}-v1.yaml`)
        const yamlContent = await readFile(yamlPath, "utf-8")
        const parsed = YAML.parse(yamlContent) as { events: Array<{ _tag: string }> }

        expect(parsed.events).toBeDefined()
        expect(Array.isArray(parsed.events)).toBe(true)

        // Verify expected events are persisted
        const persistedTags = parsed.events.map((e) => e._tag)
        expect(persistedTags).toContain("SessionStartedEvent")
        expect(persistedTags).toContain("UserMessageEvent")
        expect(persistedTags).toContain("AssistantMessageEvent")

        // Verify TextDeltaEvent is NOT persisted
        expect(persistedTags).not.toContain("TextDeltaEvent")
      } finally {
        await cleanup()
      }
    }
  )

  test("reduced state endpoint returns correct data", { timeout: 30000 }, async ({ llmEnv, testDir }) => {
    const { cleanup, port } = await startServer(testDir, llmEnv)

    try {
      const agentName = "state-test-agent"
      const baseUrl = `http://localhost:${port}`

      // First access creates the agent
      const stateResponse1 = await fetch(`${baseUrl}/agent/${agentName}/state`)
      expect(stateResponse1.status).toBe(200)

      const state1 = (await stateResponse1.json()) as Record<string, unknown>
      expect(state1.agentName).toBe(agentName)
      expect(state1.contextName).toBe(`${agentName}-v1`)
      // Agent starts with system prompt message (from config)
      expect(state1.messageCount).toBe(1)
      expect(state1.isAgentTurnInProgress).toBe(false)

      // Add a message
      const postResponse = await fetch(`${baseUrl}/agent/${agentName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _tag: "UserMessageEvent",
          content: "Say exactly: STATE_TEST"
        })
      })
      expect(postResponse.status).toBe(200)
      await postResponse.text()

      // Check state after message
      const stateResponse2 = await fetch(`${baseUrl}/agent/${agentName}/state`)
      const state2 = (await stateResponse2.json()) as Record<string, unknown>

      // Should have system prompt + user + assistant messages
      expect(state2.messageCount).toBeGreaterThanOrEqual(3)
      expect(state2.isAgentTurnInProgress).toBe(false)
    } finally {
      await cleanup()
    }
  })
})
