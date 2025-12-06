/**
 * FileSystem EventStore - Persists events as YAML files.
 *
 * Storage structure:
 * - {dataDir}/contexts/{contextName}.yaml
 * - Each file contains: { events: [...] }
 */

import { FileSystem, Path } from "@effect/platform"
import { Effect, Layer, Option, Schema } from "effect"
import * as YAML from "yaml"
import { AppConfig } from "../config.ts"
import { ContextEvent, ContextLoadError, type ContextName, ContextSaveError } from "./domain.ts"
import { EventStore } from "./event-store.ts"

const encodeEvent = Schema.encodeSync(ContextEvent)
const decodeEvent = Schema.decodeUnknownSync(ContextEvent)

/**
 * FileSystem-backed EventStore layer.
 * Requires AppConfig, FileSystem, and Path services.
 */
export const EventStoreFileSystem: Layer.Layer<
  EventStore,
  never,
  AppConfig | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  EventStore,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = yield* AppConfig

    const cwd = Option.getOrElse(config.cwd, () => process.cwd())
    const contextsDir = path.join(cwd, config.dataStorageDir, "contexts-v2")

    const getContextPath = (contextName: ContextName) => path.join(contextsDir, `${contextName}.yaml`)

    const load = (contextName: ContextName) =>
      Effect.gen(function*() {
        const filePath = getContextPath(contextName)
        const fileExists = yield* fs.exists(filePath).pipe(
          Effect.catchAll((error) =>
            Effect.fail(
              new ContextLoadError({
                contextName,
                message: `Failed to check file existence`,
                cause: Option.some(error)
              })
            )
          )
        )

        if (!fileExists) {
          return [] as ReadonlyArray<ContextEvent>
        }

        return yield* fs.readFileString(filePath).pipe(
          Effect.map((yaml) => {
            const parsed = YAML.parse(yaml) as { events?: Array<unknown> }
            return (parsed?.events ?? []).map((raw) => decodeEvent(raw))
          }),
          Effect.catchAll((error) =>
            Effect.fail(
              new ContextLoadError({
                contextName,
                message: `Failed to read context file`,
                cause: Option.some(error)
              })
            )
          )
        )
      })

    const append = (contextName: ContextName, events: ReadonlyArray<ContextEvent>) =>
      Effect.gen(function*() {
        const filePath = getContextPath(contextName)

        // Ensure directory exists
        yield* fs.makeDirectory(contextsDir, { recursive: true }).pipe(
          Effect.catchAll(() => Effect.void)
        )

        // Load existing events
        const existing = yield* load(contextName)

        // Combine and encode
        const combined = [...existing, ...events]
        const plainEvents = combined.map((e) => encodeEvent(e))
        const yaml = YAML.stringify({ events: plainEvents })

        yield* fs.writeFileString(filePath, yaml).pipe(
          Effect.catchAll((error) =>
            Effect.fail(
              new ContextSaveError({
                contextName,
                message: `Failed to write context file`,
                cause: Option.some(error)
              })
            )
          )
        )
      })

    const exists = (contextName: ContextName) =>
      fs.exists(getContextPath(contextName)).pipe(
        Effect.catchAll(() => Effect.succeed(false))
      )

    return { load, append, exists } as unknown as EventStore
  })
)
