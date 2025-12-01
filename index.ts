import { Command, Options } from "@effect/cli"
import { FileSystem } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer, Option } from "effect"

import { RpcRegistry } from "./shared/schemas.js"
import { deriveCli } from "./shared/derive.js"
import { createTracingLayer } from "./shared/tracing.js"

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_SERVER_URL = "http://localhost:3000/rpc"
const PID_FILE = "server.pid"

// =============================================================================
// Server Management Helpers
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
    env: process.env
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
// Server Management Commands
// =============================================================================

const daemonizeOption = Options.boolean("daemonize").pipe(
  Options.withAlias("d"),
  Options.withDescription("Run in background"),
  Options.withDefault(false)
)

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

const serverCommand = Command.make("server", {}, () =>
  Console.log("Usage: server <start|stop|restart|status>")
).pipe(
  Command.withDescription("Manage the RPC server"),
  Command.withSubcommands([startCommand, stopCommand, restartCommand, statusCommand])
)

// =============================================================================
// Derive CLI from RPC Registry
// =============================================================================

const derivedCli = deriveCli(RpcRegistry, {
  name: "api",
  version: "1.0.0",
  serverUrl: DEFAULT_SERVER_URL
})

// =============================================================================
// Root Command
// =============================================================================

const rootCommand = Command.make("effect-tasks", {}, () =>
  Console.log(
    "effect-tasks CLI\n\n" +
    "Usage:\n" +
    "  effect-tasks <group> <command> [options]\n" +
    "  effect-tasks server <start|stop|restart|status>\n\n" +
    "RPC Groups: tasks, llm\n" +
    "Use '<group> <command> --help' for details"
  )
).pipe(
  Command.withDescription("Task manager with RPC backend"),
  Command.withSubcommands([derivedCli, serverCommand])
)

// =============================================================================
// Run CLI
// =============================================================================

const cli = Command.run(rootCommand, {
  name: "effect-tasks",
  version: "1.0.0"
})

const TelemetryLive = createTracingLayer("effect-tasks-cli")

// Server commands need FileSystem from BunContext, telemetry provides TraceLinks
const MainLayer = Layer.mergeAll(BunContext.layer, TelemetryLive)

// Run CLI - context types are complex due to deriveCli using unknown context,
// but we know at runtime that MainLayer provides all required services
const main = cli(process.argv).pipe(Effect.provide(MainLayer)) as Effect.Effect<void>
BunRuntime.runMain(main)
