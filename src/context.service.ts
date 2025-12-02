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
import { Effect, pipe, Schema, Stream } from "effect"
import {
  type ContextEvent,
  PersistedEvent,
  type PersistedEvent as PersistedEventType,
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

    return {
      /**
       * Add events to a context, triggering LLM processing and returning the event stream.
       *
       * This is the core operation on a Context:
       * 1. Loads existing events (or creates context with system prompt)
       * 2. Appends the input events (typically UserMessage)
       * 3. Runs LLM with full history
       * 4. Streams back TextDelta (ephemeral) and AssistantMessage (persisted)
       * 5. Persists new events as they complete
       *
       * @param contextName - Name of the context (determines storage file)
       * @param inputEvents - Events to add (typically UserMessageEvent[])
       * @returns Stream of all events (ephemeral TextDelta + persisted AssistantMessage)
       */
      addEvents: (
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
          }),
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
        ),

      /**
       * Load all events from a context.
       */
      load: (contextName: string): Effect.Effect<Array<PersistedEventType>, PlatformError.PlatformError> =>
        repo.load(contextName),

      /**
       * List all context names.
       */
      list: (): Effect.Effect<Array<string>, PlatformError.PlatformError> => repo.list()
    }
  }),
  dependencies: [ContextRepository.Default],
  accessors: true
}) {}
