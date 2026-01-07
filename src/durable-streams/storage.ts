/**
 * Storage abstraction for durable streams
 */
import { Effect, Layer } from "effect"
import { isStartOffset, makeOffset, type Offset, type StorageError, StreamEvent, type StreamName } from "./types.ts"

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
}
