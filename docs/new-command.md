# Adding New Commands

This guide explains how to add new commands to the CLI application.

## Project Structure

```
├── cli.ts                  # CLI entry point
├── server.ts               # Server entry point
├── shared/
│   ├── schemas.ts          # RPC schemas (TaskRpcs, LlmRpcs, etc.)
│   └── tracing.ts          # Shared telemetry config
├── cli/
│   ├── client.ts           # RPC client helpers
│   ├── tasks.ts            # Task CLI commands
│   ├── llm.ts              # LLM CLI commands
│   ├── server.ts           # Server management commands
│   └── rpc.ts              # Interactive RPC explorer
└── server/
    ├── tasks.ts            # Task RPC handlers
    └── llm.ts              # LLM RPC handlers
```

---

## Option A: Client-Only Command

For commands that don't need server-side logic (e.g., local utilities).

### 1. Create a new file in `cli/`

```typescript
// cli/utils.ts
import { Command, Args, Options } from "@effect/cli"
import { Console, Effect } from "effect"

const myCommand = Command.make(
  "my-command",
  {
    name: Args.text({ name: "name" }).pipe(
      Args.withDescription("Your name")
    ),
    verbose: Options.boolean("verbose").pipe(
      Options.withAlias("v"),
      Options.withDefault(false)
    )
  },
  ({ name, verbose }) =>
    Effect.gen(function* () {
      yield* Console.log(`Hello, ${name}!`)
      if (verbose) {
        yield* Console.log("(verbose mode enabled)")
      }
    })
).pipe(Command.withDescription("A friendly greeting"))

export const utilsCommand = Command.make("utils", {}, () =>
  Console.log("Utility commands: my-command")
).pipe(
  Command.withDescription("Utility commands"),
  Command.withSubcommands([myCommand])
)
```

### 2. Import in `cli.ts`

```typescript
import { utilsCommand } from "./cli/utils.js"

const rootCommand = Command.make("effect-tasks", {}, () => /* ... */)
  .pipe(
    Command.withSubcommands([
      tasksCommand,
      llmCommand,
      serverCommand,
      rpcCommand,
      utilsCommand  // Add here
    ])
  )
```

---

## Option B: Client + Server Command (RPC)

For commands that need server-side processing.

### 1. Define the RPC schema in `shared/schemas.ts`

```typescript
// Add to existing file

// Error type (optional)
export class MyError extends Schema.TaggedError<MyError>()(
  "MyError",
  { reason: Schema.String }
) {}

// RPC group
export class MyRpcs extends RpcGroup.make(
  Rpc.make("doSomething", {
    success: Schema.String,
    error: MyError,
    payload: {
      input: Schema.String.annotations({ description: "The input value" })
    }
  }),

  // Streaming RPC example
  Rpc.make("streamData", {
    success: Schema.String,
    stream: true,
    payload: {
      query: Schema.String
    }
  })
) {}
```

### 2. Create server handlers in `server/`

```typescript
// server/my.ts
import { Effect, Stream } from "effect"
import { MyRpcs, MyError } from "../shared/schemas.js"

export const MyHandlers = MyRpcs.toLayer({
  doSomething: ({ input }) =>
    Effect.gen(function* () {
      // Your server logic here
      return `Processed: ${input}`
    }).pipe(Effect.withSpan("my.doSomething")),

  streamData: ({ query }) =>
    Stream.fromIterable(["chunk1", "chunk2", "chunk3"]).pipe(
      Stream.tap(() => Effect.logDebug("Streaming chunk"))
    )
})
```

### 3. Register handlers in `server.ts`

```typescript
import { MyRpcs } from "./shared/schemas.js"
import { MyHandlers } from "./server/my.js"

const RpcLayers = Layer.mergeAll(
  RpcServer.layer(TaskRpcs).pipe(Layer.provide(TaskHandlers)),
  RpcServer.layer(LlmRpcs).pipe(Layer.provide(LlmHandlers)),
  RpcServer.layer(MyRpcs).pipe(Layer.provide(MyHandlers))  // Add here
)
```

### 4. Create CLI commands in `cli/`

```typescript
// cli/my.ts
import { Args, Command, Options } from "@effect/cli"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { FetchHttpClient } from "@effect/platform"
import { Console, Effect, Layer, Stream } from "effect"
import { MyRpcs } from "../shared/schemas.js"
import { DEFAULT_SERVER_URL } from "./client.js"

const serverUrlOption = Options.text("server-url").pipe(
  Options.withAlias("u"),
  Options.withDefault(DEFAULT_SERVER_URL)
)

const doSomethingCommand = Command.make(
  "do-something",
  {
    serverUrl: serverUrlOption,
    input: Args.text({ name: "input" })
  },
  ({ serverUrl, input }) =>
    Effect.gen(function* () {
      const clientLayer = RpcClient.layerProtocolHttp({ url: serverUrl }).pipe(
        Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson])
      )

      yield* RpcClient.make(MyRpcs).pipe(
        Effect.flatMap((client) =>
          Effect.gen(function* () {
            const result = yield* client.doSomething({ input })
            yield* Console.log(result)
          })
        ),
        Effect.scoped,
        Effect.provide(clientLayer)
      )
    }).pipe(
      Effect.catchAll((error) => Console.error(`Error: ${String(error)}`))
    )
).pipe(Command.withDescription("Do something on the server"))

export const myCommand = Command.make("my", {}, () =>
  Console.log("My commands: do-something, stream-data")
).pipe(
  Command.withDescription("My custom commands"),
  Command.withSubcommands([doSomethingCommand])
)
```

### 5. Import in `cli.ts`

```typescript
import { myCommand } from "./cli/my.js"

// Add to subcommands array
```

### 6. Update the RPC explorer registry

In `cli/rpc.ts`, add your new group to `RPC_REGISTRY`:

```typescript
const RPC_REGISTRY = {
  // ... existing groups ...
  my: {
    group: MyRpcs,
    methods: ["doSomething", "streamData"],
    schemas: {
      doSomething: { payload: "{ input: string }", returns: "string" },
      streamData: { payload: "{ query: string }", returns: "Stream<string>" }
    }
  }
}
```

---

## Testing Your Command

### Manual Testing

```bash
# Start server
doppler run -- bun server.ts

# In another terminal, test CLI
doppler run -- bun cli.ts my do-something "test input"

# Or use the RPC explorer
doppler run -- bun cli.ts rpc list
doppler run -- bun cli.ts rpc call my doSomething '{"input": "test"}'
```

### Common Patterns

**Error Handling:**
```typescript
Effect.catchAll((error) =>
  Effect.gen(function* () {
    if (typeof error === "object" && error !== null && "_tag" in error) {
      yield* Console.error(`Error [${error._tag}]: ${JSON.stringify(error)}`)
    } else {
      yield* Console.error(`Error: ${String(error)}`)
    }
  })
)
```

**Streaming:**
```typescript
yield* Stream.runForEach(client.streamData({ query }), (chunk) =>
  Effect.sync(() => process.stdout.write(chunk))
)
```

**With Tracing:**
```typescript
Effect.withSpan("cli.my.doSomething")
```

---

## Checklist

- [ ] Schema defined in `shared/schemas.ts`
- [ ] Server handlers in `server/<group>.ts`
- [ ] Server handlers registered in `server.ts`
- [ ] CLI commands in `cli/<group>.ts`
- [ ] CLI commands registered in `cli.ts`
- [ ] RPC explorer registry updated in `cli/rpc.ts`
- [ ] Tested with `bun cli.ts <group> <command> --help`

