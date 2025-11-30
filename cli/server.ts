/**
 * Server Management CLI Commands
 * 
 * Commands for starting, stopping, and managing the RPC server
 */

import { Command } from "@effect/cli"
import { FileSystem } from "@effect/platform"
import { Console, Effect, Option } from "effect"
import { daemonizeOption } from "./options"

// =============================================================================
// Configuration
// =============================================================================

const PID_FILE = "server.pid"

// =============================================================================
// Helper Effects
// =============================================================================

const isServerRunning = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs.exists(PID_FILE)
  if (!exists) return false

  const pidStr = yield* fs.readFileString(PID_FILE)
  const pid = parseInt(pidStr.trim(), 10)
  if (isNaN(pid)) return false

  try {
    process.kill(pid, 0)
    return true
  } catch {
    yield* fs.remove(PID_FILE).pipe(Effect.ignore)
    return false
  }
})

const getServerPid = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs.exists(PID_FILE)
  if (!exists) return Option.none<number>()

  const pidStr = yield* fs.readFileString(PID_FILE)
  const pid = parseInt(pidStr.trim(), 10)
  if (isNaN(pid)) return Option.none<number>()
  return Option.some(pid)
})

const startServerBackground = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  yield* Console.log("Starting server in background...")

  const proc = Bun.spawn(["bun", "server.ts"], {
    cwd: process.cwd(),
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    env: process.env // Inherit env vars (e.g., from doppler)
  })

  yield* fs.writeFileString(PID_FILE, String(proc.pid))
  yield* Console.log(`Server started with PID ${proc.pid}`)
  proc.unref()
})

const startServerForeground = Effect.gen(function* () {
  yield* Console.log("Starting server in foreground (Ctrl+C to stop)...")
  yield* Effect.tryPromise(async () => {
    const { $ } = await import("bun")
    await $`bun server.ts`
  }).pipe(Effect.catchAll(() => Console.error("Server exited")))
})

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
    yield* daemonize ? startServerBackground : startServerForeground
  })
).pipe(Command.withDescription("Start the RPC server"))

const stopCommand = Command.make("stop", {}, () =>
  Effect.gen(function* () {
    const pid = yield* getServerPid
    const fs = yield* FileSystem.FileSystem

    yield* Option.match(pid, {
      onNone: () => Console.log("Server is not running"),
      onSome: (p) =>
        Effect.gen(function* () {
          try {
            process.kill(p, "SIGTERM")
            yield* Console.log(`Sent SIGTERM to server (PID ${p})`)
          } catch {
            yield* Console.log("Server process not found")
          }
          yield* fs.remove(PID_FILE).pipe(Effect.ignore)
        })
    })
  })
).pipe(Command.withDescription("Stop the RPC server"))

const restartCommand = Command.make("restart", { daemonize: daemonizeOption }, ({ daemonize }) =>
  Effect.gen(function* () {
    const pid = yield* getServerPid
    const fs = yield* FileSystem.FileSystem

    if (Option.isSome(pid)) {
      try {
        process.kill(pid.value, "SIGTERM")
        yield* Console.log(`Stopped server (PID ${pid.value})`)
      } catch {
        // Process already dead
      }
      yield* fs.remove(PID_FILE).pipe(Effect.ignore)
      yield* Effect.sleep("500 millis")
    }

    yield* daemonize ? startServerBackground : startServerForeground
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

