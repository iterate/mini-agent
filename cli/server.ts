/**
 * Server Management CLI Commands
 * 
 * Commands for starting, stopping, and managing the RPC server
 */

import { Command } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { daemonizeOption } from "./options"
import {
  isServerRunning,
  getServerPid,
  startServerBackground,
  startServerForeground,
  stopServer
} from "./server-utils"

// =============================================================================
// Commands
// =============================================================================

const startCommand = Command.make("start", { daemonize: daemonizeOption }, ({ daemonize }) =>
  Effect.gen(function* () {
    const running = yield* isServerRunning
    if (running) {
      yield* Console.log("Server is already running")
      return
    }
    
    if (daemonize) {
      yield* Console.log("Starting server in background...")
      const pid = yield* startServerBackground
      yield* Console.log(`Server started with PID ${pid}`)
    } else {
      yield* startServerForeground
    }
  })
).pipe(Command.withDescription("Start the RPC server"))

const stopCommand = Command.make("stop", {}, () =>
  Effect.gen(function* () {
    const stopped = yield* stopServer
    
    yield* Option.match(stopped, {
      onNone: () => Console.log("Server is not running"),
      onSome: (pid) => Console.log(`Stopped server (PID ${pid})`)
    })
  })
).pipe(Command.withDescription("Stop the RPC server"))

const restartCommand = Command.make("restart", { daemonize: daemonizeOption }, ({ daemonize }) =>
  Effect.gen(function* () {
    const stopped = yield* stopServer
    
    if (Option.isSome(stopped)) {
      yield* Console.log(`Stopped server (PID ${stopped.value})`)
      yield* Effect.sleep("500 millis")
    }

    if (daemonize) {
      yield* Console.log("Starting server in background...")
      const pid = yield* startServerBackground
      yield* Console.log(`Server started with PID ${pid}`)
    } else {
      yield* startServerForeground
    }
  })
).pipe(Command.withDescription("Restart the RPC server"))

const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const pid = yield* getServerPid
    const running = yield* isServerRunning

    if (running && Option.isSome(pid)) {
      yield* Console.log(`Server is running (PID ${pid.value})`)
    } else {
      yield* Console.log("Server is not running")
    }
  })
).pipe(Command.withDescription("Check server status"))

// =============================================================================
// Export Group Command
// =============================================================================

export const serverCommand = Command.make("server", {}, () =>
  Console.log("Server commands: start, stop, restart, status\nUse 'server <command> --help' for details")
).pipe(
  Command.withDescription("Manage the RPC server"),
  Command.withSubcommands([startCommand, stopCommand, restartCommand, statusCommand])
)
