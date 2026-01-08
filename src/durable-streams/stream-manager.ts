/**
 * StreamManager - Layer 4
 *
 * Manages multiple named DurableStreams with lazy initialization.
 * Each stream is created on first access and cached.
 * Uses DurableStreamFactory for stream creation (enables hook composition).
 */
import type { Scope, Stream } from "effect"
import { Effect, HashMap, Layer, Ref } from "effect"
import { Storage } from "./storage.ts"
import { DurableStreamFactory, PlainFactory } from "./stream-factory.ts"
import type { DurableStream } from "./stream.ts"
import {
  type InvalidOffsetError,
  type Offset,
  OFFSET_START,
  type StorageError,
  type StreamEvent,
  type StreamName
} from "./types.ts"

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

  /** Get events from a stream (one-shot, no live subscription) */
  getFrom(opts: {
    name: StreamName
    offset?: Offset | undefined
    limit?: number
  }): Effect.Effect<ReadonlyArray<StreamEvent>, InvalidOffsetError | StorageError>

  /** List all stream names */
  list(): Effect.Effect<ReadonlyArray<StreamName>, StorageError>

  /** Delete a stream */
  delete(opts: { name: StreamName }): Effect.Effect<void, StorageError>
}

/** Helper to create StreamManager implementation given factory and storage */
const makeStreamManager = Effect.gen(function*() {
  const factory = yield* DurableStreamFactory
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

      // Create new stream via factory
      const stream = yield* factory.make(opts)
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

  const getFrom = (opts: {
    name: StreamName
    offset?: Offset | undefined
    limit?: number
  }): Effect.Effect<ReadonlyArray<StreamEvent>, InvalidOffsetError | StorageError> =>
    Effect.gen(function*() {
      const stream = yield* getStream({ name: opts.name })
      const offset = opts.offset ?? OFFSET_START
      return yield* stream.getFrom(
        opts.limit !== undefined ? { offset, limit: opts.limit } : { offset }
      )
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
    getFrom,
    list,
    delete: deleteStream
  } satisfies StreamManager
})

/** StreamManager service tag and layer */
export class StreamManagerService extends Effect.Service<StreamManagerService>()(
  "@durable-streams/StreamManager",
  {
    effect: makeStreamManager,
    dependencies: [Storage.Default, DurableStreamFactory.Default]
  }
) {
  /** Create a StreamManagerService layer - requires Storage and DurableStreamFactory */
  static readonly Live: Layer.Layer<StreamManagerService, never, Storage | DurableStreamFactory> = Layer.effect(
    StreamManagerService,
    makeStreamManager as Effect.Effect<StreamManagerService>
  )

  /** In-memory layer with plain factory (for tests) */
  static readonly InMemory: Layer.Layer<StreamManagerService> = StreamManagerService.Live.pipe(
    Layer.provide(PlainFactory),
    Layer.provide(Storage.InMemory)
  )
}
