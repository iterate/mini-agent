/**
 * RemoteAgentService - HTTP client implementation of AgentService.
 *
 * Connects to a remote mini-agent HTTP server. Enables TUI to connect to
 * a running server elsewhere.
 */

import { HttpClient, type HttpClientError, HttpClientRequest } from "@effect/platform"
import { Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import { AgentService } from "./agent-service.ts"
import { type AgentName, type AgentTurnNumber, ContextEvent, type EventId, type ReducedContext } from "./domain.ts"

/** Configuration for remote agent service */
export interface RemoteAgentServiceConfig {
  readonly baseUrl: string
}

/** Create a RemoteAgentService layer with the given configuration */
export const makeRemoteAgentServiceLive = (
  config: RemoteAgentServiceConfig
): Layer.Layer<AgentService, never, HttpClient.HttpClient> =>
  Layer.effect(
    AgentService,
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const { baseUrl } = config

      /** Parse SSE stream from response body */
      const parseSSEStream = (body: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>) =>
        body.pipe(
          Stream.decodeText(),
          Stream.mapConcat((chunk) => chunk.split("\n")),
          Stream.filter((line) => line.startsWith("data: ")),
          Stream.map((line) => line.slice(6)),
          Stream.mapEffect((json) =>
            Schema.decodeUnknown(ContextEvent)(JSON.parse(json)).pipe(
              Effect.catchAll(() => Effect.succeed(null))
            )
          ),
          Stream.filter((event): event is ContextEvent => event !== null)
        )

      const addEvents = (agentName: AgentName, events: ReadonlyArray<ContextEvent>) =>
        Effect.gen(function*() {
          // For remote service, we POST each event to the server
          for (const event of events) {
            yield* HttpClientRequest.post(`${baseUrl}/agent/${agentName}/stream`).pipe(
              HttpClientRequest.bodyJson({ _tag: event._tag, content: (event as { content?: string }).content }),
              Effect.flatMap((req) => client.execute(req)),
              Effect.scoped,
              // Ignore response for fire-and-forget semantics
              Effect.catchAll(() => Effect.void)
            )
          }
        })

      const tapEventStream = (agentName: AgentName) =>
        Effect.gen(function*() {
          // GET /agent/:agentName/events returns SSE stream
          const response = yield* HttpClientRequest.get(`${baseUrl}/agent/${agentName}/events`).pipe(
            (req) => client.execute(req)
          )
          return parseSSEStream(response.stream).pipe(
            Stream.catchAll(() => Stream.empty)
          )
        })

      const getEvents = (agentName: AgentName) =>
        Effect.gen(function*() {
          // Subscribe and collect all existing events
          const response = yield* HttpClientRequest.get(`${baseUrl}/agent/${agentName}/events`).pipe(
            (req) => client.execute(req)
          )

          const events: Array<ContextEvent> = []
          const queue = yield* Queue.unbounded<ContextEvent>()

          // Start consuming stream in background
          yield* parseSSEStream(response.stream).pipe(
            Stream.tap((e) => Queue.offer(queue, e)),
            Stream.runDrain,
            Effect.fork
          )

          // Collect events until timeout
          yield* Effect.iterate(0, {
            while: (count) => count < 1000,
            body: () =>
              Queue.take(queue).pipe(
                Effect.timeoutOption("100 millis"),
                Effect.flatMap((maybeEvent) => {
                  if (Option.isNone(maybeEvent)) {
                    return Effect.fail("timeout" as const)
                  }
                  events.push(maybeEvent.value)
                  return Effect.succeed(events.length)
                })
              )
          }).pipe(Effect.catchAll(() => Effect.void))

          return events as ReadonlyArray<ContextEvent>
        }).pipe(Effect.scoped, Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<ContextEvent>)))

      const getState = (agentName: AgentName) =>
        Effect.gen(function*() {
          const response = yield* HttpClientRequest.get(`${baseUrl}/agent/${agentName}/state`).pipe(
            (req) => client.execute(req),
            Effect.flatMap((r) => r.json)
          )

          // Server returns simplified state, we reconstruct what we can
          const state = response as {
            nextEventNumber: number
            currentTurnNumber: number
            messageCount: number
            hasLlmConfig: boolean
            isAgentTurnInProgress: boolean
          }

          // Return a minimal ReducedContext
          return {
            messages: [],
            llmConfig: Option.none(),
            nextEventNumber: state.nextEventNumber,
            currentTurnNumber: state.currentTurnNumber as AgentTurnNumber,
            agentTurnStartedAtEventId: state.isAgentTurnInProgress
              ? Option.some("" as EventId)
              : Option.none()
          } as ReducedContext
        }).pipe(
          Effect.scoped,
          Effect.catchAll(() =>
            Effect.succeed({
              messages: [],
              llmConfig: Option.none(),
              nextEventNumber: 0,
              currentTurnNumber: 0 as AgentTurnNumber,
              agentTurnStartedAtEventId: Option.none()
            } as ReducedContext)
          )
        )

      const isIdle = (agentName: AgentName) =>
        Effect.gen(function*() {
          const response = yield* HttpClientRequest.get(`${baseUrl}/agent/${agentName}/state`).pipe(
            (req) => client.execute(req),
            Effect.flatMap((r) => r.json)
          )
          const state = response as { isAgentTurnInProgress: boolean }
          return !state.isAgentTurnInProgress
        }).pipe(Effect.scoped, Effect.catchAll(() => Effect.succeed(true)))

      const endSession = (_agentName: AgentName) =>
        // Remote service doesn't expose endSession - session management is server-side
        Effect.void

      const interruptTurn = (_agentName: AgentName) =>
        // Remote service doesn't expose interruptTurn - would need a new endpoint
        Effect.void

      const list = () => Effect.succeed([] as ReadonlyArray<AgentName>)

      return {
        addEvents,
        tapEventStream,
        getEvents,
        getState,
        isIdle,
        endSession,
        interruptTurn,
        list
      } as unknown as AgentService
    })
  )
