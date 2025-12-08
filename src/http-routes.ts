/**
 * HTTP Routes.
 *
 * Endpoints:
 * - POST /agent/:agentName/events - Add events and optionally stream back until idle
 * - GET /agent/:agentName/events - Subscribe to agent events (SSE)
 * - GET /agent/:agentName/state - Get reduced agent state
 * - GET /health - Health check
 */

import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Chunk, Duration, Effect, Schema, Stream } from "effect"
import { AgentService } from "./agent-service.ts"
import { type AgentName, ContextEvent } from "./domain.ts"

const encodeEvent = Schema.encodeSync(ContextEvent)

/** Encode a ContextEvent as an SSE data line */
const encodeSSE = (event: ContextEvent): Uint8Array =>
  new TextEncoder().encode(`data: ${JSON.stringify(encodeEvent(event))}\n\n`)

/** Input schema for adding events */
const AddEventsInputSchema = Schema.Struct({
  events: Schema.Array(ContextEvent),
  streamUntilIdle: Schema.optional(Schema.Boolean)
})
type AddEventsInput = typeof AddEventsInputSchema.Type
type AddEventsInput = typeof AddEventsInput.Type

/** Parse JSON body into AddEventsInput */
const parseAddEventsBody = (body: string) =>
  Effect.gen(function*() {
    const json = yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: (e) => new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
    })
    return yield* Schema.decodeUnknown(AddEventsInputSchema)(json)
  })

/** Handler for POST /agent/:agentName/events - Add events and optionally stream until idle */
const addEventsHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const service = yield* AgentService
  const params = yield* HttpRouter.params

  const agentName = params.agentName
  if (!agentName) {
    return yield* HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("POST /agent/:agentName/events", { agentName })

  // Read body
  const body = yield* request.text

  if (body.trim() === "") {
    return yield* HttpServerResponse.text("Empty request body", { status: 400 })
  }

  const parseResult = yield* parseAddEventsBody(body).pipe(Effect.either)

  if (parseResult._tag === "Left") {
    return yield* HttpServerResponse.text(parseResult.left.message, { status: 400 })
  }

  const input = parseResult.right
  const events = input.events
  const streamUntilIdle = input.streamUntilIdle ?? false

  // Add events
  yield* service.addEvents({ agentName: agentName as AgentName, events })

  // If not streaming, return success immediately
  if (!streamUntilIdle) {
    return yield* HttpServerResponse.json({ success: true, eventsAdded: events.length })
  }

  // Stream events until idle (50ms idle timeout)
  // tapEventStream requires Scope - create one for the HTTP request
  const eventStream = yield* service.tapEventStream({ agentName: agentName as AgentName }).pipe(Effect.scoped)

  // Use groupedWithin to collect events in 50ms windows
  // Take events until we get an empty window (idle period)
  const streamWithIdleDetection = eventStream.pipe(
    Stream.groupedWithin(Infinity, Duration.millis(50)),
    Stream.takeWhile((chunk) => Chunk.size(chunk) > 0), // Continue while we get events
    Stream.flatMap((chunk) => Stream.fromIterable(Chunk.toReadonlyArray(chunk)))
  )

  const sseStream = streamWithIdleDetection.pipe(Stream.map(encodeSSE))

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
    return yield* HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("GET /agent/:agentName/events", { agentName })

  // tapEventStream requires Scope - create one for the HTTP request
  const eventStream = yield* service.tapEventStream({ agentName: agentName as AgentName }).pipe(Effect.scoped)

  // Stream terminates when SessionEndedEvent is received
  const sseStream = eventStream.pipe(
    Stream.takeUntil((e) => e._tag === "SessionEndedEvent"),
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

/** Handler for GET /agent/:agentName/state - Get reduced agent state */
const agentStateHandler = Effect.gen(function*() {
  const service = yield* AgentService
  const params = yield* HttpRouter.params

  const agentName = params.agentName
  if (!agentName) {
    return yield* HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("GET /agent/:agentName/state", { agentName })

  const events = yield* service.getEvents({ agentName: agentName as AgentName })

  // Calculate reduced context from events
  // For now, return basic info - full reducer would require EventReducer service
  return yield* HttpServerResponse.json({
    agentName,
    eventCount: events.length,
    lastEvent: events.length > 0 ? encodeEvent(events[events.length - 1]!) : null
  })
})

/** Health check endpoint */
const healthHandler = Effect.gen(function*() {
  yield* Effect.logDebug("GET /health")
  return yield* HttpServerResponse.json({ status: "ok" })
})

/** HTTP router */
export const makeRouter = HttpRouter.empty.pipe(
  HttpRouter.post("/agent/:agentName/events", addEventsHandler),
  HttpRouter.get("/agent/:agentName/events", agentEventsHandler),
  HttpRouter.get("/agent/:agentName/state", agentStateHandler),
  HttpRouter.get("/health", healthHandler)
)
