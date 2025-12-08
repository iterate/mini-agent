/**
 * HTTP Routes.
 *
 * Endpoints:
 * - POST /agent/:agentName - Send message, receive SSE stream of events
 * - POST /agent/:agentName/stream - Send message, stream events until idle (50ms timeout)
 * - GET /agent/:agentName/events - Subscribe to agent events (SSE)
 * - GET /agent/:agentName/state - Get reduced agent state
 * - GET /health - Health check
 */

import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Chunk, Duration, Effect, Fiber, Schema, Stream } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import { type AgentName, ContextEvent, makeBaseEventFields, UserMessageEvent } from "./domain.ts"

const encodeEvent = Schema.encodeSync(ContextEvent)

/** Encode a ContextEvent as an SSE data line */
const encodeSSE = (event: ContextEvent): Uint8Array =>
  new TextEncoder().encode(`data: ${JSON.stringify(encodeEvent(event))}\n\n`)

/** Input message schema - accepts both legacy and new tag names */
const InputMessage = Schema.Struct({
  _tag: Schema.Union(Schema.Literal("UserMessage"), Schema.Literal("UserMessageEvent")),
  content: Schema.String
})
type InputMessage = typeof InputMessage.Type

/** Parse JSON body into InputMessage */
const parseBody = (body: string) =>
  Effect.gen(function*() {
    const json = yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: (e) => new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
    })
    return yield* Schema.decodeUnknown(InputMessage)(json)
  })

/** Handler for POST /agent/:agentName */
const agentHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const registry = yield* AgentRegistry
  const params = yield* HttpRouter.params

  const agentName = params.agentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("POST /agent/:agentName", { agentName })

  // Read body
  const body = yield* request.text

  if (body.trim() === "") {
    return HttpServerResponse.text("Empty request body", { status: 400 })
  }

  const parseResult = yield* parseBody(body).pipe(Effect.either)

  if (parseResult._tag === "Left") {
    return HttpServerResponse.text(parseResult.left.message, { status: 400 })
  }

  const message = parseResult.right

  // Get or create agent
  const agent = yield* registry.getOrCreate(agentName as AgentName)

  // Get existing events to include initial session events
  const existingEvents = yield* agent.getEvents

  const ctx = yield* agent.getState

  // Prepare user event
  const userEvent = new UserMessageEvent({
    ...makeBaseEventFields(agentName as AgentName, agent.contextName, ctx.nextEventNumber, true),
    content: message.content
  })

  // Subscribe BEFORE adding event to guarantee we catch all events
  // PubSub.subscribe guarantees subscription is established when this completes
  const liveEvents = yield* agent.tapEventStream

  // Fork collection before adding event
  const eventFiber = yield* liveEvents.pipe(
    Stream.takeUntil((e) =>
      e._tag === "AgentTurnCompletedEvent" ||
      e._tag === "AgentTurnFailedEvent" ||
      e._tag === "AgentTurnInterruptedEvent"
    ),
    Stream.runCollect,
    Effect.fork
  )

  yield* agent.addEvent(userEvent)

  // Wait for the turn to complete and get all new events
  const newEventsChunk = yield* Fiber.join(eventFiber).pipe(
    Effect.catchAll(() => Effect.succeed(Chunk.empty<ContextEvent>()))
  )
  const newEvents = Chunk.toArray(newEventsChunk)

  // Build SSE stream: existing events + user event + new events from turn
  const allEvents: Array<ContextEvent> = [...existingEvents, userEvent, ...newEvents]
  const sseStream = Stream.fromIterable(allEvents).pipe(
    Stream.map(encodeSSE)
  )

  return HttpServerResponse.stream(sseStream, {
    contentType: "text/event-stream",
    headers: {
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  })
})

/**
 * Handler for POST /agent/:agentName/stream - Send message, stream until idle.
 *
 * Streams events until the agent has been idle for 50ms after completing the turn.
 * This is useful for clients that want to add an event and wait for the response
 * without keeping a long-lived subscription.
 */
const agentStreamHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const registry = yield* AgentRegistry
  const params = yield* HttpRouter.params

  const agentName = params.agentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("POST /agent/:agentName/stream", { agentName })

  const body = yield* request.text

  if (body.trim() === "") {
    return HttpServerResponse.text("Empty request body", { status: 400 })
  }

  const parseResult = yield* parseBody(body).pipe(Effect.either)

  if (parseResult._tag === "Left") {
    return HttpServerResponse.text(parseResult.left.message, { status: 400 })
  }

  const message = parseResult.right

  const agent = yield* registry.getOrCreate(agentName as AgentName)
  const ctx = yield* agent.getState

  const userEvent = new UserMessageEvent({
    ...makeBaseEventFields(agentName as AgentName, agent.contextName, ctx.nextEventNumber, true),
    content: message.content
  })

  // Subscribe BEFORE adding event
  const liveEvents = yield* agent.tapEventStream

  // Create a stream that emits events and terminates when idle for 50ms
  const streamWithIdleTimeout = liveEvents.pipe(
    Stream.tap(() => Effect.void),
    // Timeout after 50ms of no events when turn is complete
    Stream.timeoutTo(Duration.millis(50), Stream.empty),
    // Also stop if we see a turn completion event
    Stream.takeUntilEffect((e) =>
      Effect.gen(function*() {
        if (
          e._tag === "AgentTurnCompletedEvent" ||
          e._tag === "AgentTurnFailedEvent" ||
          e._tag === "AgentTurnInterruptedEvent"
        ) {
          // Wait 50ms for any final events, then terminate
          yield* Effect.sleep("50 millis")
          return true
        }
        return false
      })
    )
  )

  // Fork the stream collection
  const eventFiber = yield* streamWithIdleTimeout.pipe(
    Stream.runCollect,
    Effect.fork
  )

  // Add the user event to trigger the turn
  yield* agent.addEvent(userEvent)

  // Wait for stream to complete
  const collectedChunk = yield* Fiber.join(eventFiber).pipe(
    Effect.catchAll(() => Effect.succeed(Chunk.empty<ContextEvent>()))
  )
  const collectedEvents = Chunk.toArray(collectedChunk)

  // Build SSE response with user event + collected events
  const allEvents: Array<ContextEvent> = [userEvent, ...collectedEvents]
  const sseStream = Stream.fromIterable(allEvents).pipe(
    Stream.map(encodeSSE)
  )

  return HttpServerResponse.stream(sseStream, {
    contentType: "text/event-stream",
    headers: {
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  })
})

/** Handler for GET /agent/:agentName/events - Subscribe to agent events (SSE) */
const agentEventsHandler = Effect.gen(function*() {
  const registry = yield* AgentRegistry
  const params = yield* HttpRouter.params

  const agentName = params.agentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("GET /agent/:agentName/events", { agentName })

  const agent = yield* registry.getOrCreate(agentName as AgentName)

  // Subscribe to live events FIRST to guarantee we don't miss any
  // PubSub.subscribe guarantees subscription is established when this completes
  const liveEvents = yield* agent.tapEventStream

  // Get existing events (captured at subscription time)
  const existingEvents = yield* agent.getEvents
  const existingStream = Stream.fromIterable(existingEvents)

  // Stream terminates when SessionEndedEvent is received
  const sseStream = Stream.concat(existingStream, liveEvents).pipe(
    Stream.takeUntil((e) => e._tag === "SessionEndedEvent"),
    Stream.map(encodeSSE)
  )

  return HttpServerResponse.stream(sseStream, {
    contentType: "text/event-stream",
    headers: {
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  })
})

/** Handler for GET /agent/:agentName/state - Get reduced agent state */
const agentStateHandler = Effect.gen(function*() {
  const registry = yield* AgentRegistry
  const params = yield* HttpRouter.params

  const agentName = params.agentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("GET /agent/:agentName/state", { agentName })

  const agent = yield* registry.getOrCreate(agentName as AgentName)
  const reducedContext = yield* agent.getState

  return yield* HttpServerResponse.json({
    agentName,
    contextName: agent.contextName,
    nextEventNumber: reducedContext.nextEventNumber,
    currentTurnNumber: reducedContext.currentTurnNumber,
    messageCount: reducedContext.messages.length,
    hasLlmConfig: reducedContext.llmConfig._tag === "Some",
    isAgentTurnInProgress: reducedContext.agentTurnStartedAtEventId._tag === "Some"
  })
})

/** Health check endpoint */
const healthHandler = Effect.gen(function*() {
  yield* Effect.logDebug("GET /health")
  return yield* HttpServerResponse.json({ status: "ok" })
})

/** HTTP router */
export const makeRouter = HttpRouter.empty.pipe(
  HttpRouter.post("/agent/:agentName", agentHandler),
  HttpRouter.post("/agent/:agentName/stream", agentStreamHandler),
  HttpRouter.get("/agent/:agentName/events", agentEventsHandler),
  HttpRouter.get("/agent/:agentName/state", agentStateHandler),
  HttpRouter.get("/health", healthHandler)
)
