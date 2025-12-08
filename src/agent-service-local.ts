/**
 * LocalAgentService - In-process implementation of AgentService.
 *
 * Delegates to AgentRegistry for agent management. This is the implementation
 * used when running mini-agent locally (CLI, TUI, local HTTP server).
 */

import type { Effect, Layer, Scope, Stream } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import { AgentService, type AgentServiceError } from "./agent-service.ts"
import type { AgentName, ContextEvent, ReducedContext } from "./domain.ts"

/**
 * LocalAgentService implementation using AgentRegistry.
 *
 * Each method delegates to the MiniAgent instance obtained from AgentRegistry.
 */
export const LocalAgentServiceLive: Layer.Layer<AgentService, never, AgentRegistry> = Layer.effect(
  AgentService,
  Effect.gen(function*() {
    const registry = yield* AgentRegistry

    const addEvents = (
      agentName: AgentName,
      events: ReadonlyArray<ContextEvent>
    ): Effect.Effect<void, AgentServiceError> =>
      Effect.gen(function*() {
        const agent = yield* registry.getOrCreate(agentName)
        for (const event of events) {
          yield* agent.addEvent(event)
        }
      })

    const tapEventStream = (
      agentName: AgentName
    ): Effect.Effect<Stream.Stream<ContextEvent, never>, AgentServiceError, Scope.Scope> =>
      Effect.gen(function*() {
        const agent = yield* registry.getOrCreate(agentName)
        return yield* agent.tapEventStream
      })

    const getEvents = (agentName: AgentName): Effect.Effect<ReadonlyArray<ContextEvent>, AgentServiceError> =>
      Effect.gen(function*() {
        const agent = yield* registry.getOrCreate(agentName)
        return yield* agent.getEvents
      })

    const getState = (agentName: AgentName): Effect.Effect<ReducedContext, AgentServiceError> =>
      Effect.gen(function*() {
        const agent = yield* registry.getOrCreate(agentName)
        return yield* agent.getState
      })

    const isIdle = (agentName: AgentName): Effect.Effect<boolean, AgentServiceError> =>
      Effect.gen(function*() {
        const agent = yield* registry.getOrCreate(agentName)
        return yield* agent.isIdle
      })

    const endSession = (agentName: AgentName): Effect.Effect<void, AgentServiceError> =>
      Effect.gen(function*() {
        const agent = yield* registry.getOrCreate(agentName)
        yield* agent.endSession
      })

    const interruptTurn = (agentName: AgentName): Effect.Effect<void, AgentServiceError> =>
      Effect.gen(function*() {
        const agent = yield* registry.getOrCreate(agentName)
        yield* agent.interruptTurn
      })

    const list = (): Effect.Effect<ReadonlyArray<AgentName>> => registry.list

    return {
      addEvents,
      tapEventStream,
      getEvents,
      getState,
      isIdle,
      endSession,
      interruptTurn,
      list
    } as unknown as AgentService
  })
)

/**
 * Convenience layer that includes AgentRegistry and its dependencies.
 * Use this for production/CLI usage.
 */
export const LocalAgentServiceDefault = LocalAgentServiceLive.pipe(
  Layer.provide(AgentRegistry.Default)
)
