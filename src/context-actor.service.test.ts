/**
 * Tests for ContextActor service using Mailbox + broadcastDynamic pattern.
 *
 * Key behavior:
 * - broadcastDynamic is a LIVE stream - late subscribers miss events published before they subscribed
 * - For immediate subscription (same execution context), all events are received
 * - getEvents provides access to the full event history from internal state
 */
import { describe, expect, it } from "@effect/vitest"
import { Chunk, DateTime, Effect, Option, Stream } from "effect"
import { ContextName, EventId, UserMessageEvent } from "./actor.model.ts"
import { ContextActor, defaultActorConfig } from "./context-actor.service.ts"

const makeTestEvent = (contextName: ContextName, content: string): UserMessageEvent =>
  new UserMessageEvent({
    id: EventId.make(crypto.randomUUID()),
    timestamp: DateTime.unsafeNow(),
    contextName,
    parentEventId: Option.none(),
    content
  })

describe("ContextActor", () => {
  const testContextName = ContextName.make("test-context")
  const fastConfig = { ...defaultActorConfig, debounceMs: 1 }

  it.effect("emits SessionStartedEvent on creation", () =>
    Effect.gen(function*() {
      const actor = yield* ContextActor

      // Subscribe immediately - stream is connected during layer construction
      const firstEvent = yield* actor.events.pipe(Stream.take(1), Stream.runCollect)

      expect(Chunk.toReadonlyArray(firstEvent)).toHaveLength(1)
      expect(Chunk.unsafeGet(firstEvent, 0)._tag).toBe("SessionStartedEvent")
    }).pipe(
      Effect.scoped,
      Effect.provide(ContextActor.make(testContextName, fastConfig))
    ))

  it.effect("tracks all events in internal state via getEvents", () =>
    Effect.gen(function*() {
      const actor = yield* ContextActor

      yield* actor.addEvent(makeTestEvent(testContextName, "Hello"))
      yield* actor.addEvent(makeTestEvent(testContextName, "World"))

      const events = yield* actor.getEvents

      expect(events).toHaveLength(2)
      expect(events[0]?._tag).toBe("UserMessageEvent")
      expect(events[1]?._tag).toBe("UserMessageEvent")
    }).pipe(
      Effect.scoped,
      Effect.provide(ContextActor.make(testContextName, fastConfig))
    ))

  it.effect("addEvent persists to internal state (late subscribers can use getEvents)", () =>
    Effect.gen(function*() {
      const actor = yield* ContextActor

      // Add events first - they'll be stored in internal state
      yield* actor.addEvent(makeTestEvent(testContextName, "First"))
      yield* actor.addEvent(makeTestEvent(testContextName, "Second"))
      yield* actor.addEvent(makeTestEvent(testContextName, "Third"))

      // Late subscriber to stream only gets events published AFTER subscription
      // But getEvents returns full history
      const streamEvents = yield* actor.events.pipe(Stream.take(1), Stream.runCollect)
      const stateEvents = yield* actor.getEvents

      // Stream only gets SessionStarted (published during construction)
      expect(Chunk.size(streamEvents)).toBe(1)
      expect(Chunk.unsafeGet(streamEvents, 0)._tag).toBe("SessionStartedEvent")

      // State has all added events
      expect(stateEvents).toHaveLength(3)
    }).pipe(
      Effect.scoped,
      Effect.provide(ContextActor.make(testContextName, fastConfig))
    ))

  it.effect("shutdown ends the event stream gracefully", () =>
    Effect.gen(function*() {
      const actor = yield* ContextActor

      yield* actor.shutdown

      // After shutdown, stream ends (may have buffered SessionStarted)
      const events = yield* actor.events.pipe(Stream.runCollect)
      // Stream completes without error - that's the key assertion
      expect(Chunk.size(events)).toBeLessThanOrEqual(1)
    }).pipe(
      Effect.scoped,
      Effect.provide(ContextActor.make(testContextName, fastConfig))
    ))

  it.effect("contextName is accessible", () =>
    Effect.gen(function*() {
      const actor = yield* ContextActor
      expect(actor.contextName).toBe(testContextName)
    }).pipe(
      Effect.scoped,
      Effect.provide(ContextActor.make(testContextName, fastConfig))
    ))
})
