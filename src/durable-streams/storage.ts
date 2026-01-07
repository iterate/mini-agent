/**
 * Storage abstraction for durable streams
 *
 * Implementations:
 * - InMemory: Fast, ephemeral (for tests)
 * - FileSystem: Persistent JSON files (for production)
 */
import { FileSystem, Path } from "@effect/platform"
import { Effect, Layer, Schema } from "effect"
import { isStartOffset, makeOffset, type Offset, StorageError, StreamEvent, type StreamName } from "./types.ts"

/** Stored event shape (internal) */
interface StoredEvent {
  readonly offset: Offset
  readonly data: unknown
  readonly timestamp: number
}

/** Storage service interface - all methods use object params */
export class Storage extends Effect.Service<Storage>()("@durable-streams/Storage", {
  succeed: {
    /** Append events to a stream, returns created events with offsets */
    append: (_opts: {
      name: StreamName
      events: ReadonlyArray<{ data: unknown }>
    }): Effect.Effect<ReadonlyArray<StreamEvent>, StorageError> => Effect.succeed([]),

    /** Get events from offset (inclusive). Offset -1 means from start */
    getFrom: (_opts: {
      name: StreamName
      offset: Offset
      limit?: number
    }): Effect.Effect<ReadonlyArray<StreamEvent>, StorageError> => Effect.succeed([]),

    /** Get all events for a stream */
    getAll: (_opts: {
      name: StreamName
    }): Effect.Effect<ReadonlyArray<StreamEvent>, StorageError> => Effect.succeed([]),

    /** Check if stream exists */
    exists: (_opts: {
      name: StreamName
    }): Effect.Effect<boolean, StorageError> => Effect.succeed(false),

    /** Create stream (idempotent) */
    create: (_opts: {
      name: StreamName
    }): Effect.Effect<void, StorageError> => Effect.void,

    /** Delete stream */
    delete: (_opts: {
      name: StreamName
    }): Effect.Effect<void, StorageError> => Effect.void,

    /** List all stream names */
    list: (): Effect.Effect<ReadonlyArray<StreamName>, StorageError> => Effect.succeed([])
  },
  accessors: true
}) {
  /** In-memory storage implementation. Uses mutable Map for simplicity in tests. */
  static readonly InMemory: Layer.Layer<Storage> = Layer.sync(Storage, () => {
    const store = new Map<StreamName, Array<StoredEvent>>()

    return {
      append: (opts: { name: StreamName; events: ReadonlyArray<{ data: unknown }> }) =>
        Effect.sync(() => {
          if (!store.has(opts.name)) {
            store.set(opts.name, [])
          }
          const events = store.get(opts.name)!
          const now = Date.now()
          const newEvents: Array<StreamEvent> = opts.events.map((e, i) =>
            new StreamEvent({
              offset: makeOffset(events.length + i),
              data: e.data,
              timestamp: now
            })
          )
          store.set(opts.name, [
            ...events,
            ...newEvents.map((e) => ({
              offset: e.offset,
              data: e.data,
              timestamp: e.timestamp
            }))
          ])
          return newEvents
        }),

      getFrom: (opts: { name: StreamName; offset: Offset; limit?: number }) =>
        Effect.sync(() => {
          const events = store.get(opts.name) ?? []
          if (isStartOffset(opts.offset)) {
            const limited = opts.limit ? events.slice(0, opts.limit) : events
            return limited.map((e) => new StreamEvent(e))
          }
          const filtered = events.filter((e) => e.offset >= opts.offset)
          const limited = opts.limit ? filtered.slice(0, opts.limit) : filtered
          return limited.map((e) => new StreamEvent(e))
        }),

      getAll: (opts: { name: StreamName }) =>
        Effect.sync(() => {
          const events = store.get(opts.name) ?? []
          return events.map((e) => new StreamEvent(e))
        }),

      exists: (opts: { name: StreamName }) => Effect.sync(() => store.has(opts.name)),

      create: (opts: { name: StreamName }) =>
        Effect.sync(() => {
          if (!store.has(opts.name)) {
            store.set(opts.name, [])
          }
        }),

      delete: (opts: { name: StreamName }) =>
        Effect.sync(() => {
          store.delete(opts.name)
        }),

      list: () => Effect.sync(() => Array.from(store.keys()))
    } as unknown as Storage
  })

  /**
   * FileSystem storage implementation.
   *
   * Storage structure:
   * - {dataDir}/streams/{streamName}.json
   * - Each file contains: { events: [...] }
   *
   * Requires dataDir to be provided (typically .iterate/)
   */
  static FileSystem(opts: {
    dataDir: string
  }): Layer.Layer<Storage, never, FileSystem.FileSystem | Path.Path> {
    return Layer.effect(
      Storage,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const streamsDir = path.join(opts.dataDir, "streams")

        const getStreamPath = (name: StreamName) => path.join(streamsDir, `${name}.json`)

        // Schema for file contents
        const FileSchema = Schema.Struct({
          events: Schema.Array(Schema.Struct({
            offset: Schema.String,
            data: Schema.Unknown,
            timestamp: Schema.Number
          }))
        })

        const readStreamFile = (name: StreamName): Effect.Effect<Array<StoredEvent>, StorageError> =>
          Effect.gen(function*() {
            const filePath = getStreamPath(name)
            const exists = yield* fs.exists(filePath).pipe(
              Effect.catchAll(() => Effect.succeed(false))
            )

            if (!exists) {
              return []
            }

            const content = yield* fs.readFileString(filePath).pipe(
              Effect.mapError((e) => new StorageError({ message: `Failed to read stream file: ${e}` }))
            )

            const parsed = yield* Effect.try({
              try: () => JSON.parse(content) as unknown,
              catch: (e) => new StorageError({ message: `Invalid JSON in stream file: ${e}` })
            })

            const decoded = yield* Schema.decodeUnknown(FileSchema)(parsed).pipe(
              Effect.mapError((e) => new StorageError({ message: `Invalid stream file schema: ${e}` }))
            )

            return decoded.events.map((e) => ({
              offset: e.offset as Offset,
              data: e.data,
              timestamp: e.timestamp
            }))
          })

        const writeStreamFile = (
          name: StreamName,
          events: Array<StoredEvent>
        ): Effect.Effect<void, StorageError> =>
          Effect.gen(function*() {
            // Ensure directory exists
            yield* fs.makeDirectory(streamsDir, { recursive: true }).pipe(
              Effect.catchAll(() => Effect.void)
            )

            const filePath = getStreamPath(name)
            const content = JSON.stringify(
              { events: events.map((e) => ({ offset: e.offset, data: e.data, timestamp: e.timestamp })) },
              null,
              2
            )

            yield* fs.writeFileString(filePath, content).pipe(
              Effect.mapError((e) => new StorageError({ message: `Failed to write stream file: ${e}` }))
            )
          })

        return {
          append: (appendOpts: { name: StreamName; events: ReadonlyArray<{ data: unknown }> }) =>
            Effect.gen(function*() {
              const existing = yield* readStreamFile(appendOpts.name)
              const now = Date.now()

              const newEvents: Array<StreamEvent> = appendOpts.events.map((e, i) =>
                new StreamEvent({
                  offset: makeOffset(existing.length + i),
                  data: e.data,
                  timestamp: now
                })
              )

              const combined = [
                ...existing,
                ...newEvents.map((e) => ({
                  offset: e.offset,
                  data: e.data,
                  timestamp: e.timestamp
                }))
              ]

              yield* writeStreamFile(appendOpts.name, combined)

              return newEvents
            }),

          getFrom: (getFromOpts: { name: StreamName; offset: Offset; limit?: number }) =>
            Effect.gen(function*() {
              const events = yield* readStreamFile(getFromOpts.name)

              let filtered: Array<StoredEvent>
              if (isStartOffset(getFromOpts.offset)) {
                filtered = events
              } else {
                filtered = events.filter((e) => e.offset >= getFromOpts.offset)
              }

              const limited = getFromOpts.limit ? filtered.slice(0, getFromOpts.limit) : filtered
              return limited.map((e) => new StreamEvent(e))
            }),

          getAll: (getAllOpts: { name: StreamName }) =>
            Effect.gen(function*() {
              const events = yield* readStreamFile(getAllOpts.name)
              return events.map((e) => new StreamEvent(e))
            }),

          exists: (existsOpts: { name: StreamName }) =>
            fs.exists(getStreamPath(existsOpts.name)).pipe(
              Effect.catchAll(() => Effect.succeed(false))
            ),

          create: (createOpts: { name: StreamName }) =>
            Effect.gen(function*() {
              const filePath = getStreamPath(createOpts.name)
              const exists = yield* fs.exists(filePath).pipe(
                Effect.catchAll(() => Effect.succeed(false))
              )

              if (!exists) {
                yield* writeStreamFile(createOpts.name, [])
              }
            }),

          delete: (deleteOpts: { name: StreamName }) =>
            fs.remove(getStreamPath(deleteOpts.name)).pipe(
              Effect.catchAll(() => Effect.void),
              Effect.asVoid
            ),

          list: () =>
            Effect.gen(function*() {
              const dirExists = yield* fs.exists(streamsDir).pipe(
                Effect.catchAll(() => Effect.succeed(false))
              )

              if (!dirExists) {
                return [] as ReadonlyArray<StreamName>
              }

              const entries = yield* fs.readDirectory(streamsDir).pipe(
                Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<string>))
              )

              return entries
                .filter((name) => name.endsWith(".json"))
                .map((name) => name.slice(0, -5) as StreamName)
            })
        } as unknown as Storage
      })
    )
  }
}
