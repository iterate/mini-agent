/**
 * StreamManager - Layer 1
 *
 * Manages multiple named DurableStreams with lazy initialization.
 * Each stream is created on first access and cached.
 */
import type { Scope, Stream } from "effect"
import { Effect, HashMap, Layer, Ref } from "effect"
import { Storage } from "./storage.ts"
import { type DurableStream, makeDurableStream } from "./stream.ts"
import type { InvalidOffsetError, Offset, StorageError, StreamEvent, StreamName } from "./types.ts"

/** StreamManager service interface */
export interface StreamManager {
  /** Get or create a stream by name */
  getStream(opts: { name: StreamName }): Effect.Effect<DurableStream, StorageError>

  /** Append to a stream (creates if not exists) */
  append(opts: { name: StreamName; data: unknown }): Effect.Effect<StreamEvent, StorageError>

  /** Subscribe to a stream (creates if not exists) */
  subscribe(opts: {
    name: StreamName
    offset?: Offset | undefined
  }): Effect.Effect<Stream.Stream<StreamEvent>, InvalidOffsetError | StorageError, Scope.Scope>

  /** List all stream names */
  list(): Effect.Effect<ReadonlyArray<StreamName>, StorageError>

  /** Delete a stream */
  delete(opts: { name: StreamName }): Effect.Effect<void, StorageError>
}

/** StreamManager service tag and layer */
export class StreamManagerService extends Effect.Service<StreamManagerService>()(
  "@durable-streams/StreamManager",
  {
    effect: Effect.gen(function*() {
      const storage = yield* Storage

      // Cache of initialized streams
      const streamsRef = yield* Ref.make(HashMap.empty<StreamName, DurableStream>())

      const getStream = (opts: { name: StreamName }): Effect.Effect<DurableStream, StorageError> =>
        Effect.gen(function*() {
          const streams = yield* Ref.get(streamsRef)
          const existing = HashMap.get(streams, opts.name)

          if (existing._tag === "Some") {
            return existing.value
          }

          // Create new stream - provide Storage from closure
          const stream = yield* makeDurableStream({ name: opts.name }).pipe(
            Effect.provideService(Storage, storage)
          )
          yield* Ref.update(streamsRef, HashMap.set(opts.name, stream))
          return stream
        })

      const append = (opts: { name: StreamName; data: unknown }): Effect.Effect<StreamEvent, StorageError> =>
        Effect.gen(function*() {
          const stream = yield* getStream({ name: opts.name })
          return yield* stream.append({ data: opts.data })
        })

      const subscribe = (opts: {
        name: StreamName
        offset?: Offset | undefined
      }): Effect.Effect<Stream.Stream<StreamEvent>, InvalidOffsetError | StorageError, Scope.Scope> =>
        Effect.gen(function*() {
          const stream = yield* getStream({ name: opts.name })
          return yield* stream.subscribe(opts.offset !== undefined ? { offset: opts.offset } : {})
        })

      const list = (): Effect.Effect<ReadonlyArray<StreamName>, StorageError> => storage.list()

      const deleteStream = (opts: { name: StreamName }): Effect.Effect<void, StorageError> =>
        Effect.gen(function*() {
          yield* storage.delete(opts)
          yield* Ref.update(streamsRef, HashMap.remove(opts.name))
        })

      return {
        getStream,
        append,
        subscribe,
        list,
        delete: deleteStream
      } satisfies StreamManager
    }),
    dependencies: [Storage.Default]
  }
) {
  static readonly InMemory: Layer.Layer<StreamManagerService> = Layer.effect(
    StreamManagerService,
    Effect.gen(function*() {
      const storage = yield* Storage

      const streamsRef = yield* Ref.make(HashMap.empty<StreamName, DurableStream>())

      const getStream = (opts: { name: StreamName }): Effect.Effect<DurableStream, StorageError> =>
        Effect.gen(function*() {
          const streams = yield* Ref.get(streamsRef)
          const existing = HashMap.get(streams, opts.name)

          if (existing._tag === "Some") {
            return existing.value
          }

          const stream = yield* makeDurableStream({ name: opts.name }).pipe(
            Effect.provideService(Storage, storage)
          )
          yield* Ref.update(streamsRef, HashMap.set(opts.name, stream))
          return stream
        })

      const append = (opts: { name: StreamName; data: unknown }): Effect.Effect<StreamEvent, StorageError> =>
        Effect.gen(function*() {
          const stream = yield* getStream({ name: opts.name })
          return yield* stream.append({ data: opts.data })
        })

      const subscribe = (opts: {
        name: StreamName
        offset?: Offset | undefined
      }): Effect.Effect<Stream.Stream<StreamEvent>, InvalidOffsetError | StorageError, Scope.Scope> =>
        Effect.gen(function*() {
          const stream = yield* getStream({ name: opts.name })
          return yield* stream.subscribe(opts.offset !== undefined ? { offset: opts.offset } : {})
        })

      const list = (): Effect.Effect<ReadonlyArray<StreamName>, StorageError> => storage.list()

      const deleteStream = (opts: { name: StreamName }): Effect.Effect<void, StorageError> =>
        Effect.gen(function*() {
          yield* storage.delete(opts)
          yield* Ref.update(streamsRef, HashMap.remove(opts.name))
        })

      return {
        getStream,
        append,
        subscribe,
        list,
        delete: deleteStream
      } as unknown as StreamManagerService
    })
  ).pipe(Layer.provide(Storage.InMemory))
}
