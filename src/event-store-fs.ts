/**
 * FileSystem EventStore - Persists events as YAML files.
 *
 * Storage structure:
 * - {dataDir}/contexts/{contextName}.yaml
 * - Each file contains: { events: [...] }
 */

import { FileSystem, Path } from "@effect/platform"
import { Deferred, Effect, Layer, Option, Queue, Ref, Schema } from "effect"
import * as YAML from "yaml"
import { AppConfig } from "./config.ts"
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

    // Per-context write queues to prevent concurrent writes to the same file
    type WriteRequest = {
      events: ReadonlyArray<ContextEvent>
      deferred: Deferred.Deferred<void, ContextLoadError | ContextSaveError>
    }
    const contextQueues = yield* Ref.make(
      new Map<ContextName, Queue.Queue<WriteRequest>>()
    )

    const getOrCreateQueue = (contextName: ContextName) =>
      Effect.gen(function*() {
        const queues = yield* Ref.get(contextQueues)
        const existing = queues.get(contextName)
        if (existing) {
          return existing
        }

        const newQueue = yield* Queue.unbounded<WriteRequest>()

        // Start a fiber to process writes sequentially for this context
        yield* Effect.forkDaemon(
          Effect.forever(
            Effect.gen(function*() {
              const request = yield* Queue.take(newQueue)
              const result = yield* appendInternal(contextName, request.events).pipe(Effect.either)
              if (result._tag === "Left") {
                yield* Deferred.fail(request.deferred, result.left)
              } else {
                yield* Deferred.succeed(request.deferred, undefined)
              }
            })
          )
        )

        yield* Ref.update(contextQueues, (m) => {
          const newMap = new Map(m)
          newMap.set(contextName, newQueue)
          return newMap
        })
        return newQueue
      })

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

    // Internal append that does the actual file operation (not queue-aware)
    const appendInternal = (contextName: ContextName, events: ReadonlyArray<ContextEvent>) =>
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

    // Public append that uses queue for serialization
    const append = (contextName: ContextName, events: ReadonlyArray<ContextEvent>) =>
      Effect.gen(function*() {
        const queue = yield* getOrCreateQueue(contextName)
        const deferred = yield* Deferred.make<void, ContextLoadError | ContextSaveError>()
        yield* Queue.offer(queue, { events, deferred })
        yield* Deferred.await(deferred)
      })

    const exists = (contextName: ContextName) =>
      fs.exists(getContextPath(contextName)).pipe(
        Effect.catchAll(() => Effect.succeed(false))
      )

    const list = () =>
      Effect.gen(function*() {
        const dirExists = yield* fs.exists(contextsDir).pipe(
          Effect.catchAll(() => Effect.succeed(false))
        )
        if (!dirExists) {
          return [] as ReadonlyArray<ContextName>
        }

        const files = yield* fs.readDirectory(contextsDir).pipe(
          Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<string>))
        )

        // Filter for .yaml files and extract context names
        return files
          .filter((f) => f.endsWith(".yaml"))
          .map((f) => f.replace(/\.yaml$/, "") as ContextName)
      })

    return { load, append, exists, list } as unknown as EventStore
  })
)
