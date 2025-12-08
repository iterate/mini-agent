/**
 * AgentService - Unified interface for all CLI modes.
 *
 * Provides a clean abstraction over agent operations:
 * - addEvents: Add events to an agent (may trigger LLM turns)
 * - tapEventStream: Subscribe to live event stream
 * - getEvents: Get historical events
 * - getState: Get current reduced state
 *
 * Current implementation:
 * - LocalAgentService: In-process using AgentRegistry
 *
 * Future: HttpAgentService for TUI connecting to remote server
 */

import { Context, Duration, Effect, Layer, Option, Schema, type Scope, Stream } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import {
  type AgentName,
  type ContextEvent,
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
