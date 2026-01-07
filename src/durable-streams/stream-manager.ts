/**
 * StreamManager - Layer 1
 *
 * Manages multiple named DurableStreams with lazy initialization.
 * Each stream is created on first access and cached.
 */
import type { Scope } from "effect"
import { Effect, HashMap, Layer, Ref, Stream } from "effect"
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
    offset?: Offset
  }): Effect.Effect<Stream.Stream<StreamEvent>, InvalidOffsetError | StorageError, Scope.Scope>

  /** List all stream names */
  list(): Effect.Effect<ReadonlyArray<StreamName>, StorageError>

  /** Delete a stream */
  delete(opts: { name: StreamName }): Effect.Effect<void, StorageError>
}

/** Create StreamManager instance */
export const makeStreamManager = Effect.gen(function*() {
  const storage = yield* Storage

  // Cache of initialized streams (StreamName -> DurableStream)
  const streamsRef = yield* Ref.make(HashMap.empty<StreamName, DurableStream>())

  const getStream = (opts: { name: StreamName }): Effect.Effect<DurableStream, StorageError> =>
    Effect.gen(function*() {
      const streams = yield* Ref.get(streamsRef)
      const existing = HashMap.get(streams, opts.name)

      if (existing._tag === "Some") {
        return existing.value
      }

      // Create new stream
      const stream = yield* makeDurableStream({ name: opts.name })
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
    offset?: Offset
  }): Effect.Effect<Stream.Stream<StreamEvent>, InvalidOffsetError | StorageError, Scope.Scope> =>
    Effect.gen(function*() {
      const stream = yield* getStream({ name: opts.name })
      return yield* stream.subscribe({ offset: opts.offset })
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
})

/** StreamManager service tag */
export class StreamManagerService extends Effect.Service<StreamManagerService>()(
  "@durable-streams/StreamManager",
  {
    effect: makeStreamManager,
    dependencies: [Storage.Default]
  }
) {
  static readonly InMemory: Layer.Layer<StreamManagerService> = Layer.effect(
    StreamManagerService,
    makeStreamManager
  ).pipe(Layer.provide(Storage.InMemory))
}
