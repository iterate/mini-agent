/**
 * EventStore Tests
 *
 * Tests the event persistence layer.
 * Uses InMemory implementation for unit tests.
 */
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Option } from "effect"
import type { AgentName, ContextName } from "../src/domain.ts"
import { makeEventId, UserMessageEvent } from "../src/domain.ts"
import { EventStore } from "../src/event-store.ts"

const testAgentName = "test-agent" as AgentName
const testContextName = "test-context" as ContextName

const makeTestEvent = (eventNumber: number, content: string) =>
  new UserMessageEvent({
    id: makeEventId(testContextName, eventNumber),
    timestamp: DateTime.unsafeNow(),
    agentName: testAgentName,
    parentEventId: Option.none(),
    triggersAgentTurn: true,
    content
  })

describe("EventStore", () => {
  describe("load", () => {
    it.effect("returns empty array for non-existent context", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        const events = yield* store.load("non-existent" as ContextName)
        expect(events).toEqual([])
      }).pipe(Effect.provide(EventStore.InMemory)))

    it.effect("returns saved events after append", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        const events = [makeTestEvent(0, "Hello")]

        yield* store.append(testContextName, events)
        const loaded = yield* store.load(testContextName)

        expect(loaded).toHaveLength(1)
        expect(loaded[0]?._tag).toBe("UserMessageEvent")
      }).pipe(Effect.provide(EventStore.InMemory)))
  })

  describe("append", () => {
    it.effect("appends events to existing context", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        const firstBatch = [makeTestEvent(0, "First")]
        const secondBatch = [makeTestEvent(1, "Second")]

        yield* store.append(testContextName, firstBatch)
        yield* store.append(testContextName, secondBatch)

        const loaded = yield* store.load(testContextName)
        expect(loaded).toHaveLength(2)
      }).pipe(Effect.provide(EventStore.InMemory)))

    it.effect("appends multiple events at once", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        const events = [
          makeTestEvent(0, "First"),
          makeTestEvent(1, "Second"),
          makeTestEvent(2, "Third")
        ]

        yield* store.append(testContextName, events)
        const loaded = yield* store.load(testContextName)

        expect(loaded).toHaveLength(3)
      }).pipe(Effect.provide(EventStore.InMemory)))
  })

  describe("exists", () => {
    it.effect("returns false for non-existent context", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        const exists = yield* store.exists("non-existent" as ContextName)
        expect(exists).toBe(false)
      }).pipe(Effect.provide(EventStore.InMemory)))

    it.effect("returns true after events are appended", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        yield* store.append(testContextName, [makeTestEvent(0, "Hello")])

        const exists = yield* store.exists(testContextName)
        expect(exists).toBe(true)
      }).pipe(Effect.provide(EventStore.InMemory)))
  })

  describe("isolation", () => {
    it.effect("different contexts are independent", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        const context1 = "context-1" as ContextName
        const context2 = "context-2" as ContextName

        yield* store.append(context1, [makeTestEvent(0, "Context 1")])
        yield* store.append(context2, [makeTestEvent(0, "Context 2")])

        const loaded1 = yield* store.load(context1)
        const loaded2 = yield* store.load(context2)

        expect(loaded1).toHaveLength(1)
        expect(loaded2).toHaveLength(1)
        expect((loaded1[0] as UserMessageEvent).content).toBe("Context 1")
        expect((loaded2[0] as UserMessageEvent).content).toBe("Context 2")
      }).pipe(Effect.provide(EventStore.InMemory)))
  })

  describe("test isolation", () => {
    it.effect("first test creates data", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        yield* store.append(testContextName, [makeTestEvent(0, "Isolation test")])

        const loaded = yield* store.load(testContextName)
        expect(loaded).toHaveLength(1)
      }).pipe(Effect.provide(EventStore.InMemory)))

    it.effect("second test has fresh state", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        const loaded = yield* store.load(testContextName)
        expect(loaded).toEqual([])
      }).pipe(Effect.provide(EventStore.InMemory)))
  })
})
