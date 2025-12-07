/**
 * Message Flow Behavior Tests
 *
 * Tests core message flow behaviors that should be identical across all modes.
 * Each test runs against multiple adapters to verify cross-mode symmetry.
 */
import { Effect } from "effect"
import { beforeAll, describe, expect, test } from "vitest"
import { createCliAdapter } from "../_shared/cli-adapter.ts"
// import { createHttpAdapter } from "../_shared/http-adapter.ts"
import { extractAssistantText, hasLifecycleEvents, type ModeAdapter, verifyChain } from "../_shared/mode-adapters.ts"

// Skip if no test environment available
const SKIP_E2E = process.env.SKIP_E2E === "true"

describe.skipIf(SKIP_E2E)("Message Flow Behaviors", () => {
  // Test against each mode
  const modes: Array<{ name: string; createAdapter: () => ModeAdapter }> = [
    // HTTP adapter requires server running - enable when server is up
    // { name: "HTTP", createAdapter: () => createHttpAdapter({ baseUrl: "http://localhost:3000" }) },
    {
      name: "CLI",
      createAdapter: () =>
        createCliAdapter({
          cwd: process.cwd(),
          env: { LLM: "openai:gpt-4.1-mini" }
        })
    }
  ]

  for (const { createAdapter, name } of modes) {
    describe(`${name} mode`, () => {
      let adapter: ModeAdapter

      beforeAll(() => {
        adapter = createAdapter()
      })

      test.skip("sends message and receives response", async () => {
        const contextName = `test-${name.toLowerCase()}-${Date.now()}`

        const events = await Effect.runPromise(adapter.sendMessage(contextName, "Say exactly: TEST_OK"))

        const lifecycle = hasLifecycleEvents(events)
        expect(lifecycle.hasSessionStarted).toBe(true)
        expect(lifecycle.hasTurnStarted).toBe(true)
        expect(lifecycle.hasTurnCompleted).toBe(true)
        expect(lifecycle.hasAssistantMessage).toBe(true)

        const text = extractAssistantText(events)
        expect(text).toContain("TEST_OK")
      })

      test.skip("events form blockchain chain", async () => {
        const contextName = `test-chain-${name.toLowerCase()}-${Date.now()}`

        const events = await Effect.runPromise(adapter.sendMessage(contextName, "Hello"))

        expect(events.length).toBeGreaterThan(0)
        expect(verifyChain(events)).toBe(true)
      })
    })
  }
})
