import { Chunk, Context, Duration, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import {
  type AgentName,
  ContextEvent,
  ContextLoadError,
  type ContextName,
  type EventId,
  makeBaseEventFields,
  type MiniAgent,
  type ContextSaveError,
  type ReducerError,
  UserMessageEvent
} from "./domain.ts"

export interface AgentEventsSnapshot {
  readonly agentName: AgentName
  readonly contextName: ContextName
  readonly events: ReadonlyArray<ContextEvent>
}

const UserMessageInput = Schema.Struct({
  _tag: Schema.Literal("UserMessageEvent"),
  content: Schema.String,
  images: Schema.optional(Schema.Array(Schema.String)),
  triggersAgentTurn: Schema.optional(Schema.Boolean)
})

const InterruptTurnInput = Schema.Struct({
  _tag: Schema.Literal("InterruptTurn")
})

const EndSessionInput = Schema.Struct({
  _tag: Schema.Literal("EndSession")
})

export const AgentEventInput = Schema.Union(UserMessageInput, InterruptTurnInput, EndSessionInput)
export type AgentEventInput = typeof AgentEventInput.Type

export interface AgentService {
  readonly getEvents: (args: { agentName: AgentName }) => Effect.Effect<AgentEventsSnapshot, MiniAgentCreationError>
  readonly tapEventStream: (
    args: { agentName: AgentName }
  ) => Effect.Effect<Stream.Stream<ContextEvent, never>, MiniAgentCreationError>
  readonly addEvents: (
    args: { agentName: AgentName; events: ReadonlyArray<AgentEventInput> }
  ) => Effect.Effect<void, MiniAgentCreationError>
}

type MiniAgentCreationError = ReducerError | ContextLoadError | ContextSaveError

export const AgentService = Context.Tag<AgentService>()("@mini-agent/AgentService")

const makeLocalAgentService = Effect.gen(function*(): AgentService {
  const registry = yield* AgentRegistry

  const loadAgent = (agentName: AgentName): Effect.Effect<MiniAgent, MiniAgentCreationError> =>
    registry.getOrCreate(agentName)

  const getEvents = ({ agentName }: { agentName: AgentName }) =>
    Effect.gen(function*() {
      const agent = yield* loadAgent(agentName)
      const events = yield* agent.getEvents
      return {
        agentName: agent.agentName,
        contextName: agent.contextName,
        events
      }
    })

  const tapEventStream = ({ agentName }: { agentName: AgentName }) =>
    Effect.gen(function*() {
      const agent = yield* loadAgent(agentName)
      return yield* agent.tapEventStream
    })

  const addEvents = ({ agentName, events }: { agentName: AgentName; events: ReadonlyArray<AgentEventInput> }) =>
    Effect.gen(function*() {
      if (events.length === 0) {
        return
      }

      const agent = yield* loadAgent(agentName)
      const state = yield* agent.getState
      let nextEventNumber = state.nextEventNumber

      for (const input of events) {
        switch (input._tag) {
          case "UserMessageEvent": {
            const event = new UserMessageEvent({
              ...makeBaseEventFields(
                agent.agentName,
                agent.contextName,
                nextEventNumber,
                input.triggersAgentTurn ?? true
              ),
              content: input.content,
              images: input.images && input.images.length > 0 ? input.images : undefined
            })
            nextEventNumber += 1
            yield* agent.addEvent(event)
            break
          }
          case "InterruptTurn": {
            yield* agent.interruptTurn
            break
          }
          case "EndSession": {
            yield* agent.endSession
            break
          }
          default: {
            const _exhaustive: never = input
            return _exhaustive
          }
        }
      }
    })

  return {
    getEvents,
    tapEventStream,
    addEvents
  }
})

export const AgentServiceLive = Layer.effect(AgentService, makeLocalAgentService).pipe(
  Layer.provide(AgentRegistry.Default)
)

interface RemoteOptions {
  readonly baseUrl: string
  readonly pollInterval?: Duration.DurationInput
}

const fetchJson = (url: string): Effect.Effect<unknown, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`)
      }
      return response.json()
    },
    catch: (error) => error instanceof Error ? error : new Error(String(error))
  })

const postJson = (url: string, body: unknown): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      })
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`)
      }
    },
    catch: (error) => error instanceof Error ? error : new Error(String(error))
  })

const intoLoadError = (agentName: AgentName, error: unknown): ContextLoadError =>
  new ContextLoadError({
    contextName: `${agentName}-remote` as ContextName,
    message: error instanceof Error ? error.message : String(error),
    cause: Option.none()
  })

export const AgentServiceRemote = (options: RemoteOptions): Layer.Layer<never, never, AgentService> => {
  const sanitizedBase = options.baseUrl.replace(/\/+$/, "")
  const pollInterval = options.pollInterval ?? Duration.millis(200)

  const makeUrl = (path: string) => `${sanitizedBase}${path}`

  const decodeEvents = (agentName: AgentName, payload: ReadonlyArray<unknown>) =>
    Effect.forEach(payload, (event) => Schema.decodeUnknown(ContextEvent)(event)).pipe(
      Effect.catchAll((err) => Effect.fail(intoLoadError(agentName, err)))
    )

  const remoteService: AgentService = {
    getEvents: ({ agentName }) =>
      Effect.gen(function*() {
        const raw = (yield* fetchJson(makeUrl(`/agent/${agentName}/history`)).pipe(
          Effect.catchAll((err) => Effect.fail(intoLoadError(agentName, err)))
        )) as { agentName: string; contextName: string; events: ReadonlyArray<unknown> }
        const events = yield* decodeEvents(agentName, raw.events)
        return {
          agentName: raw.agentName as AgentName,
          contextName: raw.contextName as ContextName,
          events
        }
      }),

    tapEventStream: ({ agentName }) =>
      Effect.gen(function*() {
        const initialSnapshot = yield* remoteService.getEvents({ agentName })
        let lastEventId: EventId | null = initialSnapshot.events.length > 0
          ? initialSnapshot.events[initialSnapshot.events.length - 1]!.id
          : null

        return Stream.asyncScoped<ContextEvent, never>((emit) =>
          Effect.gen(function*() {
            const loop = Effect.forever(
              remoteService.getEvents({ agentName }).pipe(
                Effect.flatMap((snapshot) => {
                  let startIdx = -1
                  if (lastEventId !== null) {
                    startIdx = snapshot.events.findIndex((event) => event.id === lastEventId)
                  } else {
                    startIdx = snapshot.events.length - 1
                  }
                  const newEvents = snapshot.events.slice(startIdx + 1)
                  if (newEvents.length > 0) {
                    lastEventId = newEvents[newEvents.length - 1]!.id
                    return emit(Effect.succeed(Chunk.fromIterable(newEvents)))
                  }
                  return Effect.void
                }),
                Effect.zipRight(Effect.sleep(pollInterval))
              )
            )

            const fiber = yield* Effect.fork(loop)
            yield* Effect.addFinalizer(() => Fiber.interrupt(fiber))
          })
        )
      }),

    addEvents: ({ agentName, events }) =>
      postJson(makeUrl(`/agent/${agentName}/events`), { events }).pipe(
        Effect.catchAll((err) => Effect.fail(intoLoadError(agentName, err)))
      )
  }

  return Layer.succeed(AgentService, remoteService)
}