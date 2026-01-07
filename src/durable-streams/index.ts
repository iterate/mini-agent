/**
 * Durable Streams - Event sourcing primitives with Effect-TS
 *
 * @module durable-streams
 */

// Types
export {
  InvalidOffsetError,
  isStartOffset,
  makeOffset,
  Offset,
  OFFSET_START,
  parseOffset,
  StorageError,
  StreamEvent,
  StreamName,
  StreamNotFoundError
} from "./types.ts"
export type { Offset as OffsetType, StreamName as StreamNameType } from "./types.ts"

// Storage
export { Storage } from "./storage.ts"

// Stream (Layer 0)
export { type DurableStream, makeDurableStream } from "./stream.ts"

// StreamManager (Layer 1)
export { type StreamManager, StreamManagerService } from "./stream-manager.ts"

// HTTP Routes (Layer 2)
export { durableStreamsRouter } from "./http-routes.ts"

// CLI
export { cli, run } from "./cli.ts"
