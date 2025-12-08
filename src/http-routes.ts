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
import { Chunk, Effect, Fiber, Schema, Stream } from "effect"
import { AgentService } from "./agent-service.ts"
import { type AgentName, ContextEvent, makeBaseEventFields, UserMessageEvent } from "./domain.ts"
import { deriveContextMetadata } from "./cli/event-context.ts"

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

const AddEventsBody = Schema.Struct({
  events: Schema.Array(ContextEvent),
  streamUntilIdle: Schema.optional(Schema.Boolean)
})
type AddEventsBody = typeof AddEventsBody.Type

/** Parse JSON body into InputMessage */
const parseBody = (body: string) =>
  Effect.gen(function*() {
    const json = yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: (e) => new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
    })
    return yield* Schema.decodeUnknown(InputMessage)(json)
  })

const shouldStopTurn = (event: ContextEvent): boolean =>
  event._tag === "AgentTurnCompletedEvent" ||
  event._tag === "AgentTurnFailedEvent" ||
  event._tag === "AgentTurnInterruptedEvent"

const waitForIdleStable = (agentService: AgentService, agentName: AgentName, duration = 50) =>
  Effect.gen(function*() {
    while (true) {
      const idle = yield* agentService.isIdle({ agentName })
      if (idle) {
        yield* Effect.sleep(`${duration} millis`)
        const stillIdle = yield* agentService.isIdle({ agentName })
        if (stillIdle) {
          return
        }
      } else {
        yield* Effect.sleep("25 millis")
      }
    }
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
  // Get existing events to include initial session events
  const existingEvents = yield* agentService.getEvents({ agentName })
  const { contextName, nextEventNumber } = deriveContextMetadata(agentName, existingEvents)

  // Prepare user event
  const userEvent = new UserMessageEvent({
    ...makeBaseEventFields(agentName, contextName, nextEventNumber, true),
    content: message.content
  })

  // Subscribe BEFORE adding event to guarantee we catch all events
  // PubSub.subscribe guarantees subscription is established when this completes
  const liveEvents = yield* agentService.tapEventStream({ agentName })

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

  yield* agentService.addEvents({ agentName, events: [userEvent] })

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

  // Subscribe to live events FIRST to guarantee we don't miss any
  // PubSub.subscribe guarantees subscription is established when this completes
  const liveEvents = yield* agentService.tapEventStream({ agentName })

  // Get existing events (captured at subscription time)
  const existingEvents = yield* agentService.getEvents({ agentName })
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

/** Handler for GET /agent/:agentName/events/live - Subscribe to live-only stream */
const agentEventsLiveHandler = Effect.gen(function*() {
  const agentService = yield* AgentService
  const params = yield* HttpRouter.params

  const agentNameParam = params.agentName
  if (!agentNameParam) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }
  const agentName = agentNameParam as AgentName

  yield* Effect.logDebug("GET /agent/:agentName/events/live", { agentName })

  const liveEvents = yield* agentService.tapEventStream({ agentName })
  const sseStream = liveEvents.pipe(Stream.map(encodeSSE))

  return HttpServerResponse.stream(sseStream, {
    contentType: "text/event-stream",
    headers: {
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  })
})

/** Handler for GET /agent/:agentName/history - JSON snapshot of events */
const agentHistoryHandler = Effect.gen(function*() {
  const agentService = yield* AgentService
  const params = yield* HttpRouter.params

  const agentNameParam = params.agentName
  if (!agentNameParam) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }
  const agentName = agentNameParam as AgentName

  yield* Effect.logDebug("GET /agent/:agentName/history", { agentName })

  const events = yield* agentService.getEvents({ agentName })
  const encoded = events.map(encodeEvent)

  return yield* HttpServerResponse.json({
    agentName: agentNameParam,
    events: encoded
  })
})

/** Handler for POST /agent/:agentName/events - Add events, optional idle streaming */
const addEventsHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const agentService = yield* AgentService
  const params = yield* HttpRouter.params

  const agentNameParam = params.agentName
  if (!agentNameParam) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }
  const agentName = agentNameParam as AgentName

  const bodyText = yield* request.text
  if (bodyText.trim() === "") {
    return HttpServerResponse.text("Empty request body", { status: 400 })
  }

  const parsedJson = yield* Effect.try({
    try: () => JSON.parse(bodyText) as unknown,
    catch: (e) => new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }).pipe(Effect.either)

  if (parsedJson._tag === "Left") {
    return HttpServerResponse.text(parsedJson.left.message, { status: 400 })
  }

  const parsedBodyResult = yield* Schema.decodeUnknown(AddEventsBody)(parsedJson.right).pipe(Effect.either)
  if (parsedBodyResult._tag === "Left") {
    return HttpServerResponse.text("Invalid events payload", { status: 400 })
  }

  const { events, streamUntilIdle = false } = parsedBodyResult.right
  const triggersTurn = events.some((event) => event.triggersAgentTurn)

  yield* Effect.logDebug("POST /agent/:agentName/events", {
    agentName,
    eventCount: events.length,
    streamUntilIdle
  })

  let newEvents: Array<ContextEvent> = []

  if (streamUntilIdle && triggersTurn) {
    const liveEvents = yield* agentService.tapEventStream({ agentName })
    const eventFiber = yield* liveEvents.pipe(
      Stream.takeUntil(shouldStopTurn),
      Stream.runCollect,
      Effect.fork
    )

    yield* agentService.addEvents({ agentName, events })
    const collected = yield* Fiber.join(eventFiber).pipe(
      Effect.catchAll(() => Effect.succeed(Chunk.empty<ContextEvent>()))
    )
    newEvents = Chunk.toArray(collected)
    yield* waitForIdleStable(agentService, agentName)

    const sseStream = Stream.fromIterable([...events, ...newEvents]).pipe(
      Stream.map(encodeSSE)
    )

    return HttpServerResponse.stream(sseStream, {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    })
  }

  yield* agentService.addEvents({ agentName, events })

  if (streamUntilIdle && !triggersTurn) {
    const sseStream = Stream.fromIterable(events).pipe(Stream.map(encodeSSE))
    return HttpServerResponse.stream(sseStream, {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    })
  }

  return HttpServerResponse.json({ status: "ok" })
})

