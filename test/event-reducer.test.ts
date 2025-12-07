/**
 * EventReducer Tests
 *
 * Tests the pure reducer that folds events into ReducedContext.
 */
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Option, Schema } from "effect"
import type { AgentName, AgentTurnNumber, ContextName, EventId } from "../src/domain.ts"
import {
  AgentTurnCompletedEvent,
  AgentTurnStartedEvent,
  AssistantMessageEvent,
  ContextEvent,
  makeEventId,
  ReducedContext,
  SetLlmConfigEvent,
  SystemPromptEvent,
  UserMessageEvent
} from "../src/domain.ts"
import { EventReducer } from "../src/event-reducer.ts"

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

    it.effect("has no llmConfig initially", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const initial = reducer.initialReducedContext
        expect(Option.isNone(initial.llmConfig)).toBe(true)
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
    it.effect("SetLlmConfigEvent sets llmConfig", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const event = new SetLlmConfigEvent({
          ...baseFields(0),
          apiFormat: "anthropic",
          model: "claude-3-opus",
          baseUrl: "https://api.anthropic.com",
          apiKeyEnvVar: "ANTHROPIC_API_KEY"
        })

        const result = yield* reducer.reduce(reducer.initialReducedContext, [event])

        expect(Option.isSome(result.llmConfig)).toBe(true)
        const config = Option.getOrThrow(result.llmConfig)
        expect(config.apiFormat).toBe("anthropic")
        expect(config.model).toBe("claude-3-opus")
        expect(config.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY")
      }).pipe(Effect.provide(EventReducer.Default)))

    it.effect("SetLlmConfigEvent replaces previous config", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const event1 = new SetLlmConfigEvent({
          ...baseFields(0),
          apiFormat: "openai-responses",
          model: "gpt-4",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnvVar: "OPENAI_API_KEY"
        })
        const event2 = new SetLlmConfigEvent({
          ...baseFields(1),
          apiFormat: "anthropic",
          model: "claude-3-opus",
          baseUrl: "https://api.anthropic.com",
          apiKeyEnvVar: "ANTHROPIC_API_KEY"
        })

        const result = yield* reducer.reduce(reducer.initialReducedContext, [event1, event2])

        const config = Option.getOrThrow(result.llmConfig)
        expect(config.apiFormat).toBe("anthropic")
        expect(config.model).toBe("claude-3-opus")
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

  describe("JSON serialization", () => {
    it("parentEventId is omitted when None (not full Option object)", () => {
      const event = new UserMessageEvent({
        ...baseFields(0),
        content: "Hello"
      })

      const json = JSON.parse(JSON.stringify(Schema.encodeSync(ContextEvent)(event)))

      // parentEventId should be absent/undefined, not {"_id":"Option","_tag":"None"}
      expect(json.parentEventId).toBeUndefined()
      expect("parentEventId" in json).toBe(false)
    })

    it("parentEventId serializes to string when Some", () => {
      const parentId = "test-context:0001" as EventId
      const event = new UserMessageEvent({
        id: makeEventId(testContextName, 2),
        timestamp: DateTime.unsafeNow(),
        agentName: testAgentName,
        parentEventId: Option.some(parentId),
        triggersAgentTurn: false,
        content: "Hello"
      })

      const json = JSON.parse(JSON.stringify(Schema.encodeSync(ContextEvent)(event)))

      // parentEventId should serialize to the string value, not {"_id":"Option","_tag":"Some","value":"..."}
      expect(json.parentEventId).toBe(parentId)
    })
  })
})
