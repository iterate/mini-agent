/**
 * AgentService - Unified service for all CLI modes.
 *
 * This is the single service interface used by:
 * - HTTP server
 * - Piped input mode
 * - TUI mode
 * - Single-turn mode
 *
 * Implementations:
 * - InProcess: runs MiniAgent actors locally
 * - HttpClient: connects to remote mini-agent server
 */

import { Effect, Option, type Scope, Stream } from "effect"
import type { AgentName, ContextEvent, ReducedContext } from "./domain.ts"

/**
 * AgentService provides a clean interface for all agent interactions.
 * All modes (HTTP, CLI, TUI) use this same interface.
 */
export class AgentService extends Effect.Service<AgentService>()("@mini-agent/AgentService", {
  succeed: {
    /**
     * Add events to an agent. Creates agent if it doesn't exist.
     * Fire-and-forget: queues events for processing and returns immediately.
     */
    addEvents: (_params: {
      agentName: AgentName
      events: ReadonlyArray<ContextEvent>
    }): Effect.Effect<void> => Effect.void,

    /**
     * Subscribe to live events from an agent.
     * Returns an Effect that, when it completes, guarantees the subscription is established.
     * The returned stream receives events added after subscription.
     */
    tapEventStream: (_params: {
      agentName: AgentName
    }): Effect.Effect<Stream.Stream<ContextEvent>, never, Scope.Scope> => Effect.succeed(Stream.empty),

    /**
     * Get all historical events for an agent.
     */
    getEvents: (_params: {
      agentName: AgentName
    }): Effect.Effect<ReadonlyArray<ContextEvent>> => Effect.succeed([]),

    /**
     * Get the current reduced state for an agent.
     */
    getState: (_params: {
      agentName: AgentName
    }): Effect.Effect<ReducedContext> =>
      Effect.succeed({
        messages: [],
        llmConfig: Option.none(),
        nextEventNumber: 0,
        currentTurnNumber: 0 as never,
        agentTurnStartedAtEventId: Option.none()
      } as unknown as ReducedContext),

    /**
     * Add events and stream back until the agent is idle.
     * Useful for HTTP endpoints that want to stream responses.
     * Returns existing events + new events until idle for idleTimeoutMs.
     */
    addEventsAndStreamUntilIdle: (_params: {
      agentName: AgentName
      events: ReadonlyArray<ContextEvent>
      idleTimeoutMs?: number
    }): Stream.Stream<ContextEvent> => Stream.empty,

    /**
     * Gracefully end an agent session.
     */
    endSession: (_params: {
      agentName: AgentName
    }): Effect.Effect<void> => Effect.void,

    /**
     * Interrupt the current turn if one is in progress.
     */
    interruptTurn: (_params: {
      agentName: AgentName
    }): Effect.Effect<void> => Effect.void,

    /**
     * Check if agent is currently idle (no turn in progress).
     */
    isIdle: (_params: {
      agentName: AgentName
    }): Effect.Effect<boolean> => Effect.succeed(true),

    /**
     * List all active agents.
     */
    listAgents: (): Effect.Effect<ReadonlyArray<AgentName>> => Effect.succeed([])
  },
  accessors: true
}) {}

// InProcess implementation is provided by AgentRegistry.InProcessAgentService
