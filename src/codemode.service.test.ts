import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Stream } from "effect"
import { CodeBlockEvent, TypecheckPassEvent, TypecheckStartEvent } from "./codemode.model.ts"
import { CodemodeService } from "./codemode.service.ts"

describe("CodemodeService", () => {
  const testLayer = CodemodeService.testLayer

  it.effect("returns none for content without code block", () =>
    Effect.gen(function*() {
      const service = yield* CodemodeService
      const result = yield* service.processResponse("test-context", "Just some regular text")
      expect(Option.isNone(result)).toBe(true)
    }).pipe(Effect.provide(testLayer)))

  it.effect("returns stream for content with code block", () =>
    Effect.gen(function*() {
      const service = yield* CodemodeService
      const content = `Here is some code:
<codemode>
export default async function(t) {
  await t.log("Hello!")
}
</codemode>`

      const result = yield* service.processResponse("test-context", content)
      expect(Option.isSome(result)).toBe(true)

      if (Option.isSome(result)) {
        const events = yield* Stream.runCollect(result.value).pipe(Effect.scoped)
        const eventArray = Array.from(events)

        expect(eventArray.length).toBe(3)
        expect(eventArray[0]).toBeInstanceOf(CodeBlockEvent)
        expect(eventArray[1]).toBeInstanceOf(TypecheckStartEvent)
        expect(eventArray[2]).toBeInstanceOf(TypecheckPassEvent)
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("hasCodeBlock returns true for valid markers", () =>
    Effect.gen(function*() {
      const service = yield* CodemodeService
      expect(service.hasCodeBlock("<codemode>code</codemode>")).toBe(true)
      expect(service.hasCodeBlock("no markers here")).toBe(false)
    }).pipe(Effect.provide(testLayer)))
})
