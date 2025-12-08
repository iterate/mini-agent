/**
 * AgentService - Unified interface for all CLI modes.
 *
 * Provides a clean abstraction over agent operations:
 * - addEvents: Add events to an agent (may trigger LLM turns)
 * - tapEventStream: Subscribe to live event stream
 * - getEvents: Get historical events
 * - getState: Get current reduced state
 *
 * Implementations:
 * - LocalAgentService: In-process using AgentRegistry
 * - HttpAgentService: HTTP client connecting to remote server
 */

import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "@effect/platform"
import { Context, Duration, Effect, Layer, Option, Schema, type Scope, Stream } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import {
  type AgentName,
  type AgentTurnNumber,
  type ContextEvent,
  ContextEvent as ContextEventSchema,
  type ContextLoadError,
  type ContextSaveError,
  makeBaseEventFields,
  type ReducedContext,
  type ReducerError,
  UserMessageEvent
} from "./domain.ts"

/** Service errors */
export class AgentServiceError extends Schema.TaggedError<AgentServiceError>()(
  "AgentServiceError",
  { message: Schema.String, cause: Schema.optionalWith(Schema.Defect, { as: "Option" }) }
) {}

/** Options for addEvents */
export interface AddEventsOptions {
  readonly agentName: AgentName
  readonly events: ReadonlyArray<ContextEvent>
}

/** Options for adding events and streaming until idle */
export interface AddAndStreamOptions {
  readonly agentName: AgentName
  readonly events: ReadonlyArray<ContextEvent>
  /** Idle timeout in ms before stream ends (default 50ms) */
  readonly idleTimeoutMs?: number
}

/** Options for tapEventStream */
export interface TapEventStreamOptions {
  readonly agentName: AgentName
}

/** Options for getEvents */
export interface GetEventsOptions {
  readonly agentName: AgentName
}

/** Options for getState */
export interface GetStateOptions {
  readonly agentName: AgentName
}

/** The service interface shape */
export interface AgentServiceShape {
  readonly addEvents: (options: AddEventsOptions) => Effect.Effect<void, AgentServiceError>
  readonly addAndStream: (
    options: AddAndStreamOptions
  ) => Effect.Effect<Stream.Stream<ContextEvent, AgentServiceError>, AgentServiceError, Scope.Scope>
  readonly tapEventStream: (
    options: TapEventStreamOptions
  ) => Effect.Effect<Stream.Stream<ContextEvent, never>, AgentServiceError, Scope.Scope>
  readonly getEvents: (options: GetEventsOptions) => Effect.Effect<ReadonlyArray<ContextEvent>, AgentServiceError>
  readonly getState: (options: GetStateOptions) => Effect.Effect<ReducedContext, AgentServiceError>
  readonly endSession: (options: { agentName: AgentName }) => Effect.Effect<void, AgentServiceError>
  readonly isIdle: (options: { agentName: AgentName }) => Effect.Effect<boolean, AgentServiceError>
  readonly interruptTurn: (options: { agentName: AgentName }) => Effect.Effect<void, AgentServiceError>
}

type AgentServiceCreationError = ReducerError | ContextLoadError | ContextSaveError

/**
 * AgentService - Unified service for all CLI modes.
 */
export class AgentService extends Context.Tag("@mini-agent/AgentService")<AgentService, AgentServiceShape>() {}

/**
 * LocalAgentService - In-process implementation using AgentRegistry.
 */
