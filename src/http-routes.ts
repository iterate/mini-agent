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

  const ctx = yield* agent.getReducedContext

  // Prepare user event
  const userEvent = new UserMessageEvent({
    ...makeBaseEventFields(agentName as AgentName, agent.contextName, ctx.nextEventNumber, true),
    content: message.content
  })

  // Add the user event to trigger the LLM turn (before creating stream to ensure subscription catches all events)
  const eventFiber = yield* agent.events.pipe(
    Stream.takeUntil((e) => e._tag === "AgentTurnCompletedEvent" || e._tag === "AgentTurnFailedEvent"),
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

/** Handler for GET /agent/:agentName/events - Subscribe to agent event stream */
const agentEventsHandler = Effect.gen(function*() {
  const registry = yield* AgentRegistry
  const params = yield* HttpRouter.params

  const agentName = params.agentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("GET /agent/:agentName/events", { agentName })

  const agent = yield* registry.getOrCreate(agentName as AgentName)

  // Get existing events first, then stream new ones
  const existingEvents = yield* agent.getEvents
  const existingStream = Stream.fromIterable(existingEvents)

  // Stream terminates when SessionEndedEvent is received (mailbox closes)
  const sseStream = Stream.concat(existingStream, agent.events).pipe(
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

/** HTTP router */
export const makeRouter = HttpRouter.empty.pipe(
  HttpRouter.post("/agent/:agentName", agentHandler),
  HttpRouter.get("/agent/:agentName/events", agentEventsHandler),
  HttpRouter.get("/agent/:agentName/state", agentStateHandler),
  HttpRouter.get("/health", healthHandler)
)
