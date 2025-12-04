/**
 * Complete type definitions for the LLM Context Service Architecture.
 * Service interfaces only - no implementations.
 *
 * Key design decisions:
 * - All events share BaseEventFields (id, timestamp, contextName)
 * - Uses @effect/ai Prompt.Message for LLM messages (not custom types)
 * - Uses Effect Schedule for retry (not custom RetryConfig)
 * - Agent.takeTurn (not stream) - may involve multiple requests in future
 * - Single ContextEvent union - no InputEvent/StreamEvent distinction
 */

import type { Prompt } from "@effect/ai"
import { Context, Duration, Effect, Fiber, Layer, Schedule, Schema, Stream } from "effect"

// =============================================================================
// Branded Types
// =============================================================================

export const ContextName = Schema.String.pipe(Schema.brand("ContextName"))
export type ContextName = typeof ContextName.Type

export const LlmProviderId = Schema.String.pipe(Schema.brand("LlmProviderId"))
export type LlmProviderId = typeof LlmProviderId.Type

export const EventId = Schema.String.pipe(Schema.brand("EventId"))
export type EventId = typeof EventId.Type

// =============================================================================
// Base Event Fields - All events share these
// =============================================================================

/**
 * All context events must have these fields.
 * Use spread: { ...BaseEventFields, myField: Schema.String }
 */
export const BaseEventFields = {
  id: EventId,
  timestamp: Schema.DateTimeUtc,
  contextName: ContextName
}

// =============================================================================
// Configuration Schemas
// =============================================================================

export class LlmProviderConfig extends Schema.Class<LlmProviderConfig>("LlmProviderConfig")({
  providerId: LlmProviderId,
  model: Schema.String,
  apiKey: Schema.Redacted(Schema.String),
  baseUrl: Schema.optionalWith(Schema.String, { as: "Option" })
}) {}

/**
 * Agent configuration. Uses Effect Schedule for retry instead of custom config.
 * The schedule is not serialized - it's provided at layer construction time.
 */
export class AgentConfig extends Schema.Class<AgentConfig>("AgentConfig")({
  primary: LlmProviderConfig,
  fallback: Schema.optionalWith(LlmProviderConfig, { as: "Option" }),
  timeoutMs: Schema.Number.pipe(Schema.positive())
}) {}

// =============================================================================
// ReducedContext - Output of reducer, input to Agent
// =============================================================================

/**
 * The reduced state ready for an agent turn.
 * Uses @effect/ai Prompt.Message for messages.
 */
export interface ReducedContext {
  readonly messages: ReadonlyArray<Prompt.Message>
  readonly config: AgentConfig
}

// =============================================================================
// Content Events
// =============================================================================

export class SystemPromptEvent extends Schema.TaggedClass<SystemPromptEvent>()(
  "SystemPromptEvent",
  {
    ...BaseEventFields,
    content: Schema.String
  }
) {}

export class UserMessageEvent extends Schema.TaggedClass<UserMessageEvent>()(
  "UserMessageEvent",
  {
    ...BaseEventFields,
    content: Schema.String
  }
) {}

export class FileAttachmentEvent extends Schema.TaggedClass<FileAttachmentEvent>()(
  "FileAttachmentEvent",
  {
    ...BaseEventFields,
    source: Schema.String,
    mimeType: Schema.String,
    content: Schema.String
  }
) {}

export class AssistantMessageEvent extends Schema.TaggedClass<AssistantMessageEvent>()(
  "AssistantMessageEvent",
  {
    ...BaseEventFields,
    content: Schema.String
  }
) {}

export class TextDeltaEvent extends Schema.TaggedClass<TextDeltaEvent>()(
  "TextDeltaEvent",
  {
    ...BaseEventFields,
    delta: Schema.String
  }
) {}

// =============================================================================
// Configuration Events
// =============================================================================

export class SetLlmProviderConfigEvent extends Schema.TaggedClass<SetLlmProviderConfigEvent>()(
  "SetLlmProviderConfigEvent",
  {
    ...BaseEventFields,
    providerId: LlmProviderId,
    model: Schema.String,
    apiKey: Schema.Redacted(Schema.String),
    baseUrl: Schema.optionalWith(Schema.String, { as: "Option" }),
    asFallback: Schema.Boolean
  }
) {}

