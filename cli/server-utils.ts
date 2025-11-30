/**
 * Server Management Utilities
 * 
 * Shared utilities for server process management
 */

import { FileSystem } from "@effect/platform"
import { Console, Effect, Option, Schedule } from "effect"

// =============================================================================
// Configuration
// =============================================================================

export const PID_FILE = "server.pid"
export const DEFAULT_SERVER_PORT = 3000

// =============================================================================
// Server Status Checks
// =============================================================================

/**
 * Check if the server process is running
 */
export const isServerRunning = Effect.gen(function* () {
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

/**
 * Get the server PID if available
 */
export const getServerPid = Effect.gen(function* () {
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
 * Start the server in background (daemonized)
 */
export const startServerBackground = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem

  const proc = Bun.spawn(["bun", "server.ts"], {
    cwd: process.cwd(),
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    env: process.env
  })

  yield* fs.writeFileString(PID_FILE, String(proc.pid))
  proc.unref()
  
  return proc.pid
})

/**
 * Start the server in foreground (blocking)
 */
export const startServerForeground = Effect.gen(function* () {
  yield* Console.log("Starting server in foreground (Ctrl+C to stop)...")
  yield* Effect.tryPromise(async () => {
    const { $ } = await import("bun")
    await $`bun server.ts`
  }).pipe(Effect.catchAll(() => Console.error("Server exited")))
})

/**
 * Stop the server if running
 */
export const stopServer = Effect.gen(function* () {
  const pid = yield* getServerPid
  const fs = yield* FileSystem.FileSystem

  if (Option.isSome(pid)) {
    try {
      process.kill(pid.value, "SIGTERM")
    } catch {
      // Process already dead
    }
    yield* fs.remove(PID_FILE).pipe(Effect.ignore)
    return Option.some(pid.value)
  }
  return Option.none<number>()
})

// =============================================================================
// Auto-Start Helper
// =============================================================================

/**
 * Check if server is responding to health checks
 */
export const isServerHealthy = (serverUrl: string) =>
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
export const waitForServer = (serverUrl: string, maxAttempts = 20) =>
  Effect.gen(function* () {
    const healthy = yield* isServerHealthy(serverUrl)
    if (!healthy) {
      return yield* Effect.fail(new Error("Server not healthy"))
    }
    return true
  }).pipe(
    Effect.retry(
      Schedule.recurs(maxAttempts).pipe(
        Schedule.addDelay(() => "100 millis")
      )
    ),
    Effect.timeout("5 seconds"),
    Effect.orElseFail(() => new Error("Server failed to start"))
  )

/**
 * Ensure server is running, starting it if necessary
 * Returns true if server was started, false if already running
 */
export const ensureServerRunning = (serverUrl: string, options?: { silent?: boolean }) =>
  Effect.gen(function* () {
    // First check if server is healthy (handles case where PID file is stale)
    const healthy = yield* isServerHealthy(serverUrl)
    if (healthy) return false

    // Check PID file
    const running = yield* isServerRunning
    if (running) {
      // PID exists but not healthy - wait a bit for startup
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

    // Wait for server to be ready
    yield* waitForServer(serverUrl)
    
    return true
  })

