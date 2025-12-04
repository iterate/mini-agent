/**
 * LLM Request
 *
 * Pure function that takes persisted events and produces a stream of context events.
 */
import { type AiError, LanguageModel } from "@effect/ai"
import { Effect, Option, pipe, Ref, Stream } from "effect"
import { AssistantMessageEvent, type ContextEvent, type PersistedEvent, TextDeltaEvent } from "./context.model.ts"

/**
 * Stream an LLM response from persisted conversation events.
 *
 * Takes the full conversation history and produces:
 * 1. TextDelta events for each streaming chunk (ephemeral)
 * 2. A final AssistantMessage event with the complete response (persisted)
 */
export const streamLLMResponse = (
  events: ReadonlyArray<PersistedEvent>
): Stream.Stream<ContextEvent, AiError.AiError, LanguageModel.LanguageModel> =>
  Stream.unwrap(
    Effect.fn("LLM.streamLLMResponse")(function*() {
      const model = yield* LanguageModel.LanguageModel
      const fullResponseRef = yield* Ref.make("")
      yield* Effect.logDebug("Streaming LLM response")

      const messages = events.map((event) => event.toLLMMessage())

      return pipe(
        model.streamText({ prompt: messages }),
        Stream.filterMap((part) => part.type === "text-delta" ? Option.some(part.delta) : Option.none()),
        Stream.mapEffect((delta) =>
          Ref.update(fullResponseRef, (t) => t + delta).pipe(
            Effect.as(new TextDeltaEvent({ delta }) as ContextEvent)
          )
        ),
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
