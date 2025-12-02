/**
 * JSON logger.
 *
 * Based on https://github.com/sukovanej/effect-log
 * Original author: Milan Suk (sukovanej)
 * License: MIT
 *
 * @since 1.0.0
 */
import * as Array from "effect/Array"
import * as FiberId from "effect/FiberId"
import * as HashMap from "effect/HashMap"
import type * as Layer from "effect/Layer"
import * as List from "effect/List"
import * as Logger from "effect/Logger"
import type * as LogLevel from "effect/LogLevel"

/** @internal */
const serializeUnknown = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * @category models
 * @since 1.0.0
 */
export interface Options {
  showFiberId: boolean
  showTime: boolean
  showSpans: boolean
  messageField: string
  logLevelField: string
  logLevelFormat: "lowercase" | "uppercase" | "capitalized"
}

/** @internal */
const defaultOptions: Options = {
  showFiberId: true,
  showTime: true,
  showSpans: true,
  messageField: "message",
  logLevelField: "level",
  logLevelFormat: "capitalized"
}

const capitalize = (string: string) => string.charAt(0).toUpperCase() + string.slice(1).toLowerCase()

/** @internal */
const formatLogLevel: (format: Options["logLevelFormat"]) => (logLevel: LogLevel.LogLevel) => string = (format) => {
  if (format === "lowercase") {
    return (logLevel) => logLevel.label.toLowerCase()
  } else if (format === "uppercase") {
    return (logLevel) => logLevel.label.toUpperCase()
  }
  return (logLevel) => capitalize(logLevel.label)
}

/** @internal */
const buildLogRecord = (
  options: Options,
  { annotations, cause, date, fiberId, logLevel, message, spans }: Logger.Logger.Options<unknown>
): Record<string, unknown> => {
  const _formatLogLevel = formatLogLevel(options.logLevelFormat)
  const tags: Record<string, unknown> = HashMap.reduce(
    annotations,
    {},
    (acc, v, k) => ({
      ...acc,
      [k]: v
    })
  )

  if (options.showTime) {
    tags["date"] = date
  }
  tags[options.logLevelField] = _formatLogLevel(logLevel)
  tags[options.messageField] = Array.ensure(message).map(serializeUnknown).join(" ")

  if (options.showFiberId) {
    tags["fiberId"] = FiberId.threadName(fiberId)
  }

  if (options.showSpans && List.isCons(spans)) {
    tags["spans"] = List.toArray(spans).map((span) => span.label)
  }

  if (cause._tag !== "Empty") {
    tags["cause"] = cause
  }

  return tags
}

/**
 * @category constructors
 * @since 1.0.0
 */
export const make: (options?: Partial<Options>) => Logger.Logger<unknown, void> = (options) => {
  const _options = { ...defaultOptions, ...options }

  return Logger.make((logOptions) => {
    const tags = buildLogRecord(_options, logOptions)
    console.log(JSON.stringify(tags))
  })
}

/**
 * Creates a JSON logger that returns the JSON string instead of writing to console.
 * Useful for file-based logging with PlatformLogger.toFile.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeStringified: (options?: Partial<Options>) => Logger.Logger<unknown, string> = (options) => {
  const _options = { ...defaultOptions, ...options }

  return Logger.make((logOptions) => {
    const tags = buildLogRecord(_options, logOptions)
    return JSON.stringify(tags)
  })
}

/**
 * @category layers
 * @since 1.0.0
 */
export const layer: (
  options?: Partial<Options>
) => Layer.Layer<never, never, never> = (options) => Logger.replace(Logger.defaultLogger, make(options ?? {}))

