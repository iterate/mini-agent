/**
 * EventStore Tests
 *
 * Tests the event store interface using the InMemory implementation.
 * FileSystem implementation tested via e2e tests.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { AgentName, AgentTurnNumber, ContextName } from "../src/domain.ts"
import { EventBuilder } from "../src/domain.ts"
import { EventStore } from "../src/event-store.ts"

const testAgentName = "test-agent" as AgentName
const testContextName = "test-context" as ContextName

describe("EventStore.InMemory", () => {
  describe("load", () => {
    it.effect("returns empty array for non-existent context", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        const events = yield* store.load(testContextName)
        expect(events).toEqual([])
      }).pipe(Effect.provide(EventStore.InMemory)))

    it.effect("returns events after append", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        const event = EventBuilder.userMessage(testAgentName, testContextName, 0, "Hello")

        yield* store.append(testContextName, [event])
        const events = yield* store.load(testContextName)

        expect(events.length).toBe(1)
        expect(events[0]?._tag).toBe("UserMessageEvent")
      }).pipe(Effect.provide(EventStore.InMemory)))
  })

  describe("append", () => {
    it.effect("appends multiple events", () =>
      Effect.gen(function*() {
        const store = yield* EventStore

        const events = [
          EventBuilder.userMessage(testAgentName, testContextName, 0, "First"),
          EventBuilder.userMessage(testAgentName, testContextName, 1, "Second")
        ]

        yield* store.append(testContextName, events)
        const loaded = yield* store.load(testContextName)

        expect(loaded.length).toBe(2)
      }).pipe(Effect.provide(EventStore.InMemory)))

    it.effect("appends incrementally", () =>
      Effect.gen(function*() {
        const store = yield* EventStore

        yield* store.append(testContextName, [
          EventBuilder.userMessage(testAgentName, testContextName, 0, "First")
        ])
        yield* store.append(testContextName, [
          EventBuilder.userMessage(testAgentName, testContextName, 1, "Second")
        ])

        const loaded = yield* store.load(testContextName)
        expect(loaded.length).toBe(2)
      }).pipe(Effect.provide(EventStore.InMemory)))

    it.effect("preserves event content", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        const content = "Test message with special chars: 日本語 🎉"
        const event = EventBuilder.userMessage(testAgentName, testContextName, 0, content)

        yield* store.append(testContextName, [event])
        const [loaded] = yield* store.load(testContextName)

        expect(loaded?._tag).toBe("UserMessageEvent")
        if (loaded?._tag === "UserMessageEvent") {
          expect(loaded.content).toBe(content)
        }
      }).pipe(Effect.provide(EventStore.InMemory)))
  })

  describe("exists", () => {
    it.effect("returns false for non-existent context", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        const exists = yield* store.exists(testContextName)
        expect(exists).toBe(false)
      }).pipe(Effect.provide(EventStore.InMemory)))

    it.effect("returns true after append", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        const event = EventBuilder.userMessage(testAgentName, testContextName, 0, "Hello")

        yield* store.append(testContextName, [event])
        const exists = yield* store.exists(testContextName)

        expect(exists).toBe(true)
      }).pipe(Effect.provide(EventStore.InMemory)))
  })

  describe("isolation", () => {
    it.effect("different contexts are isolated", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        const context1 = "context-1" as ContextName
        const context2 = "context-2" as ContextName

        yield* store.append(context1, [
          EventBuilder.userMessage(testAgentName, context1, 0, "Context 1")
        ])
        yield* store.append(context2, [
          EventBuilder.userMessage(testAgentName, context2, 0, "Context 2 - 1"),
          EventBuilder.userMessage(testAgentName, context2, 1, "Context 2 - 2")
        ])

        const events1 = yield* store.load(context1)
        const events2 = yield* store.load(context2)

        expect(events1.length).toBe(1)
        expect(events2.length).toBe(2)
      }).pipe(Effect.provide(EventStore.InMemory)))
  })

  describe("event types", () => {
    it.effect("stores all event types", () =>
      Effect.gen(function*() {
        const store = yield* EventStore

        const events = [
          EventBuilder.systemPrompt(testAgentName, testContextName, 0, "System"),
          EventBuilder.userMessage(testAgentName, testContextName, 1, "User"),
          EventBuilder.assistantMessage(testAgentName, testContextName, 2, "Assistant"),
          EventBuilder.textDelta(testAgentName, testContextName, 3, "Delta"),
          EventBuilder.agentTurnStarted(testAgentName, testContextName, 4, 1 as AgentTurnNumber),
          EventBuilder.agentTurnCompleted(testAgentName, testContextName, 5, 1 as AgentTurnNumber, 100)
        ]

        yield* store.append(testContextName, events)
        const loaded = yield* store.load(testContextName)

        expect(loaded.length).toBe(6)
        expect(loaded.map((e) => e._tag)).toEqual([
          "SystemPromptEvent",
          "UserMessageEvent",
          "AssistantMessageEvent",
          "TextDeltaEvent",
          "AgentTurnStartedEvent",
          "AgentTurnCompletedEvent"
        ])
      }).pipe(Effect.provide(EventStore.InMemory)))
  })
})
