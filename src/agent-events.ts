import { DateTime, Effect, Layer, Option, Schema, Stream, type Scope } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import { type AgentName, ContextEvent, makeEventId, UserMessageEvent } from "./domain.ts"

const UserMessageInput = Schema.Struct({
  _tag: Schema.Union(Schema.Literal("UserMessageEvent"), Schema.Literal("UserMessage")),
  content: Schema.String,
  images: Schema.optional(Schema.Array(Schema.String))
})

const InterruptTurnInput = Schema.Struct({
  _tag: Schema.Literal("InterruptTurn")
})

const EndSessionInput = Schema.Struct({
  _tag: Schema.Literal("EndSession")
})

export const AgentEventInput = Schema.Union(UserMessageInput, InterruptTurnInput, EndSessionInput)
export type AgentEventInput = typeof AgentEventInput.Type

export interface AddEventsInput {
  readonly agentName: AgentName
  readonly events: ReadonlyArray<AgentEventInput>
}

export class AgentEvents extends Effect.Service<AgentEvents>()("@mini-agent/AgentEvents", {
  effect: Effect.gen(function*() {
    const registry = yield* AgentRegistry

    const resolveAgent = (agentName: AgentName) => registry.getOrCreate(agentName)

    const addEvents = ({ agentName, events }: AddEventsInput) =>
      Effect.gen(function*() {
        if (events.length === 0) {
          return
        }

        const agent = yield* resolveAgent(agentName)
        let nextEventNumber = (yield* agent.getState).nextEventNumber

        for (const event of events) {
          switch (event._tag) {
            case "UserMessage":
            case "UserMessageEvent": {
              const userEvent = new UserMessageEvent({
                id: makeEventId(agent.contextName, nextEventNumber),
                timestamp: DateTime.unsafeNow(),
                agentName: agent.agentName,
                parentEventId: Option.none(),
                triggersAgentTurn: true,
                content: event.content,
                images: event.images
              })
              nextEventNumber++
              yield* agent.addEvent(userEvent)
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
          }
        }
      })

    const tapEventStream = ({ agentName }: { agentName: AgentName }) =>
      Effect.gen(function*() {
        const agent = yield* resolveAgent(agentName)
        return yield* agent.tapEventStream
      })

    const getEvents = ({ agentName }: { agentName: AgentName }) =>
      Effect.gen(function*() {
        const agent = yield* resolveAgent(agentName)
        return yield* agent.getEvents
      })

    return { addEvents, tapEventStream, getEvents }
  }),
  dependencies: [AgentRegistry.Default],
  accessors: true
}) {
  static readonly Local = AgentEvents.Default

  static remote(options: RemoteAgentEventsOptions): Layer.Layer<never, never, AgentEvents> {
    const baseUrl = options.baseUrl.replace(/\/+$/, "")
    const decodeEvents = Schema.decodeUnknown(Schema.Array(ContextEvent))
    const decodeEvent = Schema.decodeUnknown(ContextEvent)

    const fetchJson = (path: string) =>
      Effect.tryPromise({
        try: () => fetch(`${baseUrl}${path}`),
        catch: (error) => new Error(`Failed to fetch ${path}: ${String(error)}`)
      }).pipe(
        Effect.flatMap((response) =>
          response.ok
            ? Effect.promise(() => response.json() as Promise<unknown>)
            : Effect.fail(new Error(`Request to ${path} failed with status ${response.status}`))
        )
      )

    const drainBody = (body: ReadableStream<Uint8Array>) =>
      Effect.tryPromise({
        try: async () => {
          const reader = body.getReader()
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
          reader.releaseLock()
        },
        catch: (error) => new Error(`Failed to read response body: ${String(error)}`)
      })

    return Layer.scoped(
      AgentEvents,
      Effect.gen(function*() {
        const addEvents = ({ agentName, events }: AddEventsInput) =>
          events.length === 0
            ? Effect.void
            : Effect.tryPromise({
              try: () =>
                fetch(`${baseUrl}/agent/${agentName}?streamUntilIdle=true`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(events)
                }),
              catch: (error) => new Error(`Failed to add events: ${String(error)}`)
            }).pipe(
              Effect.flatMap((response) => {
                if (!response.ok) {
                  return Effect.fail(
                    new Error(`Remote addEvents failed with status ${response.status}`)
                  )
                }
                return response.body ? drainBody(response.body) : Effect.void
              }),
              Effect.orDie
            )

        const getEvents = ({ agentName }: { agentName: AgentName }) =>
          fetchJson(`/agent/${agentName}/events/history`).pipe(
            Effect.flatMap((json) => decodeEvents(json)),
            Effect.orDie
          )

        const tapEventStream = ({ agentName }: { agentName: AgentName }) =>
          Effect.acquireUseRelease(
            Effect.gen(function*() {
              const controller = new AbortController()
              const response = yield* Effect.tryPromise({
                try: () =>
                  fetch(`${baseUrl}/agent/${agentName}/events`, {
                    headers: { Accept: "text/event-stream" },
                    signal: controller.signal
                  }),
                catch: (error) => new Error(`Failed to connect to event stream: ${String(error)}`)
              }).pipe(Effect.orDie)

              if (!response.ok || !response.body) {
                controller.abort()
                return yield* Effect.die(
                  new Error(
                    `Event stream request failed${response.ok ? " (empty body)" : ` with status ${response.status}`}`
                  )
                )
              }

              const stream = Stream.fromAsyncIterable(
                makeSseIterator(response.body),
                (error) => new Error(String(error))
              ).pipe(
                Stream.mapEffect((line) =>
                  Effect.try({
                    try: () => JSON.parse(line) as unknown,
                    catch: (error) => new Error(`Invalid SSE payload: ${String(error)}`)
                  }).pipe(Effect.flatMap((json) => decodeEvent(json)), Effect.orDie)
                )
              )

              return { controller, stream }
            }),
            ({ controller }) => Effect.sync(() => controller.abort()),
            ({ stream }) => Effect.succeed(stream)
          )

        return { addEvents, tapEventStream, getEvents }
      })
    )
  }
}

export interface RemoteAgentEventsOptions {
  readonly baseUrl: string
}

export type AgentEventsService = AgentEvents
export const AgentEventCommands = {
  userMessage: (input: { content: string; images?: ReadonlyArray<string> }) =>
    ({
      _tag: "UserMessageEvent",
      content: input.content,
      images: input.images
    }) satisfies AgentEventInput,
  interruptTurn: { _tag: "InterruptTurn" } as AgentEventInput,
  endSession: { _tag: "EndSession" } as AgentEventInput
} as const

const makeSseIterator = (body: ReadableStream<Uint8Array>) => ({
  async *[Symbol.asyncIterator]() {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf("\n\n")
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const dataLine = chunk
            .split("\n")
            .find((line) => line.startsWith("data:"))
          if (dataLine) {
            yield dataLine.slice(5).trim()
          }
          boundary = buffer.indexOf("\n\n")
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
})
