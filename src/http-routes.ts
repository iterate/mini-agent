/** Handler for GET /agent/:agentName/events/history - Fetch all events as JSON */
const agentEventsHistoryHandler = Effect.gen(function*() {
  const params = yield* HttpRouter.params
  const service = yield* AgentEvents

  const agentNameParam = params.agentName
  if (!agentNameParam) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }
  const agentName = agentNameParam as AgentName

  yield* Effect.logDebug("GET /agent/:agentName/events/history", { agentName })

  const events = yield* service.getEvents({ agentName })
  const payload = events.map((event) => encodeEvent(event))
  return HttpServerResponse.json(payload)
})
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
import { Chunk, Deferred, Effect, Fiber, Option, Ref, Schema, Stream } from "effect"
import { AgentEventInput, AgentEvents } from "./agent-events.ts"
import { type AgentName, ContextEvent } from "./domain.ts"
import { EventReducer } from "./event-reducer.ts"

const encodeEvent = Schema.encodeSync(ContextEvent)

/** Encode a ContextEvent as an SSE data line */
const encodeSSE = (event: ContextEvent): Uint8Array =>
  new TextEncoder().encode(`data: ${JSON.stringify(encodeEvent(event))}\n\n`)

const isTurnTerminalEvent = (event: ContextEvent): boolean =>
  event._tag === "AgentTurnCompletedEvent" ||
  event._tag === "AgentTurnFailedEvent" ||
  event._tag === "AgentTurnInterruptedEvent"

const sseResponseOptions = {
  contentType: "text/event-stream",
  headers: {
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  }
} as const

const needsSessionEnd = (command: AgentEventInput): boolean => command._tag === "EndSession"

const needsTurnCompletion = (command: AgentEventInput): boolean =>
  command._tag === "UserMessage" ||
  command._tag === "UserMessageEvent" ||
  command._tag === "InterruptTurn"

const decodeCommand = Schema.decodeUnknown(AgentEventInput)
const decodeCommandList = Schema.decodeUnknown(Schema.Array(AgentEventInput))

/** Parse JSON body into AgentEventInput[] */
const parseBody = (body: string) =>
  Effect.gen(function*() {
    const json = yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: (e) => new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
    })
    if (Array.isArray(json)) {
      return yield* decodeCommandList(json)
    }
    const command = yield* decodeCommand(json)
    return [command]
  })

const collectCommandResponse = (
  service: AgentEvents,
  agentName: AgentName,
  commands: ReadonlyArray<AgentEventInput>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const existingEvents = yield* service.getEvents({ agentName })
      const awaitSessionEnd = commands.some(needsSessionEnd)
      const awaitTurnCompletion = commands.some(needsTurnCompletion) || (!awaitSessionEnd && commands.length > 0)
      const liveStream = yield* service.tapEventStream({ agentName })

      const collectorFiber = yield* liveStream.pipe(
        Stream.takeUntil((event: ContextEvent) => {
          if (awaitSessionEnd && event._tag === "SessionEndedEvent") {
            return true
          }
          if (awaitTurnCompletion && isTurnTerminalEvent(event)) {
            return true
          }
          return false
        }),
        Stream.runCollect,
        Effect.fork
      )

      yield* service.addEvents({ agentName, events: commands })

      const collected = yield* Effect.race(
        Fiber.join(collectorFiber).pipe(
          Effect.catchAll(() => Effect.succeed(Chunk.empty<ContextEvent>())),
          Effect.map((chunk) => Option.some(chunk))
        ),
        Effect.sleep("120 seconds").pipe(
          Effect.as(Option.none<Chunk.Chunk<ContextEvent>>())
        )
      )

      if (Option.isNone(collected)) {
        yield* Fiber.interrupt(collectorFiber)
        return HttpServerResponse.text("Timed out waiting for agent events", { status: 504 })
      }

      const newEvents = Chunk.toArray(collected.value)
      const sseStream = Stream.fromIterable([...existingEvents, ...newEvents]).pipe(
        Stream.map(encodeSSE)
      )

      return yield* HttpServerResponse.stream(sseStream, sseResponseOptions).pipe(Effect.orDie)
    })
  )

