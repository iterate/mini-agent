/**
 * Configuration Module
 *
 * Provides configuration management with source precedence:
 * CLI arguments → Environment variables → YAML config file → Defaults
 *
 * Uses Effect's ConfigProvider composition to merge multiple sources.
 */
import { FileSystem } from "@effect/platform"
import { Config, ConfigProvider, Context, Effect, Layer, LogLevel, Option, Redacted } from "effect"
import * as yaml from "yaml"

// =============================================================================
// YAML Config Provider
// =============================================================================

/**
 * Create a ConfigProvider from a YAML config file.
 * Returns an empty provider if the file doesn't exist.
 */
export const fromYamlFile = (path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(path)
    if (!exists) return ConfigProvider.fromMap(new Map())
    const content = yield* fs.readFileString(path)
    const parsed = yaml.parse(content) as Record<string, unknown>
    return ConfigProvider.fromJson(parsed)
  })

// =============================================================================
// CLI Args Config Provider
// =============================================================================

/**
 * Parse CLI arguments into a ConfigProvider.
 * Supports --key value and --key=value formats.
 * Keys are converted to SCREAMING_SNAKE_CASE.
 */
export const fromCliArgs = (args: ReadonlyArray<string>): ConfigProvider.ConfigProvider => {
  const map = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg.startsWith("--") && !arg.includes("=")) {
      const key = arg.slice(2).toUpperCase().replace(/-/g, "_")
      const next = args[i + 1]
      if (next && !next.startsWith("--")) {
        map.set(key, next)
        i++
      } else {
        map.set(key, "true")
      }
    } else if (arg.startsWith("--") && arg.includes("=")) {
      const eqIndex = arg.indexOf("=")
      const keyPart = arg.slice(2, eqIndex)
      const value = arg.slice(eqIndex + 1)
      map.set(keyPart.toUpperCase().replace(/-/g, "_"), value)
    }
  }
  return ConfigProvider.fromMap(map)
}

// =============================================================================
// Composed Config Provider
// =============================================================================

/**
 * Create a composed ConfigProvider with precedence:
 * CLI args → Environment variables → YAML config file → Defaults
 */
export const makeConfigProvider = (configPath: string, args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const yamlProvider = yield* fromYamlFile(configPath)
    const cliProvider = fromCliArgs(args)
    const envProvider = ConfigProvider.fromEnv()
    const defaultsProvider = ConfigProvider.fromMap(
      new Map([
        ["DATA_STORAGE_DIR", ".mini-agent"],
        ["LOGGING_STDOUT_LOG_LEVEL", "info"],
        ["LOGGING_FILE_LOG_LEVEL", "debug"]
      ])
    )

    return cliProvider.pipe(
      ConfigProvider.orElse(() => envProvider),
      ConfigProvider.orElse(() => yamlProvider),
      ConfigProvider.orElse(() => defaultsProvider)
    )
  })

// =============================================================================
// Log Level Config Helper
// =============================================================================

/**
 * Parse a log level string into a LogLevel, supporting 'none' to disable logging.
 */
const logLevelConfig = (name: string) =>
  Config.string(name).pipe(
    Config.map((s): LogLevel.LogLevel => {
      const level = s.toLowerCase()
      if (level === "none" || level === "off") return LogLevel.None
      return LogLevel.fromLiteral(level as LogLevel.Literal)
    })
  )

// =============================================================================
// MiniAgentConfig Schema
// =============================================================================

/**
 * Full application configuration schema.
 * All values are resolved at startup from the composed ConfigProvider.
 */
export const MiniAgentConfig = Config.all({
  // OpenAI API configuration
  openaiApiKey: Config.redacted("OPENAI_API_KEY"),
  openaiModel: Config.string("OPENAI_MODEL").pipe(
    Config.withDefault("gpt-4o-mini")
  ),

  // Data storage
  dataStorageDir: Config.string("DATA_STORAGE_DIR").pipe(
    Config.withDefault(".mini-agent")
  ),

  // Config file path (stored for reference)
  configFile: Config.string("CONFIG_FILE").pipe(
    Config.withDefault("mini-agent.config.yaml")
  ),

  // Working directory override
  cwd: Config.string("CWD").pipe(Config.option),

  // Logging configuration
  logging: Config.all({
    stdoutLevel: logLevelConfig("STDOUT_LOG_LEVEL").pipe(
      Config.withDefault(LogLevel.Info)
    ),
    fileLogPath: Config.string("FILE_LOG_PATH").pipe(Config.option),
    fileLogLevel: logLevelConfig("FILE_LOG_LEVEL").pipe(
      Config.withDefault(LogLevel.Debug)
    )
  }).pipe(Config.nested("LOGGING"))
})

export type MiniAgentConfig = Config.Config.Success<typeof MiniAgentConfig>

// =============================================================================
// AppConfig Service
// =============================================================================

/**
 * Service providing validated application configuration.
 * Services should depend on this and extract only the config slices they need.
 */
export class AppConfig extends Context.Tag("AppConfig")<
  AppConfig,
  MiniAgentConfig
>() {
  /**
   * Create an AppConfig layer from the given configuration.
   */
  static layer(config: MiniAgentConfig): Layer.Layer<AppConfig> {
    return Layer.succeed(AppConfig, config)
  }
}

// =============================================================================
// Config Utilities
// =============================================================================

/**
 * Extract --config value from CLI args.
 * Returns the default config path if not specified.
 */
export const extractConfigPath = (args: ReadonlyArray<string>): string => {
  const configIdx = args.findIndex((a) => a === "--config" || a === "-c")
  const nextArg = configIdx >= 0 ? args[configIdx + 1] : undefined
  if (nextArg !== undefined) {
    return nextArg
  }
  return "mini-agent.config.yaml"
}

/**
 * Resolve the base directory for relative paths.
 * Combines cwd (if set) with dataStorageDir.
 */
export const resolveBaseDir = (config: MiniAgentConfig): string => {
  const cwd = Option.getOrElse(config.cwd, () => process.cwd())
  return `${cwd}/${config.dataStorageDir}`
}

/**
 * Get OpenAI API key as string for use with clients.
 * @throws if key is not configured
 */
export const getOpenAiApiKeyString = (config: MiniAgentConfig): string => Redacted.value(config.openaiApiKey)
