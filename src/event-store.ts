/**
 * EventStore - Persists events by context name.
 *
 * Pluggable implementations:
 * - InMemory: For tests (fresh state per layer creation)
 * - FileSystem: For production (YAML files)
 */

import { Effect, Layer } from "effect"
import type { ContextEvent, ContextLoadError, ContextName, ContextSaveError } from "./domain.ts"

/**
 * EventStore persists context events.
 */
export class EventStore extends Effect.Service<EventStore>()("@mini-agent/EventStore", {
  succeed: {
    load: (_contextName: ContextName): Effect.Effect<ReadonlyArray<ContextEvent>, ContextLoadError> =>
      Effect.succeed([]),
    append: (_contextName: ContextName, _events: ReadonlyArray<ContextEvent>): Effect.Effect<void, ContextSaveError> =>
      Effect.void,
    exists: (_contextName: ContextName): Effect.Effect<boolean> => Effect.succeed(false),
    list: (): Effect.Effect<ReadonlyArray<ContextName>> => Effect.succeed([])
  },
  accessors: true
}) {
  /**
   * In-memory implementation for tests.
   * Fresh state per layer creation ensures test isolation.
   */
  static readonly InMemory: Layer.Layer<EventStore> = Layer.sync(EventStore, () => {
    const store = new Map<ContextName, Array<ContextEvent>>()

    return {
      load: (contextName: ContextName) => Effect.sync(() => store.get(contextName) ?? []),

      append: (contextName: ContextName, events: ReadonlyArray<ContextEvent>) =>
        Effect.sync(() => {
          const existing = store.get(contextName) ?? []
          store.set(contextName, [...existing, ...events])
        }),

      exists: (contextName: ContextName) => Effect.sync(() => store.has(contextName)),

      list: () => Effect.sync(() => Array.from(store.keys()))
    } as unknown as EventStore
  })
}
