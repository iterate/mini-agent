/**
 * LLM Request
 *
 * Pure function that takes persisted events and produces a stream of context events.
 * This is the core LLM interaction - converting conversation history into a response stream.
 */
import { type AiError, LanguageModel } from "@effect/ai"
import { Effect, Option, pipe, Ref, Stream } from "effect"
import { AssistantMessageEvent, type ContextEvent, type PersistedEvent, TextDeltaEvent } from "./context.model.ts"

// =============================================================================
// LLM Response Streaming
// =============================================================================

/**
 * Stream an LLM response from persisted conversation events.
 *
 * Takes the full conversation history and produces:
 * 1. TextDelta events for each streaming chunk (ephemeral)
 * 2. A final AssistantMessage event with the complete response (persisted)
 *
 * @param events - Array of persisted events representing conversation history
 * @returns Stream of context events
 */
export const streamLLMResponse = (
  events: ReadonlyArray<PersistedEvent>
): Stream.Stream<ContextEvent, AiError.AiError, LanguageModel.LanguageModel> =>
  Stream.unwrap(
    Effect.fn("streamLLMResponse")(function*() {
      const model = yield* LanguageModel.LanguageModel
      const fullResponseRef = yield* Ref.make("")
      yield* Effect.logDebug("Streaming LLM response")
      return pipe(
        // Convert persisted events to LLM message format
        events.map((event) => event.toLLMMessage()),
        // Stream the LLM response
        (messages) => model.streamText({ prompt: messages }),
        // Extract text deltas
        Stream.filterMap((part) => part.type === "text-delta" ? Option.some(part.delta) : Option.none()),
        // Accumulate full response and emit TextDelta events
        Stream.mapEffect((delta) =>
          Ref.update(fullResponseRef, (t) => t + delta).pipe(
            Effect.as(new TextDeltaEvent({ delta }))
          )
        ),
        // Append final AssistantMessage with complete response
        Stream.concat(
          Stream.fromEffect(
            Ref.get(fullResponseRef).pipe(
              Effect.map((content) => new AssistantMessageEvent({ content }))
            )
          )
        )
      )
    })()
  )
