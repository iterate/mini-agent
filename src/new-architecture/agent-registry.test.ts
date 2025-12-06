/**
 * AgentRegistry Tests
 *
 * Tests the agent lifecycle management:
 * - Creating agents on demand (getOrCreate)
 * - Caching agents by name
 * - Listing active agents
 * - Shutting down individual agents
 * - Shutting down all agents
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import { type AgentName, type ContextEvent, MiniAgentTurn, type ReducedContext } from "./domain.ts"
import { EventReducer } from "./event-reducer.ts"
import { EventStore } from "./event-store.ts"

// Mock MiniAgentTurn
const MockTurn = Layer.sync(MiniAgentTurn, () =>
  ({
    execute: (_ctx: ReducedContext) => Stream.empty as Stream.Stream<ContextEvent, never>
  }) as unknown as MiniAgentTurn)

// Test layer with all dependencies
const TestLayer = Layer.mergeAll(
  EventReducer.Default,
  EventStore.InMemory,
  MockTurn
).pipe(Layer.provideMerge(AgentRegistry.Default))

describe("AgentRegistry", () => {
  describe("getOrCreate", () => {
    it.effect("creates new agent for unknown name", () =>
      Effect.gen(function*() {
        const registry = yield* AgentRegistry
        const agent = yield* registry.getOrCreate("new-agent" as AgentName)

        expect(agent.agentName).toBe("new-agent")
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("returns same agent for same name", () =>
      Effect.gen(function*() {
        const registry = yield* AgentRegistry

        const agent1 = yield* registry.getOrCreate("cached" as AgentName)
        const agent2 = yield* registry.getOrCreate("cached" as AgentName)

        // Same instance
        expect(agent1.agentName).toBe(agent2.agentName)
        expect(agent1.contextName).toBe(agent2.contextName)
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("creates different agents for different names", () =>
      Effect.gen(function*() {
        const registry = yield* AgentRegistry

        const agent1 = yield* registry.getOrCreate("agent-a" as AgentName)
        const agent2 = yield* registry.getOrCreate("agent-b" as AgentName)

        expect(agent1.agentName).not.toBe(agent2.agentName)
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("assigns contextName based on agentName", () =>
      Effect.gen(function*() {
        const registry = yield* AgentRegistry
        const agent = yield* registry.getOrCreate("my-agent" as AgentName)

        // Context name should contain agent name
        expect(agent.contextName.includes("my-agent")).toBe(true)
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))
  })

  describe("get", () => {
    it.effect("fails for non-existent agent", () =>
      Effect.gen(function*() {
        const registry = yield* AgentRegistry
        const result = yield* registry.get("non-existent" as AgentName).pipe(
          Effect.either
        )

        expect(result._tag).toBe("Left")
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("returns agent after getOrCreate", () =>
      Effect.gen(function*() {
        const registry = yield* AgentRegistry

        yield* registry.getOrCreate("exists" as AgentName)
        const agent = yield* registry.get("exists" as AgentName)

        expect(agent.agentName).toBe("exists")
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))
  })

  describe("list", () => {
    it.effect("returns empty array when no agents", () =>
      Effect.gen(function*() {
        const registry = yield* AgentRegistry
        const agents = yield* registry.list

        expect(agents).toEqual([])
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("returns all created agents", () =>
      Effect.gen(function*() {
        const registry = yield* AgentRegistry

        yield* registry.getOrCreate("agent-1" as AgentName)
        yield* registry.getOrCreate("agent-2" as AgentName)
        yield* registry.getOrCreate("agent-3" as AgentName)

        const agents = yield* registry.list

        expect(agents.length).toBe(3)
        expect(agents).toContain("agent-1")
        expect(agents).toContain("agent-2")
        expect(agents).toContain("agent-3")
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))
  })

  describe("shutdownAgent", () => {
    it.effect("fails for non-existent agent", () =>
      Effect.gen(function*() {
        const registry = yield* AgentRegistry
        const result = yield* registry.shutdownAgent("non-existent" as AgentName).pipe(
          Effect.either
        )

        expect(result._tag).toBe("Left")
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("removes agent from registry", () =>
      Effect.gen(function*() {
        const registry = yield* AgentRegistry

        yield* registry.getOrCreate("to-remove" as AgentName)
        yield* registry.shutdownAgent("to-remove" as AgentName)

        const agents = yield* registry.list
        expect(agents).not.toContain("to-remove")
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))
  })

  describe("shutdownAll", () => {
    it.effect("clears all agents", () =>
      Effect.gen(function*() {
        const registry = yield* AgentRegistry

        yield* registry.getOrCreate("agent-1" as AgentName)
        yield* registry.getOrCreate("agent-2" as AgentName)
        yield* registry.shutdownAll

        const agents = yield* registry.list
        expect(agents).toEqual([])
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))
  })

  describe("test isolation", () => {
    it.effect("first test creates agent", () =>
      Effect.gen(function*() {
        const registry = yield* AgentRegistry
        yield* registry.getOrCreate("isolation" as AgentName)

        const agents = yield* registry.list
        expect(agents).toContain("isolation")
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))

    it.effect("second test has fresh registry", () =>
      Effect.gen(function*() {
        const registry = yield* AgentRegistry
        const agents = yield* registry.list

        // Should not see agent from previous test
        expect(agents).not.toContain("isolation")
      }).pipe(
        Effect.scoped,
        Effect.provide(TestLayer)
      ))
  })
})
