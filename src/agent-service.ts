/**
 * Unified AgentService - Single interface for all CLI modes.
 *
 * Provides a clean abstraction over agent operations:
 * - addEvents: Add events to an agent
 * - tapEventStream: Subscribe to live event stream
 * - getEvents: Get all events for an agent
 *
 * Implementations:
 * - InProcessAgentService: Uses AgentRegistry directly (in-process)
 * - HttpAgentService: HTTP client to remote server
 */

import { Effect, Layer, Schema, Stream, type Scope } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import { type AgentName, ContextEvent, type ReducedContext } from "./domain.ts"

/**
 * Unified service interface for agent operations.
 * All CLI modes (HTTP server, CLI, TUI, single-turn) use this interface.
 */
export class AgentService extends Effect.Service<AgentService>()("@mini-agent/AgentService", {
  succeed: {
    /**
     * Add events to an agent. Returns immediately after queuing.
     */
    addEvents: (_args: { agentName: AgentName; events: ReadonlyArray<ContextEvent> }) =>
      Effect.void,

    /**
     * Subscribe to live event stream for an agent.
     * Returns a scoped stream that emits all future events.
     */
    tapEventStream: (_args: { agentName: AgentName }) =>
      Effect.succeed(Stream.empty<ContextEvent>()) as Effect.Effect<Stream.Stream<ContextEvent, never>, never, Scope.Scope>,

    /**
     * Get all events for an agent (current snapshot).
     */
    getEvents: (_args: { agentName: AgentName }) =>
      Effect.succeed<ReadonlyArray<ContextEvent>>([]),

    /**
     * Get reduced state for an agent.
     */
    getState: (_args: { agentName: AgentName }) =>
      Effect.succeed({} as ReducedContext)
  },
  accessors: true
}) {}

/**
 * In-process implementation using AgentRegistry directly.
 */
export class InProcessAgentService extends Effect.Service<InProcessAgentService>()(
  "@mini-agent/InProcessAgentService",
  {
    effect: Effect.gen(function*() {
      const registry = yield* AgentRegistry

      const addEvents = ({ agentName, events }: { agentName: AgentName; events: ReadonlyArray<ContextEvent> }) =>
        Effect.gen(function*() {
          const agent = yield* registry.getOrCreate(agentName)
          for (const event of events) {
            yield* agent.addEvent(event)
          }
        })

    const tapEventStream = ({ agentName }: { agentName: AgentName }) =>
      Effect.gen(function*() {
        const agent = yield* registry.getOrCreate(agentName)
        // agent.subscribe returns Effect<Stream, never, Scope>
        return yield* agent.subscribe
      })

    const getEvents = ({ agentName }: { agentName: AgentName }) =>
        Effect.gen(function*() {
          const agent = yield* registry.getOrCreate(agentName)
          return yield* agent.getEvents
        })

      const getState = ({ agentName }: { agentName: AgentName }) =>
        Effect.gen(function*() {
          const agent = yield* registry.getOrCreate(agentName)
          return yield* agent.getReducedContext
        })

      return {
        addEvents,
        tapEventStream,
        getEvents,
        getState
      }
    }),
    dependencies: [AgentRegistry.Default],
    accessors: true
  }
) {}

/**
 * HTTP client implementation that connects to a remote server.
 */
