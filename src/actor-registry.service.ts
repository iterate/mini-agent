/**
 * Actor Registry Service
 *
 * Manages multiple ContextActor instances.
 *
 * Responsibilities:
 * - Create actors on demand (lazy initialization)
 * - Cache actors by context name
 * - Route events to correct actor
 * - Graceful shutdown of all actors
 *
 * This is the main entry point for the application layer.
 * In the future, this could be replaced by @effect/cluster Sharding.
 */
import { Context, Effect, Exit, Layer, Ref, Scope, Stream } from "effect"
import type { ContextEvent, ContextName } from "./actor.model.ts"
import { ActorNotFoundError } from "./actor.model.ts"
import { type ActorConfig, ContextActor, defaultActorConfig } from "./context-actor.service.ts"
import type { ContextLoadError, ContextSaveError } from "./errors.ts"

// =============================================================================
// ActorRegistry Service
// =============================================================================

/**
 * ActorRegistry manages multiple ContextActor instances.
 *
 * Each actor is created lazily and cached. The registry handles:
 * - Actor lifecycle management
 * - Routing events to the correct actor
 * - Graceful shutdown of all actors
 */
export class ActorRegistry extends Context.Tag("@app/ActorRegistry")<
  ActorRegistry,
  {
    /**
     * Get or create an actor for a context.
     * Actors are cached - subsequent calls return the same instance.
     */
    readonly getOrCreate: (
      contextName: ContextName
    ) => Effect.Effect<
      {
        readonly contextName: ContextName
        readonly addEvent: (event: ContextEvent) => Effect.Effect<void, ContextLoadError | ContextSaveError>
        readonly events: Stream.Stream<ContextEvent, never>
        readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>
        readonly shutdown: Effect.Effect<void>
      },
      ContextLoadError | ContextSaveError
    >

    /**
     * Get an existing actor (fails if not found).
     */
    readonly get: (
      contextName: ContextName
    ) => Effect.Effect<
      {
        readonly contextName: ContextName
        readonly addEvent: (event: ContextEvent) => Effect.Effect<void, ContextLoadError | ContextSaveError>
        readonly events: Stream.Stream<ContextEvent, never>
        readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>
        readonly shutdown: Effect.Effect<void>
      },
      ActorNotFoundError
    >

    /**
     * List all active context names.
     */
    readonly list: Effect.Effect<ReadonlyArray<ContextName>>

    /**
     * Shutdown a specific actor.
     */
    readonly shutdownActor: (contextName: ContextName) => Effect.Effect<void, ActorNotFoundError>

    /**
     * Shutdown all actors gracefully.
     */
    readonly shutdownAll: Effect.Effect<void>
  }
