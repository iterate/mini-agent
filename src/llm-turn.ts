/**
 * LlmTurn - Production MiniAgentTurn implementation.
 *
 * Converts ReducedContext.messages to @effect/ai Prompt format
 * and streams LLM responses as TextDeltaEvent + AssistantMessageEvent.
 */

import { type AiError, LanguageModel, Prompt } from "@effect/ai"
import { DateTime, Effect, Layer, Option, pipe, Ref, Stream } from "effect"
import {
  AgentError,
  type AgentName,
  AssistantMessageEvent,
  type ContextEvent,
  type EventId,
  type LlmProviderId,
  MiniAgentTurn,
  type ReducedContext,
  TextDeltaEvent
} from "./domain.ts"
import { CurrentLlmConfig } from "./llm-config.ts"

/**
 * Convert ReducedContext messages to @effect/ai Prompt.
 * Messages are already in Prompt.Message format from the reducer.
 */
const contextToPrompt = (ctx: ReducedContext): Prompt.Prompt => Prompt.make(ctx.messages as Array<Prompt.Message>)

/**
 * Map @effect/ai errors to our AgentError type.
 */
const mapAiError = (providerId: LlmProviderId) => (error: AiError.AiError): AgentError =>
  new AgentError({
    message: `LLM request failed: ${error.message}`,
    provider: providerId,
    cause: Option.some(error)
  })

/**
 * Production MiniAgentTurn layer.
 * Captures LanguageModel and CurrentLlmConfig at layer creation time.
 *
 * Note: Events created here use placeholder IDs and agentName since the turn service
 * doesn't have access to agent context. The IDs are unique via timestamp+counter
 * and events are persisted by the agent which assigns them to the correct context.
 */
export const LlmTurnLive: Layer.Layer<
  MiniAgentTurn,
  never,
  LanguageModel.LanguageModel | CurrentLlmConfig
> = Layer.effect(
  MiniAgentTurn,
  Effect.gen(function*() {
    // Capture services at layer creation time
    const model = yield* LanguageModel.LanguageModel
    const llmConfig = yield* CurrentLlmConfig

    // Global counter for unique event IDs within this turn service instance
    let eventCounter = 0

    return {
      execute: (ctx: ReducedContext): Stream.Stream<ContextEvent, AgentError> =>
        Stream.unwrap(
          Effect.gen(function*() {
            const fullResponseRef = yield* Ref.make("")
            const turnStartTime = Date.now()

            const prompt = contextToPrompt(ctx)
            const providerId = llmConfig.apiFormat as LlmProviderId

            yield* Effect.logDebug("Streaming LLM response", {
              model: llmConfig.model,
              apiFormat: llmConfig.apiFormat,
              messageCount: ctx.messages.length
            })

            // Placeholder context for events created during LLM turn
            const placeholderAgentName = "llm-turn" as AgentName

            const makeEventId = (): EventId => {
              eventCounter++
              return `llm-${turnStartTime}-${eventCounter}` as EventId
            }

            return pipe(
              model.streamText({ prompt }),
              Stream.filterMap((part) => part.type === "text-delta" ? Option.some(part.delta) : Option.none()),
              Stream.mapEffect((delta) =>
                Ref.update(fullResponseRef, (t) => t + delta).pipe(
                  Effect.as(
                    new TextDeltaEvent({
                      id: makeEventId(),
                      timestamp: DateTime.unsafeNow(),
                      agentName: placeholderAgentName,
                      parentEventId: Option.none(),
                      triggersAgentTurn: false,
                      delta
                    }) as ContextEvent
                  )
                )
              ),
              Stream.concat(
                Stream.fromEffect(
                  Ref.get(fullResponseRef).pipe(
                    Effect.map(
                      (content) =>
                        new AssistantMessageEvent({
                          id: makeEventId(),
                          timestamp: DateTime.unsafeNow(),
                          agentName: placeholderAgentName,
                          parentEventId: Option.none(),
                          triggersAgentTurn: false,
                          content
                        }) as ContextEvent
                    )
                  )
                )
              ),
              Stream.mapError(mapAiError(providerId))
            )
          })
        )
    } as unknown as MiniAgentTurn
  })
)