const streamCommandsUntilIdle = (
  service: AgentEvents,
  agentName: AgentName,
  commands: ReadonlyArray<AgentEventInput>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const existingEvents = yield* service.getEvents({ agentName })
      const idleDeferred = yield* Deferred.make<void>()
      const lastTerminalRef = yield* Ref.make<Option.Option<number>>(Option.none())
      const liveStream = yield* service.tapEventStream({ agentName })

      const markIdleCandidate = (event: ContextEvent) =>
        Effect.gen(function*() {
          if (event._tag === "SessionEndedEvent") {
            yield* Deferred.succeed(idleDeferred, void 0).pipe(Effect.catchAll(() => Effect.void))
            return
          }
          if (event._tag === "AgentTurnStartedEvent") {
            yield* Ref.set(lastTerminalRef, Option.none())
            return
          }
          if (isTurnTerminalEvent(event)) {
            const stamp = Date.now()
            yield* Ref.set(lastTerminalRef, Option.some(stamp))
            yield* Effect.sleep("50 millis").pipe(
              Effect.flatMap(() =>
                Ref.get(lastTerminalRef).pipe(
                  Effect.flatMap((current) =>
                    Option.isSome(current) && current.value === stamp
                      ? Deferred.succeed(idleDeferred, void 0)
                      : Effect.void
                  )
                )
              ),
              Effect.catchAll(() => Effect.void),
              Effect.forkScoped
            )
          }
        })

      yield* service.addEvents({ agentName, events: commands })

      const terminationEffect = Effect.race(
        Deferred.await(idleDeferred),
        Effect.sleep("2 minutes")
      )

      const sseStream = Stream.concat(Stream.fromIterable(existingEvents), liveStream).pipe(
        Stream.tap((event: ContextEvent) => markIdleCandidate(event)),
        Stream.map(encodeSSE),
        Stream.interruptWhen(terminationEffect)
      )

      return yield* HttpServerResponse.stream(sseStream, sseResponseOptions).pipe(Effect.orDie)
    })
  )

/** Handler for POST /agent/:agentName */
const agentHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const params = yield* HttpRouter.params
  const service = yield* AgentEvents

  const agentNameParam = params.agentName
  if (!agentNameParam) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }
  const agentName = agentNameParam as AgentName

  yield* Effect.logDebug("POST /agent/:agentName", { agentName })

  const url = new URL(request.url, "http://localhost")
  const streamUntilIdle = url.searchParams.get("streamUntilIdle") === "true"

  const body = yield* request.text
  if (body.trim() === "") {
    return HttpServerResponse.text("Empty request body", { status: 400 })
  }

  const parseResult = yield* parseBody(body).pipe(Effect.either)
  if (parseResult._tag === "Left") {
    return HttpServerResponse.text(parseResult.left.message, { status: 400 })
  }

  const commands = parseResult.right
  if (commands.length === 0) {
    return HttpServerResponse.text("At least one command is required", { status: 400 })
  }

  if (streamUntilIdle) {
    return yield* streamCommandsUntilIdle(service, agentName, commands)
  }

  return yield* collectCommandResponse(service, agentName, commands)
})

/** Handler for GET /agent/:agentName/events - Subscribe to agent event stream */
const agentEventsHandler = Effect.gen(function*() {
  const params = yield* HttpRouter.params
  const service = yield* AgentEvents

  const agentNameParam = params.agentName
  if (!agentNameParam) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }
  const agentName = agentNameParam as AgentName

  yield* Effect.logDebug("GET /agent/:agentName/events", { agentName })

  return yield* Effect.scoped(
    Effect.gen(function*() {
      const liveEvents = yield* service.tapEventStream({ agentName })
      const existingEvents = yield* service.getEvents({ agentName })
      const sseStream = Stream.concat(Stream.fromIterable(existingEvents), liveEvents).pipe(
        Stream.takeUntil((e) => e._tag === "SessionEndedEvent"),
        Stream.map(encodeSSE)
      )
      return HttpServerResponse.stream(sseStream, sseResponseOptions)
    })
  )
})

/** Handler for GET /agent/:agentName/state - Get reduced agent state */
const agentStateHandler = Effect.gen(function*() {
  const params = yield* HttpRouter.params
  const reducer = yield* EventReducer
  const service = yield* AgentEvents

  const agentName = params.agentName
  if (!agentName) {
    return HttpServerResponse.text("Missing agentName", { status: 400 })
  }

  yield* Effect.logDebug("GET /agent/:agentName/state", { agentName })

  const events = yield* service.getEvents({ agentName: agentName as AgentName })
  const reducedContext = events.length === 0
    ? reducer.initialReducedContext
    : yield* reducer.reduce(reducer.initialReducedContext, events)

  return yield* HttpServerResponse.json({
    agentName,
    contextName: `${agentName}-v1`,
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
  HttpRouter.get("/agent/:agentName/events/history", agentEventsHistoryHandler),
  HttpRouter.get("/agent/:agentName/state", agentStateHandler),
  HttpRouter.get("/health", healthHandler)
)
