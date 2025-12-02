/**
 * Logging Module
 *
 * Provides multi-target logging with separate log levels for stdout and file output.
 * Uses Effect's Logger module with @effect/platform for file logging.
 */
import { FileSystem, PlatformLogger } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Console, Effect, Layer, Logger, LogLevel, Option } from "effect"
import * as Path from "node:path"

// =============================================================================
// Logging Configuration
// =============================================================================

export interface LoggingConfig {
  readonly stdoutLevel: LogLevel.LogLevel
  readonly fileLogPath: Option.Option<string>
  readonly fileLogLevel: LogLevel.LogLevel
  readonly baseDir: string
}

// =============================================================================
// Logger Creation
// =============================================================================

/**
 * Create a logging layer based on configuration.
 *
 * Supports:
 * - Console logging with configurable level (or disabled with LogLevel.None)
 * - File logging with separate level and path (optional)
 * - Both outputs can be combined or used independently
 *
 * If file logging fails to initialize, falls back to console-only logging.
 */
export const createLoggingLayer = (config: LoggingConfig): Layer.Layer<never> => {
  // Check if stdout is disabled (None level)
  const stdoutDisabled = config.stdoutLevel === LogLevel.None
  const fileDisabled = Option.isNone(config.fileLogPath) || config.fileLogLevel === LogLevel.None

  // Console logger with stdout level filter
  const consoleLogger = stdoutDisabled
    ? Logger.none
    : Logger.filterLogLevel(
      Logger.prettyLoggerDefault,
      (level) => LogLevel.greaterThanEqual(level, config.stdoutLevel)
    )

  // If no file logging, just use console logger
  if (fileDisabled) {
    return Logger.replace(Logger.defaultLogger, consoleLogger)
  }

  // Resolve file path relative to baseDir
  const filePath = Option.getOrThrow(config.fileLogPath)
  const resolvedPath = Path.isAbsolute(filePath)
    ? filePath
    : Path.join(config.baseDir, filePath)

  // Ensure log directory exists, then create file logger
  const fileLoggerEffect = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const logDir = Path.dirname(resolvedPath)

    // Create directory if it doesn't exist
    yield* fs.makeDirectory(logDir, { recursive: true }).pipe(
      Effect.catchAll(() => Effect.void)
    )

    // Now create the file logger
    return yield* Logger.jsonLogger.pipe(
      PlatformLogger.toFile(resolvedPath, { batchWindow: "100 millis" })
    )
  })

  if (stdoutDisabled) {
    // File logging only
    const filteredFileLoggerEffect = Effect.map(fileLoggerEffect, (fileLogger) =>
      Logger.filterLogLevel(
        fileLogger,
        (level) => LogLevel.greaterThanEqual(level, config.fileLogLevel)
      ))

    return Logger.replaceScoped(Logger.defaultLogger, filteredFileLoggerEffect).pipe(
      Layer.provide(BunContext.layer),
      // If file logging fails, fall back to no logging (since console is disabled)
      Layer.catchAll((error) =>
        Layer.effectDiscard(Console.error(`File logging failed: ${error}`)).pipe(
          Layer.merge(Logger.replace(Logger.defaultLogger, Logger.none))
        )
      )
    )
  }

  // Create combined logger effect - both console and file
  const combinedLoggerEffect = Effect.map(fileLoggerEffect, (fileLogger) => {
    const filteredFile = Logger.filterLogLevel(
      fileLogger,
      (level) => LogLevel.greaterThanEqual(level, config.fileLogLevel)
    )

    // Map the file logger to void output to match console logger
    const normalizedFile = Logger.map(filteredFile, () => undefined as void)

    // Combine both loggers
    return Logger.zipRight(consoleLogger, normalizedFile)
  })

  return Logger.replaceScoped(Logger.defaultLogger, combinedLoggerEffect).pipe(
    Layer.provide(BunContext.layer),
    // If file logging fails, fall back to console-only logging
    Layer.catchAll((error) =>
      Layer.effectDiscard(Console.error(`File logging failed, using console only: ${error}`)).pipe(
        Layer.merge(Logger.replace(Logger.defaultLogger, consoleLogger))
      )
    )
  )
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Create a simple console-only logging layer with the given level.
 */
export const consoleLoggingLayer = (level: LogLevel.LogLevel): Layer.Layer<never> =>
  Logger.replace(
    Logger.defaultLogger,
    Logger.filterLogLevel(
      Logger.prettyLoggerDefault,
      (l) => LogLevel.greaterThanEqual(l, level)
    )
  )

/**
 * Disable all logging.
 */
export const noLoggingLayer: Layer.Layer<never> = Logger.replace(Logger.defaultLogger, Logger.none)
