/**
 * AgentService - Unified interface for all CLI modes.
 *
 * Abstracts agent operations behind a clean interface that can be implemented:
 * - LocalAgentService: In-process using AgentRegistry and MiniAgent
 * - RemoteAgentService: HTTP client connecting to a remote mini-agent server
 *
 * All CLI modes (single-turn, pipe, script, TUI, HTTP server) use this service.
 */

import { Effect, type Scope, Stream } from "effect"
import type {
  AgentName,
  ContextEvent,
  ContextLoadError,
  ContextSaveError,
  ReducedContext,
  ReducerError
} from "./domain.ts"

/** Errors that can occur during agent service operations */
export type AgentServiceError = ReducerError | ContextLoadError | ContextSaveError

/**
 * AgentService - The unified interface for all agent operations.
 *
 * Design:
 * - addEvents: Fire-and-forget event addition (triggers LLM turn if triggersAgentTurn=true)
 * - tapEventStream: Subscribe to live event stream (returns Effect that guarantees subscription)
 * - getEvents: Get all historical events
 * - getState: Get reduced context (messages, config, etc.)
 * - isIdle: Check if no LLM turn is in progress
 * - endSession: Gracefully end session with proper cleanup
 */
export class AgentService extends Effect.Service<AgentService>()("@mini-agent/AgentService", {
  effect: Effect.succeed({
    /** Add events to an agent. Events with triggersAgentTurn=true start LLM turns. */
    addEvents: (_agentName: AgentName, _events: ReadonlyArray<ContextEvent>): Effect.Effect<void, AgentServiceError> =>
      Effect.void,

    /**
     * Subscribe to live event stream for an agent.
     * Returns Effect that guarantees subscription is established when it completes.
     * The returned stream is scoped to the caller's scope.
     */
    tapEventStream: (
      _agentName: AgentName
    ): Effect.Effect<Stream.Stream<ContextEvent, never>, AgentServiceError, Scope.Scope> =>
      Effect.succeed(Stream.empty),

    /** Get all historical events for an agent. */
    getEvents: (_agentName: AgentName): Effect.Effect<ReadonlyArray<ContextEvent>, AgentServiceError> =>
      Effect.succeed([]),

    /** Get reduced context (derived state from events). */
    getState: (_agentName: AgentName): Effect.Effect<ReducedContext, AgentServiceError> =>
      Effect.fail(new Error("Not implemented") as unknown as AgentServiceError),

    /** Check if agent is idle (no LLM turn in progress). */
    isIdle: (_agentName: AgentName): Effect.Effect<boolean, AgentServiceError> => Effect.succeed(true),

    /** Gracefully end session for an agent. */
    endSession: (_agentName: AgentName): Effect.Effect<void, AgentServiceError> => Effect.void,

    /** Interrupt current LLM turn without starting a new one. */
    interruptTurn: (_agentName: AgentName): Effect.Effect<void, AgentServiceError> => Effect.void,

    /** List all active agent names. */
    list: (): Effect.Effect<ReadonlyArray<AgentName>> => Effect.succeed([])
  }),
  accessors: true
}) {}
