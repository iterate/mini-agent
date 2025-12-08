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

import { Deferred, Effect, Exit, Layer, Ref, Scope, Stream } from "effect"
import { AgentService } from "./agent-service.ts"
import {
  type AgentName,
  AgentNotFoundError,
  type ContextEvent,
  type ContextLoadError,
  type ContextName,
  type ContextSaveError,
  type MiniAgent,
  MiniAgentTurn,
  type ReducerError
} from "./domain.ts"
import { EventReducer } from "./event-reducer.ts"
import { EventStore } from "./event-store.ts"
import { makeMiniAgent } from "./mini-agent.ts"

type MiniAgentCreationError = ReducerError | ContextLoadError | ContextSaveError

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

    // Track in-progress creations using Deferred for proper synchronization
    const creationLocks = yield* Ref.make(
      new Map<AgentName, Deferred.Deferred<MiniAgent, MiniAgentCreationError>>()
    )

    type CacheResult = { type: "cached"; agent: MiniAgent } | { type: "not-found" }
    type LockResult =
      | { type: "waiting"; deferred: Deferred.Deferred<MiniAgent, MiniAgentCreationError> }
      | { type: "create" }

    const getOrCreate = (agentName: AgentName): Effect.Effect<MiniAgent, MiniAgentCreationError> =>
      Effect.gen(function*() {
        // Atomically check cache and in-progress, potentially creating a deferred
        const result: CacheResult = yield* Ref.modify(agents, (agentsMap) => {
          const existing = agentsMap.get(agentName)
          if (existing) {
            return [{ type: "cached" as const, agent: existing.agent } as CacheResult, agentsMap]
          }
          return [{ type: "not-found" as const } as CacheResult, agentsMap]
        })

        if (result.type === "cached") {
          return result.agent
        }

        // Check if creation is in progress or start new creation
        const lockResult: LockResult = yield* Ref.modify(creationLocks, (locks) => {
          const existing = locks.get(agentName)
          if (existing) {
            return [{ type: "waiting" as const, deferred: existing } as LockResult, locks]
          }
          return [{ type: "create" as const } as LockResult, locks]
        })

        if (lockResult.type === "waiting") {
          return yield* Deferred.await(lockResult.deferred)
        }

        // We need to create - first make a deferred for others to wait on
        const newDeferred = yield* Deferred.make<MiniAgent, MiniAgentCreationError>()
        yield* Ref.update(creationLocks, (m) => {
          const newMap = new Map(m)
          newMap.set(agentName, newDeferred)
          return newMap
        })

        // Create the agent
        const createResult = yield* Effect.gen(function*() {
          // Double-check cache after acquiring deferred
          const recheck = yield* Ref.get(agents)
          const recheckExisting = recheck.get(agentName)
          if (recheckExisting) {
            return recheckExisting.agent
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
        }).pipe(Effect.either)

        // Clean up the lock
        yield* Ref.update(creationLocks, (m) => {
          const newMap = new Map(m)
          newMap.delete(agentName)
          return newMap
        })

        // Complete the deferred and return
        if (createResult._tag === "Left") {
          yield* Deferred.fail(newDeferred, createResult.left)
          return yield* Effect.fail(createResult.left)
        } else {
          yield* Deferred.succeed(newDeferred, createResult.right)
          return createResult.right
        }
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

        // Close scope - this triggers the finalizer which handles cleanup and SessionEndedEvent
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

      // Close all scopes - each finalizer handles cleanup and SessionEndedEvent
      for (const [, entry] of current) {
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
  accessors: true
}) {
  /**
   * Default layer for tests - uses InMemory store and stub turn.
   */
  static readonly TestLayer = AgentRegistry.Default.pipe(
    Layer.provide(EventReducer.Default),
    Layer.provide(EventStore.InMemory),
    Layer.provide(MiniAgentTurn.Default)
  )

  /**
   * InProcess implementation of AgentService.
   * Wraps AgentRegistry to provide the unified service interface.
   * Errors from agent creation are converted to defects (orDie).
   */
  static readonly InProcessAgentService: Layer.Layer<AgentService, never, AgentRegistry> = Layer.effect(
    AgentService,
    Effect.gen(function*() {
      const registry = yield* AgentRegistry

      return {
        addEvents: ({ agentName, events }: { agentName: AgentName; events: ReadonlyArray<ContextEvent> }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            for (const event of events) {
              yield* agent.addEvent(event)
            }
          }).pipe(Effect.orDie),

        tapEventStream: ({ agentName }: { agentName: AgentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            return yield* agent.tapEventStream
          }).pipe(Effect.orDie),

        getEvents: ({ agentName }: { agentName: AgentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            return yield* agent.getEvents
          }).pipe(Effect.orDie),

        getState: ({ agentName }: { agentName: AgentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            return yield* agent.getState
          }).pipe(Effect.orDie),

        addEventsAndStreamUntilIdle: (
          { agentName, events, idleTimeoutMs = 50 }: {
            agentName: AgentName
            events: ReadonlyArray<ContextEvent>
            idleTimeoutMs?: number
          }
        ) =>
          Stream.unwrapScoped(
            Effect.gen(function*() {
              const agent = yield* registry.getOrCreate(agentName)

              // Get existing events first
              const existingEvents = yield* agent.getEvents

              // Subscribe to live events BEFORE adding new events
              const liveEvents = yield* agent.tapEventStream

              // Add the new events
              for (const event of events) {
                yield* agent.addEvent(event)
              }

              // Stream existing + live events until idle
              const existingStream = Stream.fromIterable(existingEvents)
              const liveUntilIdle = liveEvents.pipe(
                Stream.takeUntil((e) =>
                  e._tag === "AgentTurnCompletedEvent" ||
                  e._tag === "AgentTurnFailedEvent" ||
                  e._tag === "AgentTurnInterruptedEvent" ||
                  e._tag === "SessionEndedEvent"
                ),
                // Add idle timeout check after turn events
                Stream.concat(
                  Stream.fromEffect(
                    Effect.gen(function*() {
                      // Wait for idle
                      yield* Effect.iterate(0, {
                        while: () => true,
                        body: () =>
                          Effect.gen(function*() {
                            const isIdle = yield* agent.isIdle
                            if (isIdle) {
                              return Effect.fail("idle" as const)
                            }
                            yield* Effect.sleep(`${idleTimeoutMs} millis`)
                            return Effect.succeed(0)
                          }).pipe(Effect.flatten)
                      }).pipe(
                        Effect.catchAll(() => Effect.void),
                        Effect.timeout("30 seconds"),
                        Effect.orDie
                      )
                    })
                  ).pipe(Stream.drain)
                )
              )

              return Stream.concat(existingStream, liveUntilIdle)
            }).pipe(Effect.orDie)
          ),

        endSession: ({ agentName }: { agentName: AgentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            yield* agent.endSession
          }).pipe(Effect.orDie),

        interruptTurn: ({ agentName }: { agentName: AgentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            yield* agent.interruptTurn
          }).pipe(Effect.orDie),

        isIdle: ({ agentName }: { agentName: AgentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            return yield* agent.isIdle
          }).pipe(Effect.orDie),

        listAgents: () => registry.list
      } as unknown as AgentService
    })
  )
}
