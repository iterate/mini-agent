/**
 * RPC Server Entry Point
 * 
 * Main server application that imports handlers from server/ subdirectory
 */

import { RpcServer, RpcSerialization } from "@effect/rpc"
import { HttpRouter, HttpMiddleware } from "@effect/platform"
import { BunHttpServer, BunContext } from "@effect/platform-bun"
import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer, Config } from "effect"

import { AllRpcs } from "./shared/schemas"
import { TaskHandlers } from "./server/tasks"
import { LlmHandlers } from "./server/llm"
import { createTracingLayer } from "./shared/tracing"

// =============================================================================
// Configuration
// =============================================================================

const ServerPort = Config.integer("PORT").pipe(Config.withDefault(3000))

// =============================================================================
// RPC Layer Composition
// =============================================================================

// Merge all handlers into a single layer for the combined RpcGroup
const AllHandlers = Layer.mergeAll(TaskHandlers, LlmHandlers)

const RpcLive = RpcServer.layer(AllRpcs).pipe(Layer.provide(AllHandlers))

const HttpProtocol = RpcServer.layerProtocolHttp({
  path: "/rpc"
}).pipe(Layer.provide(RpcSerialization.layerNdjson))

// =============================================================================
// Server Layer Factory
// =============================================================================

const makeServerLayer = (port: number) =>
  HttpRouter.Default.serve(HttpMiddleware.logger).pipe(
    Layer.provide(RpcLive),
    Layer.provide(HttpProtocol),
    Layer.provide(BunHttpServer.layer({ port }))
  )

// =============================================================================
// Main
// =============================================================================

const TelemetryLive = createTracingLayer("effect-tasks-server")
const MainLayer = Layer.merge(TelemetryLive, BunContext.layer)

const main = Effect.gen(function* () {
  const port = yield* ServerPort
  yield* Console.log(`Starting server on http://localhost:${port}`)
  yield* Console.log(`RPC endpoint: POST http://localhost:${port}/rpc`)
  return yield* Layer.launch(makeServerLayer(port))
})

BunRuntime.runMain(main.pipe(Effect.provide(MainLayer)))
