/**
 * EventReducer Tests
 *
 * Tests the pure reducer that folds events into ReducedContext.
 */
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Option, Redacted } from "effect"
import type { AgentName, AgentTurnNumber, ContextName, LlmProviderId } from "./domain.ts"
import {
  AgentTurnCompletedEvent,
  AgentTurnStartedEvent,
  AssistantMessageEvent,
  makeEventId,
  ReducedContext,
  SetLlmConfigEvent,
  SetTimeoutEvent,
  SystemPromptEvent,
  UserMessageEvent
} from "./domain.ts"
import { EventReducer } from "./event-reducer.ts"

const testAgentName = "test-agent" as AgentName
const testContextName = "test-context" as ContextName

const baseFields = (eventNumber: number, triggersAgentTurn = false) => ({
  id: makeEventId(testContextName, eventNumber),
  timestamp: DateTime.unsafeNow(),
  agentName: testAgentName,
  parentEventId: Option.none(),
  triggersAgentTurn
})

describe("EventReducer", () => {
  describe("initial state", () => {
    it.effect("has empty messages", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const initial = reducer.initialReducedContext
        expect(initial.messages).toEqual([])
      }).pipe(Effect.provide(EventReducer.Default)))

    it.effect("has zero nextEventNumber", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const initial = reducer.initialReducedContext
        expect(initial.nextEventNumber).toBe(0)
      }).pipe(Effect.provide(EventReducer.Default)))

    it.effect("has no agent turn in progress", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const initial = reducer.initialReducedContext
        expect(Option.isNone(initial.agentTurnStartedAtEventId)).toBe(true)
      }).pipe(Effect.provide(EventReducer.Default)))
  })

  describe("message events", () => {
    it.effect("SystemPromptEvent adds system message", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const event = new SystemPromptEvent({
          ...baseFields(0),
          content: "You are a helpful assistant."
        })

        const result = yield* reducer.reduce(reducer.initialReducedContext, [event])

        expect(result.messages).toHaveLength(1)
        expect(result.messages[0]?.role).toBe("system")
      }).pipe(Effect.provide(EventReducer.Default)))

    it.effect("UserMessageEvent adds user message", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const event = new UserMessageEvent({
          ...baseFields(0),
          content: "Hello!"
        })

        const result = yield* reducer.reduce(reducer.initialReducedContext, [event])

        expect(result.messages).toHaveLength(1)
        expect(result.messages[0]?.role).toBe("user")
      }).pipe(Effect.provide(EventReducer.Default)))

    it.effect("AssistantMessageEvent adds assistant message", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const event = new AssistantMessageEvent({
          ...baseFields(0),
          content: "Hi there!"
        })

        const result = yield* reducer.reduce(reducer.initialReducedContext, [event])

        expect(result.messages).toHaveLength(1)
        expect(result.messages[0]?.role).toBe("assistant")
      }).pipe(Effect.provide(EventReducer.Default)))

    it.effect("multiple messages accumulate in order", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const events = [
          new SystemPromptEvent({ ...baseFields(0), content: "System" }),
          new UserMessageEvent({ ...baseFields(1), content: "User" }),
          new AssistantMessageEvent({ ...baseFields(2), content: "Assistant" })
        ]

        const result = yield* reducer.reduce(reducer.initialReducedContext, events)

        expect(result.messages).toHaveLength(3)
        expect(result.messages[0]?.role).toBe("system")
        expect(result.messages[1]?.role).toBe("user")
        expect(result.messages[2]?.role).toBe("assistant")
      }).pipe(Effect.provide(EventReducer.Default)))
  })

  describe("config events", () => {
    it.effect("SetLlmConfigEvent updates primary config", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const event = new SetLlmConfigEvent({
          ...baseFields(0),
          providerId: "anthropic" as LlmProviderId,
          model: "claude-3-opus",
          apiKey: Redacted.make("test-key"),
          baseUrl: Option.none(),
          asFallback: false
        })

        const result = yield* reducer.reduce(reducer.initialReducedContext, [event])

        expect(result.config.primary.providerId).toBe("anthropic")
        expect(result.config.primary.model).toBe("claude-3-opus")
      }).pipe(Effect.provide(EventReducer.Default)))

    it.effect("SetLlmConfigEvent with asFallback=true sets fallback", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const event = new SetLlmConfigEvent({
          ...baseFields(0),
          providerId: "openai" as LlmProviderId,
          model: "gpt-4",
          apiKey: Redacted.make("fallback-key"),
          baseUrl: Option.none(),
          asFallback: true
        })

        const result = yield* reducer.reduce(reducer.initialReducedContext, [event])

        expect(Option.isSome(result.config.fallback)).toBe(true)
        const fallback = Option.getOrThrow(result.config.fallback)
        expect(fallback.providerId).toBe("openai")
        expect(fallback.model).toBe("gpt-4")
      }).pipe(Effect.provide(EventReducer.Default)))

    it.effect("SetTimeoutEvent updates timeout", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const event = new SetTimeoutEvent({ ...baseFields(0), timeoutMs: 60000 })

        const result = yield* reducer.reduce(reducer.initialReducedContext, [event])

        expect(result.config.timeoutMs).toBe(60000)
      }).pipe(Effect.provide(EventReducer.Default)))
  })

  describe("turn tracking", () => {
    it.effect("AgentTurnStartedEvent sets turn in progress", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const event = new AgentTurnStartedEvent({
          ...baseFields(0),
          turnNumber: 1 as AgentTurnNumber
        })

        const result = yield* reducer.reduce(reducer.initialReducedContext, [event])

        expect(ReducedContext.isAgentTurnInProgress(result)).toBe(true)
        expect(Option.getOrThrow(result.agentTurnStartedAtEventId)).toBe(event.id)
      }).pipe(Effect.provide(EventReducer.Default)))

    it.effect("AgentTurnCompletedEvent clears turn in progress", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const startEvent = new AgentTurnStartedEvent({
          ...baseFields(0),
          turnNumber: 1 as AgentTurnNumber
        })
        const completeEvent = new AgentTurnCompletedEvent({
          ...baseFields(1),
          turnNumber: 1 as AgentTurnNumber,
          durationMs: 100
        })

        const afterStart = yield* reducer.reduce(reducer.initialReducedContext, [startEvent])
        const afterComplete = yield* reducer.reduce(afterStart, [completeEvent])

        expect(ReducedContext.isAgentTurnInProgress(afterComplete)).toBe(false)
      }).pipe(Effect.provide(EventReducer.Default)))

    it.effect("currentTurnNumber increments on turn completion", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const events = [
          new AgentTurnStartedEvent({ ...baseFields(0), turnNumber: 1 as AgentTurnNumber }),
          new AgentTurnCompletedEvent({ ...baseFields(1), turnNumber: 1 as AgentTurnNumber, durationMs: 100 })
        ]

        const result = yield* reducer.reduce(reducer.initialReducedContext, events)

        expect(result.currentTurnNumber).toBe(1)
      }).pipe(Effect.provide(EventReducer.Default)))
  })

  describe("event counting", () => {
    it.effect("nextEventNumber increments for each event", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const events = [
          new UserMessageEvent({ ...baseFields(0), content: "First" }),
          new UserMessageEvent({ ...baseFields(1), content: "Second" }),
          new UserMessageEvent({ ...baseFields(2), content: "Third" })
        ]

        const result = yield* reducer.reduce(reducer.initialReducedContext, events)

        expect(result.nextEventNumber).toBe(3)
      }).pipe(Effect.provide(EventReducer.Default)))
  })

  describe("idempotency", () => {
    it.effect("reducing same events twice yields same result", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const events = [
          new SystemPromptEvent({ ...baseFields(0), content: "System" }),
          new UserMessageEvent({ ...baseFields(1), content: "Hello" })
        ]

        const result1 = yield* reducer.reduce(reducer.initialReducedContext, events)
        const result2 = yield* reducer.reduce(reducer.initialReducedContext, events)

        expect(result1.messages.length).toBe(result2.messages.length)
        expect(result1.nextEventNumber).toBe(result2.nextEventNumber)
      }).pipe(Effect.provide(EventReducer.Default)))
  })
})
