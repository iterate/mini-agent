/**
 * Context Repository
 *
 * Handles file I/O for context persistence. Contexts are stored as YAML files
 * in the configured data storage directory.
 */
import type { Error as PlatformError } from "@effect/platform"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Option, Schema } from "effect"
import * as YAML from "yaml"
import { AppConfig } from "./config.js"
import {
  DEFAULT_SYSTEM_PROMPT,
  PersistedEvent,
  type PersistedEvent as PersistedEventType,
  SystemPromptEvent
} from "./context.model.js"

// =============================================================================
// Event Decoding Helper
// =============================================================================

/**
 * Decode a plain object to a PersistedEvent class instance.
 * This ensures the event has all the methods defined on the class.
 */
const decodeEvent = Schema.decodeUnknownSync(PersistedEvent)

/**
 * Decode an array of plain objects to PersistedEvent class instances.
 */
const decodeEvents = (rawEvents: Array<unknown>): Array<PersistedEventType> => rawEvents.map((raw) => decodeEvent(raw))

// =============================================================================
// Context Repository Service
// =============================================================================

export class ContextRepository extends Effect.Service<ContextRepository>()("ContextRepository", {
  effect: Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = yield* AppConfig

    // Resolve the contexts directory from config
    const cwd = Option.getOrElse(config.cwd, () => process.cwd())
    const contextsDir = path.join(cwd, config.dataStorageDir, "contexts")

    const getContextPath = (contextName: string) => path.join(contextsDir, `${contextName}.yaml`)

    return {
      /**
       * Load events from a context file.
       * Returns empty array if context doesn't exist.
       */
      load: (contextName: string): Effect.Effect<Array<PersistedEventType>, PlatformError.PlatformError> =>
        Effect.gen(function*() {
          const filePath = getContextPath(contextName)
          const exists = yield* fs.exists(filePath)

          if (!exists) {
            return []
          }

          return yield* fs.readFileString(filePath).pipe(
            Effect.map((yaml) => {
              const parsed = YAML.parse(yaml) as { events?: Array<unknown> }
              return decodeEvents(parsed?.events ?? [])
            }),
            Effect.catchAll(() => Effect.succeed([] as Array<PersistedEventType>))
          )
        }),

      /**
       * Load events from a context, creating it with default system prompt if it doesn't exist.
       */
      loadOrCreate: (contextName: string): Effect.Effect<Array<PersistedEventType>, PlatformError.PlatformError> =>
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
              return decodeEvents(parsed?.events ?? [])
            }),
            Effect.catchAll(() => Effect.succeed([] as Array<PersistedEventType>))
          )
        }),

      /**
       * Save events to a context file.
       */
      save: (
        contextName: string,
        events: ReadonlyArray<PersistedEventType>
      ): Effect.Effect<void, PlatformError.PlatformError> => save(contextName, events),

      /**
       * List all existing context names.
       */
      list: (): Effect.Effect<Array<string>, PlatformError.PlatformError> =>
        Effect.gen(function*() {
          const exists = yield* fs.exists(contextsDir)
          if (!exists) return []

          const entries = yield* fs.readDirectory(contextsDir)
          return entries
            .filter((name) => name.endsWith(".yaml"))
            .map((name) => name.replace(/\.yaml$/, ""))
            .sort()
        }),

      /**
       * Get the contexts directory path.
       */
      getContextsDir: () => contextsDir
    }

    function save(
      contextName: string,
      events: ReadonlyArray<PersistedEventType>
    ): Effect.Effect<void, PlatformError.PlatformError> {
      return Effect.gen(function*() {
        const filePath = getContextPath(contextName)

        // Ensure directory exists
        yield* fs.makeDirectory(contextsDir, { recursive: true }).pipe(
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
