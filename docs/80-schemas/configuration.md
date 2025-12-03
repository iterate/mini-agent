# Configuration Schemas

Configuration schemas for the service layers.

## Session Configuration

Configuration for a context session.

```typescript
export class SessionConfig extends Schema.Class<SessionConfig>("SessionConfig")({
  // Context name
  contextName: ContextName,

  // Debounce delay (ms) - wait this long after last event before LLM request
  debounceMs: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),

  // Default system prompt if context is new
  defaultSystemPrompt: Schema.optional(Schema.String),
}) {
  static readonly default = (contextName: ContextName) =>
    SessionConfig.make({
      contextName,
      debounceMs: 10,  // 10ms default
    })
}
```

---

## Application Configuration

Top-level application configuration.

```typescript
export class AppConfig extends Schema.Class<AppConfig>("AppConfig")({
  // Primary LLM provider
  primaryProvider: ProviderConfig,

  // Optional fallback provider
  fallbackProvider: Schema.optional(ProviderConfig),

  // Default retry configuration
  defaultRetry: RetryConfig,

  // Default request timeout (ms)
  defaultTimeoutMs: Schema.Number.pipe(Schema.positive()),

  // Default debounce delay (ms)
  defaultDebounceMs: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),

  // Data storage directory
  dataDir: Schema.String,

  // Logging configuration
  logging: LoggingConfig,
}) {}
```

### LoggingConfig

```typescript
export class LoggingConfig extends Schema.Class<LoggingConfig>("LoggingConfig")({
  // Console log level
  stdoutLevel: Schema.Literal("none", "error", "warn", "info", "debug"),

  // File log level
  fileLevel: Schema.Literal("none", "error", "warn", "info", "debug"),

  // Log file path (relative to dataDir)
  filePath: Schema.optional(Schema.String),
}) {
  static readonly default = LoggingConfig.make({
    stdoutLevel: "info",
    fileLevel: "debug",
    filePath: "logs/app.log",
  })
}
```

---

## Handler Configuration

Configuration for the interruptible request handler.

```typescript
export class HandlerConfig extends Schema.Class<HandlerConfig>("HandlerConfig")({
  // Debounce delay (ms)
  debounceMs: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),

  // Whether to emit interrupted events
  emitInterruptedEvents: Schema.Boolean,

  // Maximum partial response to capture (bytes)
  maxPartialResponseBytes: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
}) {
  static readonly default = HandlerConfig.make({
    debounceMs: 10,
    emitInterruptedEvents: true,
    maxPartialResponseBytes: 10000,
  })
}
```

---

## Hooks Configuration

Configuration for extensibility hooks.

```typescript
export class HooksConfig extends Schema.Class<HooksConfig>("HooksConfig")({
  // Enable/disable specific hooks
  enableBeforeRequest: Schema.Boolean,
  enableAfterResponse: Schema.Boolean,
  enableOnEvent: Schema.Boolean,

  // Timeout for hook execution (ms)
  hookTimeoutMs: Schema.Number.pipe(Schema.positive()),
}) {
  static readonly default = HooksConfig.make({
    enableBeforeRequest: true,
    enableAfterResponse: true,
    enableOnEvent: true,
    hookTimeoutMs: 5000,
  })
}
```

---

## Persistence Configuration

Configuration for event persistence.

```typescript
export class PersistenceConfig extends Schema.Class<PersistenceConfig>("PersistenceConfig")({
  // Storage backend type
  backend: Schema.Literal("yaml", "json", "sqlite"),

  // Base directory for file-based storage
  baseDir: Schema.String,

  // Whether to persist lifecycle events
  persistLifecycleEvents: Schema.Boolean,

  // Whether to persist config events
  persistConfigEvents: Schema.Boolean,

  // File extension for context files
  fileExtension: Schema.optional(Schema.String),
}) {
  static readonly default = PersistenceConfig.make({
    backend: "yaml",
    baseDir: ".mini-agent/contexts",
    persistLifecycleEvents: true,
    persistConfigEvents: true,
    fileExtension: ".yaml",
  })
}
```

---

## Full Configuration Assembly

```typescript
export class FullConfig extends Schema.Class<FullConfig>("FullConfig")({
  app: AppConfig,
  handler: HandlerConfig,
  hooks: HooksConfig,
  persistence: PersistenceConfig,
}) {}

// Load from environment + file
export const loadConfig = Effect.gen(function*() {
  // Load from ConfigProvider (env vars, files, etc.)
  const apiKey = yield* Config.redacted("OPENAI_API_KEY")
  const model = yield* Config.string("OPENAI_MODEL").pipe(
    Config.withDefault("gpt-4o-mini")
  )
  const dataDir = yield* Config.string("DATA_STORAGE_DIR").pipe(
    Config.withDefault(".mini-agent")
  )
  const debounceMs = yield* Config.number("DEBOUNCE_MS").pipe(
    Config.withDefault(10)
  )

  return FullConfig.make({
    app: AppConfig.make({
      primaryProvider: ProviderConfig.make({
        providerId: ProviderId.make("openai"),
        model,
        apiKey,
      }),
      defaultRetry: RetryConfig.default,
      defaultTimeoutMs: 30000,
      defaultDebounceMs: debounceMs,
      dataDir,
      logging: LoggingConfig.default,
    }),
    handler: HandlerConfig.default,
    hooks: HooksConfig.default,
    persistence: PersistenceConfig.make({
      ...PersistenceConfig.default,
      baseDir: `${dataDir}/contexts`,
    }),
  })
})
```

---

## Configuration as Context.Tag

For dependency injection:

```typescript
class AppConfigService extends Context.Tag("@app/AppConfig")<
  AppConfigService,
  FullConfig
>() {
  static readonly layer = Layer.effect(
    AppConfigService,
    loadConfig
  )

  static readonly testLayer = Layer.succeed(
    AppConfigService,
    FullConfig.make({
      app: /* test config */,
      handler: HandlerConfig.default,
      hooks: HooksConfig.default,
      persistence: /* test config */,
    })
  )
}
```

---

## Runtime Configuration Updates

Some configuration can be changed at runtime via events:

```typescript
// These events modify the ReducedContext config
SetRetryConfigEvent      // Changes retry behavior
SetProviderConfigEvent   // Changes provider/model
SetTimeoutEvent         // Changes timeout

// These are session-level, not event-driven
SessionConfig           // debounceMs, etc.
```

---

## Effect Pattern Alignment

| Pattern | Usage |
|---------|-------|
| `Schema.Class` | Structured configuration |
| `Config.*` | Loading from environment |
| `Context.Tag` | DI for configuration |
| `Layer.effect` | Configuration loading layer |
| `Schema.Literal` | Enum constraints |
| `Schema.optional` | Optional with defaults |