export class SetTimeoutEvent extends Schema.TaggedClass<SetTimeoutEvent>()(
  "SetTimeoutEvent",
  {
    ...BaseEventFields,
    timeoutMs: Schema.Number
  }
) {}

// =============================================================================
// Lifecycle Events
// =============================================================================

export class SessionStartedEvent extends Schema.TaggedClass<SessionStartedEvent>()(
  "SessionStartedEvent",
  {
    ...BaseEventFields
  }
) {}

export class SessionEndedEvent extends Schema.TaggedClass<SessionEndedEvent>()(
  "SessionEndedEvent",
  {
    ...BaseEventFields
  }
) {}

export class AgentTurnStartedEvent extends Schema.TaggedClass<AgentTurnStartedEvent>()(
  "AgentTurnStartedEvent",
  {
    ...BaseEventFields
  }
) {}

export class AgentTurnCompletedEvent extends Schema.TaggedClass<AgentTurnCompletedEvent>()(
  "AgentTurnCompletedEvent",
  {
    ...BaseEventFields,
    durationMs: Schema.Number
  }
) {}

export class AgentTurnInterruptedEvent extends Schema.TaggedClass<AgentTurnInterruptedEvent>()(
  "AgentTurnInterruptedEvent",
  {
    ...BaseEventFields,
    reason: Schema.String
  }
) {}

export class AgentTurnFailedEvent extends Schema.TaggedClass<AgentTurnFailedEvent>()(
  "AgentTurnFailedEvent",
  {
    ...BaseEventFields,
    error: Schema.String
  }
) {}

// =============================================================================
// ContextEvent - The one and only event union
// =============================================================================

/**
 * All events that can occur in a context. There's no distinction between
 * "input" and "output" events - they're all just events that flow through
 * the system and get streamed to consumers.
 */
export const ContextEvent = Schema.Union(
  // Content events
  SystemPromptEvent,
  UserMessageEvent,
  FileAttachmentEvent,
  AssistantMessageEvent,
  TextDeltaEvent,
  // Configuration events
  SetLlmProviderConfigEvent,
  SetTimeoutEvent,
  // Lifecycle events
  SessionStartedEvent,
  SessionEndedEvent,
  AgentTurnStartedEvent,
  AgentTurnCompletedEvent,
  AgentTurnInterruptedEvent,
  AgentTurnFailedEvent
)
export type ContextEvent = typeof ContextEvent.Type

// =============================================================================
// Errors
// =============================================================================

export class AgentError extends Schema.TaggedError<AgentError>()(
  "AgentError",
  {
    message: Schema.String,
    provider: LlmProviderId,
    cause: Schema.optionalWith(Schema.Defect, { as: "Option" })
  }
) {}

export class ReducerError extends Schema.TaggedError<ReducerError>()(
  "ReducerError",
  {
    message: Schema.String,
    event: Schema.optionalWith(ContextEvent, { as: "Option" })
  }
) {}

export class ContextNotFoundError extends Schema.TaggedError<ContextNotFoundError>()(
  "ContextNotFoundError",
  {
    contextName: ContextName
  }
) {}

export class ContextLoadError extends Schema.TaggedError<ContextLoadError>()(
  "ContextLoadError",
  {
    contextName: ContextName,
    message: Schema.String,
    cause: Schema.optionalWith(Schema.Defect, { as: "Option" })
  }
) {}

export class HookError extends Schema.TaggedError<HookError>()(
  "HookError",
  {
    hook: Schema.Literal("beforeTurn", "afterTurn", "onEvent"),
    message: Schema.String,
    cause: Schema.optionalWith(Schema.Defect, { as: "Option" })
  }
) {}

export const ContextError = Schema.Union(ContextNotFoundError, ContextLoadError)
export type ContextError = typeof ContextError.Type

export const SessionError = Schema.Union(ContextNotFoundError, ContextLoadError, ReducerError, HookError)
export type SessionError = typeof SessionError.Type

// =============================================================================
// Layer 1: Agent Service
// =============================================================================

/**
 * Agent service - makes LLM requests with retry and fallback.
 *
 * takeTurn: Execute an agent turn (may involve multiple LLM requests in future).
 * Returns a stream of events during the turn.
 */
export class Agent extends Context.Tag("@app/Agent")<
  Agent,
  {
    readonly takeTurn: (ctx: ReducedContext) => Stream.Stream<ContextEvent, AgentError>
  }
