/**
 * HTTP Server for Agent
 *
 * Endpoints:
 * - POST /agent/:agentName - Send message, receive SSE stream of events
 * - GET /health - Health check
 */

import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Fiber, Runtime, Schema, Stream } from "effect"
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

  // Capture the runtime to use in the Stream.async callback
  const runtime = yield* Effect.runtime<AgentRegistry>()

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

  // Create SSE stream using the captured runtime
  const sseStream = makeSseStream(runtime, agent, userEvent)

  return HttpServerResponse.stream(sseStream, {
    contentType: "text/event-stream",
    headers: {
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  })
})

/** Create SSE stream that emits events until turn completes */
const makeSseStream = (
  runtime: Runtime.Runtime<AgentRegistry>,
  agent: {
    events: Stream.Stream<ContextEvent, never>
    addEvent: (e: ContextEvent) => Effect.Effect<void, unknown>
  },
  userEvent: ContextEvent
): Stream.Stream<Uint8Array, never> =>
  Stream.async<Uint8Array, never>((emit) => {
    // Create the effect that will:
    // 1. Subscribe to events
    // 2. Add user event (triggering LLM turn)
    // 3. Stream events until turn completes
    const runStream = Effect.gen(function*() {
      // Fork the event subscription first - it will receive all events including userEvent
      const streamFiber = yield* agent.events.pipe(
        Stream.takeUntil((e) => e._tag === "AgentTurnCompletedEvent" || e._tag === "AgentTurnFailedEvent"),
        Stream.tap((e) =>
          Effect.sync(() => {
            emit.single(encodeSSE(e))
          })
        ),
        Stream.runDrain,
        Effect.fork
      )

      // Small delay to ensure the subscription fiber is actually consuming
      yield* Effect.sleep("10 millis")

      // Add user event to agent (it will be broadcast to the subscriber)
      yield* agent.addEvent(userEvent)

      // Wait for stream to complete
      yield* Fiber.join(streamFiber)
      emit.end()
    })

    // Run with the captured runtime
    Runtime.runFork(runtime)(runStream)
  })

/** Health check endpoint */
const healthHandler = Effect.gen(function*() {
  yield* Effect.logDebug("GET /health")
  return yield* HttpServerResponse.json({ status: "ok" })
})

/** HTTP router */
export const makeRouter = HttpRouter.empty.pipe(
  HttpRouter.post("/agent/:agentName", agentHandler),
  HttpRouter.get("/health", healthHandler)
)
