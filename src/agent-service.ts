/**
 * Unified Agent Service
 *
 * Single service interface for all CLI modes (http server, piped, TUI, single turn).
 * Can be implemented as in-process (AgentRegistry) or HTTP client (remote server).
 */

import { HttpClient, HttpClientRequest, HttpBody } from "@effect/platform"
import { Chunk, Effect, Layer, Schema, Stream, Scope } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import { ContextEvent } from "./domain.ts"
import type { AgentName } from "./domain.ts"

const encodeEvent = Schema.encodeSync(ContextEvent)
const decodeEvent = Schema.decodeUnknown(ContextEvent)

/**
 * Unified service for interacting with agents.
 * All CLI modes use this interface.
 */
export class AgentService extends Effect.Service<AgentService>()("@mini-agent/AgentService", {
  succeed: {
    /**
     * Add events to an agent. Returns immediately (fire-and-forget).
     */
    addEvents: (_args: {
      agentName: AgentName
      events: ReadonlyArray<ContextEvent>
    }): Effect.Effect<void> => Effect.void,

    /**
     * Subscribe to live event stream for an agent.
     * Returns a stream that includes existing events followed by live events.
     * Requires Scope for subscription management.
     */
    tapEventStream: (_args: {
      agentName: AgentName
    }): Effect.Effect<Stream.Stream<ContextEvent, never>, never, Scope.Scope> => Effect.succeed(Stream.empty),

    /**
     * Get all events for an agent (current snapshot).
     */
    getEvents: (_args: {
      agentName: AgentName
    }): Effect.Effect<ReadonlyArray<ContextEvent>> => Effect.succeed([]),

    /**
     * End the session gracefully (emits SessionEndedEvent).
     */
    endSession: (_args: {
      agentName: AgentName
    }): Effect.Effect<void> => Effect.void,

    /**
     * Interrupt the current turn if one is in progress.
     */
    interruptTurn: (_args: {
      agentName: AgentName
    }): Effect.Effect<void> => Effect.void,

    /**
     * Check if agent is idle (no turn in progress).
     */
    isIdle: (_args: {
      agentName: AgentName
    }): Effect.Effect<boolean> => Effect.succeed(true)
  },
  accessors: true
}) {
  /**
   * In-process implementation using AgentRegistry.
   */
  static readonly InProcess: Layer.Layer<AgentService, never, AgentRegistry> = Layer.effect(
    AgentService,
    Effect.gen(function*() {
      const registry = yield* AgentRegistry

        return {
        addEvents: ({ agentName, events }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            for (const event of events) {
              yield* agent.addEvent(event)
            }
          }),

        tapEventStream: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            const existingEvents = yield* agent.getEvents
            // tapEventStream requires Scope - it's already in context from caller
            const liveStream = yield* agent.tapEventStream
            return Stream.concat(Stream.fromIterable(existingEvents), liveStream)
          }),

        getEvents: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            return yield* agent.getEvents
          }),

        endSession: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            return yield* agent.endSession
          }),

        interruptTurn: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            return yield* agent.interruptTurn
          }),

        isIdle: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName)
            return yield* agent.isIdle
          })
      } as AgentService
    })
  )

  /**
   * HTTP client implementation for remote server.
   */
  static readonly HttpClient = (baseUrl: string): Layer.Layer<AgentService, never, HttpClient.HttpClient> =>
    Layer.effect(
      AgentService,
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const httpClientOk = HttpClient.filterStatusOk(client)

        const addEvents = ({ agentName, events }: { agentName: AgentName; events: ReadonlyArray<ContextEvent> }) =>
          Effect.gen(function*() {
            const url = `${baseUrl}/agent/${agentName}/events`
            const encodedEvents = events.map((e) => encodeEvent(e))
            const body = JSON.stringify({ events: encodedEvents, streamUntilIdle: false })
            yield* httpClientOk.execute(
              HttpClientRequest.post(url, {
                headers: { "Content-Type": "application/json" },
                body: HttpBody.text(body)
              })
            ).pipe(Effect.asVoid, Effect.scoped, Effect.catchAll(() => Effect.void))
          })

        const tapEventStream = ({ agentName }: { agentName: AgentName }) =>
          Effect.gen(function*() {
            // Create a scope for the HTTP connection
            const scope = yield* Scope.Scope
            const url = `${baseUrl}/agent/${agentName}/events`
            const response = yield* httpClientOk.execute(
              HttpClientRequest.get(url, {
                headers: { Accept: "text/event-stream" }
              })
            ).pipe(Effect.scoped, Effect.catchAll(() => Effect.die(new Error("Failed to connect to remote server"))))

            // Parse SSE stream
            const stream = response.stream.pipe(
              Stream.mapChunks(Chunk.map((bytes) => new TextDecoder().decode(bytes))),
              Stream.splitLines,
              Stream.filter((line) => line.startsWith("data: ")),
              Stream.map((line) => {
                const json = line.slice(6) // Remove "data: " prefix
                return JSON.parse(json) as unknown
              }),
              Stream.mapEffect((json) => decodeEvent(json).pipe(Effect.catchAll(() => Effect.die(new Error("Failed to decode event"))))),
              Stream.catchAll(() => Stream.empty),
              Stream.ensuring(Scope.close(scope, "success"))
            )

            return stream
          })

        const getEvents = ({ agentName }: { agentName: AgentName }) =>
          Effect.gen(function*() {
            // Use tapEventStream to get all events, then take until SessionEndedEvent or timeout
            const eventStream = yield* tapEventStream({ agentName })
            const events: Array<ContextEvent> = []
            yield* eventStream.pipe(
              Stream.takeUntil((e) => e._tag === "SessionEndedEvent"),
              Stream.take(10000), // Safety limit
              Stream.runForEach((event) => Effect.sync(() => events.push(event)))
            ).pipe(Effect.catchAll(() => Effect.void))
            return events
          })

        const endSession = () =>
          Effect.void // HTTP client can't end session directly - would need a new endpoint

        const interruptTurn = () =>
          Effect.void // HTTP client can't interrupt directly - would need a new endpoint

        const isIdle = () =>
          Effect.succeed(true) // Simplified - would need state endpoint to check properly

        return {
          addEvents,
          tapEventStream,
          getEvents,
          endSession,
          interruptTurn,
          isIdle
        } as unknown as AgentService
      })
    )

  /**
   * Test layer - uses InMemory store and stub turn.
   */
  static readonly TestLayer = AgentService.InProcess.pipe(
    Layer.provide(AgentRegistry.TestLayer)
  )
}
