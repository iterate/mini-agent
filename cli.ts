/**
 * CLI Entry Point
 * 
 * Main CLI application that imports commands from cli/ subdirectory
 */

import { Command } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"

import { tasksCommand } from "./cli/tasks"
import { llmCommand } from "./cli/llm"
import { serverCommand } from "./cli/server"
import { rpcCommand } from "./cli/rpc"
import { createTracingLayer } from "./shared/tracing"
import pkg from "./package.json"

// =============================================================================
// Root Command
// =============================================================================

const rootCommand = Command.make("effect-tasks", {}, () => Effect.void).pipe(
  Command.withDescription("Task manager with RPC backend"),
  Command.withSubcommands([tasksCommand, llmCommand, serverCommand, rpcCommand])
)

// =============================================================================
// Run CLI
// =============================================================================

const cli = Command.run(rootCommand, {
  name: pkg.name,
  version: pkg.version
})

const TelemetryLive = createTracingLayer("mini-agent-cli") 
const MainLayer = Layer.mergeAll(BunContext.layer, TelemetryLive)

// Run CLI with all required context
cli(process.argv).pipe(
  Effect.provide(MainLayer),
  Effect.catchAllDefect((defect) => Effect.logError("Unexpected error", defect)),
  BunRuntime.runMain
)