export const LocalAgentService = {
  Default: Layer.effect(
    AgentService,
    Effect.gen(function*() {
      const registry = yield* AgentRegistry

      const wrapError = (error: AgentServiceCreationError): AgentServiceError =>
        new AgentServiceError({ message: error.message, cause: Option.some(error) })

      return {
        addEvents: ({ agentName, events }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName).pipe(Effect.mapError(wrapError))
            for (const event of events) {
              yield* agent.addEvent(event)
            }
          }),

        addAndStream: ({ agentName, events, idleTimeoutMs = 50 }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName).pipe(Effect.mapError(wrapError))

            // Subscribe first to guarantee we catch all events
            const liveStream = yield* agent.tapEventStream

            // Fork event addition
            yield* Effect.fork(
              Effect.gen(function*() {
                for (const event of events) {
                  yield* agent.addEvent(event)
                }
              })
            )

            // Stream events until idle for idleTimeoutMs
            return liveStream.pipe(
              Stream.timeoutTo(Duration.millis(idleTimeoutMs), Stream.empty),
              Stream.concat(
                Stream.fromEffect(
                  Effect.gen(function*() {
                    // After timeout, check if there are more events coming
                    // Continue streaming while not idle
                    while (true) {
                      const isIdle = yield* agent.isIdle
                      if (isIdle) {
                        break
                      }
                      yield* Effect.sleep(Duration.millis(10))
                    }
                  }).pipe(Effect.as(undefined))
                ).pipe(Stream.drain)
              )
            )
          }),

        tapEventStream: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName).pipe(Effect.mapError(wrapError))
            return yield* agent.tapEventStream
          }),

        getEvents: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName).pipe(Effect.mapError(wrapError))
            return yield* agent.getEvents
          }),

        getState: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName).pipe(Effect.mapError(wrapError))
            return yield* agent.getState
          }),

        endSession: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName).pipe(Effect.mapError(wrapError))
            yield* agent.endSession
          }),

        isIdle: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName).pipe(Effect.mapError(wrapError))
            return yield* agent.isIdle
          }),

        interruptTurn: ({ agentName }) =>
          Effect.gen(function*() {
            const agent = yield* registry.getOrCreate(agentName).pipe(Effect.mapError(wrapError))
            yield* agent.interruptTurn
          })
      } satisfies AgentServiceShape
    })
  )
}

/** Helper to create a UserMessageEvent with proper fields */
export const makeUserMessageEvent = (
  agentName: AgentName,
  contextName: string,
  nextEventNumber: number,
  content: string,
  images?: ReadonlyArray<string>
): UserMessageEvent =>
  new UserMessageEvent({
    ...makeBaseEventFields(agentName, contextName as any, nextEventNumber, true),
    content,
    images: images && images.length > 0 ? [...images] : undefined
  })

/**
 * Remote server configuration.
 */
export class RemoteServerConfig extends Context.Tag("@mini-agent/RemoteServerConfig")<
  RemoteServerConfig,
  { readonly baseUrl: string }
>() {
  static layer(baseUrl: string): Layer.Layer<RemoteServerConfig> {
    return Layer.succeed(RemoteServerConfig, { baseUrl })
  }
}

/** Schema for state response from server */
const StateResponse = Schema.Struct({
  agentName: Schema.String,
  contextName: Schema.String,
  nextEventNumber: Schema.Number,
  currentTurnNumber: Schema.Number,
  messageCount: Schema.Number,
  hasLlmConfig: Schema.Boolean,
  isAgentTurnInProgress: Schema.Boolean
})

/** Parse SSE data line into ContextEvent */
const parseSSELine = (line: string): Effect.Effect<ContextEvent | null, AgentServiceError> =>
  Effect.gen(function*() {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data: ")) {
      return null
    }
    const jsonStr = trimmed.slice(6) // Remove "data: " prefix
    if (!jsonStr) return null

    const parsed = yield* Effect.try({
      try: () => JSON.parse(jsonStr) as unknown,
      catch: (e) => new AgentServiceError({ message: `Failed to parse SSE JSON: ${e}`, cause: Option.none() })
    })
    const event = yield* Schema.decodeUnknown(ContextEventSchema)(parsed).pipe(
      Effect.mapError((e) => new AgentServiceError({ message: `Failed to decode event: ${e}`, cause: Option.none() }))
    )
    return event
  })

/** Parse SSE stream into ContextEvent stream (errors are logged and filtered) */
const parseSSEStream = (
  response: { readonly stream: Stream.Stream<Uint8Array, unknown> }
): Stream.Stream<ContextEvent, never> =>
  response.stream.pipe(
    Stream.catchAll(() => Stream.empty),
    Stream.map((chunk) => new TextDecoder().decode(chunk)),
    Stream.mapConcat((text) => text.split("\n")),
    Stream.mapEffect((line) =>
      parseSSELine(line).pipe(
        Effect.catchAll(() => Effect.succeed(null))
      )
    ),
    Stream.filter((e): e is ContextEvent => e !== null)
  )

/**
 * HttpAgentService - HTTP client implementation connecting to remote server.
 */
