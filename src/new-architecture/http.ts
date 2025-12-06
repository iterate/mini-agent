/**
 * HTTP Server for new architecture.
 *
 * Endpoints:
 * - POST /agent/:agentName - Send message, receive SSE stream of events
 * - GET /health - Health check
 */

import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Schema, Stream } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import { type AgentName, type ContextEvent, EventBuilder } from "./domain.ts"

/** Encode a ContextEvent as an SSE data line */
const encodeSSE = (event: ContextEvent): Uint8Array => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)

/** Input message schema */
const InputMessage = Schema.Struct({
  _tag: Schema.Literal("UserMessage"),
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
  const ctx = yield* agent.getReducedContext

  // Prepare user event
  const userEvent = EventBuilder.userMessage(
    agentName as AgentName,
    agent.contextName,
    ctx.nextEventNumber,
    message.content
  )

  // Create an SSE stream that:
  // 1. First emits the user event (so client sees it immediately)
  // 2. Adds the event to the agent (which triggers the LLM turn)
  // 3. Then streams all subsequent events until turn completes
  const sseStream = Stream.concat(
    // Emit user event immediately to client, then add it to agent
    Stream.fromEffect(
      agent.addEvent(userEvent).pipe(
        Effect.as(encodeSSE(userEvent)),
        Effect.catchAll(() => Effect.succeed(encodeSSE(userEvent)))
      )
    ),
    // Stream remaining events (the broadcast will include events after UserMessage)
    agent.events.pipe(
      Stream.takeUntil((e) => e._tag === "AgentTurnCompletedEvent" || e._tag === "AgentTurnFailedEvent"),
      Stream.map(encodeSSE)
    )
  )

  return HttpServerResponse.stream(sseStream, {
    contentType: "text/event-stream",
    headers: {
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  })
})

/** Health check endpoint */
const healthHandler = Effect.gen(function*() {
  yield* Effect.logDebug("GET /health")
  return yield* HttpServerResponse.json({ status: "ok" })
})

/** HTTP router for new architecture */
export const makeRouterV2 = HttpRouter.empty.pipe(
  HttpRouter.post("/agent/:agentName", agentHandler),
  HttpRouter.get("/health", healthHandler)
)
