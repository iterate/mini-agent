/**
 * HTTP Routes.
 *
 * Endpoints:
 * - POST /agent/:agentName - Send message, receive SSE stream of events
 * - POST /agent/:agentName/add-and-stream - Add events and stream until idle (50ms)
 * - GET /agent/:agentName/events - Subscribe to agent events (SSE)
 * - GET /agent/:agentName/state - Get reduced agent state
 * - GET /health - Health check
 */

import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Chunk, Duration, Effect, Fiber, Schema, Stream } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import { AgentService } from "./agent-service.ts"
import { type AgentName, ContextEvent } from "./domain.ts"

const encodeEvent = Schema.encodeSync(ContextEvent)

/** Encode a ContextEvent as an SSE data line */
const encodeSSE = (event: ContextEvent): Uint8Array =>
  new TextEncoder().encode(`data: ${JSON.stringify(encodeEvent(event))}\n\n`)

/** Parse JSON body into array of events */
const parseEventsBody = (body: string) =>
  Effect.gen(function*() {
    const json = yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: (e) => new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
    })
    return yield* Schema.decodeUnknown(Schema.Array(ContextEvent))(json)
  })

/** Handler for POST /agent/:agentName - Legacy endpoint for single message */
const agentHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const service = yield* AgentService
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

  // Parse as array of events (for backward compat, also accept single event)
  const parseResult = yield* parseEventsBody(body).pipe(Effect.either)

  if (parseResult._tag === "Left") {
    return HttpServerResponse.text(parseResult.left.message, { status: 400 })
  }

  const events = parseResult.right

  // Get existing events
  const existingEvents = yield* service.getEvents({ agentName: agentName as AgentName })

  // Subscribe before adding events
  const eventStream = yield* service.tapEventStream({ agentName: agentName as AgentName })

  // Fork collection
  const eventFiber = yield* eventStream.pipe(
    Stream.takeUntil((e) =>
      e._tag === "AgentTurnCompletedEvent" ||
      e._tag === "AgentTurnFailedEvent" ||
      e._tag === "AgentTurnInterruptedEvent"
    ),
    Stream.runCollect,
    Effect.fork
  )

  // Add events
  yield* service.addEvents({ agentName: agentName as AgentName, events })

  // Wait for turn to complete
  const newEventsChunk = yield* Fiber.join(eventFiber).pipe(
    Effect.catchAll(() => Effect.succeed(Chunk.empty<ContextEvent>()))
  )
  const newEvents = Chunk.toArray(newEventsChunk)

  // Build SSE stream
  const allEvents: Array<ContextEvent> = [...existingEvents, ...events, ...newEvents]
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

/** Handler for POST /agent/:agentName/add-and-stream - Add events and stream until idle */
const addAndStreamHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const service = yield* AgentService
  const params = yield* HttpRouter.params

  const agentName = params.agentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("POST /agent/:agentName/add-and-stream", { agentName })

  // Read body
  const body = yield* request.text

  if (body.trim() === "") {
    return HttpServerResponse.text("Empty request body", { status: 400 })
  }

  const parseResult = yield* parseEventsBody(body).pipe(Effect.either)

  if (parseResult._tag === "Left") {
    return HttpServerResponse.text(parseResult.left.message, { status: 400 })
  }

  const events = parseResult.right

  // Get existing events
  const existingEvents = yield* service.getEvents({ agentName: agentName as AgentName })

  // Subscribe before adding events
  const eventStream = yield* service.tapEventStream({ agentName: agentName as AgentName })

  // Add events
  yield* service.addEvents({ agentName: agentName as AgentName, events })

  // Stream events until idle for 50ms
  // Use debounce to detect when we've been idle for 50ms
  const combinedStream = Stream.concat(
    Stream.fromIterable(existingEvents),
    Stream.fromIterable(events),
    eventStream
  )

  // Create a signal stream that emits when we've been idle for 50ms
  const idleSignal = combinedStream.pipe(
    Stream.debounce(Duration.millis(50)),
    Stream.take(1),
    Stream.map(() => null as ContextEvent | null)
  )

  // Stream events until idle signal fires
  const sseStream = Stream.merge(combinedStream, idleSignal).pipe(
    Stream.takeUntil((item) => item === null), // Stop when idle signal fires
    Stream.filter((item): item is ContextEvent => item !== null),
    Stream.map(encodeSSE)
  )

  return yield* HttpServerResponse.stream(sseStream, {
    contentType: "text/event-stream",
    headers: {
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  })
})

/** Handler for GET /agent/:agentName/events - Subscribe to agent event stream */
const agentEventsHandler = Effect.gen(function*() {
  const service = yield* AgentService
  const params = yield* HttpRouter.params

  const agentName = params.agentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("GET /agent/:agentName/events", { agentName })

  // Get existing events
  const existingEvents = yield* service.getEvents({ agentName: agentName as AgentName })

  // Subscribe to live events
  const liveEvents = yield* service.tapEventStream({ agentName: agentName as AgentName })

  // Stream terminates when SessionEndedEvent is received
  const sseStream = Stream.concat(
    Stream.fromIterable(existingEvents),
    liveEvents
  ).pipe(
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
  const reducedContext = yield* agent.getReducedContext

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

/** Handler for POST /agent/:agentName/events - Add events (no streaming) */
const addEventsHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const service = yield* AgentService
  const params = yield* HttpRouter.params

  const agentName = params.agentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("POST /agent/:agentName/events", { agentName })

  // Read body
  const body = yield* request.text

  if (body.trim() === "") {
    return HttpServerResponse.text("Empty request body", { status: 400 })
  }

  const parseResult = yield* parseEventsBody(body).pipe(Effect.either)

  if (parseResult._tag === "Left") {
    return HttpServerResponse.text(parseResult.left.message, { status: 400 })
  }

  const events = parseResult.right

  // Add events
  yield* service.addEvents({ agentName: agentName as AgentName, events })

  return HttpServerResponse.json({ success: true, count: events.length })
})

/** HTTP router */
export const makeRouter = HttpRouter.empty.pipe(
  HttpRouter.post("/agent/:agentName", agentHandler),
  HttpRouter.post("/agent/:agentName/events", addEventsHandler),
  HttpRouter.post("/agent/:agentName/add-and-stream", addAndStreamHandler),
  HttpRouter.get("/agent/:agentName/events", agentEventsHandler),
  HttpRouter.get("/agent/:agentName/state", agentStateHandler),
  HttpRouter.get("/health", healthHandler)
)
