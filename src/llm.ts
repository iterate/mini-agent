/**
 * LLM Request
 *
 * Pure function that takes persisted events and produces a stream of context events.
 * This is the core LLM interaction - converting conversation history into a response stream.
 */
import { type AiError, LanguageModel } from "@effect/ai"
import { Effect, Option, pipe, Ref, Stream } from "effect"
import {
  AssistantMessageEvent,
  type ContextEvent,
  LLMRequestStartEvent,
  type PersistedEvent,
  TextDeltaEvent
} from "./context.model.ts"

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

/**
 * Stream an LLM response with a start event for tracing.
 *
 * Same as streamLLMResponse but emits an LLMRequestStartEvent first
 * containing the full message array being sent to the LLM.
 *
 * @param events - Array of persisted events representing conversation history
 * @param requestId - Unique identifier for this request (for correlating with interrupts)
 * @returns Stream of context events starting with LLMRequestStartEvent
 */
export const streamLLMResponseWithStart = (
  events: ReadonlyArray<PersistedEvent>,
  requestId: string
): Stream.Stream<ContextEvent, AiError.AiError, LanguageModel.LanguageModel> =>
  Stream.unwrap(
    Effect.fn("streamLLMResponseWithStart")(function*() {
      const model = yield* LanguageModel.LanguageModel
      const fullResponseRef = yield* Ref.make("")
      yield* Effect.logDebug("Streaming LLM response with start event")

      const messages = events.map((event) => event.toLLMMessage())

      const startEvent = new LLMRequestStartEvent({
        requestId,
        timestamp: new Date(),
        messages
      })

      return pipe(
        // Emit start event first
        Stream.make(startEvent as ContextEvent),
        // Then stream the response
        Stream.concat(
          pipe(
            model.streamText({ prompt: messages }),
            Stream.filterMap((part) =>
              part.type === "text-delta" ? Option.some(part.delta) : Option.none()
            ),
            Stream.mapEffect((delta) =>
              Ref.update(fullResponseRef, (t) => t + delta).pipe(
                Effect.as(new TextDeltaEvent({ delta }) as ContextEvent)
              )
            )
          )
        ),
        // Append final AssistantMessage with complete response
        Stream.concat(
          Stream.fromEffect(
            Ref.get(fullResponseRef).pipe(
              Effect.map((content) => new AssistantMessageEvent({ content }) as ContextEvent)
            )
          )
        )
      )
    })()
  )
