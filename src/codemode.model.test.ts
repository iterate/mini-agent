import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { hasCodeBlock, parseCodeBlock } from "./codemode.model.ts"

describe("parseCodeBlock", () => {
  it.effect("extracts code from simple codemode block", () =>
    Effect.gen(function*() {
      const text = `Here is some code:
<codemode>
const x = 1
console.log(x)
</codemode>
That's it!`

      const result = yield* parseCodeBlock(text)
      expect(Option.isSome(result)).toBe(true)
      expect(Option.getOrThrow(result)).toBe("const x = 1\nconsole.log(x)")
    }))

  it.effect("extracts code with markdown fences", () =>
    Effect.gen(function*() {
      const text = `<codemode>
\`\`\`typescript
export default async function(t: Tools) {
  const result = await t.add()
  console.log(result)
}
\`\`\`
</codemode>`

      const result = yield* parseCodeBlock(text)
      expect(Option.isSome(result)).toBe(true)
      const code = Option.getOrThrow(result)
      expect(code).toContain("export default async function")
      expect(code).not.toContain("```")
    }))

  it.effect("returns none when no markers present", () =>
    Effect.gen(function*() {
      const text = "Just some regular text without code"
      const result = yield* parseCodeBlock(text)
      expect(Option.isNone(result)).toBe(true)
    }))

  it.effect("returns none when only start marker present", () =>
    Effect.gen(function*() {
      const text = "<codemode>some code without end"
      const result = yield* parseCodeBlock(text)
      expect(Option.isNone(result)).toBe(true)
    }))

  it.effect("returns none when only end marker present", () =>
    Effect.gen(function*() {
      const text = "some text</codemode>"
      const result = yield* parseCodeBlock(text)
      expect(Option.isNone(result)).toBe(true)
    }))

  it.effect("returns none for empty code block", () =>
    Effect.gen(function*() {
      const text = "<codemode>   </codemode>"
      const result = yield* parseCodeBlock(text)
      expect(Option.isNone(result)).toBe(true)
    }))
})

describe("hasCodeBlock", () => {
  it("returns true when both markers present", () => {
    expect(hasCodeBlock("<codemode>code</codemode>")).toBe(true)
  })

  it("returns false when start marker missing", () => {
    expect(hasCodeBlock("code</codemode>")).toBe(false)
  })

  it("returns false when end marker missing", () => {
    expect(hasCodeBlock("<codemode>code")).toBe(false)
  })

  it("returns false for plain text", () => {
    expect(hasCodeBlock("just some text")).toBe(false)
  })
})
