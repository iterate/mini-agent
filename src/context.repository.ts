/**
 * Context Repository
 *
 * Handles file I/O for context persistence. Contexts are stored as YAML files
 * in the .contexts directory.
 */
import { FileSystem, Path, Error as PlatformError } from "@effect/platform"
import { Effect } from "effect"
import * as YAML from "yaml"
import {
  type PersistedEvent,
  SystemPromptEvent,
  DEFAULT_SYSTEM_PROMPT
} from "./context.model.js"

// =============================================================================
// Configuration
// =============================================================================

const CONTEXTS_DIR = ".contexts"

// =============================================================================
// Context Repository Service
// =============================================================================

export class ContextRepository extends Effect.Service<ContextRepository>()("ContextRepository", {
  effect: Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const getContextPath = (contextName: string) =>
      path.join(CONTEXTS_DIR, `${contextName}.yaml`)

    return {
      /**
       * Load events from a context file.
       * Returns empty array if context doesn't exist.
       */
      load: (contextName: string): Effect.Effect<Array<PersistedEvent>, PlatformError.PlatformError> =>
        Effect.gen(function*() {
          const filePath = getContextPath(contextName)
          const exists = yield* fs.exists(filePath)

          if (!exists) {
            return []
          }

          return yield* fs.readFileString(filePath).pipe(
            Effect.map((yaml) => {
              const parsed = YAML.parse(yaml) as { events?: Array<unknown> }
              return (parsed?.events ?? []) as Array<PersistedEvent>
            }),
            Effect.catchAll(() => Effect.succeed([] as Array<PersistedEvent>))
          )
        }),

      /**
       * Load events from a context, creating it with default system prompt if it doesn't exist.
       */
      loadOrCreate: (contextName: string): Effect.Effect<Array<PersistedEvent>, PlatformError.PlatformError> =>
        Effect.gen(function*() {
          const filePath = getContextPath(contextName)
          const exists = yield* fs.exists(filePath)

          if (!exists) {
            const initialEvents = [new SystemPromptEvent({ content: DEFAULT_SYSTEM_PROMPT })]
            yield* save(contextName, initialEvents)
            return initialEvents
          }

          return yield* fs.readFileString(filePath).pipe(
            Effect.map((yaml) => {
              const parsed = YAML.parse(yaml) as { events?: Array<unknown> }
              return (parsed?.events ?? []) as Array<PersistedEvent>
            }),
            Effect.catchAll(() => Effect.succeed([] as Array<PersistedEvent>))
          )
        }),

      /**
       * Save events to a context file.
       */
      save: (contextName: string, events: ReadonlyArray<PersistedEvent>): Effect.Effect<void, PlatformError.PlatformError> =>
        save(contextName, events),

      /**
       * List all existing context names.
       */
      list: (): Effect.Effect<Array<string>, PlatformError.PlatformError> =>
        Effect.gen(function*() {
          const exists = yield* fs.exists(CONTEXTS_DIR)
          if (!exists) return []

          const entries = yield* fs.readDirectory(CONTEXTS_DIR)
          return entries
            .filter((name) => name.endsWith(".yaml"))
            .map((name) => name.replace(/\.yaml$/, ""))
            .sort()
        })
    }

    function save(contextName: string, events: ReadonlyArray<PersistedEvent>): Effect.Effect<void, PlatformError.PlatformError> {
      return Effect.gen(function*() {
        const filePath = getContextPath(contextName)

        // Ensure directory exists
        yield* fs.makeDirectory(CONTEXTS_DIR, { recursive: true }).pipe(
          Effect.catchAll(() => Effect.void)
        )

        // Convert to plain objects for YAML serialization
        const plainEvents = events.map((e) => ({
          _tag: e._tag,
          content: e.content
        }))

        const yaml = YAML.stringify({ events: plainEvents })
        yield* fs.writeFileString(filePath, yaml)
      })
    }
  }),
  accessors: true
}) {}


