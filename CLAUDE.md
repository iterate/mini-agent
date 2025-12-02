---
description: Effect-TS CLI project conventions and patterns
globs: "*.ts, *.tsx, package.json"
alwaysApply: true
---

# Project Conventions

## Runtime: Bun

- Use `bun <file>` instead of `node` or `ts-node`
- Use `bun install` instead of npm/yarn/pnpm
- Use `bun run <script>` for npm scripts
- Bun auto-loads `.env` files

## Environment: Doppler

All commands needing env vars must use `doppler run --`:

```bash
doppler run -- bun src/main.ts        # Run app
doppler run -- bun --watch src/main.ts # Dev mode
bun run check                          # Type check (no env needed)
bun run test                           # Tests
bun run lint                           # Lint
```

## Testing: Vitest

```typescript
import { describe, expect, it } from "@effect/vitest"

describe("MyService", () => {
  it.effect("does something", () =>
    Effect.gen(function*() {
      const result = yield* MyService.doSomething()
      expect(result).toBe(expected)
    }).pipe(Effect.provide(MyService.Default))
  )
})
```

---

# Effect Patterns

## Core Concept: Context

A **Context** is a named, ordered list of events. The only operation is `addEvents`:
1. Appends input events (UserMessage)
2. Triggers LLM with full history
3. Streams back events (TextDelta ephemeral, AssistantMessage persisted)
4. Persists new events

## Services with Effect.Service (Modern Pattern)

```typescript
export class MyService extends Effect.Service<MyService>()("MyService", {
  effect: Effect.gen(function*() {
    const dep = yield* SomeDependency
    return {
      doSomething: () => Effect.succeed("result"),
      doAsync: () => Effect.gen(function*() { /* ... */ })
    }
  }),
  dependencies: [SomeDependency.Default],
  accessors: true  // Generates static accessor methods
}) {}

// Usage
yield* MyService.doSomething()  // With accessors
yield* MyService.pipe(Effect.flatMap((s) => s.doSomething()))  // Without
```

## Schemas with TaggedClass

```typescript
export class UserMessage extends Schema.TaggedClass<UserMessage>()("UserMessage", {
  content: Schema.String
}) {}

// Type guard
export const isUserMessage = Schema.is(UserMessage)

// Union types
export const Event = Schema.Union(UserMessage, SystemPrompt, AssistantMessage)
export type Event = typeof Event.Type
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
  PlatformLayer
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
      Stream.map(transformFn),
      Stream.tap((item) => Effect.log(`Got: ${item}`))
    )
  })
)

// Run stream
yield* myStream.pipe(Stream.runForEach((event) => handleEvent(event)))
```

## Error Handling

```typescript
// Tagged errors
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  id: Schema.String
}) {}

// Catch specific errors
effect.pipe(
  Effect.catchTag("NotFound", (e) => Effect.succeed(fallback)),
  Effect.catchTags({
    NotFound: (e) => /* ... */,
    ValidationError: (e) => /* ... */
  })
)
```

## Configuration

```typescript
const ApiKey = Config.redacted("API_KEY")
const Model = Config.string("MODEL").pipe(Config.withDefault("gpt-4"))
const OptionalKey = Config.option(Config.redacted("OPTIONAL_KEY"))

// Use in layer
const MyLayer = Layer.unwrapEffect(
  Effect.gen(function*() {
    const key = yield* ApiKey
    return SomeService.layer({ apiKey: key })
  })
)
```

## File Structure

```
src/
├── context.model.ts      # Schemas (TaggedClass)
├── context.repository.ts # Data access (Effect.Service)
├── context.service.ts    # Domain logic (Effect.Service)
├── llm.ts               # Pure functions
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
import { FileSystem, Path } from "@effect/platform"
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

---

<!-- effect-solutions:start -->
## Effect Solutions Usage

- `effect-solutions list` - List all available topics
- `effect-solutions show <slug...>` - Read one or more topics
- `effect-solutions search <term>` - Search topics by keyword

**Local Effect Source:** `~/src/github.com/Effect-TS/effect`

**Effect Patterns Knowledge Base:** `~/src/github.com/PaulJPhilp/EffectPatterns` - A community-driven collection of practical Effect-TS patterns. Grep through this repo to find examples for services, layers, streams, error handling, testing, observability, and more. Key directories:
- `content/` - Pattern documentation in MDX format
- `packages/` - Example implementations
<!-- effect-solutions:end -->
