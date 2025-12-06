/**
 * AgentRegistry - Creates and manages MiniAgent instances.
 *
 * Key responsibilities:
 * - Create agents on demand (getOrCreate)
 * - Cache agents by name
 * - Graceful shutdown (individual and all)
 *
 * Future: Replace with @effect/cluster Sharding
 */

import { Effect, Exit, Ref, Scope } from "effect"
import {
  type AgentName,
  AgentNotFoundError,
  type ContextName,
  type ContextSaveError,
  type MiniAgent,
  MiniAgentTurn,
  type ReducerError
} from "./domain.ts"
import { EventReducer } from "./event-reducer.ts"
import { EventStore } from "./event-store.ts"
import { makeMiniAgent } from "./mini-agent.ts"

type MiniAgentError = ReducerError | ContextSaveError

/**
 * AgentRegistry manages MiniAgent instances.
 */
export class AgentRegistry extends Effect.Service<AgentRegistry>()("@mini-agent/AgentRegistry", {
  effect: Effect.gen(function*() {
    // Get dependencies
    const reducer = yield* EventReducer
    const store = yield* EventStore
    const turn = yield* MiniAgentTurn

    // Map of agentName -> { agent, scope }
    const agents = yield* Ref.make(new Map<AgentName, { agent: MiniAgent; scope: Scope.CloseableScope }>())

    // Generate context name from agent name
    const makeContextName = (agentName: AgentName): ContextName => `${agentName}-v1` as ContextName

    const getOrCreate = (agentName: AgentName): Effect.Effect<MiniAgent, MiniAgentError> =>
      Effect.gen(function*() {
        const current = yield* Ref.get(agents)
        const existing = current.get(agentName)

        if (existing) {
          return existing.agent
        }

        // Create new agent with its own scope
        const scope = yield* Scope.make()
        const contextName = makeContextName(agentName)

        const agent = yield* makeMiniAgent(agentName, contextName).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(EventReducer, reducer),
          Effect.provideService(EventStore, store),
          Effect.provideService(MiniAgentTurn, turn)
        )

        // Cache the agent
        yield* Ref.update(agents, (map) => {
          const newMap = new Map(map)
          newMap.set(agentName, { agent, scope })
          return newMap
        })

        return agent
      })

    const get = (agentName: AgentName): Effect.Effect<MiniAgent, AgentNotFoundError> =>
      Effect.gen(function*() {
        const current = yield* Ref.get(agents)
        const existing = current.get(agentName)

        if (!existing) {
          return yield* Effect.fail(new AgentNotFoundError({ agentName }))
        }

        return existing.agent
      })

    const list: Effect.Effect<ReadonlyArray<AgentName>> = Ref.get(agents).pipe(
      Effect.map((map) => Array.from(map.keys()))
    )

    const shutdownAgent = (agentName: AgentName): Effect.Effect<void, AgentNotFoundError> =>
      Effect.gen(function*() {
        const current = yield* Ref.get(agents)
        const existing = current.get(agentName)

        if (!existing) {
          return yield* Effect.fail(new AgentNotFoundError({ agentName }))
        }

        // Shutdown the agent
        yield* existing.agent.shutdown
        yield* Scope.close(existing.scope, Exit.void)

        // Remove from cache
        yield* Ref.update(agents, (map) => {
          const newMap = new Map(map)
          newMap.delete(agentName)
          return newMap
        })
      })

    const shutdownAll: Effect.Effect<void> = Effect.gen(function*() {
      const current = yield* Ref.get(agents)

      // Shutdown all agents
      for (const [, entry] of current) {
        yield* entry.agent.shutdown.pipe(
          Effect.catchAll(() => Effect.void)
        )
        yield* Scope.close(entry.scope, Exit.void)
      }

      // Clear the cache
      yield* Ref.set(agents, new Map())
    })

    return {
      getOrCreate,
      get,
      list,
      shutdownAgent,
      shutdownAll
    }
  }),
  dependencies: [EventReducer.Default, EventStore.InMemory, MiniAgentTurn.Default],
  accessors: true
}) {}
