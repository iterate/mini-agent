# Building Effect-TS CLI applications with comprehensive configuration
https://claude.ai/chat/7589a889-63b1-469d-ad53-6ef878e04f66


Effect-TS provides a powerful foundation for building CLI applications with type-safe configuration management. The recommended approach combines `@effect/cli` for argument parsing, `ConfigProvider` composition for merging multiple config sources with precedence, and Effect's `Logger` module with `@effect/platform` for multi-target logging. Services should depend on **specific config slices** rather than full config objects, with dependencies resolved at layer construction time.

## Config source merging with proper precedence

Effect's `ConfigProvider` system supports composing multiple configuration sources using `ConfigProvider.orElse` to establish fallback chains. The pattern **CLI arguments → environment variables → config file → defaults** achieves standard configuration precedence where more specific sources override general ones.

```typescript
import { Config, ConfigProvider, Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import * as yaml from "js-yaml"

// Create YAML ConfigProvider from file
const fromYamlFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(path)
    if (!exists) return ConfigProvider.fromMap(new Map())
    const content = yield* fs.readFileString(path)
    const parsed = yaml.load(content) as Record<string, unknown>
    return ConfigProvider.fromJson(parsed)
  })

// Parse CLI args into ConfigProvider
const fromCliArgs = (args: string[]): ConfigProvider.ConfigProvider => {
  const map = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
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
      const [keyPart, value] = arg.slice(2).split("=")
      map.set(keyPart.toUpperCase().replace(/-/g, "_"), value)
    }
  }
  return ConfigProvider.fromMap(map)
}

// Compose providers with precedence: CLI > Env > YAML > Defaults
const makeConfigProvider = (configPath: string, args: string[]) =>
  Effect.gen(function* () {
    const yamlProvider = yield* fromYamlFile(configPath)
    const cliProvider = fromCliArgs(args)
    const envProvider = ConfigProvider.fromEnv()
    const defaultsProvider = ConfigProvider.fromMap(new Map([
      ["DATA_STORAGE_DIR", ".mini-agent"],
      ["STDOUT_LOG_LEVEL", "info"],
      ["FILE_LOG_LEVEL", "debug"]
    ]))

    return cliProvider.pipe(
      ConfigProvider.orElse(() => envProvider),
      ConfigProvider.orElse(() => yamlProvider),
      ConfigProvider.orElse(() => defaultsProvider)
    )
  })
```

The `ConfigProvider.orElse` combinator creates a fallback chain where the first provider to successfully return a value wins. This enables the **"most specific wins"** precedence model that users expect from CLI tools.

## Defining the MiniAgentConfig schema

Effect's `Config` module provides a declarative DSL for describing configuration structure. Each config value specifies its type, environment variable name, and optional default value. The `Config.nested` combinator groups related settings under a namespace prefix.

```typescript
import { Config, LogLevel } from "effect"
import { Option } from "effect"

// Parse log level from string, supporting 'none'
const logLevelConfig = (name: string) =>
  Config.string(name).pipe(
    Config.map((s): LogLevel.LogLevel => {
      const level = s.toLowerCase()
      if (level === "none" || level === "off") return LogLevel.None
      return LogLevel.fromLiteral(level as LogLevel.Literal)
    })
  )

// Full config schema
const MiniAgentConfig = Config.all({
  // API keys
  someApiKey: Config.redacted("SOME_API_KEY").pipe(Config.option),
  
  // Data storage
  dataStorageDir: Config.string("DATA_STORAGE_DIR").pipe(
    Config.withDefault(".mini-agent")
  ),
  
  // Config file path (already used to load config, stored for reference)
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
    fileLogPath: Config.string("LOG_FILE_PATH").pipe(Config.option),
    fileLogLevel: logLevelConfig("FILE_LOG_LEVEL").pipe(
      Config.withDefault(LogLevel.Debug)
    )
  }).pipe(Config.nested("LOGGING"))
})

// Infer the type
type MiniAgentConfig = Config.Config.Success<typeof MiniAgentConfig>
```

Using `Config.redacted` for API keys ensures sensitive values aren't accidentally logged. The `Config.option` combinator makes values optional, returning `Option<A>` instead of failing when missing.

## Service architecture for config dependencies

The Effect community recommends that **services depend on specific config slices rather than full config objects**. This improves testability and makes dependencies explicit. Define a config service that provides the full validated configuration, then have dependent services extract only what they need during layer construction.

