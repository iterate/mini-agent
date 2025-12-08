/**
 * Configuration Module
 *
 * Precedence: CLI arguments → Environment variables → YAML config file → Defaults
 */
import { FileSystem } from "@effect/platform"
import { Config, ConfigProvider, Context, Effect, Layer, LogLevel, Option } from "effect"
import * as yaml from "yaml"

/** Create a ConfigProvider from a YAML config file. Returns empty if file doesn't exist. */
export const fromYamlFile = (path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(path)
    if (!exists) return ConfigProvider.fromMap(new Map())
    const content = yield* fs.readFileString(path)
    const parsed = yaml.parse(content) as Record<string, unknown>
    return ConfigProvider.fromJson(parsed)
  })

/** Parse CLI arguments into a ConfigProvider. Supports --key value and --key=value. */
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

/** Create composed ConfigProvider: CLI → env → YAML → defaults */
export const makeConfigProvider = (configPath: string, args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const yamlProvider = yield* fromYamlFile(configPath)
    const cliProvider = fromCliArgs(args)
    const envProvider = ConfigProvider.fromEnv()
    const defaultsProvider = ConfigProvider.fromMap(
      new Map([
        ["DATA_STORAGE_DIR", ".mini-agent"],
        ["STDOUT_LOG_LEVEL", "warning"],
        ["FILE_LOG_LEVEL", "debug"],
        ["PORT", "3000"],
        ["HOST", "0.0.0.0"]
      ])
    )

    return cliProvider.pipe(
      ConfigProvider.orElse(() => envProvider),
      ConfigProvider.orElse(() => yamlProvider),
      ConfigProvider.orElse(() => defaultsProvider)
    )
  })

const logLevelConfig = (name: string) =>
  Config.string(name).pipe(
    Config.map((s): LogLevel.LogLevel => {
      const level = s.toLowerCase()
      if (level === "none" || level === "off") return LogLevel.None
      // Map common aliases to Effect's expected literals
      const literalMap: Record<string, LogLevel.Literal> = {
        trace: "Trace",
        debug: "Debug",
        info: "Info",
        warn: "Warning", // CLI uses "warn" but Effect uses "Warning"
        warning: "Warning",
        error: "Error",
        fatal: "Fatal"
      }
      const literal = literalMap[level]
      if (!literal) return LogLevel.Info // fallback
      return LogLevel.fromLiteral(literal)
    })
  )

export const MiniAgentConfig = Config.all({
  // LLM provider:model. See llm-config.ts
  llm: Config.string("LLM").pipe(Config.withDefault("openai:gpt-4.1-mini")),

  // System prompt - emitted on session start
  systemPrompt: Config.string("SYSTEM_PROMPT").pipe(
    Config.withDefault("You are a helpful assistant.")
  ),

  dataStorageDir: Config.string("DATA_STORAGE_DIR").pipe(
    Config.withDefault(".mini-agent")
  ),

  configFile: Config.string("CONFIG_FILE").pipe(
    Config.withDefault("mini-agent.config.yaml")
  ),

  cwd: Config.string("CWD").pipe(Config.option),

  stdoutLogLevel: logLevelConfig("STDOUT_LOG_LEVEL").pipe(
    Config.withDefault(LogLevel.Warning)
  ),
  fileLogLevel: logLevelConfig("FILE_LOG_LEVEL").pipe(
    Config.withDefault(LogLevel.Debug)
  ),

  // HTTP server config
  port: Config.number("PORT").pipe(Config.withDefault(3000)),
  host: Config.string("HOST").pipe(Config.withDefault("0.0.0.0")),

  // LayerCode webhook secret for signature verification
  layercodeWebhookSecret: Config.redacted("LAYERCODE_WEBHOOK_SECRET").pipe(Config.option)
})

export type MiniAgentConfig = Config.Config.Success<typeof MiniAgentConfig>

export class AppConfig extends Context.Tag("@mini-agent/AppConfig")<
  AppConfig,
  MiniAgentConfig
>() {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function*() {
      const config = yield* MiniAgentConfig
      return config
    })
  )

  static fromConfig(config: MiniAgentConfig): Layer.Layer<AppConfig> {
    return Layer.succeed(AppConfig, config)
  }
}

export const extractConfigPath = (args: ReadonlyArray<string>): string => {
  const configIdx = args.findIndex((a) => a === "--config" || a === "-c")
  const nextArg = configIdx >= 0 ? args[configIdx + 1] : undefined
  if (nextArg !== undefined) {
    return nextArg
  }
  return "mini-agent.config.yaml"
}

export const extractRemoteUrl = (args: ReadonlyArray<string>): Option.Option<string> => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === "--remote-url" || arg === "-R") {
      const value = args[i + 1]
      if (value && !value.startsWith("--")) {
        return Option.some(value)
      }
    } else if (arg.startsWith("--remote-url=")) {
      const value = arg.slice("--remote-url=".length)
      if (value) {
        return Option.some(value)
      }
    }
  }
  return Option.none()
}

export const resolveBaseDir = (config: MiniAgentConfig): string => {
  const cwd = Option.getOrElse(config.cwd, () => process.cwd())
  return `${cwd}/${config.dataStorageDir}`
}
