/**
 * MiniAgent Tests
 *
 * Tests the core actor functionality:
 * - Event addition and persistence
 * - State derivation via reducer
 * - Session lifecycle events
 *
 * All tests use mocked services - no actual LLM calls.
 * Tests focus on synchronous state checks to avoid stream timing complexity.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Ref, Stream } from "effect"
import type { AgentName, AgentTurnNumber, ContextEvent, ContextName, LlmProviderId, ReducedContext } from "./domain.ts"
import { AgentError, EventBuilder, MiniAgentTurn } from "./domain.ts"
import { EventReducer } from "./event-reducer.ts"
import { EventStore } from "./event-store.ts"
import type { ActorState } from "./mini-agent.ts"
import { makeExecuteTurn, makeMiniAgent } from "./mini-agent.ts"

const testAgentName = "test-agent" as AgentName
const testContextName = "test-context" as ContextName

// Mock MiniAgentTurn that doesn't make LLM calls
const MockTurn = Layer.sync(MiniAgentTurn, () =>
  ({
    execute: (_ctx: ReducedContext) => Stream.empty as Stream.Stream<ContextEvent, never>
  }) as unknown as MiniAgentTurn)

// Layer with all test dependencies
const TestLayer = Layer.mergeAll(
  EventReducer.Default,
  EventStore.InMemory,
  MockTurn
)

const failingAgentError = new AgentError({
  message: "test turn failure",
  provider: "test-provider" as LlmProviderId,
  cause: Option.none()
})

describe("MiniAgent", () => {
  describe("creation", () => {
    it.effect("emits SessionStartedEvent on creation", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)
        const events = yield* agent.getEvents
        expect(events.some((e) => e._tag === "SessionStartedEvent")).toBe(true)
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("has correct agentName and contextName", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)
        expect(agent.agentName).toBe(testAgentName)
        expect(agent.contextName).toBe(testContextName)
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("initializes with empty messages in reducedContext", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)
        const ctx = yield* agent.getReducedContext
        // SessionStartedEvent doesn't add to messages array
        expect(ctx.messages).toEqual([])
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))
  })

  describe("addEvent", () => {
    it.effect("persists event to store", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)
        const store = yield* EventStore

        const event = EventBuilder.userMessage(testAgentName, testContextName, 1, "Hello")
        yield* agent.addEvent(event)

        const stored = yield* store.load(testContextName)
        expect(stored.some((e) => e._tag === "UserMessageEvent")).toBe(true)
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("updates reducedContext", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)

        const event = EventBuilder.userMessage(testAgentName, testContextName, 1, "Hello")
        yield* agent.addEvent(event)

        const ctx = yield* agent.getReducedContext
        // SessionStarted (1) + UserMessage (1) = 2
        expect(ctx.nextEventNumber).toBe(2)
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("adds message to reducedContext", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)

        yield* agent.addEvent(EventBuilder.userMessage(testAgentName, testContextName, 1, "Hello"))

        const ctx = yield* agent.getReducedContext
        expect(ctx.messages.length).toBe(1)
        expect(ctx.messages[0]?.role).toBe("user")
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))
  })

  describe("getEvents", () => {
    it.effect("returns all historical events in order", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)

        yield* agent.addEvent(EventBuilder.userMessage(testAgentName, testContextName, 1, "First"))
        yield* agent.addEvent(EventBuilder.userMessage(testAgentName, testContextName, 2, "Second"))

        const events = yield* agent.getEvents
        // SessionStarted + 2 UserMessages
        expect(events.length).toBe(3)
        expect(events[0]?._tag).toBe("SessionStartedEvent")
        expect(events[1]?._tag).toBe("UserMessageEvent")
        expect(events[2]?._tag).toBe("UserMessageEvent")
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))
  })

  describe("getReducedContext", () => {
    it.effect("accumulates multiple messages", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)

        yield* agent.addEvent(EventBuilder.systemPrompt(testAgentName, testContextName, 1, "System"))
        yield* agent.addEvent(EventBuilder.userMessage(testAgentName, testContextName, 2, "Hello"))
        yield* agent.addEvent(EventBuilder.assistantMessage(testAgentName, testContextName, 3, "Hi there"))

        const ctx = yield* agent.getReducedContext
        expect(ctx.messages.length).toBe(3)
        expect(ctx.messages[0]?.role).toBe("system")
        expect(ctx.messages[1]?.role).toBe("user")
        expect(ctx.messages[2]?.role).toBe("assistant")
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("tracks nextEventNumber correctly", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)

        // SessionStarted = 1
        let ctx = yield* agent.getReducedContext
        expect(ctx.nextEventNumber).toBe(1)

        // Add 3 more events
        yield* agent.addEvent(EventBuilder.userMessage(testAgentName, testContextName, 1, "One"))
        yield* agent.addEvent(EventBuilder.userMessage(testAgentName, testContextName, 2, "Two"))
        yield* agent.addEvent(EventBuilder.userMessage(testAgentName, testContextName, 3, "Three"))

        ctx = yield* agent.getReducedContext
        expect(ctx.nextEventNumber).toBe(4)
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))
  })

  describe("state isolation", () => {
    it.effect("different agents have independent state", () =>
      Effect.gen(function*() {
        const agent1 = yield* makeMiniAgent("agent-1" as AgentName, "context-1" as ContextName)
        const agent2 = yield* makeMiniAgent("agent-2" as AgentName, "context-2" as ContextName)

        yield* agent1.addEvent(
          EventBuilder.userMessage("agent-1" as AgentName, "context-1" as ContextName, 1, "Agent 1")
        )

        const events1 = yield* agent1.getEvents
        const events2 = yield* agent2.getEvents

        // Agent 1: SessionStarted + UserMessage
        expect(events1.length).toBe(2)
        // Agent 2: Only SessionStarted
        expect(events2.length).toBe(1)
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))
  })

  describe("executeTurn", () => {
    it.effect("emits AgentTurnFailedEvent when MiniAgentTurn fails", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const stateRef = yield* Ref.make<ActorState>({
          events: [],
          reducedContext: reducer.initialReducedContext
        })

        const addEvent = (event: ContextEvent) =>
          Effect.gen(function*() {
            const state = yield* Ref.get(stateRef)
            const newEvents = [...state.events, event]
            const newReducedContext = yield* reducer.reduce(state.reducedContext, [event])
            yield* Ref.set(stateRef, { events: newEvents, reducedContext: newReducedContext })
          })

        const executeTurn = makeExecuteTurn({
          agentName: testAgentName,
          contextName: testContextName,
          stateRef,
          addEvent,
          turnService: {
            execute: (_ctx: ReducedContext) => Stream.fail(failingAgentError)
          } as unknown as MiniAgentTurn
        })

        yield* executeTurn(1 as AgentTurnNumber)

        const events = yield* Ref.get(stateRef).pipe(Effect.map((s) => s.events))
        expect(events.some((event) => event._tag === "AgentTurnFailedEvent")).toBe(true)
        expect(events.some((event) => event._tag === "AgentTurnCompletedEvent")).toBe(false)
      }).pipe(
        Effect.scoped,
        Effect.provide(EventReducer.Default)
      ))
  })
})
