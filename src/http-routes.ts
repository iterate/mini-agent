/**
 * HTTP Routes.
 *
 * Endpoints:
 * - POST /agent/:agentName - Send message, receive SSE stream of events
 * - POST /agent/:agentName/stream - Add events and stream until idle (configurable timeout)
 * - GET /agent/:agentName/events - Subscribe to agent events (SSE)
 * - GET /agent/:agentName/state - Get reduced agent state
 * - POST /agent/:agentName/end - End session gracefully
 * - POST /agent/:agentName/interrupt - Interrupt current turn
 * - GET /health - Health check
 */

import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Chunk, Duration, Effect, Fiber, Schema, Stream } from "effect"
import { AgentService } from "./agent-service.ts"
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

/** Parse JSON body into InputMessage */
const parseBody = (body: string) =>
  Effect.gen(function*() {
    const json = yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: (e) => new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
    })
    return yield* Schema.decodeUnknown(InputMessage)(json)
  })

/** Input for addAndStream endpoint */
const AddAndStreamInput = Schema.Struct({
  events: Schema.Array(ContextEvent),
  idleTimeoutMs: Schema.optional(Schema.Number)
})

/** Handler for POST /agent/:agentName - Legacy endpoint for single message */
const agentHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const service = yield* AgentService
  const params = yield* HttpRouter.params

  const agentName = params.agentName as AgentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("POST /agent/:agentName", { agentName })

  const body = yield* request.text

  if (body.trim() === "") {
    return HttpServerResponse.text("Empty request body", { status: 400 })
  }

  const parseResult = yield* parseBody(body).pipe(Effect.either)

  if (parseResult._tag === "Left") {
    return HttpServerResponse.text(parseResult.left.message, { status: 400 })
  }

  const message = parseResult.right

  // Get existing events for context
  const existingEvents = yield* service.getEvents({ agentName })
  const state = yield* service.getState({ agentName })

  // Create user event
  const userEvent = new UserMessageEvent({
    ...makeBaseEventFields(
      agentName,
      `${agentName}-v1` as any,
      state.nextEventNumber,
      true
    ),
    content: message.content
  })

  // Subscribe before adding event to guarantee we catch all events
  const liveEvents = yield* service.tapEventStream({ agentName })

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

  yield* service.addEvents({ agentName, events: [userEvent] })

  // Wait for turn to complete
  const newEventsChunk = yield* Fiber.join(eventFiber).pipe(
    Effect.catchAll(() => Effect.succeed(Chunk.empty<ContextEvent>()))
  )
  const newEvents = Chunk.toArray(newEventsChunk)

  // Build SSE stream: existing events + user event + new events
  const allEvents: Array<ContextEvent> = [...existingEvents, userEvent, ...newEvents]
  const sseStream = Stream.fromIterable(allEvents).pipe(Stream.map(encodeSSE))

  return HttpServerResponse.stream(sseStream, {
    contentType: "text/event-stream",
    headers: {
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  })
})

/** Handler for POST /agent/:agentName/stream - Add events and stream until idle */
const agentStreamHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const service = yield* AgentService
  const params = yield* HttpRouter.params

  const agentName = params.agentName as AgentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("POST /agent/:agentName/stream", { agentName })

  const body = yield* request.text

  if (body.trim() === "") {
    return HttpServerResponse.text("Empty request body", { status: 400 })
  }

  const parseResult = yield* Effect.try({
    try: () => JSON.parse(body) as unknown,
    catch: (e) => new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }).pipe(
    Effect.flatMap((json) => Schema.decodeUnknown(AddAndStreamInput)(json)),
    Effect.either
  )

  if (parseResult._tag === "Left") {
    return HttpServerResponse.text(`Invalid request: ${parseResult.left}`, { status: 400 })
  }

  const { events, idleTimeoutMs = 50 } = parseResult.right

  // Get existing events for context
  const existingEvents = yield* service.getEvents({ agentName })

  // Subscribe before adding events
  const liveEvents = yield* service.tapEventStream({ agentName })

  // Fork collection with idle timeout
  const eventFiber = yield* liveEvents.pipe(
    Stream.tap(() => Effect.void),
    Stream.concat(
      Stream.fromEffect(
        Effect.gen(function*() {
          // Wait for idle
          while (true) {
            const isIdle = yield* service.isIdle({ agentName })
            if (isIdle) break
            yield* Effect.sleep(Duration.millis(10))
          }
          // Wait for idle timeout
          yield* Effect.sleep(Duration.millis(idleTimeoutMs))
        }).pipe(Effect.as(undefined))
      ).pipe(Stream.drain)
    ),
    Stream.takeUntil((e) => e._tag === "SessionEndedEvent"),
    Stream.timeout(Duration.seconds(120)), // Max timeout
    Stream.runCollect,
    Effect.fork
  )

  // Add events
  if (events.length > 0) {
    yield* service.addEvents({ agentName, events })
  }

  // Wait for collection
  const newEventsChunk = yield* Fiber.join(eventFiber).pipe(
    Effect.catchAll(() => Effect.succeed(Chunk.empty<ContextEvent>()))
  )
  const newEvents = Chunk.toArray(newEventsChunk)

  // Build SSE stream: existing events + new events
  const allEvents: Array<ContextEvent> = [...existingEvents, ...newEvents]
  const sseStream = Stream.fromIterable(allEvents).pipe(Stream.map(encodeSSE))

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

  const agentName = params.agentName as AgentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("GET /agent/:agentName/events", { agentName })

  // Get existing events
  const existingEvents = yield* service.getEvents({ agentName })
  const existingStream = Stream.fromIterable(existingEvents)

  // Subscribe to live events
  const liveEvents = yield* service.tapEventStream({ agentName })

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
  const service = yield* AgentService
  const params = yield* HttpRouter.params

  const agentName = params.agentName as AgentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("GET /agent/:agentName/state", { agentName })

  const state = yield* service.getState({ agentName })

  return yield* HttpServerResponse.json({
    agentName,
    contextName: `${agentName}-v1`,
    nextEventNumber: state.nextEventNumber,
    currentTurnNumber: state.currentTurnNumber,
    messageCount: state.messages.length,
    hasLlmConfig: state.llmConfig._tag === "Some",
    isAgentTurnInProgress: state.agentTurnStartedAtEventId._tag === "Some"
  })
})

/** Handler for POST /agent/:agentName/end - End session gracefully */
const agentEndHandler = Effect.gen(function*() {
  const service = yield* AgentService
  const params = yield* HttpRouter.params

  const agentName = params.agentName as AgentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("POST /agent/:agentName/end", { agentName })

  yield* service.endSession({ agentName })

  return HttpServerResponse.empty({ status: 200 })
})

/** Handler for POST /agent/:agentName/interrupt - Interrupt current turn */
const agentInterruptHandler = Effect.gen(function*() {
  const service = yield* AgentService
  const params = yield* HttpRouter.params

  const agentName = params.agentName as AgentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("POST /agent/:agentName/interrupt", { agentName })

  yield* service.interruptTurn({ agentName })

  return HttpServerResponse.empty({ status: 200 })
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
  HttpRouter.post("/agent/:agentName/end", agentEndHandler),
  HttpRouter.post("/agent/:agentName/interrupt", agentInterruptHandler),
  HttpRouter.get("/health", healthHandler)
)
