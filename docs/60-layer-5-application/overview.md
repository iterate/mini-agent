# Layer 5: Application Service - Overview

The outermost layer. Provides a clean interface for external consumers (CLI, HTTP API).

## Responsibility

1. **Session management**: Start/stop sessions, track active context
2. **Input routing**: Forward user input to handler
3. **Output formatting**: Provide event stream for display
4. **Lifecycle**: Initialize on startup, cleanup on shutdown

## Service Interface

```typescript
class ApplicationService extends Context.Tag("@app/ApplicationService")<
  ApplicationService,
  {
    // Start a session for a context
    readonly startSession: (contextName: ContextName) => Effect.Effect<void, ContextError>

    // Send a message
    readonly sendMessage: (content: string) => Effect.Effect<void>

    // Send a message with attachments
    readonly sendWithAttachments: (
      content: string,
      attachments: readonly FileAttachmentEvent[]
    ) => Effect.Effect<void>

    // Event stream for display
    readonly events: Stream.Stream<ContextEvent, LLMError>

    // Get conversation history
    readonly getHistory: () => Effect.Effect<readonly PersistedEvent[]>

    // List available contexts
    readonly listContexts: () => Effect.Effect<readonly ContextName[]>

    // End current session
    readonly endSession: () => Effect.Effect<void>
  }
>() {}
```

## Implementation

```typescript
class ApplicationService extends Context.Tag("@app/ApplicationService")<
  ApplicationService,
  {
    readonly startSession: (contextName: ContextName) => Effect.Effect<void, ContextError>
    readonly sendMessage: (content: string) => Effect.Effect<void>
    readonly sendWithAttachments: (content: string, attachments: readonly FileAttachmentEvent[]) => Effect.Effect<void>
    readonly events: Stream.Stream<ContextEvent, LLMError>
    readonly getHistory: () => Effect.Effect<readonly PersistedEvent[]>
    readonly listContexts: () => Effect.Effect<readonly ContextName[]>
    readonly endSession: () => Effect.Effect<void>
  }
>() {
  static readonly layer = Layer.effect(
    ApplicationService,
    Effect.gen(function*() {
      const handler = yield* InterruptibleHandler
      const session = yield* ContextSession
      const repository = yield* ContextRepository

      const startSession = Effect.fn("ApplicationService.startSession")(
        function*(contextName: ContextName) {
          yield* session.initialize(contextName)
        }
      )

      const sendMessage = Effect.fn("ApplicationService.sendMessage")(
        function*(content: string) {
          const event = UserMessageEvent.make({ content })
          yield* handler.submit(event)
        }
      )

      const sendWithAttachments = Effect.fn("ApplicationService.sendWithAttachments")(
        function*(content: string, attachments: readonly FileAttachmentEvent[]) {
          // Submit attachments first
          for (const attachment of attachments) {
            yield* handler.submit(attachment)
          }
          // Then the message
          yield* handler.submit(UserMessageEvent.make({ content }))
        }
      )

      const events = handler.events

      const getHistory = () => session.getEvents()

      const listContexts = () => repository.list()

      const endSession = () => session.close()

      return ApplicationService.of({
        startSession,
        sendMessage,
        sendWithAttachments,
        events,
        getHistory,
        listContexts,
        endSession,
      })
    })
  )
}
```

## Key Design Decisions

### 1. Thin Wrapper

Application service is intentionally thin—just routing and convenience methods. Complex logic lives in inner layers.

### 2. Session Lifecycle Ownership

The Application layer is responsible for:
- Calling `session.initialize()` on startup
- Calling `session.close()` on shutdown

This ensures `SessionStartedEvent` and `SessionEndedEvent` are emitted.

### 3. Event Stream Passthrough

Events from handler are passed through directly. The Application layer doesn't transform them.

### 4. Repository Access

The Application layer can access the repository directly for listing contexts—this doesn't go through the session.

## Dependencies

```
ApplicationService
├── InterruptibleHandler (submit events, get output stream)
├── ContextSession (initialize, close, get history)
└── ContextRepository (list contexts)
```

## Usage by CLI/HTTP

See:
- [cli-integration.md](./cli-integration.md) for CLI usage
- [http-integration.md](./http-integration.md) for HTTP API considerations
