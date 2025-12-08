/**
 * Unified AgentService - Single interface for all CLI modes.
 *
 * Provides:
 * - addEvents({agentName, events}) - Add events to an agent
 * - tapEventStream({agentName}) - Subscribe to live event stream
 * - getEvents({agentName}) - Get all events for an agent
 *
 * Implementations:
 * - InProcessAgentService - Uses AgentRegistry (local)
 * - HttpAgentService - HTTP client (remote)
 */

import { Effect, Option, Stream, type Scope } from "effect"
import type { AgentName, AgentTurnNumber, ContextEvent, ReducedContext } from "./domain.ts"

export interface AddEventsRequest {
  readonly agentName: AgentName
  readonly events: ReadonlyArray<ContextEvent>
}

export interface TapEventStreamRequest {
  readonly agentName: AgentName
}

export interface GetEventsRequest {
  readonly agentName: AgentName
}

export interface GetReducedContextRequest {
  readonly agentName: AgentName
}

/**
 * Unified service for interacting with agents across all modes.
 */
export class AgentService extends Effect.Service<AgentService>()("@mini-agent/AgentService", {
  succeed: {
    addEvents: (_req: AddEventsRequest): Effect.Effect<void> => Effect.void,
    tapEventStream: (_req: TapEventStreamRequest): Effect.Effect<Stream.Stream<ContextEvent, never>, never, Scope.Scope> =>
      Effect.succeed(Stream.empty),
    getEvents: (_req: GetEventsRequest): Effect.Effect<ReadonlyArray<ContextEvent>> => Effect.succeed([]),
    getReducedContext: (_req: GetReducedContextRequest): Effect.Effect<ReducedContext> =>
      Effect.succeed({ messages: [], llmConfig: Option.none(), nextEventNumber: 0, currentTurnNumber: 0 as AgentTurnNumber, agentTurnStartedAtEventId: Option.none() })
  },
  accessors: true
}) {}
