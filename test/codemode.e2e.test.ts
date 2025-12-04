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

  test("processes valid code block and executes it", async () => {
    const program = Effect.gen(function*() {
      const service = yield* CodemodeService

      // Simulate an assistant response with a valid codemode block
      const response = `Here's some code that prints a message:

<codemode>
export default async function(t: Tools) {
  await t.log("Hello from codemode!")
}
</codemode>

This code will greet you!`

      const streamOpt = yield* service.processResponse(response)
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
export default async function(t: Tools) {
  // This will cause a type error - nonExistentMethod doesn't exist
  await t.nonExistentMethod()
}
</codemode>`

      const streamOpt = yield* service.processResponse(response)
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
      const streamOpt = yield* service.processResponse(response)

      expect(streamOpt._tag).toBe("None")
    }).pipe(
      Effect.provide(fullLayer)
    )

    await Effect.runPromise(program)
  })

  test("creates files in .mini-agent/codemode directory", async ({ testDir }) => {
    // Change to test directory so files are created there
    const originalCwd = process.cwd()
    process.chdir(testDir)

    try {
      const program = Effect.gen(function*() {
        const service = yield* CodemodeService
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const response = `<codemode>
export default async function(t: Tools) {
  await t.log("test")
}
</codemode>`

        const streamOpt = yield* service.processResponse(response)
        expect(streamOpt._tag).toBe("Some")

        if (streamOpt._tag === "Some") {
          // Consume the stream to trigger file creation
          yield* streamOpt.value.pipe(
            Stream.runForEach(() => Effect.void),
            Effect.scoped
          )

          // Check that codemode directory was created
          const codemodeDir = path.join(testDir, ".mini-agent", "codemode")
          const exists = yield* fs.exists(codemodeDir)
          expect(exists).toBe(true)

          // Check that there's at least one response directory
          const entries = yield* fs.readDirectory(codemodeDir)
          expect(entries.length).toBeGreaterThan(0)

          // Check that the response directory has the expected files
          const responseDir = path.join(codemodeDir, entries[0]!)
          const indexExists = yield* fs.exists(path.join(responseDir, "index.ts"))
          const typesExists = yield* fs.exists(path.join(responseDir, "types.ts"))
          const tsconfigExists = yield* fs.exists(path.join(responseDir, "tsconfig.json"))

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

        const response = `<codemode>
export default async function(t: Tools) {
  await t.log("First message")
  await t.log("Second message")
  return { endTurn: true }
}
</codemode>`

        const streamOpt = yield* service.processResponse(response)
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
        const response = `<codemode>
export default async function(t: Tools) {
  const secret = await t.getSecret("demo-secret")
  await t.log("Got secret: " + secret)
  return { endTurn: true, data: { secret } }
}
</codemode>`

        const streamOpt = yield* service.processResponse(response)
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

  test("returns CodemodeResult with endTurn and data fields", async ({ testDir }) => {
    const originalCwd = process.cwd()
    process.chdir(testDir)

    try {
      const program = Effect.gen(function*() {
        const service = yield* CodemodeService

        // Code that returns structured data
        const response = `<codemode>
export default async function(t: Tools) {
  await t.log("Processing...")
  return { endTurn: false, data: { step: 1, result: "intermediate" } }
}
</codemode>`

        const streamOpt = yield* service.processResponse(response)
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
          // The result marker should be in stdout
          expect(fullOutput).toContain("__CODEMODE_RESULT__")
          expect(fullOutput).toContain("\"endTurn\":false")
          expect(fullOutput).toContain("\"step\":1")
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