>() {
  /**
   * Production layer.
   */
  static readonly layer = (config: ActorConfig = defaultActorConfig) =>
    Layer.scoped(
      ActorRegistry,
      Effect.gen(function*() {
        // Map of active actors
        type ActorHandle = {
          readonly contextName: ContextName
          readonly addEvent: (event: ContextEvent) => Effect.Effect<void, ContextLoadError | ContextSaveError>
          readonly events: Stream.Stream<ContextEvent, never>
          readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>
          readonly shutdown: Effect.Effect<void>
          readonly scope: Scope.CloseableScope
        }
        const actorsRef = yield* Ref.make(new Map<ContextName, ActorHandle>())

        const getOrCreate = Effect.fn("ActorRegistry.getOrCreate")(function*(contextName: ContextName) {
          const actors = yield* Ref.get(actorsRef)

          // Return cached actor if exists
          const existing = actors.get(contextName)
          if (existing) {
            return {
              contextName: existing.contextName,
              addEvent: existing.addEvent,
              events: existing.events,
              getEvents: existing.getEvents,
              shutdown: existing.shutdown
            }
          }

          // Create new actor with its own scope
          const actorScope = yield* Scope.make()

          const actorLayer = ContextActor.make(contextName, config)
          const actorContext = yield* Layer.buildWithScope(actorLayer, actorScope)
          const actor = Context.get(actorContext, ContextActor)

          const handle: ActorHandle = {
            contextName: actor.contextName,
            addEvent: actor.addEvent,
            events: actor.events,
            getEvents: actor.getEvents,
            shutdown: actor.shutdown,
            scope: actorScope
          }

          // Cache the actor
          yield* Ref.update(actorsRef, (map) => {
            const newMap = new Map(map)
            newMap.set(contextName, handle)
            return newMap
          })

          return {
            contextName: actor.contextName,
            addEvent: actor.addEvent,
            events: actor.events,
            getEvents: actor.getEvents,
            shutdown: actor.shutdown
          }
        })

        const get = Effect.fn("ActorRegistry.get")(function*(contextName: ContextName) {
          const actors = yield* Ref.get(actorsRef)
          const actor = actors.get(contextName)

          if (!actor) {
            return yield* new ActorNotFoundError({ contextName })
          }

          return {
            contextName: actor.contextName,
            addEvent: actor.addEvent,
            events: actor.events,
            getEvents: actor.getEvents,
            shutdown: actor.shutdown
          }
        })

        const list = Ref.get(actorsRef).pipe(
          Effect.map((actors) => Array.from(actors.keys()))
        )

        const shutdownActor = Effect.fn("ActorRegistry.shutdownActor")(function*(contextName: ContextName) {
          const actors = yield* Ref.get(actorsRef)
          const actor = actors.get(contextName)

          if (!actor) {
            return yield* new ActorNotFoundError({ contextName })
          }

          // Shutdown the actor
          yield* actor.shutdown

          // Close the scope
          yield* Scope.close(actor.scope, Exit.void)

          // Remove from cache
          yield* Ref.update(actorsRef, (map) => {
            const newMap = new Map(map)
            newMap.delete(contextName)
            return newMap
          })
        })

        const shutdownAll = Effect.gen(function*() {
          const actors = yield* Ref.get(actorsRef)

          // Shutdown all actors in parallel
          yield* Effect.all(
            Array.from(actors.values()).map((actor) =>
              Effect.gen(function*() {
                yield* actor.shutdown
                yield* Scope.close(actor.scope, Exit.void)
              })
            ),
            { concurrency: "unbounded" }
          )

          // Clear the cache
          yield* Ref.set(actorsRef, new Map())
        }).pipe(Effect.withSpan("ActorRegistry.shutdownAll"))

        // Cleanup on scope close
        yield* Effect.addFinalizer((_exit) =>
          Effect.gen(function*() {
            const actors = yield* Ref.get(actorsRef)
            yield* Effect.all(
              Array.from(actors.values()).map((actor) =>
                Effect.gen(function*() {
                  yield* actor.shutdown
                  yield* Scope.close(actor.scope, Exit.void)
                })
              ),
              { concurrency: "unbounded" }
            )
            yield* Ref.set(actorsRef, new Map())
          })
        )

        return ActorRegistry.of({
          getOrCreate,
          get,
          list,
          shutdownActor,
          shutdownAll
        })
      })
    )

  /**
   * Test layer with in-memory actors.
   */
  static readonly testLayer = Layer.sync(ActorRegistry, () => {
    const actors = new Map<
      ContextName,
      {
        readonly contextName: ContextName
        readonly addEvent: (event: ContextEvent) => Effect.Effect<void, ContextLoadError | ContextSaveError>
        readonly events: Stream.Stream<ContextEvent, never>
        readonly getEvents: Effect.Effect<ReadonlyArray<ContextEvent>>
        readonly shutdown: Effect.Effect<void>
      }
    >()
    const eventStores = new Map<ContextName, Array<ContextEvent>>()

    const createMockActor = (contextName: ContextName) => {
      const events = eventStores.get(contextName) ?? []
      eventStores.set(contextName, events)

      return {
        contextName,
        addEvent: (event: ContextEvent) =>
          Effect.sync(() => {
            events.push(event)
          }),
        events: Stream.empty as Stream.Stream<ContextEvent, never>,
        getEvents: Effect.succeed(events),
        shutdown: Effect.void
      }
    }

    return ActorRegistry.of({
      getOrCreate: (contextName) =>
        Effect.sync(() => {
          const existing = actors.get(contextName)
          if (existing) return existing

          const actor = createMockActor(contextName)
          actors.set(contextName, actor)
          return actor
        }),
      get: (contextName) =>
        Effect.suspend(() => {
          const actor = actors.get(contextName)
          if (!actor) return Effect.fail(new ActorNotFoundError({ contextName }))
          return Effect.succeed(actor)
        }),
      list: Effect.succeed(Array.from(actors.keys())),
      shutdownActor: (contextName) =>
        Effect.suspend(() => {
          if (!actors.has(contextName)) {
            return Effect.fail(new ActorNotFoundError({ contextName }))
          }
          actors.delete(contextName)
          eventStores.delete(contextName)
          return Effect.void
        }),
      shutdownAll: Effect.sync(() => {
        actors.clear()
        eventStores.clear()
      })
    })
  })
}

