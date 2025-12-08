/**
 * HTTP Routes.
 *
 * Endpoints:
 * - POST /agent/:agentName - Send message, receive SSE stream of events
 * - GET /agent/:agentName/events - Subscribe to agent events (SSE)
 * - GET /agent/:agentName/state - Get reduced agent state
 * - GET /health - Health check
 */

import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Schema, Stream } from "effect"
import { contextNameFromAgent } from "./agent-registry.ts"
import { AgentService } from "./agent-service.ts"
import { type AgentName, ContextEvent, makeBaseEventFields, UserMessageEvent } from "./domain.ts"
import { EventReducer } from "./event-reducer.ts"

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
  const agentService = yield* AgentService
  const params = yield* HttpRouter.params

  const agentNameParam = params.agentName
  if (!agentNameParam) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  const agentName = agentNameParam as AgentName
  const url = new URL(request.url, "http://localhost")
  const streamUntilIdle = url.searchParams.get("streamUntilIdle") === "true"

  yield* Effect.logDebug("POST /agent/:agentName", { agentName, streamUntilIdle })

  const body = yield* request.text

  if (body.trim() === "") {
    return HttpServerResponse.text("Empty request body", { status: 400 })
  }

  const parseResult = yield* parseBody(body).pipe(Effect.either)

  if (parseResult._tag === "Left") {
    return HttpServerResponse.text(parseResult.left.message, { status: 400 })
  }

  const message = parseResult.right
  const existingEvents = yield* agentService.getEvents({ agentName })
  const contextName = contextNameFromAgent(agentName)
  const nextEventNumber = existingEvents.length

  const userEvent = new UserMessageEvent({
    ...makeBaseEventFields(agentName, contextName, nextEventNumber, true),
    content: message.content
  })

  const completionPredicate = (event: ContextEvent): boolean =>
    event._tag === "AgentTurnCompletedEvent" ||
    event._tag === "AgentTurnFailedEvent" ||
    event._tag === "AgentTurnInterruptedEvent"

  const liveStream: Stream.Stream<ContextEvent, never, never> = Stream.unwrapScoped(
    Effect.gen(function*() {
      const stream = yield* agentService.tapEventStream({ agentName })
      yield* agentService.addEvents({ agentName, events: [userEvent] })
      return stream
    })
  )

  let streamedEvents = liveStream.pipe(Stream.takeUntil(completionPredicate))
  if (streamUntilIdle) {
    streamedEvents = streamedEvents.pipe(
      Stream.concat(Stream.fromEffect(Effect.sleep("50 millis")).pipe(Stream.drain))
    )
  }

  const sseStream = Stream.concat(Stream.fromIterable(existingEvents), streamedEvents).pipe(
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

/** Handler for GET /agent/:agentName/events - Subscribe to agent event stream */
const agentEventsHandler = Effect.gen(function*() {
  const agentService = yield* AgentService
  const params = yield* HttpRouter.params

  const agentNameParam = params.agentName
  if (!agentNameParam) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  const agentName = agentNameParam as AgentName

  yield* Effect.logDebug("GET /agent/:agentName/events", { agentName })

  const liveStream: Stream.Stream<ContextEvent, never, never> = Stream.unwrapScoped(
    agentService.tapEventStream({ agentName })
  )
  const existingEvents = yield* agentService.getEvents({ agentName })
  const sseStream = Stream.concat(Stream.fromIterable(existingEvents), liveStream).pipe(
    Stream.takeUntil((event) => event._tag === "SessionEndedEvent"),
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
  const agentService = yield* AgentService
  const reducer = yield* EventReducer
  const params = yield* HttpRouter.params

  const agentNameParam = params.agentName
  if (!agentNameParam) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  const agentName = agentNameParam as AgentName

  yield* Effect.logDebug("GET /agent/:agentName/state", { agentName })

  const events = yield* agentService.getEvents({ agentName })
  const reducedContext = yield* reducer.reduce(reducer.initialReducedContext, events)

  return yield* HttpServerResponse.json({
    agentName,
    contextName: contextNameFromAgent(agentName),
    nextEventNumber: reducedContext.nextEventNumber,
    currentTurnNumber: reducedContext.currentTurnNumber,
    messageCount: reducedContext.messages.length,
    hasLlmConfig: reducedContext.llmConfig._tag === "Some",
    isAgentTurnInProgress: reducedContext.agentTurnStartedAtEventId._tag === "Some"
  })
})

const snapshotHandler = Effect.gen(function*() {
  const agentService = yield* AgentService
  const params = yield* HttpRouter.params

  const agentNameParam = params.agentName
  if (!agentNameParam) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  const agentName = agentNameParam as AgentName
  const events = yield* agentService.getEvents({ agentName })
  const encoded = events.map((event) => encodeEvent(event))

  return yield* HttpServerResponse.json({ events: encoded })
})

const addEventsHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const agentService = yield* AgentService
  const params = yield* HttpRouter.params

  const agentNameParam = params.agentName
  if (!agentNameParam) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  const agentName = agentNameParam as AgentName
  const body = yield* request.text

  if (body.trim() === "") {
    return HttpServerResponse.text("Empty request body", { status: 400 })
  }

  const parsed = yield* Effect.try({
    try: () => JSON.parse(body) as unknown,
    catch: (error) => new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  })

  const eventsPayload = Array.isArray(parsed)
    ? parsed
    : (parsed as { events?: Array<unknown> }).events

  if (!eventsPayload) {
    return HttpServerResponse.text("Missing events array", { status: 400 })
  }

  const decodedEvents = yield* Effect.forEach(eventsPayload, (value) => Schema.decodeUnknown(ContextEvent)(value)).pipe(
    Effect.orDie
  )

  yield* agentService.addEvents({ agentName, events: decodedEvents })
  return yield* HttpServerResponse.json({ status: "ok" })
})

/** Health check endpoint */
const healthHandler = Effect.gen(function*() {
  yield* Effect.logDebug("GET /health")
  return yield* HttpServerResponse.json({ status: "ok" })
})

/** HTTP router */
export const makeRouter = HttpRouter.empty.pipe(
  HttpRouter.post("/agent/:agentName", agentHandler),
  HttpRouter.post("/agent/:agentName/events", addEventsHandler),
  HttpRouter.get("/agent/:agentName/events", agentEventsHandler),
  HttpRouter.get("/agent/:agentName/log", snapshotHandler),
  HttpRouter.get("/agent/:agentName/state", agentStateHandler),
  HttpRouter.get("/health", healthHandler)
)
