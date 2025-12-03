---
description: Effect-TS CLI project conventions and patterns
globs: "*.ts, *.tsx, package.json"
alwaysApply: true
---
# General

- Sacrifice grammar in favour of concision. Write like a good software engineer would write to another.

# What we're building

See README.md for context

# Typescript

- Use bun as runtime and package manager
- Run using `doppler run -- bun src/main.ts` (for env vars)
- kebab-case filenames
- tests using vitest; colocate test files with .test.ts
- import using .ts extension; no .js
- Use comments sparingly to explain any additional context and "why" that isn't evident from the code. Don't redundantly describe the code below.
- No banner comments (e.g. `// ===== Section Name =====`). Use whitespace and JSDoc to organize code.
- DO NOT use nodejs imports like node:fs etc - you must use @effect/platform/FileSystem and @effect/platform/Path instead (read source if you need to grok it)

## Scripts

- `bun run typecheck` — tsc only
- `bun run lint` / `bun run lint:fix` — eslint only
- `bun run check` — typecheck + lint
- `bun run check:fix` — typecheck + lint:fix
- `doppler run -- bun run test` — vitest (requires Doppler for API keys)
- `doppler run -- bun run test:watch` — vitest watch mode

## Pull Requests

Before committing and pushing code, you must run:
```bash
bun run check:fix
```

This runs typecheck + linter with auto-fix. Commit any resulting changes before pushing.

Also make sure to amend the pull request description using the `gh` utility each time you push.

## Use of effect

<!-- effect-solutions:start -->
## Effect Solutions Usage

- `effect-solutions list` - List all available topics
- `effect-solutions show <slug...>` - Read one or more topics
- `effect-solutions search <term>` - Search topics by keyword

**Local Effect Source:** `~/src/github.com/Effect-TS/effect`
<!-- effect-solutions:end -->

**Effect Patterns Knowledge Base:** Cross-reference with `~/src/github.com/PaulJPhilp/EffectPatterns` for community patterns in `content/` and `packages/`.


## Services with Context.Tag (Canonical Pattern)

Services define a contract (interface) separate from implementation. Use `Context.Tag` with static `layer` and `testLayer` properties:

```typescript
class MyService extends Context.Tag("@app/MyService")<
  MyService,
  {
    readonly doSomething: (input: string) => Effect.Effect<string>
  }
>() {
  // Production layer with dependencies
  static readonly layer = Layer.effect(
    MyService,
    Effect.gen(function*() {
      const dep = yield* SomeDependency

      // Use Effect.fn for call-site tracing
      const doSomething = Effect.fn("MyService.doSomething")(
        function*(input: string) {
          yield* Effect.log(`Processing: ${input}`)
          return "result"
        }
      )

      return MyService.of({ doSomething })
    })
  )

  // Test layer with mock implementation
  static readonly testLayer = Layer.sync(MyService, () =>
    MyService.of({
      doSomething: (input) => Effect.succeed(`mock: ${input}`)
    })
  )
}
```

**Why Context.Tag over Effect.Service:**
- Supports service-driven development (sketch interfaces before implementations)
- Explicit separation of contract and implementation
- Clearer dependency graph

## Prefer Schema Over Plain Types

Use `Schema` instead of plain TypeScript types for domain values. Schemas provide runtime validation, encoding/decoding, and type guards - plain types only exist at compile time.

```typescript
// ❌ Plain type - no runtime validation
type Status = "pending" | "active" | "done"

// ✅ Schema - runtime validation + type derivation
const Status = Schema.Literal("pending", "active", "done")
type Status = typeof Status.Type

// Use the schema for validation
const validateStatus = Schema.decodeUnknown(Status)
const isStatus = Schema.is(Status)
```

