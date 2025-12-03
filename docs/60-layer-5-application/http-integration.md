# HTTP Integration (Future)

How an HTTP API could use the same Application layer.

## Overview

The Application layer is transport-agnostic. The same service can be wrapped by:
- CLI (current)
- HTTP API (future)
- WebSocket server (future)
- gRPC (future)

## HTTP Server Example

```typescript
import { HttpServer, HttpRouter, HttpServerResponse } from "@effect/platform"

const app = HttpRouter.empty.pipe(
  // List contexts
  HttpRouter.get("/contexts", Effect.gen(function*() {
    const app = yield* ApplicationService
    const contexts = yield* app.listContexts()
    return HttpServerResponse.json(contexts)
  })),

  // Start session
  HttpRouter.post("/sessions/:contextName", Effect.gen(function*() {
    const app = yield* ApplicationService
    const { contextName } = yield* HttpRouter.params
    yield* app.startSession(ContextName.make(contextName))
    return HttpServerResponse.json({ status: "started" })
  })),

  // Send message (SSE response for streaming)
  HttpRouter.post("/sessions/:contextName/messages", Effect.gen(function*() {
    const app = yield* ApplicationService
    const body = yield* HttpServerRequest.json
    const { content, attachments } = body

    if (attachments?.length > 0) {
      yield* app.sendWithAttachments(content, attachments)
    } else {
      yield* app.sendMessage(content)
    }

    // Return SSE stream
    return HttpServerResponse.stream(
      app.events.pipe(
        Stream.map((event) => {
          const json = JSON.stringify(Schema.encodeSync(ContextEvent)(event))
          return `data: ${json}\n\n`
        }),
        Stream.encodeText
      ),
      { contentType: "text/event-stream" }
    )
  })),

  // Get history
  HttpRouter.get("/sessions/:contextName/history", Effect.gen(function*() {
    const app = yield* ApplicationService
    const history = yield* app.getHistory()
    return HttpServerResponse.json(history.map((e) =>
      Schema.encodeSync(PersistedEvent)(e)
    ))
  })),

  // End session
  HttpRouter.delete("/sessions/:contextName", Effect.gen(function*() {
    const app = yield* ApplicationService
    yield* app.endSession()
    return HttpServerResponse.json({ status: "ended" })
  })),
)
```

## Multi-Session Support

The current design has one session at a time. For HTTP, we'd need multiple concurrent sessions:

### Option A: Session per Request

```typescript
// Each request creates its own session scope
HttpRouter.post("/chat", Effect.gen(function*() {
  const { contextName, message } = yield* HttpServerRequest.json

  // Scoped session for this request
  yield* Effect.scoped(
    Effect.gen(function*() {
      const session = yield* ContextSession
      yield* session.initialize(ContextName.make(contextName))
      yield* session.addEvent(UserMessageEvent.make({ content: message }))
      // Stream response...
    }).pipe(
      Effect.provide(ContextSession.layer)
    )
  )
}))
```

### Option B: Session Manager Service

```typescript
class SessionManager extends Context.Tag("@app/SessionManager")<
  SessionManager,
  {
    readonly getOrCreate: (contextName: ContextName) => Effect.Effect<ContextSession>
    readonly close: (contextName: ContextName) => Effect.Effect<void>
    readonly closeAll: () => Effect.Effect<void>
  }
>() {
  static readonly layer = Layer.scoped(
    SessionManager,
    Effect.gen(function*() {
      const sessions = yield* Ref.make<Map<ContextName, ContextSession>>(new Map())

      const getOrCreate = Effect.fn("SessionManager.getOrCreate")(
        function*(contextName: ContextName) {
          const existing = yield* Ref.get(sessions).pipe(
            Effect.map((m) => m.get(contextName))
          )

          if (existing) return existing

          // Create new session
          const newSession = yield* createSession(contextName)
          yield* Ref.update(sessions, (m) => new Map([...m, [contextName, newSession]]))
          return newSession
        }
      )

      // ... close, closeAll implementations

      return SessionManager.of({ getOrCreate, close, closeAll })
    })
  )
}
```

## WebSocket for Real-Time

```typescript
HttpRouter.get("/ws/:contextName", Effect.gen(function*() {
  const app = yield* ApplicationService
  const { contextName } = yield* HttpRouter.params

  yield* app.startSession(ContextName.make(contextName))

  return HttpServerResponse.upgradeWebSocket((socket) =>
    Effect.gen(function*() {
      // Forward events to client
      yield* Effect.fork(
        app.events.pipe(
          Stream.runForEach((event) =>
            socket.send(JSON.stringify(Schema.encodeSync(ContextEvent)(event)))
          )
        )
      )

      // Receive messages from client
      yield* socket.messages.pipe(
        Stream.runForEach((msg) => {
          if (msg.type === "text") {
            const parsed = JSON.parse(msg.data)
            if (parsed.type === "message") {
              return app.sendMessage(parsed.content)
            }
          }
          return Effect.void
        })
      )
    })
  )
}))
```

## Design Considerations

### Stateless vs Stateful

| Approach | Description | Trade-offs |
|----------|-------------|-----------|
| **Stateless** | Load context per request | Simple, scales horizontally, slower |
| **Stateful** | Keep sessions in memory | Faster, harder to scale, memory use |
| **Hybrid** | In-memory with persistence | Best of both, more complex |

### Authentication

```typescript
const authMiddleware = HttpMiddleware.make((app) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const authHeader = request.headers.get("Authorization")

    if (!authHeader) {
      return HttpServerResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = yield* validateToken(authHeader)

    // Add user to context
    return yield* app.pipe(
      Effect.provideService(CurrentUser, userId)
    )
  })
)
```

### Rate Limiting

```typescript
const rateLimitMiddleware = HttpMiddleware.make((app) =>
  Effect.gen(function*() {
    const userId = yield* CurrentUser
    const allowed = yield* RateLimiter.check(userId)

    if (!allowed) {
      return HttpServerResponse.json(
        { error: "Rate limit exceeded" },
        { status: 429 }
      )
    }

    return yield* app
  })
)
```

## Layer Composition

```typescript
const httpLayer = ApplicationService.layer.pipe(
  Layer.provide(InterruptibleHandler.layer),
  Layer.provide(ContextSession.layer),
  // ... same as CLI ...
)

const server = HttpServer.serve(app.pipe(
  HttpRouter.use(authMiddleware),
  HttpRouter.use(rateLimitMiddleware),
  HttpRouter.use(HttpMiddleware.logger),
)).pipe(
  Effect.provide(httpLayer),
  Effect.provide(HttpServer.layer({ port: 3000 })),
)

BunRuntime.runMain(server)
```

## Key Insight

The Application layer doesn't change for HTTP—it's already transport-agnostic. The HTTP server is just another consumer of the same service interface.
