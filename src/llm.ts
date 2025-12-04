/**
 * LLM Request
 *
 * Pure function that takes persisted events and produces a stream of context events.
 */
import { type AiError, LanguageModel, Prompt } from "@effect/ai"
import { type Error as PlatformError, FileSystem } from "@effect/platform"
import { Effect, Option, pipe, Ref, Schema, Stream } from "effect"
import {
  AssistantMessageEvent,
  type ContextEvent,
  FileAttachmentEvent,
  type PersistedEvent,
  SystemPromptEvent,
  TextDeltaEvent,
  UserMessageEvent
} from "./context.model.ts"
import { CurrentLlmConfig } from "./llm-config.ts"

// =============================================================================
// Event to Prompt Conversion
// =============================================================================

const isSystem = Schema.is(SystemPromptEvent)
const isAssistant = Schema.is(AssistantMessageEvent)
const isUser = Schema.is(UserMessageEvent)
const isFile = Schema.is(FileAttachmentEvent)

/**
 * Groups consecutive user events (messages + attachments) into single multi-part messages.
 * File attachments are read at call time, not persisted as base64.
 */
const eventsToPrompt = (
  events: ReadonlyArray<PersistedEvent>
): Effect.Effect<Prompt.Prompt, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const messages: Array<Prompt.Message> = []

    let i = 0
    while (i < events.length) {
      const event = events[i]!

      if (isSystem(event)) {
        messages.push(Prompt.makeMessage("system", { content: event.content }))
        i++
      } else if (isAssistant(event)) {
        messages.push(
          Prompt.makeMessage("assistant", {
            content: [Prompt.makePart("text", { text: event.content })]
          })
        )
        i++
      } else if (isUser(event) || isFile(event)) {
        // Consecutive user/file events become a single multi-part user message
        const userParts: Array<Prompt.UserMessagePart> = []

        while (i < events.length) {
          const e = events[i]!
          if (isFile(e)) {
            if (e.source.type === "file") {
              const bytes = yield* fs.readFile(e.source.path)
              userParts.push(
                Prompt.makePart("file", {
                  mediaType: e.mediaType,
                  data: bytes,
                  fileName: e.fileName
                })
              )
            } else {
              userParts.push(
                Prompt.makePart("file", {
                  mediaType: e.mediaType,
                  data: new URL(e.source.url),
                  fileName: e.fileName
                })
              )
            }
            i++
          } else if (isUser(e)) {
            userParts.push(Prompt.makePart("text", { text: e.content }))
            i++
          } else {
            break
          }
        }

        if (userParts.length > 0) {
          messages.push(Prompt.makeMessage("user", { content: userParts }))
        }
      } else {
        i++
      }
    }

    return Prompt.make(messages)
  })

/**
 * Stream an LLM response from persisted conversation events.
 *
 * Takes the full conversation history and produces:
 * 1. TextDelta events for each streaming chunk (ephemeral)
 * 2. A final AssistantMessage event with the complete response (persisted)
 */
export const streamLLMResponse = (
  events: ReadonlyArray<PersistedEvent>
): Stream.Stream<
  ContextEvent,
  AiError.AiError | PlatformError.PlatformError,
  LanguageModel.LanguageModel | FileSystem.FileSystem | CurrentLlmConfig
> =>
  Stream.unwrap(
    Effect.fn("LLM.streamLLMResponse")(function*() {
      const model = yield* LanguageModel.LanguageModel
      const llmConfig = yield* CurrentLlmConfig
      const fullResponseRef = yield* Ref.make("")
      yield* Effect.logDebug(`Streaming LLM response`, {
        model: llmConfig.model,
        apiFormat: llmConfig.apiFormat
      })

      // Convert events to @effect/ai Prompt format
      const prompt = yield* eventsToPrompt(events)

      return pipe(
        model.streamText({ prompt }),
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
