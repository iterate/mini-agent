/**
 * Context Repository
 *
 * Handles file I/O for context persistence. Contexts are stored as YAML files
 * in the configured data storage directory.
 */
import { FileSystem, Path } from "@effect/platform"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as YAML from "yaml"
import { AppConfig } from "./config.ts"
import {
  ContextName,
  DEFAULT_SYSTEM_PROMPT,
  makeBaseFields,
  PersistedEvent,
  type PersistedEvent as PersistedEventType,
  SystemPromptEvent
} from "./context.model.ts"
import {
  ContextLoadError,
  ContextSaveError,
  makeContextLoadError,
  makeContextSaveError
} from "./errors.ts"

/**
 * Decode a plain object to a PersistedEvent class instance.
 */
const decodeEvent = Schema.decodeUnknownSync(PersistedEvent)

/**
 * Decode an array of plain objects to PersistedEvent class instances.
 */
const decodeEvents = (rawEvents: Array<unknown>): Array<PersistedEventType> =>
  rawEvents.map((raw) => decodeEvent(raw))

/**
 * Encode an event to a plain object for YAML serialization.
 */
const encodeEvent = Schema.encodeSync(PersistedEvent)

export class ContextRepository extends Context.Tag("@app/ContextRepository")<
  ContextRepository,
  {
    readonly load: (
      contextName: string
    ) => Effect.Effect<Array<PersistedEventType>, ContextLoadError>
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
  static readonly layer = Layer.effect(
    ContextRepository,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const config = yield* AppConfig

      const cwd = Option.getOrElse(config.cwd, () => process.cwd())
      const contextsDir = path.join(cwd, config.dataStorageDir, "contexts")

      const getContextPath = (contextName: string) =>
        path.join(contextsDir, `${contextName}.yaml`)

      const save = Effect.fn("ContextRepository.save")(
        function*(contextName: string, events: ReadonlyArray<PersistedEventType>) {
          const filePath = getContextPath(contextName)

          yield* fs.makeDirectory(contextsDir, { recursive: true }).pipe(
            Effect.catchAll(() => Effect.void)
          )

          const plainEvents = events.map((e) => encodeEvent(e))
          const yaml = YAML.stringify({ events: plainEvents })

          yield* fs.writeFileString(filePath, yaml).pipe(
            Effect.mapError((error) =>
              makeContextSaveError(
                ContextName.make(contextName),
                `Failed to save context: ${error.message}`,
                error
              )
            )
          )
        }
      )

      const load = Effect.fn("ContextRepository.load")(function*(contextName: string) {
        const filePath = getContextPath(contextName)

        const exists = yield* fs.exists(filePath).pipe(
          Effect.mapError((error) =>
            makeContextLoadError(
              ContextName.make(contextName),
              `Failed to check if context exists: ${error.message}`,
              error
            )
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
          Effect.mapError((error) =>
            makeContextLoadError(
              ContextName.make(contextName),
              `Failed to load context: ${error instanceof Error ? error.message : String(error)}`,
              error
            )
          )
        )
      })

      const loadOrCreate = Effect.fn("ContextRepository.loadOrCreate")(
        function*(contextName: string) {
          const filePath = getContextPath(contextName)

          const exists = yield* fs.exists(filePath).pipe(
            Effect.mapError((error) =>
              makeContextLoadError(
                ContextName.make(contextName),
                `Failed to check if context exists: ${error.message}`,
                error
              )
            )
          )

          if (!exists) {
            const initialEvents = [
              new SystemPromptEvent({
                ...makeBaseFields(ContextName.make(contextName)),
                content: DEFAULT_SYSTEM_PROMPT
              })
            ]
            yield* save(contextName, initialEvents)
            return initialEvents
          }

          return yield* fs.readFileString(filePath).pipe(
            Effect.map((yaml) => {
              const parsed = YAML.parse(yaml) as { events?: Array<unknown> }
              return decodeEvents(parsed?.events ?? [])
            }),
            Effect.mapError((error) =>
              makeContextLoadError(
                ContextName.make(contextName),
                `Failed to load context: ${error instanceof Error ? error.message : String(error)}`,
                error
              )
            )
          )
        }
      )

      const list = Effect.fn("ContextRepository.list")(function*() {
        const exists = yield* fs.exists(contextsDir).pipe(
          Effect.mapError((error) =>
            makeContextLoadError(
              ContextName.make(""),
              `Failed to check contexts directory: ${error.message}`,
              error
            )
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
          Effect.mapError((error) =>
            makeContextLoadError(
              ContextName.make(""),
              `Failed to list contexts: ${error.message}`,
              error
            )
          )
        )
      })

      return ContextRepository.of({
        load,
        loadOrCreate,
        save,
        list,
        getContextsDir: () => contextsDir
      })
    })
  )

  static readonly testLayer = Layer.sync(ContextRepository, () => {
    const store = new Map<string, Array<PersistedEventType>>()

    return ContextRepository.of({
      load: (contextName: string) => Effect.succeed(store.get(contextName) ?? []),
      loadOrCreate: (contextName: string) =>
        Effect.sync(() => {
          const existing = store.get(contextName)
          if (existing) return existing
          const initial = [
            new SystemPromptEvent({
              ...makeBaseFields(ContextName.make(contextName)),
              content: DEFAULT_SYSTEM_PROMPT
            })
          ]
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
