import { Clock, Effect, Layer, Schema, Scope, Stream } from "effect"
import { AgentService, type AgentServiceApi } from "./agent-service.ts"
import { EventReducer } from "./event-reducer.ts"
import {
  type AgentName,
  type ContextEvent,
  ContextEvent as ContextEventSchema
} from "./domain.ts"

const encodeEvent = Schema.encodeSync(ContextEventSchema)
const decodeEvent = Schema.decodeUnknown(ContextEventSchema)

const jsonHeaders = { "Content-Type": "application/json" }

const sanitizeBaseUrl = (url: string) => url.endsWith("/") ? url.slice(0, -1) : url

const parseEventsResponse = (data: unknown): Effect.Effect<ReadonlyArray<ContextEvent>> =>
  Effect.sync(() => {
    if (typeof data !== "object" || data === null || !("events" in data)) {
      throw new Error("Invalid events payload")
    }
    const eventsData = (data as { events: unknown }).events
    if (!Array.isArray(eventsData)) {
      throw new Error("Events field must be an array")
    }
    return eventsData
  }).pipe(
    Effect.flatMap((eventsData) =>
      Effect.forEach(eventsData, (entry) => decodeEvent(entry), { concurrency: "unbounded" })
    )
  )

export const makeHttpAgentServiceLayer = (baseUrl: string) => {
  const normalizedBase = sanitizeBaseUrl(baseUrl)

  const fetchJson = (path: string, init?: RequestInit) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${normalizedBase}${path}`, init)
        if (!response.ok) {
          const message = await response.text().catch(() => response.statusText)
          throw new Error(`HTTP ${response.status}: ${message}`)
        }
        if (response.status === 204) {
          return null
        }
        return response.json()
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error)))
    })

  const postJson = (path: string, body?: unknown) =>
    fetchJson(path, {
      method: "POST",
      headers: jsonHeaders,
      body: body === undefined ? undefined : JSON.stringify(body)
    })

  return Layer.effect(
    AgentService,
    Effect.gen(function*() {
      const reducer = yield* EventReducer

      const getEvents = ({ agentName }: { readonly agentName: AgentName }) =>
        fetchJson(`/agent/${agentName}/events/history`).pipe(
          Effect.flatMap(parseEventsResponse)
        )

      const addEvents = ({ agentName, events }: { readonly agentName: AgentName; readonly events: ReadonlyArray<ContextEvent> }) =>
        postJson(`/agent/${agentName}/events`, {
          events: events.map((event) => encodeEvent(event)),
          streamUntilIdle: false
        }).pipe(Effect.asVoid)

      const endSession = ({ agentName }: { readonly agentName: AgentName }) =>
        postJson(`/agent/${agentName}/end-session`, undefined).pipe(Effect.asVoid)

      const interruptTurn = ({ agentName }: { readonly agentName: AgentName }) =>
        postJson(`/agent/${agentName}/interrupt`, undefined).pipe(Effect.asVoid)

      const isIdle = ({ agentName }: { readonly agentName: AgentName }) =>
        fetchJson(`/agent/${agentName}/idle`).pipe(
          Effect.map((data) =>
            typeof data === "object" && data !== null && "idle" in data ? Boolean((data as { idle: unknown }).idle) : false
          )
        )

      const getState = ({ agentName }: { readonly agentName: AgentName }) =>
        getEvents({ agentName }).pipe(
          Effect.flatMap((events) => reducer.reduce(reducer.initialReducedContext, events))
        )

      const tapEventStream: AgentServiceApi["tapEventStream"] = ({ agentName }) =>
        Effect.gen(function*() {
          const existingEvents = yield* getEvents({ agentName })
          let lastEventId = existingEvents.length > 0 ? existingEvents[existingEvents.length - 1]!.id : null

          return Stream.asyncScoped<ContextEvent, never, never>((emit) =>
            Effect.gen(function*() {
              let cancelled = false
              yield* Effect.addFinalizer(() => Effect.sync(() => { cancelled = true }))

              while (!cancelled) {
                yield* Effect.sleep("200 millis")
                const events = yield* getEvents({ agentName })
                if (events.length === 0) {
                  continue
                }
                if (!lastEventId) {
                  lastEventId = events[events.length - 1]!.id
                  continue
                }
                const lastIndex = events.findIndex((event) => event.id === lastEventId)
                const startIndex = lastIndex === -1 ? events.length : lastIndex + 1
                for (let idx = startIndex; idx < events.length; idx++) {
                  const event = events[idx]!
                  lastEventId = event.id
                  yield* emit.single(event)
                }
              }
            })
          )
        })

      return {
        addEvents,
        tapEventStream,
        getEvents,
        getState,
        endSession,
        interruptTurn,
        isIdle
      } satisfies AgentServiceApi
    })
  )
}
