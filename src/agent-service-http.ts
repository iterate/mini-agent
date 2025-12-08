/**
 * HttpAgentService - Remote implementation using HTTP client.
 * 
 * TODO: Implement proper HTTP client usage with @effect/platform
 */

import { Effect, Layer, Option, Stream, type Scope } from "effect"
import { ContextEvent, type AgentTurnNumber, type ReducedContext } from "./domain.ts"
import { AgentService, type AddEventsRequest, type GetEventsRequest, type GetReducedContextRequest, type TapEventStreamRequest } from "./agent-service.ts"

export interface HttpAgentServiceConfig {
  readonly baseUrl: string
}

export const makeHttpAgentService = (_config: HttpAgentServiceConfig) =>
  Layer.sync(
    AgentService,
    () => {
      // TODO: Implement HTTP client calls
      // For now, return stub implementations
      const addEvents = (_req: AddEventsRequest): Effect.Effect<void> =>
        Effect.fail(new Error("HttpAgentService not yet implemented")).pipe(Effect.catchAll(() => Effect.void))

      const tapEventStream = (_req: TapEventStreamRequest): Effect.Effect<Stream.Stream<ContextEvent, never>, never, Scope.Scope> =>
        Effect.succeed(Stream.empty)

      const getEvents = (_req: GetEventsRequest): Effect.Effect<ReadonlyArray<ContextEvent>> =>
        Effect.succeed([])

      const getReducedContext = (_req: GetReducedContextRequest): Effect.Effect<ReducedContext> =>
        Effect.succeed({
          messages: [],
          llmConfig: Option.none(),
          nextEventNumber: 0,
          currentTurnNumber: 0 as AgentTurnNumber,
          agentTurnStartedAtEventId: Option.none()
        })

      return {
        addEvents,
        tapEventStream,
        getEvents,
        getReducedContext
      } as AgentService
    }
  )
