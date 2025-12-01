/**
 * RPC Client Helpers
 * 
 * Shared utilities for creating RPC clients in CLI commands.
 * Client types are derived from RPC schemas for type safety.
 */

import { RpcClient, RpcSerialization } from "@effect/rpc"
import { FetchHttpClient, FileSystem } from "@effect/platform"
import { Effect, Layer } from "effect"
import { TaskRpcs, LlmRpcs } from "../shared/schemas"
import { DEFAULT_SERVER_URL } from "../shared/config"
import { ensureServerRunning } from "./server-utils"
import type { PlatformError } from "@effect/platform/Error"
import type { RpcClientError } from "@effect/rpc/RpcClientError"

// =============================================================================
// Re-export for backwards compatibility
// =============================================================================

export { DEFAULT_SERVER_URL }

// =============================================================================
// Client Layer Factory
// =============================================================================

const makeClientLayer = (serverUrl: string) =>
  RpcClient.layerProtocolHttp({ url: serverUrl }).pipe(
    Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson])
  )

// =============================================================================
// Derived Client Types (from RPC schemas)
// =============================================================================

/** TaskRpcs client type derived from schema */
export type TaskClient = RpcClient.FromGroup<typeof TaskRpcs, RpcClientError>

/** LlmRpcs client type derived from schema */
export type LlmClient = RpcClient.FromGroup<typeof LlmRpcs, RpcClientError>

// =============================================================================
// Scoped Client Helpers (with auto-start)
// =============================================================================

/**
 * Run an operation with a scoped TaskRpcs client.
 * Automatically starts the server if not running.
 */
export const withTaskClient = <A, E>(
  serverUrl: string,
  fn: (client: TaskClient) => Effect.Effect<A, E>
): Effect.Effect<A, E | Error | PlatformError | RpcClientError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* ensureServerRunning(serverUrl)
    const client: TaskClient = yield* RpcClient.make(TaskRpcs)
    return yield* fn(client)
  }).pipe(
    Effect.scoped,
    Effect.provide(makeClientLayer(serverUrl))
  )

/**
 * Run an operation with a scoped LlmRpcs client.
 * Automatically starts the server if not running.
 */
export const withLlmClient = <A, E>(
  serverUrl: string,
  fn: (client: LlmClient) => Effect.Effect<A, E>
): Effect.Effect<A, E | Error | PlatformError | RpcClientError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* ensureServerRunning(serverUrl)
    const client: LlmClient = yield* RpcClient.make(LlmRpcs)
    return yield* fn(client)
  }).pipe(
    Effect.scoped,
    Effect.provide(makeClientLayer(serverUrl))
  )

/**
 * Get a raw client layer for custom usage (e.g., interactive mode)
 */
export const getClientLayer = makeClientLayer
