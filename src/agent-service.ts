import { Context, Effect, Layer, Option, Queue, Schema, type Scope, Stream } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import { type AgentName, type ContextEvent, ContextEvent as ContextEventSchema } from "./domain.ts"

export interface AgentServiceApi {
  readonly addEvents: (options: AddEventsInput) => Effect.Effect<void>
  readonly tapEventStream: (
    options: TapEventStreamInput
  ) => Effect.Effect<Stream.Stream<ContextEvent, never>, never, Scope.Scope>
  readonly getEvents: (options: GetEventsInput) => Effect.Effect<ReadonlyArray<ContextEvent>>
}

export interface AddEventsInput {
  readonly agentName: AgentName
  readonly events: ReadonlyArray<ContextEvent>
}

export interface TapEventStreamInput {
  readonly agentName: AgentName
}

export interface GetEventsInput {
  readonly agentName: AgentName
}

export class AgentService extends Context.Tag("@mini-agent/AgentService")<
  AgentService,
  AgentServiceApi
>() {}

export class RemoteAgentConfig extends Context.Tag("@mini-agent/RemoteAgentConfig")<
  RemoteAgentConfig,
  Option.Option<string>
>() {}

export const RemoteAgentConfigDefault = Layer.succeed(RemoteAgentConfig, Option.none<string>())

const makeLocalAgentService = Effect.gen(function*() {
  const registry = yield* AgentRegistry

  const addEvents: AgentServiceApi["addEvents"] = ({ agentName, events }) =>
    Effect.gen(function*() {
      const agent = yield* registry.getOrCreate(agentName).pipe(Effect.orDie)
      for (const event of events) {
        yield* agent.addEvent(event)
      }
    })

  const tapEventStream: AgentServiceApi["tapEventStream"] = ({ agentName }) =>
    Effect.gen(function*() {
      const agent = yield* registry.getOrCreate(agentName).pipe(Effect.orDie)
      return yield* agent.tapEventStream
    })

  const getEvents: AgentServiceApi["getEvents"] = ({ agentName }) =>
    Effect.gen(function*() {
      const agent = yield* registry.getOrCreate(agentName).pipe(Effect.orDie)
      return yield* agent.getEvents
    })

  return { addEvents, tapEventStream, getEvents }
})

const encodeContextEvent = Schema.encodeSync(ContextEventSchema)
const decodeContextEvent = Schema.decodeUnknown(ContextEventSchema)

const makeHttpAgentService = (options: {
  readonly baseUrl: string
  readonly pollIntervalMs?: number
}) =>
  Effect.sync(() => {
    const baseUrl = options.baseUrl.replace(/\/$/, "")
    const pollInterval = options.pollIntervalMs ?? 150

    const fetchJson = (path: string, init?: RequestInit) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${baseUrl}${path}`, {
            ...init,
            headers: {
              "Content-Type": "application/json",
              ...(init?.headers ?? {})
            }
          })
          if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`)
          }
          return await response.json()
        },
        catch: (error) => error instanceof Error ? error : new Error(String(error))
      })
    const safeFetchJson = (path: string, init?: RequestInit) => fetchJson(path, init).pipe(Effect.orDie)

    const getEvents: AgentServiceApi["getEvents"] = ({ agentName }) =>
      Effect.gen(function*() {
        const json = (yield* safeFetchJson(`/agent/${encodeURIComponent(agentName)}/log`)) as {
          readonly events?: ReadonlyArray<unknown>
        }
        const events = Array.isArray(json.events) ? json.events : []
        return yield* Effect.forEach(events, (value) => decodeContextEvent(value)).pipe(Effect.orDie)
      })

    const addEvents: AgentServiceApi["addEvents"] = ({ agentName, events }) =>
      safeFetchJson(`/agent/${encodeURIComponent(agentName)}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: events.map((event) => encodeContextEvent(event))
        })
      }).pipe(Effect.asVoid)

    const tapEventStream: AgentServiceApi["tapEventStream"] = ({ agentName }) =>
      Effect.scoped(
        Effect.gen(function*() {
          const queue = yield* Queue.unbounded<ContextEvent>()
          yield* Effect.addFinalizer(() => Queue.shutdown(queue))
          const loop = (seen: number): Effect.Effect<void> =>
            Effect.gen(function*() {
              const events = yield* getEvents({ agentName })
              const fresh = events.slice(seen)
              for (const event of fresh) {
                yield* Queue.offer(queue, event)
              }
              yield* Effect.sleep(`${pollInterval} millis`)
              return yield* loop(events.length)
            })

          yield* Effect.forkScoped(loop(0))
          return Stream.fromQueue(queue)
        })
      )

    return { addEvents, tapEventStream, getEvents }
  })

export const AgentServiceLive = Layer.effect(
  AgentService,
  Effect.gen(function*() {
    const remoteConfig = yield* RemoteAgentConfig
    if (Option.isSome(remoteConfig)) {
      return yield* makeHttpAgentService({ baseUrl: remoteConfig.value })
    }
    return yield* makeLocalAgentService
  })
).pipe(Layer.provideMerge(AgentRegistry.Default))
