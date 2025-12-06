/**
 * LlmTurn - Production MiniAgentTurn implementation.
 *
 * Converts ReducedContext.messages to @effect/ai Prompt format
 * and streams LLM responses as TextDeltaEvent + AssistantMessageEvent.
 */

import { type AiError, LanguageModel, Prompt } from "@effect/ai"
import { Effect, Layer, Option, pipe, Ref, Stream } from "effect"
import { CurrentLlmConfig } from "../llm-config.ts"
import {
  AgentError,
  AssistantMessageEvent,
  type ContextEvent,
  type LlmProviderId,
  MiniAgentTurn,
  type ReducedContext,
  TextDeltaEvent
} from "./domain.ts"

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

    return {
      execute: (ctx: ReducedContext): Stream.Stream<ContextEvent, AgentError> =>
        Stream.unwrap(
          Effect.gen(function*() {
            const fullResponseRef = yield* Ref.make("")

            const prompt = contextToPrompt(ctx)
            const providerId = llmConfig.apiFormat as LlmProviderId

            yield* Effect.logDebug("Streaming LLM response", {
              model: llmConfig.model,
              apiFormat: llmConfig.apiFormat,
              messageCount: ctx.messages.length
            })

            return pipe(
              model.streamText({ prompt }),
              Stream.filterMap((part) => part.type === "text-delta" ? Option.some(part.delta) : Option.none()),
              Stream.mapEffect((delta) =>
                Ref.update(fullResponseRef, (t) => t + delta).pipe(
                  Effect.as(
                    new TextDeltaEvent({
                      id: `delta-${Date.now()}` as never,
                      timestamp: new Date() as never,
                      agentName: "" as never,
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
                          id: `assistant-${Date.now()}` as never,
                          timestamp: new Date() as never,
                          agentName: "" as never,
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
