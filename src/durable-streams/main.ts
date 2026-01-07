/**
 * Durable Streams CLI Entry Point
 *
 * Usage: npx tsx src/durable-streams/main.ts start [--port 3000]
 */
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Layer, Logger, LogLevel } from "effect"
import { run } from "./cli.ts"

const loggingLayer = Logger.minimumLogLevel(LogLevel.Info)

const mainLayer = Layer.mergeAll(loggingLayer, NodeContext.layer)

run(process.argv).pipe(
  Effect.provide(mainLayer),
  Effect.catchAllCause((cause) => Cause.isInterruptedOnly(cause) ? Effect.void : Effect.failCause(cause)),
  NodeRuntime.runMain
)
