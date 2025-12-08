/**
 * HTTP Routes.
 *
 * Endpoints:
 * - POST /agent/:agentName - Add events + stream results (SSE)
 * - GET /agent/:agentName/events - Subscribe to event stream (SSE)
 * - GET /agent/:agentName/history - Fetch existing events
 * - GET /agent/:agentName/state - Derived state snapshot
 * - GET /health - Health check
 */

import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Duration, Effect, Fiber, Option, Queue, Ref, Schema, Stream } from "effect"
import { AgentEventInput, AgentService } from "./agent-service.ts"
import { EventReducer } from "./event-reducer.ts"
import { type AgentName, ContextEvent } from "./domain.ts"

const encodeEvent = Schema.encodeSync(ContextEvent)

/** Encode a ContextEvent as an SSE data line */
const encodeSSE = (event: ContextEvent): Uint8Array =>
  new TextEncoder().encode(`data: ${JSON.stringify(encodeEvent(event))}\n\n`)

const decodeEventInput = Schema.decodeUnknown(AgentEventInput)

const parseEventsPayload = (payload: unknown) =>
  Effect.gen(function*() {
    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        return yield* Effect.fail(new Error("events array must not be empty"))
      }
      return yield* Effect.all(payload.map((item) => decodeEventInput(item)))
    }

    if (
      payload &&
      typeof payload === "object" &&
      Array.isArray((payload as { events?: ReadonlyArray<unknown> }).events)
    ) {
      const events = (payload as { events: ReadonlyArray<unknown> }).events
      if (events.length === 0) {
        return yield* Effect.fail(new Error("events array must not be empty"))
      }
      return yield* Effect.all(events.map((item) => decodeEventInput(item)))
    }

    const single = yield* decodeEventInput(payload)
    return [single] as const
  })

const readEventsFromRequest = (body: string) =>
  Effect.gen(function*() {
    const json = yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: (error) => new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    })
    return yield* parseEventsPayload(json)
  })

const isTurnTerminal = (event: ContextEvent): boolean =>
  event._tag === "AgentTurnCompletedEvent" ||
  event._tag === "AgentTurnFailedEvent" ||
  event._tag === "AgentTurnInterruptedEvent"

