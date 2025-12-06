/**
 * Service Unit Tests
 *
 * Tests services using testLayer pattern for isolated unit testing.
 * See: https://www.effect.solutions/testing
 *
 * Pattern: Each test provides a fresh layer so state never leaks between tests.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SystemPromptEvent, UserMessageEvent } from "../src/context.model.js"
import { ContextRepository } from "../src/context.repository.js"

// =============================================================================
// ContextRepository Tests
// =============================================================================

describe.concurrent("ContextRepository", () => {
  describe("load", () => {
    it.effect("returns empty array for non-existent context", () =>
      Effect.gen(function*() {
        const repo = yield* ContextRepository
        const events = yield* repo.load("non-existent")
        expect(events).toEqual([])
      }).pipe(Effect.provide(ContextRepository.testLayer)))

    it.effect("returns saved events after save", () =>
      Effect.gen(function*() {
        const repo = yield* ContextRepository
        const events = [
          new SystemPromptEvent({ content: "Test system prompt" }),
          new UserMessageEvent({ content: "Hello" })
        ]

        yield* repo.save("test-context", events)
        const loaded = yield* repo.load("test-context")

        expect(loaded).toHaveLength(2)
        expect(loaded[0]?._tag).toBe("SystemPrompt")
        expect(loaded[1]?._tag).toBe("UserMessage")
      }).pipe(Effect.provide(ContextRepository.testLayer)))
  })

  describe("loadOrCreate", () => {
    it.effect("creates context with system prompt if not exists", () =>
      Effect.gen(function*() {
        const repo = yield* ContextRepository
        const events = yield* repo.loadOrCreate("new-context")

        expect(events).toHaveLength(1)
        expect(events[0]?._tag).toBe("SystemPrompt")
      }).pipe(Effect.provide(ContextRepository.testLayer)))

    it.effect("returns existing events if context exists", () =>
      Effect.gen(function*() {
        const repo = yield* ContextRepository
        const initial = [new SystemPromptEvent({ content: "Custom prompt" })]
        yield* repo.save("existing", initial)

        const events = yield* repo.loadOrCreate("existing")

        expect(events).toHaveLength(1)
        expect(events[0]?._tag).toBe("SystemPrompt")
        expect(events[0]?._tag === "SystemPrompt" && events[0].content).toBe("Custom prompt")
      }).pipe(Effect.provide(ContextRepository.testLayer)))
  })

  describe("list", () => {
    it.effect("returns empty array when no contexts", () =>
      Effect.gen(function*() {
        const repo = yield* ContextRepository
        const contexts = yield* repo.list()
        expect(contexts).toEqual([])
      }).pipe(Effect.provide(ContextRepository.testLayer)))

    it.effect("returns sorted context names", () =>
      Effect.gen(function*() {
        const repo = yield* ContextRepository
        yield* repo.save("zebra", [new SystemPromptEvent({ content: "z" })])
        yield* repo.save("alpha", [new SystemPromptEvent({ content: "a" })])

        const contexts = yield* repo.list()

        expect(contexts).toEqual(["alpha", "zebra"])
      }).pipe(Effect.provide(ContextRepository.testLayer)))
  })

  describe("save", () => {
    it.effect("overwrites existing context", () =>
      Effect.gen(function*() {
        const repo = yield* ContextRepository
        const initial = [new SystemPromptEvent({ content: "First" })]
        const updated = [
          new SystemPromptEvent({ content: "Second" }),
          new UserMessageEvent({ content: "Hello" })
        ]

        yield* repo.save("overwrite-test", initial)
        yield* repo.save("overwrite-test", updated)

        const loaded = yield* repo.load("overwrite-test")
        expect(loaded).toHaveLength(2)
        expect(loaded[0]?._tag === "SystemPrompt" && loaded[0].content).toBe("Second")
      }).pipe(Effect.provide(ContextRepository.testLayer)))
  })

  describe("getContextsDir", () => {
    it.effect("returns test directory path", () =>
      Effect.gen(function*() {
        const repo = yield* ContextRepository
        const dir = repo.getContextsDir()
        expect(dir).toBe("/test/contexts")
      }).pipe(Effect.provide(ContextRepository.testLayer)))
  })
})

// =============================================================================
// State Isolation Tests
// =============================================================================

describe.concurrent("Test Isolation", () => {
  it.effect("first test saves data", () =>
    Effect.gen(function*() {
      const repo = yield* ContextRepository
      yield* repo.save("isolation-test", [
        new SystemPromptEvent({ content: "First test data" })
      ])

      const loaded = yield* repo.load("isolation-test")
      expect(loaded).toHaveLength(1)
    }).pipe(Effect.provide(ContextRepository.testLayer)))

  it.effect("second test has fresh state (no leakage)", () =>
    Effect.gen(function*() {
      const repo = yield* ContextRepository
      // Should not see data from first test
      const loaded = yield* repo.load("isolation-test")
      expect(loaded).toEqual([])
    }).pipe(Effect.provide(ContextRepository.testLayer)))
})