```typescript
import { Context, Effect, Layer } from "effect"

// Config service provides validated configuration
class AppConfig extends Context.Tag("AppConfig")<
  AppConfig,
  MiniAgentConfig
>() {}

// Logger service depends only on logging config slice
class AppLogger extends Context.Tag("AppLogger")<
  AppLogger,
  {
    readonly info: (message: string) => Effect.Effect<void>
    readonly debug: (message: string) => Effect.Effect<void>
    readonly error: (message: string) => Effect.Effect<void>
  }
>() {
  // Layer extracts only logging config it needs
  static Live = Layer.effect(
    AppLogger,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const { stdoutLevel, fileLogPath, fileLogLevel } = config.logging
      // Implementation uses only these specific values
      return {
        info: (msg) => Effect.log(msg),
        debug: (msg) => Effect.logDebug(msg),
        error: (msg) => Effect.logError(msg)
      }
    })
  )
}

// API client depends only on API key
class ApiClient extends Context.Tag("ApiClient")<
  ApiClient,
  { readonly call: (endpoint: string) => Effect.Effect<unknown> }
>() {
  static Live = Layer.effect(
    ApiClient,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const apiKey = config.someApiKey // Only accesses needed slice
      return {
        call: (endpoint) => Effect.succeed({ endpoint, authenticated: Option.isSome(apiKey) })
      }
    })
  )
}
```

This pattern keeps service interfaces clean and enables easy testing by providing mock config layers with only the values each service actually needs.

## Multi-target logging with separate log levels

Effect's logging system supports multiple simultaneous outputs through `Logger.zip`, which combines two loggers into one that writes to both. Apply `Logger.filterLogLevel` to each target independently to achieve different verbosity levels for stdout versus file output.

```typescript
import { Effect, Layer, Logger, LogLevel, Option } from "effect"
import { PlatformLogger } from "@effect/platform"
import { NodeFileSystem } from "@effect/platform-node"
import * as Path from "node:path"

interface LoggingConfig {
  stdoutLevel: LogLevel.LogLevel
  fileLogPath: Option.Option<string>
  fileLogLevel: LogLevel.LogLevel
  baseDir: string  // Resolved from cwd + dataStorageDir
}

const createLoggingLayer = (config: LoggingConfig) => {
  // Console logger with stdout level filter
  const consoleLogger = Logger.filterLogLevel(
    Logger.prettyLoggerDefault,
    (level) => LogLevel.greaterThanEqual(level, config.stdoutLevel)
  )

  // If stdout is 'none', use Logger.none for console
  const effectiveConsoleLogger = LogLevel.lessThan(config.stdoutLevel, LogLevel.None)
    ? Logger.map(consoleLogger, Option.getOrUndefined)
    : Logger.none

  // File logger (if path configured and level isn't 'none')
  if (Option.isNone(config.fileLogPath) || config.fileLogLevel === LogLevel.None) {
    // No file logging - just use console
    return Logger.replace(Logger.defaultLogger, effectiveConsoleLogger)
  }

  // Resolve file path relative to baseDir
  const resolvedPath = Path.isAbsolute(config.fileLogPath.value)
    ? config.fileLogPath.value
    : Path.join(config.baseDir, config.fileLogPath.value)

  const fileLogger = Logger.jsonLogger.pipe(
    PlatformLogger.toFile(resolvedPath, { batchWindow: "100 millis" })
  )

  const combinedLogger = Effect.map(fileLogger, (file) => {
    const filteredFile = Logger.filterLogLevel(
      file,
      (level) => LogLevel.greaterThanEqual(level, config.fileLogLevel)
    )
    return Logger.zip(
      effectiveConsoleLogger,
      Logger.map(filteredFile, Option.getOrUndefined)
    )
  })

  return Logger.replaceScoped(Logger.defaultLogger, combinedLogger).pipe(
    Layer.provide(NodeFileSystem.layer)
  )
}
```

The `PlatformLogger.toFile` function from `@effect/platform` creates a file-based logger that integrates with Effect's scoped resource management, ensuring files are properly closed when the application exits.

## Complete CLI application structure

The following example demonstrates the full pattern: CLI argument parsing with `@effect/cli`, configuration merging, service layers, and multi-target logging. The `--config` option specifies the YAML config file path, which is extracted first to determine which file to load.

