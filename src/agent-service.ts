import { Clock, Context, Effect, Layer, Scope, Stream } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import { type AgentName, type ContextEvent, type MiniAgent, type ReducedContext } from "./domain.ts"

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

export interface AgentServiceApi {
  readonly addEvents: (input: AddEventsInput) => Effect.Effect<void>
  readonly tapEventStream: (
    input: TapEventStreamInput
  ) => Effect.Effect<Stream.Stream<ContextEvent, never>, never, Scope.Scope | Clock.Clock>
  readonly getEvents: (input: GetEventsInput) => Effect.Effect<ReadonlyArray<ContextEvent>>
  readonly getState: (input: { readonly agentName: AgentName }) => Effect.Effect<ReducedContext>
  readonly endSession: (input: { readonly agentName: AgentName }) => Effect.Effect<void>
  readonly interruptTurn: (input: { readonly agentName: AgentName }) => Effect.Effect<void>
  readonly isIdle: (input: { readonly agentName: AgentName }) => Effect.Effect<boolean>
}

export const AgentService = Context.Tag<AgentServiceApi>()("@mini-agent/AgentService")

export const AgentServiceLive = Layer.effect(
  AgentService,
  Effect.gen(function*() {
    const registry = yield* AgentRegistry

    const withAgent = <A>(
      agentName: AgentName,
      useAgent: (agent: MiniAgent) => Effect.Effect<A>
    ): Effect.Effect<A> =>
      Effect.gen(function*() {
        const agent = yield* registry.getOrCreate(agentName).pipe(Effect.orDie)
        return yield* useAgent(agent)
      })

    const addEvents = ({ agentName, events }: AddEventsInput) =>
      withAgent(agentName, (agent) =>
        Effect.forEach(events, (event) => agent.addEvent(event), { discard: true })
      )

    const tapEventStream: AgentServiceApi["tapEventStream"] = ({ agentName }) =>
      withAgent(agentName, (agent) => agent.tapEventStream)

    const getEvents = ({ agentName }: GetEventsInput) =>
      withAgent(agentName, (agent) => agent.getEvents)

    const getState = ({ agentName }: { readonly agentName: AgentName }) =>
      withAgent(agentName, (agent) => agent.getState)

    const endSession = ({ agentName }: { readonly agentName: AgentName }) =>
      withAgent(agentName, (agent) => agent.endSession)

    const interruptTurn = ({ agentName }: { readonly agentName: AgentName }) =>
      withAgent(agentName, (agent) => agent.interruptTurn)

    const isIdle = ({ agentName }: { readonly agentName: AgentName }) =>
      withAgent(agentName, (agent) => agent.isIdle)

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
