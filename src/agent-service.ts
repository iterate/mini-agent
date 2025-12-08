/**
 * Unified Agent Service
 *
 * Single service interface for all CLI modes (http server, piped, TUI, single turn).
 * Can be implemented as in-process (AgentRegistry) or HTTP client (remote server).
 */

import { HttpClient } from "@effect/platform"
import { Effect, Layer, Stream } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import type { ContextEvent } from "./domain.ts"
import type { AgentName } from "./domain.ts"

/**
 * Unified service for interacting with agents.
 * All CLI modes use this interface.
 */
export class AgentService extends Effect.Service<AgentService>()("@mini-agent/AgentService", {
  succeed: {
    /**
     * Add events to an agent. Returns immediately (fire-and-forget).
     */
    addEvents: (_args: {
      agentName: AgentName
      events: ReadonlyArray<ContextEvent>
    }): Effect.Effect<void> => Effect.void,

    /**
     * Subscribe to live event stream for an agent.
     * Returns a stream that includes existing events followed by live events.
     */
    tapEventStream: (_args: {
      agentName: AgentName
    }): Effect.Effect<Stream.Stream<ContextEvent, never>> => Effect.succeed(Stream.empty),

    /**
     * Get all events for an agent (current snapshot).
     */
    getEvents: (_args: {
      agentName: AgentName
    }): Effect.Effect<ReadonlyArray<ContextEvent>> => Effect.succeed([]),

    /**
     * End the session gracefully (emits SessionEndedEvent).
     */
    endSession: (_args: {
      agentName: AgentName
    }): Effect.Effect<void> => Effect.void,

    /**
     * Interrupt the current turn if one is in progress.
     */
    interruptTurn: (_args: {
      agentName: AgentName
    }): Effect.Effect<void> => Effect.void,

    /**
     * Check if agent is idle (no turn in progress).
     */
    isIdle: (_args: {
      agentName: AgentName
    }): Effect.Effect<boolean> => Effect.succeed(true)
  },
  accessors: true
}) {
  /**
   * In-process implementation using AgentRegistry.
   */
  static readonly InProcess: Layer.Layer<AgentService, never, AgentRegistry> = Layer.effect(
    AgentService,
    Effect.gen(function*() {
      const registry = yield* AgentRegistry

        return {
        addEvents: ({ agentName, events }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            for (const event of events) {
              yield* agent.addEvent(event)
            }
          }),

        tapEventStream: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            const existingEvents = yield* agent.getEvents
            const liveStream = yield* agent.tapEventStream
            return Stream.concat(Stream.fromIterable(existingEvents), liveStream)
          }),

        getEvents: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            return yield* agent.getEvents
          }),

        endSession: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            return yield* agent.endSession
          }),

        interruptTurn: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            return yield* agent.interruptTurn
          }),

        isIdle: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            return yield* agent.isIdle
          })
      } as AgentService
    })
  )

  /**
   * HTTP client implementation for remote server.
   * TODO: Implement proper HTTP client using @effect/platform HttpClient
   */
  static readonly HttpClient = (baseUrl: string): Layer.Layer<AgentService, never, HttpClient.HttpClient> =>
    Layer.succeed(
      AgentService,
      {
        addEvents: () => Effect.die(new Error("HttpClient AgentService not yet implemented")),
        tapEventStream: () => Effect.die(new Error("HttpClient AgentService not yet implemented")),
        getEvents: () => Effect.die(new Error("HttpClient AgentService not yet implemented")),
        endSession: () => Effect.die(new Error("HttpClient AgentService not yet implemented")),
        interruptTurn: () => Effect.die(new Error("HttpClient AgentService not yet implemented")),
        isIdle: () => Effect.die(new Error("HttpClient AgentService not yet implemented"))
      } as AgentService
    )
}
