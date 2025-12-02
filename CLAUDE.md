---
description: Effect-TS CLI project conventions and patterns
globs: "*.ts, *.tsx, package.json"
alwaysApply: true
---
# General

Sacrifice grammar in favour of concision. Write like a good software engineer would write to another.

# Project Conventions
- Use bun as runtime and package manager
- Run using `doppler run -- bun src/main.ts` (for env vars)
- kebab-case filenames
- tests using vitest; colocate test files with .test.ts
- import using .ts extension; no .js


# Use of effect

<!-- effect-solutions:start -->
## Effect Solutions Usage

- `effect-solutions list` - List all available topics
- `effect-solutions show <slug...>` - Read one or more topics
- `effect-solutions search <term>` - Search topics by keyword

**Local Effect Source:** `~/src/github.com/Effect-TS/effect`
<!-- effect-solutions:end -->

**Effect Patterns Knowledge Base:** Cross-reference with `~/src/github.com/PaulJPhilp/EffectPatterns` for community patterns in `content/` and `packages/`.

## Core Concept: Context

A **Context** is a named, ordered list of events. The only operation is `addEvents`:
1. Appends input events (UserMessage)
2. Triggers LLM with full history
3. Streams back events (TextDelta ephemeral, AssistantMessage persisted)
4. Persists new events

## Services with Effect.Service

```typescript
export class MyService extends Effect.Service<MyService>()("@app/MyService", {
  effect: Effect.gen(function*() {
    const dep = yield* SomeDependency

    // Use Effect.fn for call-site tracing
    const doSomething = Effect.fn("MyService.doSomething")(
      function*(input: string) {
        yield* Effect.log(`Processing: ${input}`)
        return "result"
      }
    )

    return { doSomething }
  }),
  dependencies: [SomeDependency.Default],
  accessors: true
}) {
  // Test layer for unit tests
  static readonly testLayer = Layer.effect(
    MyService,
    Effect.sync(() => ({
      _tag: "MyService" as const,
      doSomething: (input: string) => Effect.succeed(`mock: ${input}`)
    } satisfies MyService))
  )
}
```

## Branded Types

Use branded types for domain identifiers to prevent mixing strings:

```typescript
export const ContextName = Schema.String.pipe(Schema.brand("ContextName"))
export type ContextName = typeof ContextName.Type

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type
```

## Schemas with TaggedClass

```typescript
export class UserMessage extends Schema.TaggedClass<UserMessage>()("UserMessage", {
  content: Schema.String
}) {}

// Type guard
export const isUserMessage = Schema.is(UserMessage)

// Union types - use Schema.Union for runtime encoding/decoding
export const Event = Schema.Union(UserMessage, SystemPrompt, AssistantMessage)
export type Event = typeof Event.Type
```

## Tagged Errors

Define domain errors with Schema.TaggedError for type-safe error handling:

```typescript
export class ContextNotFound extends Schema.TaggedError<ContextNotFound>()(
  "ContextNotFound",
  { name: ContextName }
) {}

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "ConfigurationError",
  { key: Schema.String, message: Schema.String }
) {}

// Union for error types
export const ContextError = Schema.Union(ContextNotFound, ContextLoadError)
export type ContextError = typeof ContextError.Type

// Typed error recovery
effect.pipe(
  Effect.catchTag("ContextNotFound", (e) => Effect.succeed(fallback)),
  Effect.catchTags({
    ContextNotFound: (e) => handleNotFound(e),
    ConfigurationError: (e) => handleConfig(e)
  })
)
```

## Config Service Pattern

```typescript
class AppConfig extends Context.Tag("@app/AppConfig")<
  AppConfig,
  {
    readonly apiKey: Redacted.Redacted
    readonly model: string
  }
>() {
  // Layer that loads from ConfigProvider
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("API_KEY")
      const model = yield* Config.string("MODEL").pipe(
        Config.withDefault("gpt-4o-mini")
      )
      return { apiKey, model }
    })
  )

  // Test layer with mock values
  static readonly testLayer = Layer.succeed(AppConfig, {
    apiKey: Redacted.make("test-key"),
    model: "test-model"
  })
}
```

## Terminal Service (not direct process access)

Use Terminal service instead of `process.stdout.write`:

```typescript
import { Terminal } from "@effect/platform"

// ❌ Bad - direct process access
Effect.sync(() => process.stdout.write(text))

// ✅ Good - Terminal service
Effect.gen(function*() {
  const terminal = yield* Terminal.Terminal
  yield* terminal.display(text)
})
```

## Testing with testLayer

```typescript
import { describe, expect, it } from "@effect/vitest"

describe("MyService", () => {
  // Each test gets fresh layer - no state leakage
  it.effect("does something", () =>
    Effect.gen(function*() {
      const service = yield* MyService
      const result = yield* service.doSomething("input")
      expect(result).toBe("expected")
    }).pipe(Effect.provide(MyService.testLayer))
  )
})
```

## Layer Composition

```typescript
// Service layer with dependencies
const MyServiceLayer = MyService.Default.pipe(
  Layer.provide(DependencyService.Default)
)

// Main layer composition
const MainLayer = Layer.mergeAll(
  MyServiceLayer,
  OtherService.Default,
  BunContext.layer
)

// Run
myEffect.pipe(
  Effect.provide(MainLayer),
  BunRuntime.runMain
)
```

## Streams

```typescript
const myStream: Stream.Stream<Event, Error, Deps> = Stream.unwrap(
  Effect.gen(function*() {
    const service = yield* SomeService
    return pipe(
      service.getData(),
      Stream.map((item) => transformFn(item)),
      Stream.tap((item) => Effect.log(`Got: ${item}`))
    )
  })
)

// Run stream
yield* myStream.pipe(Stream.runForEach((event) => handleEvent(event)))
```

## File Structure

```
src/
├── errors.ts             # TaggedError types
├── context.model.ts      # Schemas (TaggedClass, branded types)
├── context.repository.ts # Data access (Effect.Service + testLayer)
├── context.service.ts    # Domain logic (Effect.Service + testLayer)
├── config.ts             # Config service
├── llm.ts               # Pure functions
├── logging.ts           # Logging layer
├── tracing/             # Infrastructure
│   ├── index.ts         # Main exports
│   └── *.ts             # Provider modules
├── cli.ts               # CLI commands
└── main.ts              # Entry point
```

## Import Conventions

```typescript
// Namespace imports (recommended)
import { Effect, Layer, Stream, Config, Option } from "effect"
import { Schema } from "effect"

// Platform imports
import { FileSystem, Path, Terminal } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
```

## Common Patterns

**Generator vs Pipe**: Use `Effect.gen` for business logic with control flow; use `pipe()` for linear transformations.

**Running Effects**: Use `BunRuntime.runMain` for CLI apps. Use `Effect.runFork` for fire-and-forget.

**Avoid tacit/point-free style**:
```typescript
// ❌ Bad
Effect.map(fn)
// ✅ Good
Effect.map((x) => fn(x))
```

**Service interfaces don't leak dependencies** - deps are in `dependencies` array, not return types.

**Effect.fn for tracing**: Wrap service methods with `Effect.fn("ServiceName.methodName")` for automatic span creation.

---