/** Handler for POST /agent/:agentName/end-session */
const endSessionHandler = Effect.gen(function*() {
  const agentService = yield* AgentService
  const params = yield* HttpRouter.params

  const agentNameParam = params.agentName
  if (!agentNameParam) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }
  const agentName = agentNameParam as AgentName

  yield* agentService.endSession({ agentName })
  return HttpServerResponse.json({ status: "ended" })
})

/** Handler for POST /agent/:agentName/interrupt */
const interruptHandler = Effect.gen(function*() {
  const agentService = yield* AgentService
  const params = yield* HttpRouter.params

  const agentNameParam = params.agentName
  if (!agentNameParam) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }
  const agentName = agentNameParam as AgentName

  yield* agentService.interruptTurn({ agentName })
  return HttpServerResponse.json({ status: "interrupted" })
})

/** Handler for GET /agent/:agentName/idle */
const idleStatusHandler = Effect.gen(function*() {
  const agentService = yield* AgentService
  const params = yield* HttpRouter.params

  const agentNameParam = params.agentName
  if (!agentNameParam) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }
  const agentName = agentNameParam as AgentName

  const idle = yield* agentService.isIdle({ agentName })
  return yield* HttpServerResponse.json({ agentName: agentNameParam, idle })
})

/** Handler for GET /agent/:agentName/state - Get reduced agent state */
const agentStateHandler = Effect.gen(function*() {
  const agentService = yield* AgentService
  const params = yield* HttpRouter.params

  const agentNameParam = params.agentName
  if (!agentNameParam) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }
  const agentName = agentNameParam as AgentName

  yield* Effect.logDebug("GET /agent/:agentName/state", { agentName })

  const reducedContext = yield* agentService.getState({ agentName })
  const events = yield* agentService.getEvents({ agentName })
  const { contextName } = deriveContextMetadata(agentName, events)

  return yield* HttpServerResponse.json({
    agentName: agentNameParam,
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
  HttpRouter.post("/agent/:agentName/events", addEventsHandler),
  HttpRouter.post("/agent/:agentName/end-session", endSessionHandler),
  HttpRouter.post("/agent/:agentName/interrupt", interruptHandler),
  HttpRouter.get("/agent/:agentName/events", agentEventsHandler),
  HttpRouter.get("/agent/:agentName/events/live", agentEventsLiveHandler),
  HttpRouter.get("/agent/:agentName/events/history", agentHistoryHandler),
  HttpRouter.get("/agent/:agentName/state", agentStateHandler),
  HttpRouter.get("/agent/:agentName/idle", idleStatusHandler),
  HttpRouter.get("/health", healthHandler)
)
