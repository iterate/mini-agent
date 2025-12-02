import { Effect, Stream, Ref, Option, pipe } from "effect"
import { LanguageModel, AiError } from "@effect/ai"
import {
  PersistedEvent,
  type ContextEvent,
  TextDeltaEvent,
  AssistantMessageEvent
} from "./schema.ts"

// =============================================================================
// Pure LLM Request
// =============================================================================

/**
 * Makes an LLM request with the given events.
 * This is a pure function with no file system dependency.
 * 
 * @param events - Array of persisted events to use as conversation history
 * @returns Stream of context events (TextDelta for streaming, AssistantMessage at end)
 */
export const makeLLMRequest = (
  events: ReadonlyArray<PersistedEvent>
): Stream.Stream<ContextEvent, AiError.AiError, LanguageModel.LanguageModel> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel
      const fullResponseRef = yield* Ref.make("")

      return pipe(
        events,
        (evts) => evts.map((event) => {
          switch (event._tag) {
            case "SystemPrompt":
              return { role: "system" as const, content: event.content }
            case "UserMessage":
              return { role: "user" as const, content: event.content }
            case "AssistantMessage":
              return { role: "assistant" as const, content: event.content }
          }
        }),
        (messages) => model.streamText({ prompt: messages }),
        Stream.filterMap((part) =>
          part.type === "text-delta" ? Option.some(part.delta) : Option.none()
        ),
        Stream.mapEffect((delta) =>
          Ref.update(fullResponseRef, (t) => t + delta).pipe(
            Effect.as(TextDeltaEvent.make({ delta }))
          )
        ),
        Stream.concat(
          Stream.fromEffect(
            Ref.get(fullResponseRef).pipe(
              Effect.map((content) => AssistantMessageEvent.make({ content }))
            )
          )
        )
      )
    })
  )