>() {
  static readonly layer: Layer.Layer<Agent> = undefined as never
  static readonly testLayer: Layer.Layer<Agent> = undefined as never
}

// =============================================================================
// Layer 2: EventReducer Service
// =============================================================================

/**
 * EventReducer folds events into a ReducedContext ready for an agent turn.
 * Different implementations handle context growth differently.
 */
export class EventReducer extends Context.Tag("@app/EventReducer")<
  EventReducer,
  {
    readonly reduce: (
      current: ReducedContext,
      newEvents: ReadonlyArray<ContextEvent>
    ) => Effect.Effect<ReducedContext, ReducerError>

    readonly initialReducedContext: ReducedContext
  }
>() {
  /** Default reducer - keeps all messages, no truncation */
  static readonly layer: Layer.Layer<EventReducer> = undefined as never

  /**
   * Truncating reducer - keeps only the last N messages to stay within
   * token limits. Simple sliding window approach.
   */
  static readonly truncatingLayer: Layer.Layer<EventReducer> = undefined as never

  /**
   * Summarizing reducer - when context grows too large, uses the Agent
   * to generate a summary of older messages. Requires Agent dependency
   * since it makes LLM calls to summarize.
   */
  static readonly summarizingLayer: Layer.Layer<EventReducer, never, Agent> = undefined as never

  static readonly testLayer: Layer.Layer<EventReducer> = undefined as never
}

// =============================================================================
// Layer 3: ContextSession Service
// =============================================================================

export class ContextSession extends Context.Tag("@app/ContextSession")<
  ContextSession,
  {
    readonly initialize: (contextName: ContextName) => Effect.Effect<void, ContextError>
    readonly addEvent: (event: ContextEvent) => Effect.Effect<void, SessionError>
    readonly events: Stream.Stream<ContextEvent, SessionError>
    readonly getEvents: () => Effect.Effect<ReadonlyArray<ContextEvent>>
  }
>() {
  static readonly layer: Layer.Layer<ContextSession, never, Agent | EventReducer | ContextRepository | HooksService> =
    undefined as never
  static readonly testLayer: Layer.Layer<ContextSession> = undefined as never
}

// =============================================================================
// Layer 4: ApplicationService
// =============================================================================

export class ApplicationService extends Context.Tag("@app/ApplicationService")<
  ApplicationService,
  {
    readonly addEvent: (
      contextName: ContextName,
      event: ContextEvent
    ) => Effect.Effect<void, SessionError>

    readonly eventStream: (
      contextName: ContextName
    ) => Stream.Stream<ContextEvent, SessionError>

    readonly shutdown: () => Effect.Effect<void>
  }
>() {
  static readonly layer: Layer.Layer<ApplicationService, never, ContextSession> = undefined as never
  static readonly testLayer: Layer.Layer<ApplicationService> = undefined as never
}

// =============================================================================
// ContextRepository Service
// =============================================================================

export class ContextRepository extends Context.Tag("@app/ContextRepository")<
  ContextRepository,
  {
    readonly load: (name: ContextName) => Effect.Effect<ReadonlyArray<ContextEvent>, ContextError>
    readonly append: (name: ContextName, events: ReadonlyArray<ContextEvent>) => Effect.Effect<void, ContextError>
    readonly exists: (name: ContextName) => Effect.Effect<boolean>
  }
>() {
  static readonly layer: Layer.Layer<ContextRepository> = undefined as never
  static readonly testLayer: Layer.Layer<ContextRepository> = undefined as never
}

// =============================================================================
// HooksService
// =============================================================================

export type BeforeTurnHook = (input: ReducedContext) => Effect.Effect<ReducedContext, HookError>
export type AfterTurnHook = (event: ContextEvent) => Effect.Effect<ReadonlyArray<ContextEvent>, HookError>
export type OnEventHook = (event: ContextEvent) => Effect.Effect<void, HookError>

export class HooksService extends Context.Tag("@app/HooksService")<
  HooksService,
  {
    readonly beforeTurn: BeforeTurnHook
    readonly afterTurn: AfterTurnHook
    readonly onEvent: OnEventHook
  }
>() {
  static readonly layer = Layer.succeed(HooksService, {
    beforeTurn: (input) => Effect.succeed(input),
    afterTurn: (event) => Effect.succeed([event]),
    onEvent: () => Effect.void
  })

  static readonly testLayer = HooksService.layer
}