This applies to:
- **Enums/Literals**: `Schema.Literal("a", "b", "c")` over `type T = "a" | "b" | "c"`
- **Domain objects**: `Schema.Struct({...})` or `Schema.TaggedClass` over `interface`
- **Unions**: `Schema.Union(A, B, C)` over `type T = A | B | C`
- **Branded types**: `Schema.String.pipe(Schema.brand("UserId"))` over `string & { _brand: "UserId" }`

The pattern: define Schema first, derive type with `typeof Schema.Type`.

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

## Launching Commands

Use `@effect/platform` Command for subprocess execution. Pipe stdin with `Command.stdin(Stream)`, capture output with `Command.string` / `Command.lines` / `Command.stream`:

```typescript
import { Command } from "@effect/platform"
import { Stream } from "effect"

// Run command with stdin input
const output = yield* Command.make("cat").pipe(
  Command.stdin(Stream.make(Buffer.from("hello\n", "utf-8"))),
  Command.string
)

// Stream output line by line
const lines = Command.streamLines(Command.make("ls", "-la"))
```

## Logging vs User Output

Two different output mechanisms:

**`Effect.log*`** = Observability logging (timestamps, levels, goes to file)
```typescript
yield* Effect.log("Processing request")      // info (stdout + file)
yield* Effect.logDebug("Detailed state")     // debug (file only by default)
yield* Effect.logWarning("Retrying...")      // warn
yield* Effect.logError("Failed", { error })  // error with structured data
```

**`Console.log/error`** = Direct user output (chat messages, JSON, prompts)
```typescript
yield* Console.log(assistantMessage)  // User-facing output
yield* Console.error("Error: ...")    // User-visible error
```

Config defaults: stdout=warn, file=debug (in `.mini-agent/logs/`).

For errors, do BOTH - log for observability AND show user:
```typescript
Effect.logError("Request failed", { error }).pipe(
  Effect.flatMap(() => Console.error(`Error: ${error}`))
)
```

## Log Annotations and Spans

**Annotations** add structured metadata to all logs within an effect scope. Use `Effect.annotateLogs` to attach key-value pairs (e.g., requestId, userId) that appear in every log emitted by nested effects.

**Spans** track execution duration. Wrap an effect with `Effect.withLogSpan("label")` to automatically include timing in logs—useful for performance debugging.

```typescript
const program = Effect.gen(function*() {
  yield* Effect.log("Starting")
  yield* doWork()
  yield* Effect.log("Done")
}).pipe(
  Effect.annotateLogs({ requestId: "abc123", userId: "user42" }),
  Effect.withLogSpan("processRequest")
)
// Logs include: requestId=abc123 userId=user42 processRequest=152ms
```

See [Effect logging docs](https://effect.website/docs/observability/logging/#log-spans) for details.

## Vitest test Fixtures (test/fixtures.ts)

Use `test` from `./fixtures.js` for e2e tests needing isolated temp directories:

```typescript
import { test, expect } from "./fixtures.js"

test("my test", async ({ testDir }) => {
  // testDir is a unique temp directory for this test
  // Files written here are preserved for debugging
})
```

Suite directory logged once per file; test directory only logged on failure.

## Testing with testLayer

Use `Layer.sync` for test layers (cleaner than `Layer.effect(Effect.sync(...))`):

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

**Test layer pattern:**
```typescript
static readonly testLayer = Layer.sync(MyService, () => {
  // Mutable state is fine in tests - JS is single-threaded
  const store = new Map<string, Data>()
  
  return MyService.of({
    get: (key) => Effect.succeed(store.get(key)),
    set: (key, value) => Effect.sync(() => void store.set(key, value))
  })
})
```

## Common Patterns

**Generator vs Pipe**: Use `Effect.gen` for business logic with control flow; use `pipe()` for linear transformations.

**Service interfaces don't leak dependencies** - dependencies are resolved in the layer, not exposed in the service interface.

**Effect.fn for tracing**: Wrap service methods with `Effect.fn("ServiceName.methodName")` for automatic span creation.

---