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

// Storage (Layer 0)
export { Storage } from "./storage.ts"

// Stream (Layer 1)
export { type DurableStream, makeDurableStream } from "./stream.ts"

// Hooks (Layer 2)
export { type AfterAppendHook, type BeforeAppendHook, HookError, type StreamHooks } from "./hooks.ts"
export { withHooks } from "./with-hooks.ts"

// Stream Factory (Layer 3)
export {
  ActiveFactory,
  DurableStreamFactory,
  EmbryonicAgentFactory,
  PlainFactory,
  ValidatedFactory
} from "./stream-factory.ts"

// StreamManager (Layer 4)
export { type StreamManager, StreamManagerService } from "./stream-manager.ts"

// HTTP Routes (Layer 5)
export { durableStreamsRouter } from "./http-routes.ts"

// CLI
export { cli, run } from "./cli.ts"
