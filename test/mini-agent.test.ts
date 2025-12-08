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
import { Chunk, DateTime, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import type { AgentName, AgentTurnNumber, ContextEvent, ContextName, EventId, ReducedContext } from "../src/domain.ts"
import {
  AgentError,
  AssistantMessageEvent,
  makeBaseEventFields,
  MiniAgentTurn,
  SystemPromptEvent,
  TextDeltaEvent,
  UserMessageEvent,
  withParentEventId
} from "../src/domain.ts"
import { EventReducer } from "../src/event-reducer.ts"
import { EventStore } from "../src/event-store.ts"
import type { ActorState } from "../src/mini-agent.ts"
import { makeExecuteTurn, makeMiniAgent } from "../src/mini-agent.ts"

const testAgentName = "test-agent" as AgentName
const testContextName = "test-context" as ContextName

/**
 * Wait for an event with a specific tag to be processed.
 * Since addEvent is fire-and-forget, we need to wait for the event
 * to appear before checking state. Polls getEvents until the event is found.
 */
const waitForEventTag = (
  agent: { getEvents: Effect.Effect<ReadonlyArray<ContextEvent>> },
  tag: string
) =>
  Effect.gen(function*() {
    // Poll until the event appears in getEvents
    yield* Effect.iterate(0, {
      while: () => true,
      body: () =>
        Effect.gen(function*() {
          const events = yield* agent.getEvents
          if (events.some((e) => e._tag === tag)) {
            return Effect.fail("found" as const)
          }
          yield* Effect.sleep("10 millis")
          return Effect.succeed(0)
        }).pipe(Effect.flatten)
    }).pipe(
      Effect.catchAll(() => Effect.void),
      Effect.timeout("5 seconds"),
      Effect.orDie
    )
  })

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
  apiFormat: Option.none(),
  cause: Option.none()
})

