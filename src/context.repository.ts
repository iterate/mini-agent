/**
 * Context Repository
 *
 * Handles file I/O for context persistence. Contexts are stored as YAML files
 * in the configured data storage directory.
 */
import { FileSystem, Path } from "@effect/platform"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as YAML from "yaml"
import { AppConfig } from "./config.js"
import {
  ContextName,
  DEFAULT_SYSTEM_PROMPT,
  PersistedEvent,
  type PersistedEvent as PersistedEventType,
  SystemPromptEvent
} from "./context.model.js"
import { ContextLoadError, ContextSaveError } from "./errors.js"

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

export class ContextRepository extends Context.Tag("@app/ContextRepository")<
  ContextRepository,
  {
    readonly load: (contextName: string) => Effect.Effect<Array<PersistedEventType>, ContextLoadError>
    readonly loadOrCreate: (
      contextName: string
    ) => Effect.Effect<Array<PersistedEventType>, ContextLoadError | ContextSaveError>
    readonly save: (
      contextName: string,
      events: ReadonlyArray<PersistedEventType>
    ) => Effect.Effect<void, ContextSaveError>
    readonly list: () => Effect.Effect<Array<string>, ContextLoadError>
    readonly getContextsDir: () => string
  }
>() {
  /**
   * Production layer with file system persistence.
   */
  static readonly layer = Layer.effect(
    ContextRepository,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const config = yield* AppConfig

      // Resolve the contexts directory from config
      const cwd = Option.getOrElse(config.cwd, () => process.cwd())
      const contextsDir = path.join(cwd, config.dataStorageDir, "contexts")

      const getContextPath = (contextName: string) => path.join(contextsDir, `${contextName}.yaml`)

      // Service methods wrapped with Effect.fn for call-site tracing
      // See: https://www.effect.solutions/services-and-layers

      /**
       * Save events to a context file.
       */
      const save = Effect.fn("ContextRepository.save")(
        function*(contextName: string, events: ReadonlyArray<PersistedEventType>) {
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
          yield* fs.writeFileString(filePath, yaml).pipe(
            Effect.catchAll((error) =>
              new ContextSaveError({
                name: ContextName.make(contextName),
                cause: error
              })
            )
          )
        }
      )

      /**
       * Load events from a context file.
       * Returns empty array if context doesn't exist.
       */
      const load = Effect.fn("ContextRepository.load")(
        function*(contextName: string) {
          const filePath = getContextPath(contextName)
          const exists = yield* fs.exists(filePath).pipe(
            Effect.catchAll((error) =>
              new ContextLoadError({
                name: ContextName.make(contextName),
                cause: error
              })
            )
          )

          if (!exists) {
            return [] as Array<PersistedEventType>
          }

          return yield* fs.readFileString(filePath).pipe(
            Effect.map((yaml) => {
              const parsed = YAML.parse(yaml) as { events?: Array<unknown> }
              return decodeEvents(parsed?.events ?? [])
            }),
            Effect.catchAll((error) =>
              new ContextLoadError({
                name: ContextName.make(contextName),
                cause: error
              })
            )
          )
        }
      )

      /**
       * Load events from a context, creating it with default system prompt if it doesn't exist.
       */
      const loadOrCreate = Effect.fn("ContextRepository.loadOrCreate")(
        function*(contextName: string) {
          const filePath = getContextPath(contextName)
          const exists = yield* fs.exists(filePath).pipe(
            Effect.catchAll((error) =>
              new ContextLoadError({
                name: ContextName.make(contextName),
                cause: error
              })
            )
          )

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
            Effect.catchAll((error) =>
              new ContextLoadError({
                name: ContextName.make(contextName),
                cause: error
              })
            )
          )
        }
      )

      /**
       * List all existing context names.
       */
      const list = Effect.fn("ContextRepository.list")(
        function*() {
          const exists = yield* fs.exists(contextsDir).pipe(
            Effect.catchAll((error) =>
              new ContextLoadError({
                name: ContextName.make(""),
                cause: error
              })
            )
          )
          if (!exists) return [] as Array<string>

          return yield* fs.readDirectory(contextsDir).pipe(
            Effect.map((entries) =>
              entries
                .filter((name) => name.endsWith(".yaml"))
                .map((name) => name.replace(/\.yaml$/, ""))
                .sort()
            ),
            Effect.catchAll((error) =>
              new ContextLoadError({
                name: ContextName.make(""),
                cause: error
              })
            )
          )
        }
      )

      return ContextRepository.of({
        load,
        loadOrCreate,
        save,
        list,
        getContextsDir: () => contextsDir
      })
    })
  )

  /**
   * Test layer with in-memory storage for unit tests.
   * See: https://www.effect.solutions/testing
   */
  static readonly testLayer = Layer.sync(ContextRepository, () => {
    const store = new Map<string, Array<PersistedEventType>>()

    return ContextRepository.of({
      load: (contextName: string) => Effect.succeed(store.get(contextName) ?? []),
      loadOrCreate: (contextName: string) =>
        Effect.sync(() => {
          const existing = store.get(contextName)
          if (existing) return existing
          const initial = [new SystemPromptEvent({ content: DEFAULT_SYSTEM_PROMPT })]
          store.set(contextName, initial)
          return initial
        }),
      save: (contextName: string, events: ReadonlyArray<PersistedEventType>) =>
        Effect.sync(() => void store.set(contextName, [...events])),
      list: () => Effect.sync(() => Array.from(store.keys()).sort()),
      getContextsDir: () => "/test/contexts"
    })
  })
}
