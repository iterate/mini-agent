/**
 * HTTP Client Implementation of AgentService.
 *
 * Connects to a remote mini-agent server to provide agent operations.
 * Used when running in remote mode (--remote flag).
 */

import { HttpBody, HttpClient } from "@effect/platform"
import { Effect, Layer, Option, PubSub, Stream } from "effect"
import { AgentService } from "./agent-service.ts"
import type { AgentName, AgentTurnNumber, ContextEvent, ReducedContext } from "./domain.ts"

type EventNumber = number & { readonly _brand: unique symbol }

/** Configuration for HTTP client */
export interface HttpAgentServiceConfig {
  readonly baseUrl: string
}

/** Tag for HTTP client config */
export class HttpAgentServiceConfigTag extends Effect.Tag("@mini-agent/HttpAgentServiceConfig")<
  HttpAgentServiceConfigTag,
  HttpAgentServiceConfig
>() {}

/** Parse SSE data lines into ContextEvent objects */
const parseSSELine = (line: string): ContextEvent | null => {
  if (!line.startsWith("data: ")) return null
  try {
    const json = JSON.parse(line.slice(6)) as unknown
    return json as ContextEvent
  } catch {
    return null
  }
}

/** Parse SSE stream into ContextEvent stream */
const parseSSEStream = (stream: Stream.Stream<Uint8Array, unknown>): Stream.Stream<ContextEvent, unknown> => {
  const decoder = new TextDecoder()
  let buffer = ""

  return stream.pipe(
    Stream.mapConcat((chunk) => {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      return lines
    }),
    Stream.map(parseSSELine),
    Stream.filter((e): e is ContextEvent => e !== null)
  )
}

/**
 * Create HTTP client layer for AgentService.
 * Requires HttpAgentServiceConfigTag and HttpClient to be provided.
 */
export const HttpAgentServiceLayer: Layer.Layer<
  AgentService,
  never,
  HttpAgentServiceConfigTag | HttpClient.HttpClient