/** Handler for POST /agent/:agentName */
const agentHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const service = yield* AgentService
  const params = yield* HttpRouter.params

  const agentNameText = params.agentName
  if (!agentNameText) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }
  const agentName = agentNameText as AgentName

  const rawBody = (yield* request.text).trim()
  if (rawBody === "") {
    return HttpServerResponse.text("Empty request body", { status: 400 })
  }

  const decodeResult = yield* readEventsFromRequest(rawBody).pipe(Effect.either)
  if (decodeResult._tag === "Left") {
    return HttpServerResponse.text(decodeResult.left.message, { status: 400 })
  }
  const events = decodeResult.right

  const url = new URL(request.url, "http://local.test")
  const waitParam = url.searchParams.get("waitForIdleMs")
  const waitForIdleMs = waitParam ? Number.parseInt(waitParam, 10) : NaN
  const idleDuration = Number.isFinite(waitForIdleMs) && waitForIdleMs > 0 ? Duration.millis(waitForIdleMs) : null

  const snapshot = yield* service.getEvents({ agentName })
  const queue = yield* Queue.unbounded<ContextEvent>()

  for (const event of snapshot.events) {
    yield* Queue.offer(queue, event)
  }

  const idleTimerRef = idleDuration ? yield* Ref.make(Option.none<Fiber.RuntimeFiber<void, never>>()) : null

  const shutdownQueue = Queue.shutdown(queue).pipe(Effect.catchAll(() => Effect.void))

  const cancelIdleTimer = idleTimerRef
    ? Effect.gen(function*() {
      const current = yield* Ref.getAndSet(idleTimerRef, Option.none())
      if (Option.isSome(current)) {
        yield* Fiber.interrupt(current.value).pipe(Effect.catchAll(() => Effect.void))
      }
    })
    : Effect.void

  const startIdleTimer = idleTimerRef && idleDuration
    ? Effect.gen(function*() {
      yield* cancelIdleTimer
      const fiber = yield* Effect.sleep(idleDuration).pipe(
        Effect.zipRight(shutdownQueue),
        Effect.forkScoped
      )
      yield* Ref.set(idleTimerRef, Option.some(fiber))
    })
    : Effect.void

  yield* Effect.addFinalizer(() =>
    Effect.gen(function*() {
      yield* cancelIdleTimer
      yield* shutdownQueue
    })
  )

  const liveStream = Stream.unwrapScoped(service.tapEventStream({ agentName }))

  yield* liveStream.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function*() {
        yield* Queue.offer(queue, event).pipe(Effect.catchAll(() => Effect.void))
        if (idleDuration) {
          if (event._tag === "AgentTurnStartedEvent") {
            yield* cancelIdleTimer
          }
          if (isTurnTerminal(event)) {
            yield* startIdleTimer
          }
        } else if (isTurnTerminal(event)) {
          yield* shutdownQueue
        }
            if (event._tag === "SessionEndedEvent") {
              yield* shutdownQueue
            }
      })
    ),
    Effect.forkScoped
  )

  yield* service.addEvents({ agentName, events })

  const sseStream = Stream.fromQueue(queue).pipe(
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
  const service = yield* AgentService
  const params = yield* HttpRouter.params

  const agentNameText = params.agentName
  if (!agentNameText) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }
  const agentName = agentNameText as AgentName

  const snapshot = yield* service.getEvents({ agentName })
  const queue = yield* Queue.unbounded<ContextEvent>()
  for (const event of snapshot.events) {
    yield* Queue.offer(queue, event)
  }

  const shutdownQueue = Queue.shutdown(queue).pipe(Effect.catchAll(() => Effect.void))

  const liveFiber = yield* Effect.scoped(
    Effect.gen(function*() {
      const liveStream = yield* service.tapEventStream({ agentName })
      return yield* liveStream.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function*() {
            yield* Queue.offer(queue, event).pipe(Effect.catchAll(() => Effect.void))
            if (event._tag === "SessionEndedEvent") {
              yield* shutdownQueue
            }
          })
        ),
        Effect.forkScoped
      )
    })
  )

  yield* Effect.addFinalizer(() =>
    Effect.gen(function*() {
      yield* Fiber.interrupt(liveFiber).pipe(Effect.catchAll(() => Effect.void))
      yield* shutdownQueue
    })
  )

  const sseStream = Stream.fromQueue(queue).pipe(
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

/** Handler for GET /agent/:agentName/history */
const agentHistoryHandler = Effect.gen(function*() {
  const service = yield* AgentService
  const params = yield* HttpRouter.params

  const agentNameText = params.agentName
  if (!agentNameText) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }
  const agentName = agentNameText as AgentName

  const snapshot = yield* service.getEvents({ agentName })
  const encodedEvents = snapshot.events.map((event) => encodeEvent(event))

  return yield* HttpServerResponse.json({
    agentName: snapshot.agentName,
    contextName: snapshot.contextName,
    events: encodedEvents
  })
})

/** Handler for GET /agent/:agentName/state - Derived reduced state */
const agentStateHandler = Effect.gen(function*() {
  const service = yield* AgentService
  const reducer = yield* EventReducer
  const params = yield* HttpRouter.params

  const agentNameText = params.agentName
  if (!agentNameText) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }
  const agentName = agentNameText as AgentName

  const snapshot = yield* service.getEvents({ agentName })
  const state = yield* reducer.reduce(reducer.initialReducedContext, snapshot.events)

  return yield* HttpServerResponse.json({
    agentName: snapshot.agentName,
    contextName: snapshot.contextName,
    nextEventNumber: state.nextEventNumber,
    currentTurnNumber: state.currentTurnNumber,
    messageCount: state.messages.length,
    hasLlmConfig: state.llmConfig._tag === "Some",
    isAgentTurnInProgress: state.agentTurnStartedAtEventId._tag === "Some"
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
  HttpRouter.post("/agent/:agentName/events", agentHandler),
  HttpRouter.get("/agent/:agentName/events", agentEventsHandler),
  HttpRouter.get("/agent/:agentName/history", agentHistoryHandler),
  HttpRouter.get("/agent/:agentName/state", agentStateHandler),
  HttpRouter.get("/health", healthHandler)
)
