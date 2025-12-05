/**
 * Codemode E2E Tests
 *
 * Tests the full codemode pipeline: parse, store, typecheck, execute.
 */
import { FileSystem, Path } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect, Layer, Stream } from "effect"
import { describe, expect } from "vitest"
import { CodeExecutor } from "../src/code-executor.service.ts"
import { CodemodeRepository } from "../src/codemode.repository.ts"
import { CodemodeService } from "../src/codemode.service.ts"
import { TypecheckService } from "../src/typechecker.service.ts"
import { test } from "./fixtures.ts"

describe("Codemode E2E", () => {
  // Full layer stack for real codemode processing with BunContext providing FileSystem, Path, CommandExecutor
  const serviceLayer = CodemodeService.layer.pipe(
    Layer.provide(CodemodeRepository.layer),
    Layer.provide(TypecheckService.layer),
    Layer.provide(CodeExecutor.layer),
    Layer.provide(BunContext.layer)
  )
  // Also expose BunContext services for tests that need FileSystem/Path directly
  const fullLayer = Layer.merge(serviceLayer, BunContext.layer)

  const TEST_CONTEXT = "test-context"

  test("processes valid code block and executes it", async () => {
    const program = Effect.gen(function*() {
      const service = yield* CodemodeService

      // Simulate an assistant response with a valid codemode block
      const response = `Here's some code that sends a message:

<codemode>
export default async function(t: Tools): Promise<void> {
  await t.sendMessage("Hello from codemode!")
}
</codemode>

This code will greet you!`

      const streamOpt = yield* service.processResponse(TEST_CONTEXT, response)
      expect(streamOpt._tag).toBe("Some")

      if (streamOpt._tag === "Some") {
        const events: Array<{ _tag: string }> = []
        yield* streamOpt.value.pipe(
          Stream.runForEach((event) => {
            events.push({ _tag: event._tag })
            return Effect.void
          }),
          Effect.scoped
        )

        // Should have: CodeBlock, TypecheckStart, TypecheckPass, ExecutionStart, ExecutionOutput*, ExecutionComplete
        const tags = events.map((e) => e._tag)
        expect(tags).toContain("CodeBlock")
        expect(tags).toContain("TypecheckStart")
        expect(tags).toContain("TypecheckPass")
        expect(tags).toContain("ExecutionStart")
        expect(tags).toContain("ExecutionComplete")
      }
    }).pipe(
      Effect.provide(fullLayer)
    )

    await Effect.runPromise(program)
  })

  test("detects typecheck errors in invalid code", async () => {
    const program = Effect.gen(function*() {
      const service = yield* CodemodeService

      // Code with a type error
      const response = `<codemode>
export default async function(t: Tools): Promise<void> {
  // This will cause a type error - nonExistentMethod doesn't exist
  await t.nonExistentMethod()
}
</codemode>`

      const streamOpt = yield* service.processResponse(TEST_CONTEXT, response)
      expect(streamOpt._tag).toBe("Some")

      if (streamOpt._tag === "Some") {
        const events: Array<{ _tag: string; errors?: string }> = []
        yield* streamOpt.value.pipe(
          Stream.runForEach((event) => {
            const e: { _tag: string; errors?: string } = { _tag: event._tag }
            if (event._tag === "TypecheckFail") {
              e.errors = (event as { errors: string }).errors
            }
            events.push(e)
            return Effect.void
          }),
          Effect.scoped
        )

        // Should have TypecheckFail, not ExecutionStart
        const tags = events.map((e) => e._tag)
        expect(tags).toContain("TypecheckFail")
        expect(tags).not.toContain("ExecutionStart")

        // The error should mention the missing property
        const failEvent = events.find((e) => e._tag === "TypecheckFail")
        expect(failEvent?.errors).toContain("nonExistentMethod")
      }
    }).pipe(
      Effect.provide(fullLayer)
    )

    await Effect.runPromise(program)
  })

  test("returns none for response without code block", async () => {
    const program = Effect.gen(function*() {
      const service = yield* CodemodeService

      const response = "Just a regular response without any code blocks."
      const streamOpt = yield* service.processResponse(TEST_CONTEXT, response)

      expect(streamOpt._tag).toBe("None")
    }).pipe(
      Effect.provide(fullLayer)
    )

    await Effect.runPromise(program)
  })

  test("creates files in context directory structure", async ({ testDir }) => {
    // Change to test directory so files are created there
    const originalCwd = process.cwd()
    process.chdir(testDir)

    try {
      const program = Effect.gen(function*() {
        const service = yield* CodemodeService
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const contextName = "file-test-context"
        const response = `<codemode>
export default async function(t: Tools): Promise<void> {
  await t.sendMessage("test")
}
</codemode>`

        const streamOpt = yield* service.processResponse(contextName, response)
        expect(streamOpt._tag).toBe("Some")

        if (streamOpt._tag === "Some") {
          // Consume the stream to trigger file creation
          yield* streamOpt.value.pipe(
            Stream.runForEach(() => Effect.void),
            Effect.scoped
          )

          // Check that context directory was created
          const contextDir = path.join(testDir, ".mini-agent", "contexts", contextName)
          const exists = yield* fs.exists(contextDir)
          expect(exists).toBe(true)

          // Check that there's at least one request directory
          const requestDirs = yield* fs.readDirectory(contextDir)
          expect(requestDirs.length).toBeGreaterThan(0)

          // Check that the request directory has a codeblock directory
          const requestDir = path.join(contextDir, requestDirs[0]!)
          const codeblockDirs = yield* fs.readDirectory(requestDir)
          expect(codeblockDirs.length).toBeGreaterThan(0)

          // Check that the codeblock directory has the expected files
          const codeblockDir = path.join(requestDir, codeblockDirs[0]!)
          const indexExists = yield* fs.exists(path.join(codeblockDir, "index.ts"))
          const typesExists = yield* fs.exists(path.join(codeblockDir, "types.ts"))
          const tsconfigExists = yield* fs.exists(path.join(codeblockDir, "tsconfig.json"))

          expect(indexExists).toBe(true)
          expect(typesExists).toBe(true)
          expect(tsconfigExists).toBe(true)
        }
      }).pipe(
        Effect.provide(fullLayer)
      )

      await Effect.runPromise(program)
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("captures execution output", async ({ testDir }) => {
    const originalCwd = process.cwd()
    process.chdir(testDir)

    try {
      const program = Effect.gen(function*() {
        const service = yield* CodemodeService

        // console.log goes to stdout (agent sees), sendMessage goes to stderr (user sees)
        const response = `<codemode>
export default async function(t: Tools): Promise<void> {
  await t.sendMessage("First message")
  await t.sendMessage("Second message")
}
</codemode>`

        const streamOpt = yield* service.processResponse(TEST_CONTEXT, response)
        expect(streamOpt._tag).toBe("Some")

        if (streamOpt._tag === "Some") {
          const outputs: Array<string> = []
          yield* streamOpt.value.pipe(
            Stream.runForEach((event) => {
              // sendMessage goes to stderr, so check stderr
              if (event._tag === "ExecutionOutput" && (event as { stream: string }).stream === "stderr") {
                outputs.push((event as { data: string }).data)
              }
              return Effect.void
            }),
            Effect.scoped
          )

          const fullOutput = outputs.join("")
          expect(fullOutput).toContain("First message")
          expect(fullOutput).toContain("Second message")
        }
      }).pipe(
        Effect.provide(fullLayer)
      )

      await Effect.runPromise(program)
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("getSecret tool retrieves secrets hidden from LLM", async ({ testDir }) => {
    const originalCwd = process.cwd()
    process.chdir(testDir)

    try {
      const program = Effect.gen(function*() {
        const service = yield* CodemodeService

        // Code that uses getSecret - LLM can't see the implementation
        // Use console.log so agent sees it (stdout), or sendMessage for user (stderr)
        const response = `<codemode>
export default async function(t: Tools): Promise<void> {
  const secret = await t.getSecret("demo-secret")
  console.log("Got secret: " + secret)
}
</codemode>`

        const streamOpt = yield* service.processResponse(TEST_CONTEXT, response)
        expect(streamOpt._tag).toBe("Some")

        if (streamOpt._tag === "Some") {
          const outputs: Array<string> = []
          yield* streamOpt.value.pipe(
            Stream.runForEach((event) => {
              if (event._tag === "ExecutionOutput" && (event as { stream: string }).stream === "stdout") {
                outputs.push((event as { data: string }).data)
              }
              return Effect.void
            }),
            Effect.scoped
          )

          const fullOutput = outputs.join("")
          // The secret should be revealed by the execution
          expect(fullOutput).toContain("SUPERSECRET42")
        }
      }).pipe(
        Effect.provide(fullLayer)
      )

      await Effect.runPromise(program)
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("output determines agent loop continuation", async ({ testDir }) => {
    const originalCwd = process.cwd()
    process.chdir(testDir)

    try {
      const program = Effect.gen(function*() {
        const service = yield* CodemodeService

        // console.log produces stdout which triggers another agent turn
        const response = `<codemode>
export default async function(t: Tools): Promise<void> {
  console.log("Processing...")
}
</codemode>`

        const streamOpt = yield* service.processResponse(TEST_CONTEXT, response)
        expect(streamOpt._tag).toBe("Some")

        if (streamOpt._tag === "Some") {
          const outputs: Array<string> = []
          yield* streamOpt.value.pipe(
            Stream.runForEach((event) => {
              if (event._tag === "ExecutionOutput" && (event as { stream: string }).stream === "stdout") {
                outputs.push((event as { data: string }).data)
              }
              return Effect.void
            }),
            Effect.scoped
          )

          const fullOutput = outputs.join("")
          // console.log output goes to stdout
          expect(fullOutput).toContain("Processing...")
        }
      }).pipe(
        Effect.provide(fullLayer)
      )

      await Effect.runPromise(program)
    } finally {
      process.chdir(originalCwd)
    }
  })
})