> = Layer.effect(
  AgentService,
  Effect.gen(function*() {
    const config = yield* HttpAgentServiceConfigTag
    const client = yield* HttpClient.HttpClient

    const baseUrl = config.baseUrl.replace(/\/$/, "")

    return {
      addEvents: ({ agentName, events }: { agentName: AgentName; events: ReadonlyArray<ContextEvent> }) =>
        Effect.gen(function*() {
          // For each event, POST to the agent endpoint
          // In practice, we only add UserMessageEvent this way
          for (const event of events) {
            yield* client.post(`${baseUrl}/agent/${agentName}`, {
              body: HttpBody.unsafeJson({ _tag: event._tag, content: (event as { content?: string }).content })
            }).pipe(
              Effect.flatMap((response) => response.text),
              Effect.catchAll(() => Effect.void)
            )
          }
        }),

      tapEventStream: ({ agentName }: { agentName: AgentName }) =>
        Effect.gen(function*() {
          // Create a PubSub to bridge HTTP SSE to local stream
          const pubsub = yield* PubSub.unbounded<ContextEvent>()

          // Start SSE connection in background
          yield* Effect.gen(function*() {
            const response = yield* client.get(`${baseUrl}/agent/${agentName}/events`)
            const eventStream = parseSSEStream(response.stream)

            yield* eventStream.pipe(
              Stream.runForEach((event) => PubSub.publish(pubsub, event))
            )
          }).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.forkScoped
          )

          // Return stream from PubSub
          const dequeue = yield* PubSub.subscribe(pubsub)
          return Stream.fromQueue(dequeue)
        }),

      getEvents: ({ agentName }: { agentName: AgentName }) =>
        Effect.gen(function*() {
          // GET /agent/:agentName/events returns SSE, we need to collect until done
          // For now, use state endpoint which has message count
          // Actually, let's POST and collect the response events
          const response = yield* client.post(`${baseUrl}/agent/${agentName}`, {
            body: HttpBody.unsafeJson({ _tag: "UserMessageEvent", content: "__get_events__" })
          })

          // Parse SSE response
          const events: Array<ContextEvent> = []
          const text = yield* response.text
          for (const line of text.split("\n")) {
            const event = parseSSELine(line)
            if (event) events.push(event)
          }

          // Filter out the placeholder message we sent
          return events.filter((evt: ContextEvent) => {
            if (evt._tag === "UserMessageEvent") {
              return (evt as { content?: string }).content !== "__get_events__"
            }
            return true
          })
        }).pipe(Effect.catchAll(() => Effect.succeed([]))),

      getState: ({ agentName }: { agentName: AgentName }) =>
        Effect.gen(function*() {
          const response = yield* client.get(`${baseUrl}/agent/${agentName}/state`)
          const json = yield* response.json as Effect.Effect<{
            nextEventNumber: number
            currentTurnNumber: number
            messageCount: number
            hasLlmConfig: boolean
            isAgentTurnInProgress: boolean
          }>

          // Return a minimal ReducedContext-like object
          return {
            messages: [],
            llmConfig: Option.none(),
            nextEventNumber: json.nextEventNumber as EventNumber,
            currentTurnNumber: json.currentTurnNumber as AgentTurnNumber,
            agentTurnStartedAtEventId: json.isAgentTurnInProgress ? Option.some("unknown") : Option.none()
          } as unknown as ReducedContext
        }).pipe(
          Effect.catchAll(() =>
            Effect.succeed({
              messages: [],
              llmConfig: Option.none(),
              nextEventNumber: 0 as EventNumber,
              currentTurnNumber: 0 as AgentTurnNumber,
              agentTurnStartedAtEventId: Option.none()
            } as unknown as ReducedContext)
          )
        ),

      addEventsAndStreamUntilIdle: (
        { agentName, events, idleTimeoutMs = 50 }: {
          agentName: AgentName
          events: ReadonlyArray<ContextEvent>
          idleTimeoutMs?: number
        }
      ) => {
        // POST message and stream back SSE events
        const effect = Effect.gen(function*() {
          // Find the user message content
          const userEvent = events.find((evt: ContextEvent) => evt._tag === "UserMessageEvent")
          const content = userEvent ? (userEvent as { content?: string }).content ?? "" : ""

          const url = idleTimeoutMs > 0
            ? `${baseUrl}/agent/${agentName}?idle_timeout=${idleTimeoutMs}`
            : `${baseUrl}/agent/${agentName}`

          const response = yield* client.post(url, {
            body: HttpBody.unsafeJson({ _tag: "UserMessageEvent", content })
          })

          return parseSSEStream(response.stream)
        })

        return Stream.unwrap(effect.pipe(Effect.catchAll(() => Effect.succeed(Stream.empty))))
      },

      endSession: ({ agentName }: { agentName: AgentName }) =>
        Effect.gen(function*() {
          yield* client.post(`${baseUrl}/agent/${agentName}/end`, {}).pipe(
            Effect.catchAll(() => Effect.void)
          )
        }),

      interruptTurn: ({ agentName }: { agentName: AgentName }) =>
        Effect.gen(function*() {
          yield* client.post(`${baseUrl}/agent/${agentName}/interrupt`, {}).pipe(
            Effect.catchAll(() => Effect.void)
          )
        }),

      isIdle: ({ agentName }: { agentName: AgentName }) =>
        Effect.gen(function*() {
          const response = yield* client.get(`${baseUrl}/agent/${agentName}/idle`)
          const json = yield* response.json as Effect.Effect<{ isIdle: boolean }>
          return json.isIdle
        }).pipe(Effect.catchAll(() => Effect.succeed(true))),

      listAgents: () => Effect.succeed([])
    } as unknown as AgentService
  })
)

/**
 * Create an HTTP client AgentService layer with the given base URL.
 */
export const makeHttpAgentServiceLayer = (
  baseUrl: string
): Layer.Layer<AgentService, never, HttpClient.HttpClient> =>
  HttpAgentServiceLayer.pipe(
    Layer.provide(Layer.succeed(HttpAgentServiceConfigTag, { baseUrl }))
  )
