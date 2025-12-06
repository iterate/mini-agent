import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { countCodeBlocks, hasCodeBlock, makeCodeblockId, parseCodeBlock, parseCodeBlocks } from "./codemode.model.ts"

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

describe("parseCodeBlocks", () => {
  it.effect("extracts single codeblock", () =>
    Effect.gen(function*() {
      const text = `<codemode>const x = 1</codemode>`
      const blocks = yield* parseCodeBlocks(text)
      expect(blocks.length).toBe(1)
      expect(blocks[0]!.code).toBe("const x = 1")
      expect(blocks[0]!.codeblockId).toBe(makeCodeblockId(1))
    }))

  it.effect("extracts multiple codeblocks with sequential IDs", () =>
    Effect.gen(function*() {
      const text = `First block:
<codemode>
const a = 1
</codemode>
Some text in between.
<codemode>
const b = 2
</codemode>
And a third:
<codemode>
const c = 3
</codemode>`

      const blocks = yield* parseCodeBlocks(text)
      expect(blocks.length).toBe(3)

      expect(blocks[0]!.code).toBe("const a = 1")
      expect(blocks[0]!.codeblockId).toBe(makeCodeblockId(1))

      expect(blocks[1]!.code).toBe("const b = 2")
      expect(blocks[1]!.codeblockId).toBe(makeCodeblockId(2))

      expect(blocks[2]!.code).toBe("const c = 3")
      expect(blocks[2]!.codeblockId).toBe(makeCodeblockId(3))
    }))

  it.effect("returns empty array when no codeblocks", () =>
    Effect.gen(function*() {
      const text = "Just plain text"
      const blocks = yield* parseCodeBlocks(text)
      expect(blocks.length).toBe(0)
    }))

  it.effect("skips empty codeblocks", () =>
    Effect.gen(function*() {
      const text = `<codemode>   </codemode>
<codemode>valid code</codemode>`
      const blocks = yield* parseCodeBlocks(text)
      expect(blocks.length).toBe(1)
      expect(blocks[0]!.code).toBe("valid code")
      expect(blocks[0]!.codeblockId).toBe(makeCodeblockId(1)) // ID starts at 1, not 2
    }))

  it.effect("handles markdown fences in multiple blocks", () =>
    Effect.gen(function*() {
      const text = `<codemode>
\`\`\`typescript
const a = 1
\`\`\`
</codemode>
<codemode>
\`\`\`ts
const b = 2
\`\`\`
</codemode>`

      const blocks = yield* parseCodeBlocks(text)
      expect(blocks.length).toBe(2)
      expect(blocks[0]!.code).not.toContain("```")
      expect(blocks[1]!.code).not.toContain("```")
    }))
})

describe("countCodeBlocks", () => {
  it("returns 0 for no codeblocks", () => {
    expect(countCodeBlocks("just text")).toBe(0)
  })

  it("returns 1 for single codeblock", () => {
    expect(countCodeBlocks("<codemode>code</codemode>")).toBe(1)
  })

  it("returns correct count for multiple codeblocks", () => {
    const text = "<codemode>a</codemode> text <codemode>b</codemode> more <codemode>c</codemode>"
    expect(countCodeBlocks(text)).toBe(3)
  })

  it("handles unclosed blocks correctly", () => {
    const text = "<codemode>a</codemode> <codemode>unclosed"
    expect(countCodeBlocks(text)).toBe(1)
  })
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
