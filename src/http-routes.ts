/**
 * HTTP Routes.
 *
 * Endpoints:
 * - POST /agent/:agentName - Send message, receive SSE stream of events (until turn completes)
 * - POST /agent/:agentName/events - Add event(s) and stream until idle for 50ms
 * - GET /agent/:agentName/events - Subscribe to agent events (SSE)
 * - GET /agent/:agentName/state - Get reduced agent state
 * - GET /health - Health check
 */

import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Chunk, Duration, Effect, Fiber, Schema, Stream } from "effect"
import { AgentService } from "./agent-service.ts"
import { type AgentName, type ContextName, ContextEvent, makeBaseEventFields, UserMessageEvent } from "./domain.ts"

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

/** Handler for POST /agent/:agentName - Send message, receive SSE until turn completes */
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

  const parseResult = yield* parseBody(body).pipe(Effect.either)

  if (parseResult._tag === "Left") {
    return HttpServerResponse.text(parseResult.left.message, { status: 400 })
  }

  const message = parseResult.right

  // Get existing events to include initial session events
  const existingEvents = yield* service.getEvents({ agentName: agentName as AgentName })

  const ctx = yield* service.getState({ agentName: agentName as AgentName })

  // Prepare user event - need contextName from state or derive it
  const contextName = `${agentName}-v1` as ContextName
  const userEvent = new UserMessageEvent({
    ...makeBaseEventFields(agentName as AgentName, contextName, ctx.nextEventNumber, true),
    content: message.content
  })

  // Subscribe BEFORE adding event to guarantee we catch all events
  const liveEventsStream = yield* service.tapEventStream({ agentName: agentName as AgentName })

  // Fork collection before adding event
  const eventFiber = yield* liveEventsStream.pipe(
    Stream.takeUntil((e: ContextEvent) =>
      e._tag === "AgentTurnCompletedEvent" ||
      e._tag === "AgentTurnFailedEvent" ||
      e._tag === "AgentTurnInterruptedEvent"
    ),
    Stream.runCollect,
    Effect.fork
  )

  yield* service.addEvents({ agentName: agentName as AgentName, events: [userEvent] })

  // Wait for the turn to complete and get all new events
  const newEventsChunkResult = yield* Fiber.join(eventFiber).pipe(Effect.either)
  const newEvents = newEventsChunkResult._tag === "Right" ? Chunk.toArray(newEventsChunkResult.right) : []

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

/** Handler for POST /agent/:agentName/events - Add event(s) and stream until idle for 50ms */
const addEventsAndStreamHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const service = yield* AgentService
  const params = yield* HttpRouter.params

  const agentName = params.agentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("POST /agent/:agentName/events", { agentName })

  // Read body - expect array of events or single event
  const body = yield* request.text

  if (body.trim() === "") {
    return HttpServerResponse.text("Empty request body", { status: 400 })
  }

  const json = yield* Effect.try({
    try: () => JSON.parse(body) as unknown,
    catch: (e) => new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
  })

  // Accept single event or array
  const eventsArray = Array.isArray(json) ? json : [json]
  const events = yield* Effect.all(
    eventsArray.map((e) => Schema.decodeUnknown(ContextEvent)(e))
  )

  // Get existing events
  const existingEvents = yield* service.getEvents({ agentName: agentName as AgentName })

  // Subscribe BEFORE adding events
  const liveEventsStream = yield* service.tapEventStream({ agentName: agentName as AgentName })

  // Add events
  yield* service.addEvents({ agentName: agentName as AgentName, events })

  // Stream events until idle for 50ms
  // Simplified: emit all events, then wait 50ms after stream ends
  // TODO: Improve to reset timeout on each event (complete when 50ms passes without new events)
  const allEventsStream = Stream.concat(
    Stream.fromIterable(existingEvents),
    Stream.fromIterable(events),
    liveEventsStream
  )

  // Emit all events, then wait 50ms before completing
  // Simplified: emit all events, then wait 50ms after stream ends
  const sseStream = allEventsStream.pipe(
    Stream.concat(
      Stream.fromEffect(Effect.sleep(Duration.millis(50))).pipe(Stream.flatMap(() => Stream.empty<ContextEvent>()))
    ),
    Stream.map((event: ContextEvent) => encodeSSE(event))
  )

  return HttpServerResponse.stream(sseStream, {
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

  // Subscribe to live events FIRST to guarantee we don't miss any
  const liveEventsStream = yield* service.tapEventStream({ agentName: agentName as AgentName })

  // Get existing events (captured at subscription time)
  const existingEvents = yield* service.getEvents({ agentName: agentName as AgentName })
  const existingStream = Stream.fromIterable(existingEvents)

  // Stream terminates when SessionEndedEvent is received
  const sseStream = Stream.concat(existingStream, liveEventsStream).pipe(
    Stream.takeUntil((e: ContextEvent) => e._tag === "SessionEndedEvent"),
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
  const service = yield* AgentService
  const params = yield* HttpRouter.params

  const agentName = params.agentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("GET /agent/:agentName/state", { agentName })

  const reducedContext = yield* service.getState({ agentName: agentName as AgentName })
  const contextName = `${agentName}-v1` as const

  return yield* HttpServerResponse.json({
    agentName,
    contextName,
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
  HttpRouter.post("/agent/:agentName/events", addEventsAndStreamHandler),
  HttpRouter.get("/agent/:agentName/events", agentEventsHandler),
  HttpRouter.get("/agent/:agentName/state", agentStateHandler),
  HttpRouter.get("/health", healthHandler)
)
