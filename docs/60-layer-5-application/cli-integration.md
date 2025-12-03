# CLI Integration

How the CLI uses the Application layer.

## CLI Commands

```typescript
import { Command, Options, Args } from "@effect/cli"

// Main chat command
const chat = Command.make(
  "chat",
  {
    name: Options.text("name").pipe(Options.alias("n")),
    message: Options.text("message").pipe(Options.alias("m"), Options.optional),
    image: Options.file("image").pipe(Options.alias("i"), Options.optional),
    raw: Options.boolean("raw").pipe(Options.alias("r"), Options.withDefault(false)),
  },
  ({ name, message, image, raw }) =>
    Effect.gen(function*() {
      const app = yield* ApplicationService
      const terminal = yield* Terminal.Terminal

      // Initialize session
      yield* app.startSession(ContextName.make(name))

      if (message) {
        // Non-interactive mode: send message and exit
        if (image) {
          const attachment = yield* loadImageAttachment(image)
          yield* app.sendWithAttachments(message, [attachment])
        } else {
          yield* app.sendMessage(message)
        }

        // Stream output
        yield* app.events.pipe(
          Stream.runForEach((event) =>
            formatAndDisplay(event, { raw, terminal })
          )
        )
      } else {
        // Interactive mode
        yield* runInteractiveLoop(app, terminal, { raw })
      }

      // Cleanup
      yield* app.endSession()
    })
)
```

## Interactive Loop

```typescript
const runInteractiveLoop = (
  app: ApplicationService,
  terminal: Terminal.Terminal,
  options: { raw: boolean }
): Effect.Effect<void, LLMError | TerminalError> =>
  Effect.gen(function*() {
    // Start event display in background
    const displayFiber = yield* Effect.fork(
      app.events.pipe(
        Stream.runForEach((event) =>
          formatAndDisplay(event, { raw: options.raw, terminal })
        )
      )
    )

    // Read-eval-print loop
    while (true) {
      const input = yield* terminal.readLine

      if (input === "/quit" || input === "/exit") {
        break
      }

      if (input === "/history") {
        const history = yield* app.getHistory()
        yield* displayHistory(history, terminal)
        continue
      }

      if (input === "/contexts") {
        const contexts = yield* app.listContexts()
        yield* terminal.display(contexts.join("\n") + "\n")
        continue
      }

      // Send as message
      yield* app.sendMessage(input)
    }

    yield* Fiber.interrupt(displayFiber)
  })
```

## Event Display

```typescript
const formatAndDisplay = (
  event: ContextEvent,
  options: { raw: boolean; terminal: Terminal.Terminal }
): Effect.Effect<void> =>
  Effect.gen(function*() {
    if (options.raw) {
      // JSON output
      const json = JSON.stringify(Schema.encodeSync(ContextEvent)(event))
      yield* options.terminal.display(json + "\n")
      return
    }

    // Pretty output
    switch (event._tag) {
      case "TextDeltaEvent":
        yield* options.terminal.display(event.delta)
        break

      case "AssistantMessageEvent":
        yield* options.terminal.display("\n")  // End of response
        break

      case "LLMRequestStartedEvent":
        yield* options.terminal.display("🤔 Thinking...\n")
        break

      case "LLMRequestCompletedEvent":
        yield* options.terminal.display(`\n✓ (${event.durationMs}ms)\n`)
        break

      case "LLMRequestInterruptedEvent":
        yield* options.terminal.display(`\n⚠ Interrupted\n`)
        break

      case "LLMRequestFailedEvent":
        yield* options.terminal.display(`\n❌ Error: ${event.error}\n`)
        break

      // Lifecycle events - silent by default
      case "SessionStartedEvent":
      case "SessionEndedEvent":
        break
    }
  })
```

## Layer Composition

```typescript
const cliLayer = ApplicationService.layer.pipe(
  Layer.provide(InterruptibleHandler.layer),
  Layer.provide(ContextSession.layer),
  Layer.provide(EventReducer.layer),
  Layer.provide(LLMRequest.layer),
  Layer.provide(ContextRepository.layer),
  Layer.provide(HooksService.layer),
  Layer.provide(AppConfig.layer),
  Layer.provide(Terminal.layer),
  Layer.provide(BunContext.layer),
)

const main = chat.pipe(
  Command.withDescription("Chat with AI"),
  Command.run({
    name: "mini-agent",
    version: "0.1.0",
  }),
  Effect.provide(cliLayer),
)

BunRuntime.runMain(main)
```

## Graceful Shutdown

```typescript
const main = Effect.gen(function*() {
  const app = yield* ApplicationService

  // Register shutdown handler
  yield* Effect.addFinalizer(() =>
    Effect.gen(function*() {
      yield* app.endSession()
      yield* Effect.log("Session ended gracefully")
    })
  )

  // ... run CLI ...
})
```

## Error Handling

```typescript
const chatWithErrorHandling = chat.pipe(
  Effect.catchTags({
    ContextNotFound: (e) =>
      Effect.gen(function*() {
        yield* Console.error(`Context not found: ${e.name}`)
        yield* Effect.fail(new ExitCode(1))
      }),

    LLMError: (e) =>
      Effect.gen(function*() {
        yield* Console.error(`LLM error: ${e.message}`)
        yield* Effect.fail(new ExitCode(1))
      }),

    ConfigurationError: (e) =>
      Effect.gen(function*() {
        yield* Console.error(`Config error: ${e.message}`)
        yield* Console.error(`Set ${e.key} environment variable`)
        yield* Effect.fail(new ExitCode(1))
      }),
  })
)
```

## Session Lifecycle

```
CLI starts
    │
    ▼
┌──────────────────────────┐
│ app.startSession("chat") │ → SessionStartedEvent persisted
└──────────────────────────┘
    │
    ▼
┌──────────────────────────┐
│ Interactive loop or      │
│ single message           │
└──────────────────────────┘
    │
    ▼
┌──────────────────────────┐
│ app.endSession()         │ → SessionEndedEvent persisted
└──────────────────────────┘
    │
    ▼
CLI exits
```
