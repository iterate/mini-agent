/**
 * EventReducer - Pure reducer that folds events into ReducedContext.
 *
 * The reducer is the heart of the event-sourcing pattern. It:
 * - Converts message events to Prompt.Message format
 * - Accumulates config changes
 * - Tracks turn state (started/completed)
 * - Counts events for ID generation
 */

import { Prompt } from "@effect/ai"
import { Effect, Option } from "effect"
import { type ContextEvent, LlmConfig, ReducedContext, ReducerError } from "./domain.ts"

/**
 * EventReducer folds events into ReducedContext.
 */
export class EventReducer extends Effect.Service<EventReducer>()("@mini-agent/EventReducer", {
  effect: Effect.sync(() => {
    const initialReducedContext = ReducedContext.initial()

    const reduceOne = (
      ctx: ReducedContext,
      event: ContextEvent
    ): ReducedContext => {
      // Always increment event count
      const nextEventNumber = ctx.nextEventNumber + 1

      switch (event._tag) {
        case "SystemPromptEvent": {
          const msg = Prompt.systemMessage({ content: event.content })
          return {
            ...ctx,
            messages: [...ctx.messages, msg],
            nextEventNumber
          }
        }

        case "UserMessageEvent": {
          const parts: Array<Prompt.UserMessagePart> = [Prompt.textPart({ text: event.content })]

          // Add image parts if present
          if (event.images && event.images.length > 0) {
            for (const imageData of event.images) {
              // imageData is either a data URI (data:image/...) or a URL
              if (imageData.startsWith("data:")) {
                // Parse data URI: data:image/jpeg;base64,/9j/4AAQ...
                const match = imageData.match(/^data:(image\/[^;]+);base64,(.+)$/)
                if (match) {
                  const [, mediaType, base64Data] = match
                  parts.push(Prompt.filePart({
                    mediaType: mediaType as Prompt.FilePart["mediaType"],
                    data: base64Data!
                  }))
                }
              } else if (imageData.startsWith("http://") || imageData.startsWith("https://")) {
                // URL - pass as-is
                parts.push(Prompt.filePart({
                  mediaType: "image/*" as Prompt.FilePart["mediaType"],
                  data: new URL(imageData)
                }))
              }
            }
          }

          const msg = Prompt.userMessage({ content: parts })
          return {
            ...ctx,
            messages: [...ctx.messages, msg],
            nextEventNumber
          }
        }

        case "AssistantMessageEvent": {
          const msg = Prompt.assistantMessage({
            content: [Prompt.textPart({ text: event.content })]
          })
          return {
            ...ctx,
            messages: [...ctx.messages, msg],
            nextEventNumber
          }
        }

        case "TextDeltaEvent": {
          // TextDelta events don't add to messages - they're streaming intermediates
          return { ...ctx, nextEventNumber }
        }

        case "SetLlmConfigEvent": {
          const newLlmConfig = new LlmConfig({
            apiFormat: event.apiFormat,
            model: event.model,
            baseUrl: event.baseUrl,
            apiKeyEnvVar: event.apiKeyEnvVar
          })
          return { ...ctx, llmConfig: Option.some(newLlmConfig), nextEventNumber }
        }

        case "SessionStartedEvent":
        case "SessionEndedEvent": {
          // Lifecycle events don't affect derived state (except counting)
          return { ...ctx, nextEventNumber }
        }

        case "AgentTurnStartedEvent": {
          return {
            ...ctx,
            agentTurnStartedAtEventId: Option.some(event.id),
            nextEventNumber
          }
        }

        case "AgentTurnCompletedEvent": {
          return {
            ...ctx,
            agentTurnStartedAtEventId: Option.none(),
            currentTurnNumber: event.turnNumber,
            nextEventNumber
          }
        }

        case "AgentTurnInterruptedEvent":
        case "AgentTurnFailedEvent": {
          // Turn ended (failed or interrupted) - clear in-progress state
          return {
            ...ctx,
            agentTurnStartedAtEventId: Option.none(),
            nextEventNumber
          }
        }

        default: {
          // Exhaustiveness check - if a new event type is added, this will cause a compile error
          const _exhaustiveCheck: never = event
          return _exhaustiveCheck
        }
      }
    }

    const reduce = (
      current: ReducedContext,
      newEvents: ReadonlyArray<ContextEvent>
    ): Effect.Effect<ReducedContext, ReducerError> =>
      Effect.try({
        try: () => newEvents.reduce(reduceOne, current),
        catch: (error) =>
          new ReducerError({
            message: `Reducer failed: ${String(error)}`,
            eventTag: Option.none()
          })
      })

    return { reduce, initialReducedContext }
  }),
  accessors: true
}) {}
