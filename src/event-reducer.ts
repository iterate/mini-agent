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
import {
  AgentConfig,
  type ContextEvent,
  defaultAgentConfig,
  LlmProviderConfig,
  type ReducedContext,
  ReducerError
} from "./domain.ts"

/**
 * EventReducer folds events into ReducedContext.
 */
export class EventReducer extends Effect.Service<EventReducer>()("@mini-agent/EventReducer", {
  effect: Effect.sync(() => {
    const initialReducedContext: ReducedContext = {
      messages: [],
      config: defaultAgentConfig,
      nextEventNumber: 0,
      currentTurnNumber: 0 as never,
      agentTurnStartedAtEventId: Option.none()
    }

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
          const msg = Prompt.userMessage({
            content: [Prompt.textPart({ text: event.content })]
          })
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

        case "FileAttachmentEvent": {
          // File attachments are handled during LLM request, not stored in messages
          return { ...ctx, nextEventNumber }
        }

        case "SetLlmConfigEvent": {
          const providerConfig = new LlmProviderConfig({
            providerId: event.providerId,
            model: event.model,
            apiKey: event.apiKey,
            baseUrl: event.baseUrl
          })

          const newConfig = event.asFallback
            ? new AgentConfig({
              primary: ctx.config.primary,
              fallback: Option.some(providerConfig),
              timeoutMs: ctx.config.timeoutMs
            })
            : new AgentConfig({
              primary: providerConfig,
              fallback: ctx.config.fallback,
              timeoutMs: ctx.config.timeoutMs
            })

          return { ...ctx, config: newConfig, nextEventNumber }
        }

        case "SetTimeoutEvent": {
          const newConfig = new AgentConfig({
            primary: ctx.config.primary,
            fallback: ctx.config.fallback,
            timeoutMs: event.timeoutMs
          })
          return { ...ctx, config: newConfig, nextEventNumber }
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
