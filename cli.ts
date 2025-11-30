/**
 * CLI Entry Point
 * 
 * Main CLI application that imports commands from cli/ subdirectory
 */

import { Command } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"

import { tasksCommand } from "./cli/tasks"
import { llmCommand } from "./cli/llm"
import { serverCommand } from "./cli/server"
import { rpcCommand } from "./cli/rpc"
import { createTracingLayer } from "./shared/tracing"

// =============================================================================
// Root Command
// =============================================================================

const rootCommand = Command.make("effect-tasks", {}, () =>
  Console.log(
    "effect-tasks CLI\n\n" +
    "Commands:\n" +
    "  tasks   - Task management (list, add, toggle, clear)\n" +
    "  llm     - LLM commands (generate)\n" +
    "  server  - Server management (start, stop, restart, status)\n" +
    "  rpc     - Interactive RPC explorer\n\n" +
    "Use '<command> --help' for more details"
  )
).pipe(
  Command.withDescription("Task manager with RPC backend"),
  Command.withSubcommands([tasksCommand, llmCommand, serverCommand, rpcCommand])
)

// =============================================================================
// Run CLI
// =============================================================================

const cli = Command.run(rootCommand, {
  name: "effect-tasks",
  version: "1.0.0"
})

const TelemetryLive = createTracingLayer("effect-tasks-cli")
const MainLayer = Layer.mergeAll(BunContext.layer, TelemetryLive)

// Context types are complex due to mixed command sources
const main = cli(process.argv).pipe(Effect.provide(MainLayer)) as Effect.Effect<void>
BunRuntime.runMain(main)
