/**
 * RPC Client Helpers
 * 
 * Shared utilities for creating RPC clients in CLI commands
 */

import { RpcClient, RpcSerialization } from "@effect/rpc"
import { FetchHttpClient } from "@effect/platform"
import { Effect, Layer, Stream } from "effect"
import { TaskRpcs, LlmRpcs, Task } from "../shared/schemas"

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_SERVER_URL = "http://localhost:3000/rpc"

// =============================================================================
// Client Layer Factory
// =============================================================================

const makeClientLayer = (serverUrl: string) =>
  RpcClient.layerProtocolHttp({ url: serverUrl }).pipe(
    Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson])
  )

// =============================================================================
// Client Types
// =============================================================================

export interface TaskClient {
  readonly list: (input: { readonly all?: boolean }) => Effect.Effect<ReadonlyArray<Task>>
  readonly add: (input: { readonly text: string }) => Effect.Effect<Task>
  readonly toggle: (input: { readonly id: number }) => Effect.Effect<Task>
  readonly clear: (input: Record<string, never>) => Effect.Effect<{ readonly cleared: number }>
}

export interface LlmClient {
  readonly generate: (input: { readonly prompt: string }) => Effect.Effect<string>
  readonly generateStream: (input: { readonly prompt: string }) => Stream.Stream<string>
}

// =============================================================================
// Scoped Client Helpers
// =============================================================================

/**
 * Run an operation with a scoped TaskRpcs client
 */
export const withTaskClient = <A, E>(
  serverUrl: string,
  fn: (client: TaskClient) => Effect.Effect<A, E>
): Effect.Effect<A, E | unknown> =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(TaskRpcs)
    return yield* fn(client as unknown as TaskClient)
  }).pipe(
    Effect.scoped,
    Effect.provide(makeClientLayer(serverUrl))
  )

/**
 * Run an operation with a scoped LlmRpcs client  
 */
export const withLlmClient = <A, E>(
  serverUrl: string,
  fn: (client: LlmClient) => Effect.Effect<A, E>
): Effect.Effect<A, E | unknown> =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(LlmRpcs)
    return yield* fn(client as unknown as LlmClient)
  }).pipe(
    Effect.scoped,
    Effect.provide(makeClientLayer(serverUrl))
  )

/**
 * Get a raw client layer for custom usage (e.g., interactive mode)
 */
export const getClientLayer = makeClientLayer