// =============================================================================
// AppConfig Service
// =============================================================================

export class AppConfig extends Context.Tag("@app/AppConfig")<
  AppConfig,
  {
    readonly defaultProvider: LlmProviderConfig
    readonly defaultTimeoutMs: number
    readonly maxTokens: number
    readonly debounceMs: number
    /**
     * Retry schedule for agent requests. Use Effect Schedule combinators.
     * Example: Schedule.exponential("100 millis").pipe(Schedule.intersect(Schedule.recurs(3)))
     */
    readonly retrySchedule: Schedule.Schedule<unknown, unknown>
  }
>() {
  static readonly layer: Layer.Layer<AppConfig> = undefined as never
  static readonly testLayer: Layer.Layer<AppConfig> = undefined as never
}

// =============================================================================
// Sample Layer Composition
// =============================================================================

export const makeAppLayer = () =>
  ApplicationService.layer.pipe(
    Layer.provide(ContextSession.layer),
    Layer.provide(EventReducer.layer),
    Layer.provide(Agent.layer),
    Layer.provide(ContextRepository.layer),
    Layer.provide(HooksService.layer),
    Layer.provide(AppConfig.layer)
  )

export const makeTestLayer = () =>
  ApplicationService.testLayer.pipe(
    Layer.provide(ContextSession.testLayer),
    Layer.provide(EventReducer.testLayer),
    Layer.provide(Agent.testLayer),
    Layer.provide(ContextRepository.testLayer),
    Layer.provide(HooksService.testLayer),
    Layer.provide(AppConfig.testLayer)
  )

// =============================================================================
// Sample Usage
// =============================================================================

export const sampleProgram = Effect.gen(function*() {
  const app = yield* ApplicationService
  const contextName = ContextName.make("chat")

  // Fork the event stream consumer
  const streamFiber = yield* app.eventStream(contextName).pipe(
    Stream.tap((event) => Effect.log(`Event: ${event._tag}`)),
    Stream.runDrain,
    Effect.fork
  )

  // Add a user message
  yield* app.addEvent(
    contextName,
    new UserMessageEvent({
      id: EventId.make(crypto.randomUUID()),
      timestamp: new Date() as never, // DateTime.unsafeNow() in real code
      contextName,
      content: "Hello, how are you?"
    })
  )

  // Wait for response events...
  yield* Effect.sleep(Duration.seconds(5))

  // Graceful shutdown
  yield* app.shutdown()
  yield* Fiber.await(streamFiber)
})

// =============================================================================
// Hook Composition Utilities
// =============================================================================

export const composeBeforeTurnHooks = (
  hooks: ReadonlyArray<BeforeTurnHook>
): BeforeTurnHook =>
(input) =>
  hooks.reduce(
    (acc, hook) => Effect.flatMap(acc, hook),
    Effect.succeed(input) as Effect.Effect<ReducedContext, HookError>
  )

export const composeAfterTurnHooks = (
  hooks: ReadonlyArray<AfterTurnHook>
): AfterTurnHook =>
(event) =>
  hooks.reduce(
    (acc, hook) =>
      Effect.flatMap(acc, (events) =>
        Effect.map(
          Effect.all(events.map(hook)),
          (results) => results.flat()
        )),
    Effect.succeed([event]) as Effect.Effect<ReadonlyArray<ContextEvent>, HookError>
  )

export const composeOnEventHooks = (
  hooks: ReadonlyArray<OnEventHook>
): OnEventHook =>
(event) => Effect.all(hooks.map((hook) => hook(event)), { discard: true })

// =============================================================================
// Custom Hooks Example
// =============================================================================

export const makeLoggingHooksLayer = () =>
  Layer.sync(HooksService, () =>
    HooksService.of({
      beforeTurn: Effect.fn("HooksService.beforeTurn")(
        function*(input: ReducedContext) {
          yield* Effect.log(`Turn with ${input.messages.length} messages`)
          return input
        }
      ),
      afterTurn: Effect.fn("HooksService.afterTurn")(
        function*(event: ContextEvent) {
          if (event._tag === "AssistantMessageEvent") {
            yield* Effect.log(`Response: ${event.content.slice(0, 50)}...`)
          }
          return [event]
        }
      ),
      onEvent: Effect.fn("HooksService.onEvent")(
        function*(event: ContextEvent) {
          yield* Effect.log(`Event: ${event._tag}`)
        }
      )
    }))