// =============================================================================
// ActorApplicationService
// =============================================================================

/**
 * Application service using actor-based architecture.
 * Thin facade over ActorRegistry.
 */
export class ActorApplicationService extends Context.Tag("@app/ActorApplicationService")<
  ActorApplicationService,
  {
    /**
     * Add event to a context (creates actor if needed).
     */
    readonly addEvent: (
      contextName: ContextName,
      event: ContextEvent
    ) => Effect.Effect<void, ContextLoadError | ContextSaveError>

    /**
     * Get event stream for a context.
     * Creates actor if needed.
     */
    readonly eventStream: (
      contextName: ContextName
    ) => Effect.Effect<Stream.Stream<ContextEvent, never>, ContextLoadError | ContextSaveError>

    /**
     * Get all events for a context.
     */
    readonly getEvents: (
      contextName: ContextName
    ) => Effect.Effect<ReadonlyArray<ContextEvent>, ContextLoadError | ContextSaveError>

    /**
     * List all active contexts.
     */
    readonly list: Effect.Effect<ReadonlyArray<ContextName>>

    /**
     * Shutdown all actors.
     */
    readonly shutdown: Effect.Effect<void>
  }
>() {
  static readonly layer = Layer.effect(
    ActorApplicationService,
    Effect.gen(function*() {
      const registry = yield* ActorRegistry

      const addEvent = Effect.fn("ActorApplicationService.addEvent")(
        function*(contextName: ContextName, event: ContextEvent) {
          const actor = yield* registry.getOrCreate(contextName)
          yield* actor.addEvent(event)
        }
      )

      const eventStream = Effect.fn("ActorApplicationService.eventStream")(
        function*(contextName: ContextName) {
          const actor = yield* registry.getOrCreate(contextName)
          return actor.events
        }
      )

      const getEvents = Effect.fn("ActorApplicationService.getEvents")(
        function*(contextName: ContextName) {
          const actor = yield* registry.getOrCreate(contextName)
          return yield* actor.getEvents
        }
      )

      const list = registry.list

      const shutdown = registry.shutdownAll

      return ActorApplicationService.of({
        addEvent,
        eventStream,
        getEvents,
        list,
        shutdown
      })
    })
  )

  static readonly testLayer = Layer.effect(
    ActorApplicationService,
    Effect.gen(function*() {
      const registry = yield* ActorRegistry

      return ActorApplicationService.of({
        addEvent: (contextName, event) =>
          Effect.gen(function*() {
            const actor = yield* registry.getOrCreate(contextName)
            yield* actor.addEvent(event)
          }),
        eventStream: (contextName) =>
          Effect.gen(function*() {
            const actor = yield* registry.getOrCreate(contextName)
            return actor.events
          }),
        getEvents: (contextName) =>
          Effect.gen(function*() {
            const actor = yield* registry.getOrCreate(contextName)
            return yield* actor.getEvents
          }),
        list: registry.list,
        shutdown: registry.shutdownAll
      })
    })
  ).pipe(Layer.provide(ActorRegistry.testLayer))
}
