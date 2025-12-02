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
import type { Error as PlatformError } from "@effect/platform"
import { Effect, Layer, pipe, Schema, Stream } from "effect"
import {
  AssistantMessageEvent,
  type ContextEvent,
  PersistedEvent,
  type PersistedEvent as PersistedEventType,
  SystemPromptEvent,
  TextDeltaEvent,
  type UserMessageEvent
} from "./context.model.js"
import { ContextRepository } from "./context.repository.js"
import { streamLLMResponse } from "./llm.js"

// =============================================================================
// Context Service
// =============================================================================

export class ContextService extends Effect.Service<ContextService>()("ContextService", {
  effect: Effect.gen(function*() {
    const repo = yield* ContextRepository

    // Service methods wrapped with Effect.fn for call-site tracing
    // See: https://www.effect.solutions/services-and-layers

    /**
     * Add events to a context, triggering LLM processing and returning the event stream.
     *
     * This is the core operation on a Context:
     * 1. Loads existing events (or creates context with system prompt)
     * 2. Appends the input events (typically UserMessage)
     * 3. Runs LLM with full history
     * 4. Streams back TextDelta (ephemeral) and AssistantMessage (persisted)
     * 5. Persists new events as they complete
     */
    const addEvents = (
      contextName: string,
      inputEvents: ReadonlyArray<UserMessageEvent>
    ): Stream.Stream<
      ContextEvent,
      AiError.AiError | PlatformError.PlatformError,
      LanguageModel.LanguageModel
    > =>
      pipe(
        // Load or create context, append input events
        Effect.gen(function*() {
          const existingEvents = yield* repo.loadOrCreate(contextName)
          const newPersistedInputs = inputEvents.filter(Schema.is(PersistedEvent)) as Array<PersistedEventType>

          if (newPersistedInputs.length > 0) {
            const allEvents = [...existingEvents, ...newPersistedInputs]
            yield* repo.save(contextName, allEvents)
            return allEvents
          }
          return existingEvents
        }).pipe(Effect.withSpan("ContextService.addEvents.prepare")),
        // Stream LLM response
        Effect.andThen(streamLLMResponse),
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

    /**
     * Load all events from a context.
     */
    const load = Effect.fn("ContextService.load")(
      function*(contextName: string) {
        return yield* repo.load(contextName)
      }
    )

    /**
     * List all context names.
     */
    const list = Effect.fn("ContextService.list")(
      function*() {
        return yield* repo.list()
      }
    )

    return {
      addEvents,
      load,
      list
    }
  }),
  dependencies: [ContextRepository.Default],
  accessors: true
}) {
  /**
   * Test layer with mock LLM responses for unit tests.
   * Uses ContextRepository.testLayer for in-memory storage.
   * See: https://www.effect.solutions/testing
   */
  static testLayer = Layer.effect(
    ContextService,
    Effect.sync(() => {
      // In-memory store for test contexts
      const store = new Map<string, Array<PersistedEventType>>()

      return {
        _tag: "ContextService" as const,

        addEvents: (
          contextName: string,
          inputEvents: ReadonlyArray<UserMessageEvent>
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

        list: () => Effect.sync(() => Array.from(store.keys()).sort())
      } satisfies ContextService
    })
  )
}