describe("MiniAgent", () => {
  describe("creation", () => {
    it.effect("emits SessionStartedEvent on creation", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)
        // Wait for SessionStartedEvent to be processed (fire-and-forget)
        yield* waitForEventTag(agent, "SessionStartedEvent")
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
        const ctx = yield* agent.getState
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

        const event = new UserMessageEvent({
          ...makeBaseEventFields(testAgentName, testContextName, 1, true),
          content: "Hello"
        })
        yield* agent.addEvent(event)
        // Wait for event to be processed (fire-and-forget)
        yield* waitForEventTag(agent, "UserMessageEvent")

        const stored = yield* store.load(testContextName)
        expect(stored.some((e) => e._tag === "UserMessageEvent")).toBe(true)
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("updates reducedContext", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)

        const event = new UserMessageEvent({
          ...makeBaseEventFields(testAgentName, testContextName, 1, true),
          content: "Hello"
        })
        yield* agent.addEvent(event)
        // Wait for event to be processed (fire-and-forget)
        yield* waitForEventTag(agent, "UserMessageEvent")

        const ctx = yield* agent.getState
        // SessionStarted (1) + UserMessage (1) = 2
        expect(ctx.nextEventNumber).toBe(2)
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("adds message to reducedContext", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)

        yield* agent.addEvent(
          new UserMessageEvent({
            ...makeBaseEventFields(testAgentName, testContextName, 1, true),
            content: "Hello"
          })
        )
        // Wait for event to be processed (fire-and-forget)
        yield* waitForEventTag(agent, "UserMessageEvent")

        const ctx = yield* agent.getState
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
        // Wait for initial SessionStartedEvent
        yield* waitForEventTag(agent, "SessionStartedEvent")

        // Subscribe for UserMessages
        const stream = yield* agent.tapEventStream
        const collector = yield* stream.pipe(
          Stream.filter((e) => e._tag === "UserMessageEvent"),
          Stream.take(2),
          Stream.runCollect,
          Effect.fork
        )

        yield* agent.addEvent(
          new UserMessageEvent({
            ...makeBaseEventFields(testAgentName, testContextName, 1, true),
            content: "First"
          })
        )
        yield* agent.addEvent(
          new UserMessageEvent({
            ...makeBaseEventFields(testAgentName, testContextName, 2, true),
            content: "Second"
          })
        )

        // Wait for both UserMessages to be processed
        yield* Fiber.join(collector)

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

  describe("getState", () => {
    it.effect("accumulates multiple messages", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)
        // Wait for initial SessionStartedEvent
        yield* waitForEventTag(agent, "SessionStartedEvent")

        // Subscribe for the 3 messages
        const stream = yield* agent.tapEventStream
        const collector = yield* stream.pipe(
          Stream.filter((e) => e._tag === "AssistantMessageEvent"),
          Stream.take(1),
          Stream.runCollect,
          Effect.fork
        )

        yield* agent.addEvent(
          new SystemPromptEvent({
            ...makeBaseEventFields(testAgentName, testContextName, 1, false),
            content: "System"
          })
        )
        yield* agent.addEvent(
          new UserMessageEvent({
            ...makeBaseEventFields(testAgentName, testContextName, 2, true),
            content: "Hello"
          })
        )
        yield* agent.addEvent(
          new AssistantMessageEvent({
            ...makeBaseEventFields(testAgentName, testContextName, 3, false),
            content: "Hi there"
          })
        )

        // Wait for AssistantMessage (last one) to be processed
        yield* Fiber.join(collector)

        const ctx = yield* agent.getState
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
        // Wait for initial SessionStartedEvent
        yield* waitForEventTag(agent, "SessionStartedEvent")

        // SessionStarted = 1
        let ctx = yield* agent.getState
        expect(ctx.nextEventNumber).toBe(1)

        // Subscribe for the 3 UserMessages
        const stream = yield* agent.tapEventStream
        const collector = yield* stream.pipe(
          Stream.filter((e) => e._tag === "UserMessageEvent"),
          Stream.take(3),
          Stream.runCollect,
          Effect.fork
        )

        // Add 3 more events
        yield* agent.addEvent(
          new UserMessageEvent({
            ...makeBaseEventFields(testAgentName, testContextName, 1, true),
            content: "One"
          })
        )
        yield* agent.addEvent(
          new UserMessageEvent({
            ...makeBaseEventFields(testAgentName, testContextName, 2, true),
            content: "Two"
          })
        )
        yield* agent.addEvent(
          new UserMessageEvent({
            ...makeBaseEventFields(testAgentName, testContextName, 3, true),
            content: "Three"
          })
        )

        // Wait for all 3 to be processed
        yield* Fiber.join(collector)

        ctx = yield* agent.getState
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

        // Wait for SessionStartedEvent on both agents
        yield* waitForEventTag(agent1, "SessionStartedEvent")
        yield* waitForEventTag(agent2, "SessionStartedEvent")

        yield* agent1.addEvent(
          new UserMessageEvent({
            ...makeBaseEventFields("agent-1" as AgentName, "context-1" as ContextName, 1, true),
            content: "Agent 1"
          })
        )
        // Wait for UserMessage to be processed
        yield* waitForEventTag(agent1, "UserMessageEvent")

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

  describe("context resumption", () => {
    it.effect("SessionStartedEvent uses correct ID when resuming context with existing events", () =>
      Effect.gen(function*() {
        const store = yield* EventStore
        const contextName = "resume-test-context" as ContextName

        // Pre-populate store with events (simulating a prior session)
        const existingEvents = [
          new SystemPromptEvent({
            ...makeBaseEventFields(testAgentName, contextName, 0, false),
            content: "System prompt"
          }),
          new UserMessageEvent({
            ...makeBaseEventFields(testAgentName, contextName, 1, true),
            content: "Hello"
          }),
          new AssistantMessageEvent({
            ...makeBaseEventFields(testAgentName, contextName, 2, false),
            content: "Hi there"
          })
        ]
        yield* store.append(contextName, existingEvents)

        // Create agent that loads the existing events
        const agent = yield* makeMiniAgent(testAgentName, contextName)
        // Wait for SessionStartedEvent to be processed
        yield* waitForEventTag(agent, "SessionStartedEvent")

        const events = yield* agent.getEvents

        // Should have 3 existing + 1 new SessionStartedEvent = 4 events
        expect(events.length).toBe(4)

        // The new SessionStartedEvent should have ID 3 (next after existing 0,1,2)
        const sessionStarted = events.find((e) => e._tag === "SessionStartedEvent")
        expect(sessionStarted).toBeDefined()
        expect(sessionStarted!.id).toBe(`${contextName}:0003`)
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))
  })

  describe("event chain (blockchain model)", () => {
    it.effect("events form a chain - each event (except genesis) has parentEventId pointing to previous event", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)
        // Wait for initial SessionStartedEvent
        yield* waitForEventTag(agent, "SessionStartedEvent")

        // Subscribe for the 2 UserMessages
        const stream = yield* agent.tapEventStream
        const collector = yield* stream.pipe(
          Stream.filter((e) => e._tag === "UserMessageEvent"),
          Stream.take(2),
          Stream.runCollect,
          Effect.fork
        )

        // Add some user messages (not triggering turn to avoid async complexity)
        yield* agent.addEvent(
          new UserMessageEvent({
            ...makeBaseEventFields(testAgentName, testContextName, 100, false),
            content: "First"
          })
        )
        yield* agent.addEvent(
          new UserMessageEvent({
            ...makeBaseEventFields(testAgentName, testContextName, 101, false),
            content: "Second"
          })
        )

        // Wait for both to be processed
        yield* Fiber.join(collector)

        const events = yield* agent.getEvents

        // Should have: SessionStarted + 2 UserMessages = 3
        expect(events.length).toBe(3)

        // First event (SessionStartedEvent) should have no parent (genesis)
        expect(events[0]!._tag).toBe("SessionStartedEvent")
        expect(Option.isNone(events[0]!.parentEventId)).toBe(true)

        // Second event should point to first event (the genesis)
        expect(events[1]!._tag).toBe("UserMessageEvent")
        expect(Option.isSome(events[1]!.parentEventId)).toBe(true)
        expect(Option.getOrNull(events[1]!.parentEventId)).toBe(events[0]!.id)

        // Third event should point to second event
        expect(events[2]!._tag).toBe("UserMessageEvent")
        expect(Option.isSome(events[2]!.parentEventId)).toBe(true)
        expect(Option.getOrNull(events[2]!.parentEventId)).toBe(events[1]!.id)
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("all events (except genesis) have Some parentEventId", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)
        // Wait for initial SessionStartedEvent
        yield* waitForEventTag(agent, "SessionStartedEvent")

        // Add events
        yield* agent.addEvent(
          new UserMessageEvent({
            ...makeBaseEventFields(testAgentName, testContextName, 100, false),
            content: "Hello"
          })
        )
        // Wait for UserMessage to be processed
        yield* waitForEventTag(agent, "UserMessageEvent")

        const events = yield* agent.getEvents

        // First event has no parent
        expect(Option.isNone(events[0]!.parentEventId)).toBe(true)

        // All subsequent events must have a parent
        for (let i = 1; i < events.length; i++) {
          expect(Option.isSome(events[i]!.parentEventId)).toBe(true)
        }
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
          reducedContext: reducer.initialReducedContext,
          lastEventId: Option.none()
        })

        const addEvent = (event: ContextEvent): Effect.Effect<void> =>
          Effect.gen(function*() {
            const state = yield* Ref.get(stateRef)
            const chainedEvent = withParentEventId(event, state.lastEventId)
            const newEvents = [...state.events, chainedEvent]
            const newReducedContext = yield* reducer.reduce(state.reducedContext, [chainedEvent])
            yield* Ref.set(stateRef, {
              events: newEvents,
              reducedContext: newReducedContext,
              lastEventId: Option.some(chainedEvent.id)
            })
          }).pipe(Effect.orDie)

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

    it.effect("turn events form a chain with previous events (not just to AgentTurnStartedEvent)", () =>
      Effect.gen(function*() {
        const reducer = yield* EventReducer
        const stateRef = yield* Ref.make<ActorState>({
          events: [],
          reducedContext: reducer.initialReducedContext,
          lastEventId: Option.none()
        })

        // Simplified addEvent that maintains chain (simulates actual behavior)
        const addEvent = (event: ContextEvent): Effect.Effect<void> =>
          Effect.gen(function*() {
            const state = yield* Ref.get(stateRef)
            const chainedEvent = withParentEventId(event, state.lastEventId)
            const newEvents = [...state.events, chainedEvent]
            const newReducedContext = yield* reducer.reduce(state.reducedContext, [chainedEvent])
            yield* Ref.set(stateRef, {
              events: newEvents,
              reducedContext: newReducedContext,
              lastEventId: Option.some(chainedEvent.id)
            })
          }).pipe(Effect.orDie)

        // Mock turn service that emits events during LLM turn
        const mockTurnEvents: Array<ContextEvent> = [
          new TextDeltaEvent({
            id: "llm-turn-1" as EventId,
            timestamp: DateTime.unsafeNow(),
            agentName: "llm-turn" as AgentName,
            parentEventId: Option.none(),
            triggersAgentTurn: false,
            delta: "Hello"
          }),
          new AssistantMessageEvent({
            id: "llm-turn-2" as EventId,
            timestamp: DateTime.unsafeNow(),
            agentName: "llm-turn" as AgentName,
            parentEventId: Option.none(),
            triggersAgentTurn: false,
            content: "Hello"
          })
        ]

        const executeTurn = makeExecuteTurn({
          agentName: testAgentName,
          contextName: testContextName,
          stateRef,
          addEvent,
          turnService: {
            execute: (_ctx: ReducedContext) => Stream.fromIterable(mockTurnEvents)
          } as unknown as MiniAgentTurn
        })

        yield* executeTurn(1 as AgentTurnNumber)

        const events = yield* Ref.get(stateRef).pipe(Effect.map((s) => s.events))

        // Events should form a chain: TurnStarted -> TextDelta -> AssistantMessage -> TurnCompleted
        expect(events.length).toBe(4)
        expect(events[0]!._tag).toBe("AgentTurnStartedEvent")
        expect(events[1]!._tag).toBe("TextDeltaEvent")
        expect(events[2]!._tag).toBe("AssistantMessageEvent")
        expect(events[3]!._tag).toBe("AgentTurnCompletedEvent")

        // First event has no parent (genesis of this test)
        expect(Option.isNone(events[0]!.parentEventId)).toBe(true)

        // Each subsequent event points to previous
        expect(Option.getOrNull(events[1]!.parentEventId)).toBe(events[0]!.id)
        expect(Option.getOrNull(events[2]!.parentEventId)).toBe(events[1]!.id)
        expect(Option.getOrNull(events[3]!.parentEventId)).toBe(events[2]!.id)
      }).pipe(
        Effect.scoped,
        Effect.provide(EventReducer.Default)
      ))
  })

  describe("subscription timing", () => {
    it.effect("subscribe guarantees subscription is established before effect completes", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)

        // Subscribe to events - when this completes, subscription MUST be established
        const eventStream = yield* agent.tapEventStream

        // Fork collection of events - no sleep needed because subscription is guaranteed
        const collectorFiber = yield* eventStream.pipe(
          Stream.filter((e) => e._tag === "UserMessageEvent"),
          Stream.take(1),
          Stream.runCollect,
          Effect.fork
        )

        // Immediately add event - subscription should catch it
        const userEvent = new UserMessageEvent({
          ...makeBaseEventFields(testAgentName, testContextName, 100, false),
          content: "Test message"
        })
        yield* agent.addEvent(userEvent)

        // Wait for collector with timeout
        const maybeCollected = yield* Fiber.join(collectorFiber).pipe(
          Effect.timeoutOption("1 second")
        )

        // Should have received the UserMessageEvent (not timed out)
        expect(Option.isSome(maybeCollected)).toBe(true)
        const collected = Option.getOrThrow(maybeCollected)
        const events = Chunk.toArray(collected)
        expect(events.length).toBe(1)
        expect(events[0]?._tag).toBe("UserMessageEvent")
        expect((events[0] as UserMessageEvent).content).toBe("Test message")
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("subscribe receives events added immediately after subscription", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)

        // Subscribe and immediately add multiple events
        const eventStream = yield* agent.tapEventStream

        const collectorFiber = yield* eventStream.pipe(
          Stream.filter((e) => e._tag === "UserMessageEvent"),
          Stream.take(3),
          Stream.runCollect,
          Effect.fork
        )

        // Add 3 events immediately - no delays
        yield* agent.addEvent(
          new UserMessageEvent({
            ...makeBaseEventFields(testAgentName, testContextName, 100, false),
            content: "First"
          })
        )
        yield* agent.addEvent(
          new UserMessageEvent({
            ...makeBaseEventFields(testAgentName, testContextName, 101, false),
            content: "Second"
          })
        )
        yield* agent.addEvent(
          new UserMessageEvent({
            ...makeBaseEventFields(testAgentName, testContextName, 102, false),
            content: "Third"
          })
        )

        const maybeCollected = yield* Fiber.join(collectorFiber).pipe(
          Effect.timeoutOption("1 second")
        )

        expect(Option.isSome(maybeCollected)).toBe(true)
        const collected = Option.getOrThrow(maybeCollected)
        const events = Chunk.toArray(collected)
        expect(events.length).toBe(3)
        expect((events[0] as UserMessageEvent).content).toBe("First")
        expect((events[1] as UserMessageEvent).content).toBe("Second")
        expect((events[2] as UserMessageEvent).content).toBe("Third")
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))
  })

  describe("interruptTurn", () => {
    it.effect("interruptTurn when idle does nothing", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)
        const eventsBefore = yield* agent.getEvents
        const countBefore = eventsBefore.length

        // Call interruptTurn when no turn is in progress
        yield* agent.interruptTurn

        // No new events should be added
        const eventsAfter = yield* agent.getEvents
        expect(eventsAfter.length).toBe(countBefore)
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))
  })

  describe("endSession broadcast timing", () => {
    it.effect("SessionEndedEvent is broadcast to subscribers before mailbox closes", () =>
      Effect.gen(function*() {
        const agent = yield* makeMiniAgent(testAgentName, testContextName)
        // Wait for initial SessionStartedEvent to be processed
        yield* waitForEventTag(agent, "SessionStartedEvent")

        // Subscribe to events - we want to receive SessionEndedEvent
        const eventStream = yield* agent.tapEventStream

        // Fork a collector that waits for SessionEndedEvent
        const collectorFiber = yield* eventStream.pipe(
          Stream.filter((e) => e._tag === "SessionEndedEvent"),
          Stream.take(1),
          Stream.runCollect,
          Effect.fork
        )

        // End the session - this should broadcast SessionEndedEvent BEFORE closing mailbox
        yield* agent.endSession

        // Wait for collector - should receive SessionEndedEvent
        const maybeCollected = yield* Fiber.join(collectorFiber).pipe(
          Effect.timeoutOption("1 second")
        )

        // The test fails if SessionEndedEvent wasn't broadcast before mailbox closed
        expect(Option.isSome(maybeCollected)).toBe(true)
        const collected = Option.getOrThrow(maybeCollected)
        const events = Chunk.toArray(collected)
        expect(events.length).toBe(1)
        expect(events[0]?._tag).toBe("SessionEndedEvent")
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))
  })
})
