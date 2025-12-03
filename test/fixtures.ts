/**
 * Test Fixtures
 *
 * Vitest 3.x fixtures for isolated test environments with temp directories.
 */
import { Layer, LogLevel, Option } from "effect"
import { mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as baseTest } from "vitest"
import { AppConfig, type MiniAgentConfig } from "../src/config.ts"

export const testAppConfigLayer = Layer.succeed(
  AppConfig,
  {
    llm: "openai:gpt-4o-mini",
    dataStorageDir: ".mini-agent-test",
    configFile: "mini-agent.config.yaml",
    cwd: Option.none(),
    stdoutLogLevel: LogLevel.None,
    fileLogLevel: LogLevel.None
  } satisfies MiniAgentConfig
)

export interface TestFixtures {
  suiteDir: string
  testDir: string
}

export const test = baseTest.extend<TestFixtures>({
  suiteDir: [async ({ task: _task }, use) => {
    const base = await realpath(tmpdir())
    const dir = await mkdtemp(join(base, "mini-agent-e2e-"))
    console.log(`Suite temp directory: ${dir}`)
    await use(dir)
  }, { scope: "file" as const }],

  testDir: async ({ suiteDir, task }, use) => {
    const safeName = task.name.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)
    const dir = await mkdtemp(join(suiteDir, `${safeName}-`))

    await use(dir)

    if (task.result?.state === "fail") {
      console.log(`Failed test directory: ${dir}`)
    }
  }
})

export { expect }
