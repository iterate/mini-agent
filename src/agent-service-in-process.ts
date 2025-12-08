/**
 * InProcessAgentService - Local implementation using AgentRegistry.
 */

import { Effect, Layer, Option, Stream, type Scope } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import type { AgentTurnNumber, ContextEvent, ReducedContext } from "./domain.ts"
import { AgentService, type AddEventsRequest, type GetEventsRequest, type GetReducedContextRequest, type TapEventStreamRequest } from "./agent-service.ts"

export const InProcessAgentService = Layer.effect(
  AgentService,
  Effect.gen(function*() {
    const registry = yield* AgentRegistry

    const addEvents = (req: AddEventsRequest): Effect.Effect<void> =>
      Effect.gen(function*() {
        const agent = yield* registry.getOrCreate(req.agentName)
        for (const event of req.events) {
          yield* agent.addEvent(event)
        }
      }).pipe(Effect.catchAll(() => Effect.void))

    const tapEventStream = (req: TapEventStreamRequest): Effect.Effect<Stream.Stream<ContextEvent, never>, never, Scope.Scope> =>
      Effect.gen(function*() {
        const agent = yield* registry.getOrCreate(req.agentName)
        return yield* agent.subscribe
      }).pipe(Effect.catchAll(() => Effect.succeed(Stream.empty)))

    const getEvents = (req: GetEventsRequest): Effect.Effect<ReadonlyArray<ContextEvent>> =>
      Effect.gen(function*() {
        const agent = yield* registry.getOrCreate(req.agentName)
        return yield* agent.getEvents
      }).pipe(Effect.catchAll(() => Effect.succeed([])))

    const getReducedContext = (req: GetReducedContextRequest): Effect.Effect<ReducedContext> =>
      Effect.gen(function*() {
        const agent = yield* registry.getOrCreate(req.agentName)
        return yield* agent.getReducedContext
      }).pipe(Effect.catchAll(() => Effect.succeed({ messages: [], llmConfig: Option.none(), nextEventNumber: 0, currentTurnNumber: 0 as AgentTurnNumber, agentTurnStartedAtEventId: Option.none() })))

    return {
      addEvents,
      tapEventStream,
      getEvents,
      getReducedContext
    } as AgentService
  })
).pipe(Layer.provide(AgentRegistry.Default))
