/**
 * Server Management Utilities
 * 
 * Shared utilities for server process management.
 * Process operations wrapped in Effect.try for proper error handling.
 */

import { FileSystem } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Console, Effect, Option, Schedule } from "effect"

// =============================================================================
// Configuration
// =============================================================================

export const PID_FILE = "server.pid"
export const DEFAULT_SERVER_PORT = 3000

// =============================================================================
// Process Helpers (pure functions)
// =============================================================================

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const killProcess = (pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean => {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

// =============================================================================
// Server Status Checks
// =============================================================================

/**
 * Check if the server process is running (PID file exists and process alive)
 */
export const isServerRunning: Effect.Effect<boolean, PlatformError, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(PID_FILE)
    if (!exists) return false

    const pidStr = yield* fs.readFileString(PID_FILE)
    const pid = parseInt(pidStr.trim(), 10)
    if (isNaN(pid)) return false

    if (isProcessAlive(pid)) {
      return true
    }

    // Stale PID file - clean up
    yield* fs.remove(PID_FILE).pipe(Effect.ignore)
    return false
  })

/**
 * Get the server PID if available
 */
export const getServerPid: Effect.Effect<Option.Option<number>, PlatformError, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(PID_FILE)
    if (!exists) return Option.none<number>()

    const pidStr = yield* fs.readFileString(PID_FILE)
    const pid = parseInt(pidStr.trim(), 10)
    if (isNaN(pid)) return Option.none<number>()
    return Option.some(pid)
  })

// =============================================================================
// Server Start/Stop
// =============================================================================

/**
 * Start the server in background (daemonized), returns PID
 */
export const startServerBackground: Effect.Effect<number, Error | PlatformError, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const proc = yield* Effect.try({
      try: () =>
        Bun.spawn(["bun", "server.ts"], {
          cwd: process.cwd(),
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
          env: process.env
        }),
      catch: (e) => new Error(`Failed to spawn server: ${e instanceof Error ? e.message : String(e)}`)
    })

    yield* fs.writeFileString(PID_FILE, String(proc.pid))
    proc.unref()

    return proc.pid
  })

/**
 * Start the server in foreground (blocking)
 */
export const startServerForeground: Effect.Effect<void> = Effect.gen(function* () {
  yield* Console.log("Starting server in foreground (Ctrl+C to stop)...")
  yield* Effect.tryPromise({
    try: async () => {
      const { $ } = await import("bun")
      await $`bun server.ts`
    },
    catch: () => new Error("Server process exited")
  }).pipe(Effect.catchAll(() => Console.error("Server exited")))
})

/**
 * Stop the server if running, returns PID if stopped
 */
export const stopServer: Effect.Effect<Option.Option<number>, PlatformError, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pidOpt = yield* getServerPid

    if (Option.isSome(pidOpt)) {
      killProcess(pidOpt.value, "SIGTERM")
      yield* fs.remove(PID_FILE).pipe(Effect.ignore)
      return Option.some(pidOpt.value)
    }
    return Option.none<number>()
  })

// =============================================================================
// Health Check Helpers
// =============================================================================

/**
 * Check if server is responding to health checks
 */
export const isServerHealthy = (serverUrl: string): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: async () => {
      const baseUrl = serverUrl.replace(/\/rpc$/, "")
      const response = await fetch(`${baseUrl}/health`)
      return response.ok
    },
    catch: () => new Error("Server not responding")
  }).pipe(
    Effect.map(() => true),
    Effect.orElseSucceed(() => false)
  )

/**
 * Wait for server to become healthy
 */
export const waitForServer = (
  serverUrl: string,
  maxAttempts = 20
): Effect.Effect<boolean, Error> =>
  Effect.gen(function* () {
    const healthy = yield* isServerHealthy(serverUrl)
    if (!healthy) {
      return yield* Effect.fail(new Error("Server not healthy"))
    }
    return true
  }).pipe(
    Effect.retry(
      Schedule.recurs(maxAttempts).pipe(Schedule.addDelay(() => "100 millis"))
    ),
    Effect.timeout("5 seconds"),
    Effect.orElseFail(() => new Error("Server failed to start"))
  )

// =============================================================================
// Auto-Start Helper
// =============================================================================

/**
 * Ensure server is running, starting it if necessary.
 * Returns true if server was started, false if already running.
 */
export const ensureServerRunning = (
  serverUrl: string,
  options?: { silent?: boolean }
): Effect.Effect<boolean, Error | PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    // First check if server is healthy
    const healthy = yield* isServerHealthy(serverUrl)
    if (healthy) return false

    // Check PID file
    const running = yield* isServerRunning
    if (running) {
      yield* waitForServer(serverUrl)
      return false
    }

    // Server not running - start it
    if (!options?.silent) {
      yield* Console.log("Server not running, starting automatically...")
    }

    const pid = yield* startServerBackground

    if (!options?.silent) {
      yield* Console.log(`Server started (PID ${pid})`)
    }

    yield* waitForServer(serverUrl)
    return true
  })