```typescript
import { Args, Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { FileSystem } from "@effect/platform"
import { Config, ConfigProvider, Effect, Layer, Option } from "effect"
import * as yaml from "js-yaml"
import * as Path from "node:path"

// === CLI Options (Global) ===
const configFileOption = Options.file("config").pipe(
  Options.withAlias("c"),
  Options.withDescription("Path to YAML config file"),
  Options.withDefault("mini-agent.config.yaml")
)

const cwdOption = Options.directory("cwd").pipe(
  Options.withDescription("Working directory override"),
  Options.optional
)

const logLevelOption = Options.choice("log-level", ["trace", "debug", "info", "warn", "error", "none"]).pipe(
  Options.withDescription("Stdout log level"),
  Options.optional
)

// === Commands ===
const runCommand = Command.make(
  "run",
  { prompt: Args.text({ name: "prompt" }).pipe(Args.withDescription("The prompt to execute")) },
  ({ prompt }) =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      yield* Effect.log(`Running with prompt: ${prompt}`)
      yield* Effect.logDebug(`Data dir: ${config.dataStorageDir}`)
      // Your application logic here
    })
)

const initCommand = Command.make(
  "init",
  {},
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const config = yield* AppConfig
      yield* fs.makeDirectory(config.dataStorageDir, { recursive: true })
      yield* Effect.log(`Initialized data directory: ${config.dataStorageDir}`)
    })
)

// === Root Command with Global Options ===
const rootCommand = Command.make(
  "mini-agent",
  { configFile: configFileOption, cwd: cwdOption, logLevel: logLevelOption }
).pipe(
  Command.withSubcommands([runCommand, initCommand])
)

// === Application Entry Point ===
const cli = Command.run(rootCommand, {
  name: "mini-agent",
  version: "1.0.0"
})

// Build the main layer with config and logging
const makeMainLayer = (args: string[]) =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      // Extract --config value from args first
      const configIdx = args.findIndex((a) => a === "--config" || a === "-c")
      const configPath = configIdx >= 0 && args[configIdx + 1]
        ? args[configIdx + 1]
        : "mini-agent.config.yaml"

      // Build composed ConfigProvider
      const provider = yield* makeConfigProvider(configPath, args)
      const configLayer = Layer.setConfigProvider(provider)

      // Load config values
      const config = yield* MiniAgentConfig.pipe(
        Effect.withConfigProvider(provider)
      )

      // Resolve base directory for relative paths
      const baseCwd = Option.getOrElse(config.cwd, () => process.cwd())
      const baseDir = Path.join(baseCwd, config.dataStorageDir)

      // Build logging layer
      const loggingLayer = createLoggingLayer({
        stdoutLevel: config.logging.stdoutLevel,
        fileLogPath: config.logging.fileLogPath,
        fileLogLevel: config.logging.fileLogLevel,
        baseDir
      })

      // Build config service layer
      const appConfigLayer = Layer.succeed(AppConfig, config)

      return Layer.mergeAll(
        configLayer,
        appConfigLayer,
        loggingLayer,
        AppLogger.Live,
        ApiClient.Live
      )
    })
  )

// Run the CLI
cli(process.argv).pipe(
  Effect.provide(Layer.provideMerge(
    makeMainLayer(process.argv.slice(2)),
    NodeContext.layer
  )),
  NodeRuntime.runMain
)
```

## Example YAML configuration file

The configuration file uses flat key structures that map to environment variable naming conventions. Effect's `ConfigProvider.fromJson` handles nested JSON/YAML structures naturally.

```yaml
# mini-agent.config.yaml
SOME_API_KEY: "sk-your-api-key-here"
DATA_STORAGE_DIR: ".mini-agent"

LOGGING:
  STDOUT_LOG_LEVEL: "info"
  LOG_FILE_PATH: "logs/mini-agent.log"
  FILE_LOG_LEVEL: "debug"
```

Environment variables follow the same naming with underscores for nesting: `LOGGING_STDOUT_LOG_LEVEL=warn` would override the file's value. CLI arguments use kebab-case: `--log-level none` disables stdout logging entirely.

## Architectural recommendations

The Effect community consensus from official documentation and community patterns suggests several key practices for CLI application architecture.

**Config slices over full objects**: Services should yield only the configuration values they actually use. This makes dependencies explicit, improves testability (you only mock what's needed), and prevents tight coupling between unrelated parts of the application.

**Layer-based dependency injection**: Define services using `Context.Tag` and provide implementations via `Layer.effect`. The layer constructor is where dependencies are resolved—services themselves remain pure interfaces. Use `Layer.mergeAll` to compose service layers and `Layer.provide` to wire dependencies.

**Config validation at boundaries**: Validate configuration once at application startup using Effect's `Config` module with `Config.validate` for custom constraints. Propagate validated, typed configuration through the layer system rather than re-parsing strings throughout the application.

**Testing with mock providers**: Use `ConfigProvider.fromMap` to create test configuration without touching environment variables or files. Layer substitution enables swapping entire service implementations for testing.

```typescript
// Test configuration
const TestConfigProvider = ConfigProvider.fromMap(new Map([
  ["SOME_API_KEY", "test-key"],
  ["DATA_STORAGE_DIR", "/tmp/test-agent"],
  ["LOGGING_STDOUT_LOG_LEVEL", "none"]
]))

const TestConfigLayer = Layer.setConfigProvider(TestConfigProvider)
```

## Conclusion

Building CLI applications with Effect-TS centers on three core patterns: **ConfigProvider composition** for merging multiple config sources with `orElse` chains, **service-oriented architecture** where layers construct dependencies from specific config slices, and **Logger composition** with `Logger.zip` and `Logger.filterLogLevel` for multi-target output. The `@effect/cli` package provides type-safe argument parsing that integrates naturally with ConfigProvider through `Options.withFallbackConfig`. These patterns create testable, maintainable CLI applications where configuration flows cleanly through the layer system and logging adapts to both development and production needs without code changes.