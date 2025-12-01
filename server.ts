/**
 * RPC Server Entry Point
 * 
 * Main server application that imports handlers from server/ subdirectory
 */

import { RpcServer, RpcSerialization } from "@effect/rpc"
import { HttpRouter, HttpMiddleware, HttpServerResponse } from "@effect/platform"
import { BunHttpServer, BunContext } from "@effect/platform-bun"
import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"

import { AllRpcs } from "./shared/schemas"
import { TaskHandlers } from "./server/tasks"
import { LlmHandlers } from "./server/llm"
import { createTracingLayer } from "./shared/tracing"
import { ServerPort } from "./shared/config"

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
// Health Check Route
// =============================================================================

const HealthRoute = HttpRouter.Default.use((router) =>
  Effect.gen(function* () {
    yield* router.get("/health", HttpServerResponse.json({ status: "ok" }))
    return router
  })
)

// =============================================================================
// Server Layer Factory
// =============================================================================

const makeServerLayer = (port: number) =>
  HttpRouter.Default.serve(HttpMiddleware.logger).pipe(
    Layer.provide(HealthRoute),
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

  yield* Effect.log("Starting server").pipe(
    Effect.annotateLogs({ port, rpcPath: "/rpc", healthPath: "/health" })
  )

  return yield* Layer.launch(makeServerLayer(port))
})

BunRuntime.runMain(main.pipe(Effect.provide(MainLayer)))