export const HttpAgentService = {
  Default: Layer.effect(
    AgentService,
    Effect.gen(function*() {
      const config = yield* RemoteServerConfig
      const httpClient = yield* HttpClient.HttpClient

      const makeUrl = (path: string) => `${config.baseUrl}${path}`

      const wrapHttpError = (e: unknown): AgentServiceError =>
        new AgentServiceError({
          message: e instanceof Error ? e.message : String(e),
          cause: Option.some(e)
        })

      const encodeEvent = Schema.encodeSync(ContextEventSchema)

      return {
        addEvents: ({ agentName, events }) =>
          Effect.gen(function*() {
            if (events.length === 0) return

            yield* httpClient.execute(
              HttpClientRequest.post(makeUrl(`/agent/${agentName}/stream`), {
                body: HttpBody.unsafeJson({
                  events: events.map((e) => encodeEvent(e)),
                  idleTimeoutMs: 50
                })
              })
            ).pipe(
              Effect.scoped,
              Effect.mapError(wrapHttpError)
            )
          }),

        addAndStream: ({ agentName, events, idleTimeoutMs = 50 }) =>
          Effect.gen(function*() {
            const response = yield* httpClient.execute(
              HttpClientRequest.post(makeUrl(`/agent/${agentName}/stream`), {
                body: HttpBody.unsafeJson({
                  events: events.map((e) => encodeEvent(e)),
                  idleTimeoutMs
                })
              })
            ).pipe(Effect.mapError(wrapHttpError))

            // Cast to expected error type (stream errors are already caught internally)
            return parseSSEStream(response) as Stream.Stream<ContextEvent, AgentServiceError>
          }),

        tapEventStream: ({ agentName }) =>
          Effect.gen(function*() {
            const response = yield* httpClient.execute(
              HttpClientRequest.get(makeUrl(`/agent/${agentName}/events`))
            ).pipe(Effect.mapError(wrapHttpError))

            return parseSSEStream(response)
          }),

        getEvents: (_options) =>
          Effect.gen(function*() {
            // For remote mode, we don't have full event history easily - return empty
            // The server has the events in its memory
            yield* Effect.void
            return [] as ReadonlyArray<ContextEvent>
          }),

        getState: ({ agentName }) =>
          Effect.gen(function*() {
            const response = yield* httpClient.execute(
              HttpClientRequest.get(makeUrl(`/agent/${agentName}/state`))
            ).pipe(Effect.mapError(wrapHttpError))

            const json = yield* response.json.pipe(Effect.mapError(wrapHttpError))
            const stateResponse = yield* Schema.decodeUnknown(StateResponse)(json).pipe(
              Effect.mapError(wrapHttpError)
            )

            // Convert to ReducedContext (minimal fields needed for remote operation)
            const ctx: ReducedContext = {
              messages: [],
              nextEventNumber: stateResponse.nextEventNumber,
              currentTurnNumber: stateResponse.currentTurnNumber as AgentTurnNumber,
              agentTurnStartedAtEventId: stateResponse.isAgentTurnInProgress
                ? Option.some("unknown" as any)
                : Option.none(),
              llmConfig: stateResponse.hasLlmConfig ? Option.some({} as any) : Option.none()
            }
            return ctx
          }).pipe(Effect.scoped),

        endSession: ({ agentName }) =>
          Effect.gen(function*() {
            yield* httpClient.execute(
              HttpClientRequest.post(makeUrl(`/agent/${agentName}/end`))
            ).pipe(
              Effect.scoped,
              Effect.mapError(wrapHttpError)
            )
          }),

        isIdle: ({ agentName }) =>
          Effect.gen(function*() {
            const response = yield* httpClient.execute(
              HttpClientRequest.get(makeUrl(`/agent/${agentName}/state`))
            ).pipe(Effect.mapError(wrapHttpError))

            const json = yield* response.json.pipe(Effect.mapError(wrapHttpError))
            const stateResponse = yield* Schema.decodeUnknown(StateResponse)(json).pipe(
              Effect.mapError(wrapHttpError)
            )
            return !stateResponse.isAgentTurnInProgress
          }).pipe(Effect.scoped),

        interruptTurn: ({ agentName }) =>
          Effect.gen(function*() {
            yield* httpClient.execute(
              HttpClientRequest.post(makeUrl(`/agent/${agentName}/interrupt`))
            ).pipe(
              Effect.scoped,
              Effect.mapError(wrapHttpError)
            )
          })
      } satisfies AgentServiceShape
    })
  ).pipe(
    Layer.provide(FetchHttpClient.layer)
  )
}
