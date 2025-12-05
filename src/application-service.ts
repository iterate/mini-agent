/**
 * ApplicationService (Layer 4)
 *
 * The outermost layer - provides a clean facade for external consumers (CLI, HTTP).
 * Routes events by context name and manages session lifecycle.
 *
 * Key Interface:
 * - addEvent: Route an event to the appropriate session
 * - eventStream: Get the event stream for a context
 * - shutdown: Gracefully close all sessions
 *
 * Responsibilities:
 * - Create sessions on demand (per context name)
 * - Route events to correct session
 * - Graceful shutdown of all sessions
 *
 * Does NOT contain business logic - just routing and coordination.
 */
import { FileSystem } from "@effect/platform"
import { Context, Effect, Layer, Ref, Scope, Stream } from "effect"
import { Agent } from "./agent.ts"
import { type ContextEvent, type ContextName } from "./context.model.ts"
import { ContextRepository } from "./context.repository.ts"
import { ContextSession, type SessionError } from "./context-session.ts"
import { EventReducer } from "./event-reducer.ts"
import { HooksService } from "./hooks-service.ts"

/** Internal session state */
interface SessionState {
  readonly session: Context.Tag.Service<typeof ContextSession>
  readonly scope: Scope.CloseableScope
}

/**
 * ApplicationService - Layer 4 of the architecture.
 * Routes events to sessions and manages their lifecycle.
 */
export class ApplicationService extends Context.Tag("@app/ApplicationService")<
  ApplicationService,
  {
    /** Add an event to a context (creates session if needed) */
    readonly addEvent: (
      contextName: ContextName,
      event: ContextEvent
    ) => Effect.Effect<void, SessionError>

    /** Get the event stream for a context (creates session if needed) */
    readonly eventStream: (
      contextName: ContextName
    ) => Stream.Stream<ContextEvent, SessionError>

    /** List all known context names */
    readonly listContexts: () => Effect.Effect<Array<string>>

    /** Gracefully shutdown all sessions */
    readonly shutdown: () => Effect.Effect<void>
  }
>() {
  /**
   * Production layer.
   */
  static readonly layer: Layer.Layer<
    ApplicationService,
    never,
    Agent | EventReducer | ContextRepository | HooksService | FileSystem.FileSystem
  > = Layer.effect(
    ApplicationService,
    Effect.gen(function*() {
      const agent = yield* Agent
      const reducer = yield* EventReducer
      const repository = yield* ContextRepository
      const hooks = yield* HooksService
      const fs = yield* FileSystem.FileSystem

      // Map of context name -> session state
      const sessionsRef = yield* Ref.make<Map<string, SessionState>>(new Map())

      /** Create a new session for a context */
      const createSession = (contextName: ContextName) =>
        Effect.gen(function*() {
          // Create a new scope for this session
          const scope = yield* Scope.make()

          // Build the session layer with all dependencies
          const sessionLayer = ContextSession.layer.pipe(
            Layer.provide(Layer.succeed(Agent, agent)),
            Layer.provide(Layer.succeed(EventReducer, reducer)),
            Layer.provide(Layer.succeed(ContextRepository, repository)),
            Layer.provide(Layer.succeed(HooksService, hooks)),
            Layer.provide(Layer.succeed(FileSystem.FileSystem, fs))
          )

          // Build the session within the scope
          const sessionContext = yield* Layer.buildWithScope(sessionLayer, scope)
          const session = Context.get(sessionContext, ContextSession)

          // Initialize the session
          yield* session.initialize(contextName)

          return { session, scope }
        })

      /** Get or create a session for a context */
      const getOrCreateSession = (contextName: ContextName) =>
        Effect.gen(function*() {
          const sessions = yield* Ref.get(sessionsRef)
          const existing = sessions.get(contextName as string)
          if (existing) return existing

          const sessionState = yield* createSession(contextName)
          yield* Ref.update(sessionsRef, (map) => {
            const newMap = new Map(map)
            newMap.set(contextName as string, sessionState)
            return newMap
          })

          return sessionState
        })

      return ApplicationService.of({
        addEvent: (contextName, event) =>
          Effect.gen(function*() {
            const { session } = yield* getOrCreateSession(contextName)
            yield* session.addEvent(event)
          }),

        eventStream: (contextName) =>
          Stream.unwrap(
            Effect.gen(function*() {
              const { session } = yield* getOrCreateSession(contextName)
              return session.events
            })
          ),

        listContexts: () => repository.list(),

        shutdown: () =>
          Effect.gen(function*() {
            const sessions = yield* Ref.get(sessionsRef)
            for (const [, { session, scope }] of sessions) {
              yield* session.close()
              yield* Scope.close(scope, Effect.void)
            }
            yield* Ref.set(sessionsRef, new Map())
          })
      })
    })
  )

  /** Test layer with mock implementation */
  static readonly testLayer: Layer.Layer<ApplicationService> = Layer.sync(
    ApplicationService,
    () => {
      const events = new Map<string, Array<ContextEvent>>()

      return ApplicationService.of({
        addEvent: (contextName, event) =>
          Effect.sync(() => {
            const existing = events.get(contextName as string) ?? []
            events.set(contextName as string, [...existing, event])
          }),

        eventStream: () => Stream.empty,

        listContexts: () => Effect.succeed(Array.from(events.keys())),

        shutdown: () => Effect.void
      })
    }
  )
}

/**
 * Full application layer - composes all service layers.
 */
export const AppLayer = ApplicationService.layer.pipe(
  Layer.provideMerge(ContextSession.layer),
  Layer.provideMerge(EventReducer.layer),
  Layer.provideMerge(Agent.layer),
  Layer.provideMerge(ContextRepository.layer),
  Layer.provideMerge(HooksService.layer)
)

/**
 * Test application layer - composes all test layers.
 */
export const TestAppLayer = ApplicationService.testLayer.pipe(
  Layer.provideMerge(ContextSession.testLayer),
  Layer.provideMerge(EventReducer.testLayer),
  Layer.provideMerge(Agent.testLayer),
  Layer.provideMerge(ContextRepository.testLayer),
  Layer.provideMerge(HooksService.testLayer)
)