export class HttpAgentService extends Effect.Service<HttpAgentService>()("@mini-agent/HttpAgentService", {
  effect: Effect.gen(function*() {
    const baseUrl = yield* Effect.succeed(process.env.MINI_AGENT_SERVER_URL ?? "http://localhost:3001")

    const decodeEvent = Schema.decodeUnknown(ContextEvent)

    const addEvents = ({ agentName, events }: { agentName: AgentName; events: ReadonlyArray<ContextEvent> }) =>
      Effect.gen(function*() {
        for (const event of events) {
          yield* Effect.tryPromise({
            try: () =>
              fetch(`${baseUrl}/agent/${agentName}/events`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(Schema.encodeSync(ContextEvent)(event))
              }),
            catch: (e) => new Error(`HTTP request failed: ${e}`)
          }).pipe(Effect.flatMap((res) => {
            if (!res.ok) {
              return Effect.fail(new Error(`HTTP ${res.status}: ${res.statusText}`))
            }
            return Effect.void
          }))
        }
      })

    const tapEventStream = ({ agentName }: { agentName: AgentName }) =>
      Effect.gen(function*() {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`${baseUrl}/agent/${agentName}/events`, {
              headers: { Accept: "text/event-stream" }
            }),
          catch: (e) => new Error(`HTTP request failed: ${e}`)
        })

        if (!response.ok) {
          return yield* Effect.fail(new Error(`HTTP ${response.status}: ${response.statusText}`))
        }

        if (!response.body) {
          return yield* Effect.fail(new Error("Response body is null"))
        }

        // Parse SSE stream
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        const stream = Stream.async<ContextEvent, Error>((emit) => {
          const readChunk = async () => {
            try {
              const { done, value } = await reader.read()
              if (done) {
                return
              }

              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split("\n")
              buffer = lines.pop() ?? ""

              for (const line of lines) {
                if (line.trim() && line.startsWith("data: ")) {
                  try {
                    const json = JSON.parse(line.slice(6)) as unknown
                    // Decode synchronously for now - could be improved with Effect.async
                    const eventResult = Effect.runSync(
                      Schema.decodeUnknown(ContextEvent)(json).pipe(Effect.either)
                    )
                    if (eventResult._tag === "Right") {
                      emit(Stream.succeed(eventResult.right))
                    }
                  } catch {
                    // Skip invalid JSON lines
                  }
                }
              }

              if (!done) {
                readChunk()
              }
            } catch (error) {
              emit(Stream.fail(new Error(`SSE parse error: ${error}`)))
            }
          }

          readChunk()
        })

        return stream
      })

    const getEvents = ({ agentName }: { agentName: AgentName }) =>
      Effect.gen(function*() {
        const response = yield* Effect.tryPromise({
          try: () => fetch(`${baseUrl}/agent/${agentName}/events?snapshot=true`),
          catch: (e) => new Error(`HTTP request failed: ${e}`)
        })

        if (!response.ok) {
          return yield* Effect.fail(new Error(`HTTP ${response.status}: ${response.statusText}`))
        }

        const text = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (e) => new Error(`Failed to read response: ${e}`)
        })

        const events: Array<ContextEvent> = []
        for (const line of text.split("\n")) {
          if (line.startsWith("data: ")) {
            const json = JSON.parse(line.slice(6)) as unknown
            const event = yield* decodeEvent(json).pipe(
              Effect.mapError((e) => new Error(`Failed to decode event: ${e}`))
            )
            events.push(event)
          }
        }

        return events
      })

    const getState = ({ agentName }: { agentName: AgentName }) =>
      Effect.gen(function*() {
        const response = yield* Effect.tryPromise({
          try: () => fetch(`${baseUrl}/agent/${agentName}/state`),
          catch: (e) => new Error(`HTTP request failed: ${e}`)
        })

        if (!response.ok) {
          return yield* Effect.fail(new Error(`HTTP ${response.status}: ${response.statusText}`))
        }

        const json = yield* Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: (e) => new Error(`Failed to parse JSON: ${e}`)
        })

        // For now, return initial state - HTTP endpoint doesn't return full ReducedContext
        // TODO: Update HTTP endpoint to return full ReducedContext
        return {} as ReducedContext
      })

    return {
      addEvents,
      tapEventStream,
      getEvents,
      getState
    }
  }),
  accessors: true
}) {
  /**
   * Create layer with custom base URL.
   */
  static readonly fromUrl = (baseUrl: string) =>
    Layer.succeed(HttpAgentService, {
      addEvents: ({ agentName, events }) => {
        const encodeEvent = Schema.encodeSync(ContextEvent)
        return Effect.gen(function*() {
          for (const event of events) {
            yield* Effect.tryPromise({
              try: () =>
                fetch(`${baseUrl}/agent/${agentName}/events`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(encodeEvent(event))
                }),
              catch: (e) => new Error(`HTTP request failed: ${e}`)
            }).pipe(Effect.flatMap((res) => {
              if (!res.ok) {
                return Effect.fail(new Error(`HTTP ${res.status}: ${res.statusText}`))
              }
              return Effect.void
            }))
          }
        })
      },
      tapEventStream: ({ agentName }) => {
        // Reuse the main implementation logic but with baseUrl
        return Effect.gen(function*() {
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(`${baseUrl}/agent/${agentName}/events`, {
                headers: { Accept: "text/event-stream" }
              }),
            catch: (e) => new Error(`HTTP request failed: ${e}`)
          })

          if (!response.ok) {
            return yield* Effect.fail(new Error(`HTTP ${response.status}: ${response.statusText}`))
          }

          if (!response.body) {
            return yield* Effect.fail(new Error("Response body is null"))
          }

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""

          const stream = Stream.async<ContextEvent, Error>((emit) => {
            const readChunk = async () => {
              try {
                const { done, value } = await reader.read()
                if (done) {
                  return
                }

                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split("\n")
                buffer = lines.pop() ?? ""

                for (const line of lines) {
                  if (line.trim() && line.startsWith("data: ")) {
                    try {
                      const json = JSON.parse(line.slice(6)) as unknown
                      const eventResult = Effect.runSync(
                        Schema.decodeUnknown(ContextEvent)(json).pipe(Effect.either)
                      )
                      if (eventResult._tag === "Right") {
                        emit(Stream.succeed(eventResult.right))
                      }
                    } catch {
                      // Skip invalid JSON lines
                    }
                  }
                }

                if (!done) {
                  readChunk()
                }
              } catch (error) {
                emit(Stream.fail(new Error(`SSE parse error: ${error}`)))
              }
            }

            readChunk()
          })

          return stream
        })
      },
      getEvents: ({ agentName }) => {
        const decodeEvent = Schema.decodeUnknown(ContextEvent)
        return Effect.gen(function*() {
          const response = yield* Effect.tryPromise({
            try: () => fetch(`${baseUrl}/agent/${agentName}/events?snapshot=true`),
            catch: (e) => new Error(`HTTP request failed: ${e}`)
          })

          if (!response.ok) {
            return yield* Effect.fail(new Error(`HTTP ${response.status}: ${response.statusText}`))
          }

          const text = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: (e) => new Error(`Failed to read response: ${e}`)
          })

          const events: Array<ContextEvent> = []
          for (const line of text.split("\n")) {
            if (line.startsWith("data: ")) {
              const json = JSON.parse(line.slice(6)) as unknown
              const event = yield* decodeEvent(json).pipe(
                Effect.mapError((e) => new Error(`Failed to decode event: ${e}`))
              )
              events.push(event)
            }
          }

          return events
        })
      },
      getState: ({ agentName }) => {
        return Effect.gen(function*() {
          const response = yield* Effect.tryPromise({
            try: () => fetch(`${baseUrl}/agent/${agentName}/state`),
            catch: (e) => new Error(`HTTP request failed: ${e}`)
          })

          if (!response.ok) {
            return yield* Effect.fail(new Error(`HTTP ${response.status}: ${response.statusText}`))
          }

          // For now, return initial state - HTTP endpoint doesn't return full ReducedContext
          // TODO: Update HTTP endpoint to return full ReducedContext
          return {} as ReducedContext
        })
      }
    })
}
