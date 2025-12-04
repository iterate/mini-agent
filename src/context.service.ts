/**
 * Context Service
 *
 * The main domain service for working with Contexts.
 *
 * A Context is a named, ordered list of events representing a conversation.
 * The only supported operation is `addEvents`:
 * 1. Appends input events (typically UserMessage) to the context
 * 2. Triggers an LLM request with the full event history
 * 3. Streams back new events (TextDelta ephemeral, AssistantMessage persisted)
 * 4. Persists the new events to the context file
 */
import type { AiError, LanguageModel } from "@effect/ai"
import type { Error as PlatformError, FileSystem } from "@effect/platform"
import { Context, Effect, Layer, pipe, Schema, Stream } from "effect"
import {
  AssistantMessageEvent,
  type ContextEvent,
  type InputEvent,
  PersistedEvent,
  type PersistedEvent as PersistedEventType,
  SystemPromptEvent,
  TextDeltaEvent,
  UserMessageEvent
} from "./context.model.ts"
import { ContextRepository } from "./context.repository.ts"
import type { ContextLoadError, ContextSaveError } from "./errors.ts"
import type { CurrentLlmConfig } from "./llm-config.ts"
import { streamLLMResponse } from "./llm.ts"

// =============================================================================
// Context Service
// =============================================================================

export class ContextService extends Context.Tag("@app/ContextService")<
  ContextService,
  {
    /**
     * Add events to a context, triggering LLM processing if UserMessage present.
     *
     * This is the core operation on a Context:
     * 1. Loads existing events (or creates context with system prompt)
     * 2. Appends the input events (UserMessage and/or FileAttachment)
     * 3. Runs LLM with full history (only if UserMessage present)
     * 4. Streams back TextDelta (ephemeral) and AssistantMessage (persisted)
     * 5. Persists new events as they complete
     */
    readonly addEvents: (
      contextName: string,
      inputEvents: ReadonlyArray<InputEvent>
    ) => Stream.Stream<
      ContextEvent,
      AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError,
      LanguageModel.LanguageModel | FileSystem.FileSystem | CurrentLlmConfig
    >

    /** Load all events from a context. */
    readonly load: (contextName: string) => Effect.Effect<Array<PersistedEventType>, ContextLoadError>

    /** List all context names. */
    readonly list: () => Effect.Effect<Array<string>, ContextLoadError>

    /** Persist an event directly (e.g., LLMRequestInterruptedEvent on cancel). */
    readonly persistEvent: (
      contextName: string,
      event: PersistedEventType
    ) => Effect.Effect<void, ContextLoadError | ContextSaveError>
  }
>() {
  /**
   * Production layer with file system persistence and LLM integration.
   */
  static readonly layer = Layer.effect(
    ContextService,
    Effect.gen(function*() {
      const repo = yield* ContextRepository

      // Service methods wrapped with Effect.fn for call-site tracing
      // See: https://www.effect.solutions/services-and-layers

      const addEvents = (
        contextName: string,
        inputEvents: ReadonlyArray<InputEvent>
      ): Stream.Stream<
        ContextEvent,
        AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError,
        LanguageModel.LanguageModel | FileSystem.FileSystem | CurrentLlmConfig
      > => {
        // Check if any UserMessage is present (triggers LLM)
        const hasUserMessage = inputEvents.some(Schema.is(UserMessageEvent))

        return pipe(
          // Load or create context, append input events
          Effect.fn("ContextService.addEvents.prepare")(function*() {
            const existingEvents = yield* repo.loadOrCreate(contextName)
            const newPersistedInputs = inputEvents.filter(Schema.is(PersistedEvent)) as Array<PersistedEventType>

            if (newPersistedInputs.length > 0) {
              const allEvents = [...existingEvents, ...newPersistedInputs]
              yield* repo.save(contextName, allEvents)
              return allEvents
            }
            return existingEvents
          })(),
          // Only stream LLM response if there's a UserMessage
          Effect.andThen((events) => hasUserMessage ? streamLLMResponse(events) : Stream.empty),
          Stream.unwrap,
          // Persist events as they complete (only persisted ones)
          Stream.tap((event) =>
            Schema.is(PersistedEvent)(event)
              ? Effect.gen(function*() {
                const current = yield* repo.load(contextName)
                yield* repo.save(contextName, [...current, event])
              })
              : Effect.void
          )
        )
      }

      const load = Effect.fn("ContextService.load")(
        function*(contextName: string) {
          return yield* repo.load(contextName)
        }
      )

      const list = Effect.fn("ContextService.list")(
        function*() {
          return yield* repo.list()
        }
      )

      const persistEvent = Effect.fn("ContextService.persistEvent")(
        function*(contextName: string, event: PersistedEventType) {
          const current = yield* repo.load(contextName)
          yield* repo.save(contextName, [...current, event])
        }
      )

      return ContextService.of({
        addEvents,
        load,
        list,
        persistEvent
      })
    })
  )

  /**
   * Test layer with mock LLM responses for unit tests.
   * See: https://www.effect.solutions/testing
   */
  static readonly testLayer = Layer.sync(ContextService, () => {
    // In-memory store for test contexts
    const store = new Map<string, Array<PersistedEventType>>()

    return ContextService.of({
      addEvents: (
        contextName: string,
        inputEvents: ReadonlyArray<InputEvent>
      ): Stream.Stream<ContextEvent, never, never> => {
        // Load or create context
        let events = store.get(contextName)
        if (!events) {
          events = [new SystemPromptEvent({ content: "Test system prompt" })]
          store.set(contextName, events)
        }

        // Add input events
        const newPersistedInputs = inputEvents.filter(Schema.is(PersistedEvent)) as Array<PersistedEventType>
        if (newPersistedInputs.length > 0) {
          events = [...events, ...newPersistedInputs]
          store.set(contextName, events)
        }

        // Check if any UserMessage is present
        const hasUserMessage = inputEvents.some(Schema.is(UserMessageEvent))

        // Only generate mock LLM response if there's a UserMessage
        if (!hasUserMessage) {
          return Stream.empty
        }

        // Mock LLM response stream
        const mockResponse = "This is a mock response for testing."
        const assistantEvent = new AssistantMessageEvent({ content: mockResponse })

        return Stream.make(
          new TextDeltaEvent({ delta: mockResponse }),
          assistantEvent
        ).pipe(
          Stream.tap((event) =>
            Schema.is(PersistedEvent)(event)
              ? Effect.sync(() => {
                const current = store.get(contextName) ?? []
                store.set(contextName, [...current, event])
              })
              : Effect.void
          )
        )
      },

      load: (contextName: string) => Effect.succeed(store.get(contextName) ?? []),

      list: () => Effect.sync(() => Array.from(store.keys()).sort()),

      persistEvent: (contextName: string, event: PersistedEventType) =>
        Effect.sync(() => {
          const current = store.get(contextName) ?? []
          store.set(contextName, [...current, event])
        })
    })
  })
}
