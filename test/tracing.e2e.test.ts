/**
 * Tracing E2E Tests
 *
 * Verifies that tracing failures don't crash the CLI.
 * When traces cannot be sent to a provider, the app should log warnings but continue.
 */
import { Effect } from "effect"
import { describe } from "vitest"
import { expect, runCli, test } from "./fixtures.ts"

describe("Tracing failure resilience", () => {
  test("completes with bogus hostname", async ({ testDir }) => {
    const result = await Effect.runPromise(
      runCli(["trace-test"], {
        cwd: testDir,
        env: {
          OPENAI_API_KEY: "test-api-key",
          HONEYCOMB_API_KEY: "test-key",
          HONEYCOMB_ENDPOINT: "http://bogus.invalid.hostname:9999"
        }
      })
    )

    // CLI should complete successfully even when tracing fails
    expect(result.exitCode).toBe(0)

    // Our fan-out HttpClient logs warnings when export fails
    // The message may appear in stdout (log output) or stderr
    const combinedOutput = result.stdout + result.stderr
    expect(combinedOutput).toMatch(/OTLP export to.*failed|fetch failed|ENOTFOUND|Unable to connect/i)
  })

  test("completes with invalid API key", async ({ testDir }) => {
    const result = await Effect.runPromise(
      runCli(["trace-test"], {
        cwd: testDir,
        env: {
          OPENAI_API_KEY: "test-api-key",
          HONEYCOMB_API_KEY: "definitely-not-valid-key"
        }
      })
    )

    // CLI should complete successfully even when tracing auth fails
    // The trace export might succeed at HTTP level (401 is still a response)
    // The important thing is the app doesn't crash
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Trace-test command executed")
  })
})
