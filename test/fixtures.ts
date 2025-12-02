/**
 * Test Fixtures
 *
 * Modern Vitest 3.x fixtures using test.extend() for isolated test environments.
 * Provides suite-level and per-test temp directories with failure-only logging.
 */
import { mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as baseTest } from "vitest"

export interface TestFixtures {
  /** Suite-level parent directory shared across tests in this file */
  suiteDir: string
  /** Per-test isolated directory */
  testDir: string
}

export const test = baseTest.extend<TestFixtures>({
  // File-scoped fixture: created once per test file (Vitest 3.2+)
  suiteDir: [async ({ task: _task }, use) => {
    const base = await realpath(tmpdir())
    const dir = await mkdtemp(join(base, "mini-agent-e2e-"))
    console.log(`Suite temp directory: ${dir}`)
    await use(dir)
    // No cleanup - directories preserved for inspection
  }, { scope: "file" as const }],

  // Per-test fixture: fresh directory for each test
  testDir: async ({ suiteDir, task }, use) => {
    const safeName = task.name.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)
    const dir = await mkdtemp(join(suiteDir, `${safeName}-`))

    await use(dir)

    // Only log path on test failure
    if (task.result?.state === "fail") {
      console.log(`Failed test directory: ${dir}`)
    }
  }
})

export { expect }
