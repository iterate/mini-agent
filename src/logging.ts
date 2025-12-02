/**
 * Logging Module
 *
 * Multi-target logging: console (pretty) + file (JSON).
 * Uses PlatformLogger.toFile for proper resource management.
 */
import { PlatformLogger } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect, Layer, Logger, LogLevel } from "effect"

// =============================================================================
// Logging Configuration
// =============================================================================

export interface LoggingConfig {
  readonly stdoutLogLevel: LogLevel.LogLevel
  readonly fileLogLevel: LogLevel.LogLevel
  readonly baseDir: string
}

// =============================================================================
// Timestamp Filename
// =============================================================================

const generateLogFilename = (): string => {
  const now = new Date()
  const pad = (n: number) => n.toString().padStart(2, "0")
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  return `${date}_${time}.json`
}

// =============================================================================
// Logger Creation
// =============================================================================

/**
 * Compute the minimum (most verbose) of two log levels.
 * Used to set the global minimum so messages reach all configured loggers.
 */
const minLogLevel = (a: LogLevel.LogLevel, b: LogLevel.LogLevel): LogLevel.LogLevel => LogLevel.lessThan(a, b) ? a : b

/**
 * Create logging layer with console + optional JSON file output.
 *
 * Architecture:
 * - Console logger replaces the default logger (non-scoped)
 * - File logger is added via addScoped (scoped resource, properly cleaned up)
 * - minimumLogLevel set to the most verbose level to allow messages through
 *
 * IMPORTANT: BunRuntime.runMain adds its own pretty logger by default.
 * Use { disablePrettyLogger: true } to prevent duplicate console output.
 */
export const createLoggingLayer = (config: LoggingConfig): Layer.Layer<never> => {
  const stdoutDisabled = config.stdoutLogLevel === LogLevel.None
  const fileDisabled = config.fileLogLevel === LogLevel.None

  // Console logger with level filter
  const consoleLogger = stdoutDisabled
    ? Logger.none
    : Logger.filterLogLevel(
      Logger.prettyLogger(),
      (level) => LogLevel.greaterThanEqual(level, config.stdoutLogLevel)
    )

  // No file logging - just console
  if (fileDisabled) {
    // Set minimum to stdout level (or All if disabled)
    const minLevel = stdoutDisabled ? LogLevel.All : config.stdoutLogLevel
    return Layer.merge(
      Logger.replace(Logger.defaultLogger, consoleLogger),
      Logger.minimumLogLevel(minLevel)
    )
  }

  // File path (baseDir is already resolved to absolute path)
  const logPath = `${config.baseDir}/logs/${generateLogFilename()}`

  // Determine the global minimum level - lowest of stdout and file levels
  // This allows messages through to whichever logger accepts them
  const effectiveStdoutLevel = stdoutDisabled ? LogLevel.None : config.stdoutLogLevel
  const globalMinLevel = minLogLevel(effectiveStdoutLevel, config.fileLogLevel)

  // File logger effect (scoped resource)
  const fileLoggerEffect = Logger.jsonLogger.pipe(
    PlatformLogger.toFile(logPath, { batchWindow: "100 millis" }),
    Effect.map((fileLogger) =>
      Logger.filterLogLevel(fileLogger, (level) => LogLevel.greaterThanEqual(level, config.fileLogLevel))
    )
  )

  // Two separate layers:
  // 1. Replace default with console logger (non-scoped, always available)
  // 2. Add file logger (scoped, cleaned up properly without breaking console)
  const consoleLayer = Logger.replace(Logger.defaultLogger, consoleLogger)
  const fileLayer = Logger.addScoped(fileLoggerEffect).pipe(
    Layer.provide(BunContext.layer),
    Layer.catchAll(() => Layer.empty)
  )

  // Console replaces default logger, file logger is added separately
  // minimumLogLevel ensures DEBUG messages reach the file logger even when stdout is INFO
  return Layer.mergeAll(consoleLayer, fileLayer, Logger.minimumLogLevel(globalMinLevel))
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Console-only logging layer.
 */
export const consoleLoggingLayer = (level: LogLevel.LogLevel): Layer.Layer<never> =>
  Logger.replace(
    Logger.defaultLogger,
    Logger.filterLogLevel(
      Logger.prettyLogger(),
      (l) => LogLevel.greaterThanEqual(l, level)
    )
  )

/**
 * Disable all logging.
 */
export const noLoggingLayer: Layer.Layer<never> = Logger.replace(Logger.defaultLogger, Logger.none)
