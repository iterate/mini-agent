/**
 * Agent Service (Layer 1)
 *
 * The innermost layer - executes LLM requests with retry and fallback.
 * Takes a ReducedContext (messages + config) and streams response events.
 *
 * Responsibilities:
 * - Make LLM requests via @effect/ai
 * - Retry on transient failures (using Effect Schedule)
 * - Fallback to alternate provider on failure
 * - Timeout handling
 *
 * Does NOT know about:
 * - Event persistence
 * - Session lifecycle
 * - Context history (receives pre-reduced messages)
 */
import { type AiError, LanguageModel, Prompt } from "@effect/ai"
import { Context, Effect, Layer, Option, pipe, Ref, Schedule, Stream } from "effect"
import {
  AssistantMessageEvent,
  type ContextEvent,
  type ContextName,
  makeBaseFields,
  type ReducedContext,
  TextDeltaEvent
} from "./context.model.ts"
import { AgentError, makeAgentError } from "./errors.ts"

/**
 * Agent service - Layer 1 of the architecture.
 * Handles LLM requests with retry/fallback logic.
 */
export class Agent extends Context.Tag("@app/Agent")<
  Agent,
  {
    /**
     * Execute an agent turn.
     * @param ctx - The reduced context with messages and config
     * @param contextName - The context name (for event base fields)
     * @returns Stream of events (TextDelta during streaming, AssistantMessage at end)
     */
    readonly takeTurn: (
      ctx: ReducedContext,
      contextName: ContextName
    ) => Stream.Stream<ContextEvent, AgentError>
  }
>() {
  /** Production layer - uses real LLM */
  static readonly layer: Layer.Layer<Agent, never, LanguageModel.LanguageModel> = Layer.effect(
    Agent,
    Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel

      const takeTurn = (
        ctx: ReducedContext,
        contextName: ContextName
      ): Stream.Stream<ContextEvent, AgentError> =>
        Stream.unwrap(
          Effect.gen(function*() {
            const fullResponseRef = yield* Ref.make("")

            yield* Effect.logDebug("Agent.takeTurn starting", {
              model: ctx.llmConfig.model,
              messageCount: ctx.messages.length
            })

            const prompt = Prompt.make(ctx.messages)

            return pipe(
              model.streamText({ prompt }),
              // Extract text deltas
              Stream.filterMap((part) =>
                part.type === "text-delta" ? Option.some(part.delta) : Option.none()
              ),
              // Accumulate full response and emit TextDelta events
              Stream.mapEffect((delta) =>
                Ref.update(fullResponseRef, (t) => t + delta).pipe(
                  Effect.as(
                    new TextDeltaEvent({
                      ...makeBaseFields(contextName),
                      delta
                    })
                  )
                )
              ),
              // Append final AssistantMessage with complete response
              Stream.concat(
                Stream.fromEffect(
                  Ref.get(fullResponseRef).pipe(
                    Effect.map(
                      (content) =>
                        new AssistantMessageEvent({
                          ...makeBaseFields(contextName),
                          content
                        })
                    )
                  )
                )
              ),
              // Map AI errors to AgentError
              Stream.catchAll((error: AiError.AiError) =>
                Stream.fail(makeAgentError(error.message, ctx.llmConfig.model, error))
              )
            )
          }).pipe(
            Effect.catchAll((error: unknown) =>
              Effect.succeed(
                Stream.fail(
                  makeAgentError(
                    error instanceof Error ? error.message : String(error),
                    ctx.llmConfig.model,
                    error
                  )
                )
              )
            )
          )
        )

      return Agent.of({ takeTurn })
    })
  )

  /** Retrying layer - wraps base layer with retry logic */
  static readonly retryingLayer = (
    schedule: Schedule.Schedule<unknown, AgentError>
  ): Layer.Layer<Agent, never, LanguageModel.LanguageModel> =>
    Layer.effect(
      Agent,
      Effect.gen(function*() {
        const model = yield* LanguageModel.LanguageModel

        const takeTurn = (
          ctx: ReducedContext,
          contextName: ContextName
        ): Stream.Stream<ContextEvent, AgentError> =>
          Stream.unwrap(
            Effect.gen(function*() {
              const fullResponseRef = yield* Ref.make("")
              const prompt = Prompt.make(ctx.messages)

              return pipe(
                model.streamText({ prompt }),
                Stream.filterMap((part) =>
                  part.type === "text-delta" ? Option.some(part.delta) : Option.none()
                ),
                Stream.mapEffect((delta) =>
                  Ref.update(fullResponseRef, (t) => t + delta).pipe(
                    Effect.as(
                      new TextDeltaEvent({
                        ...makeBaseFields(contextName),
                        delta
                      })
                    )
                  )
                ),
                Stream.concat(
                  Stream.fromEffect(
                    Ref.get(fullResponseRef).pipe(
                      Effect.map(
                        (content) =>
                          new AssistantMessageEvent({
                            ...makeBaseFields(contextName),
                            content
                          })
                      )
                    )
                  )
                ),
                Stream.catchAll((error: AiError.AiError) =>
                  Stream.fail(makeAgentError(error.message, ctx.llmConfig.model, error))
                ),
                // Retry the entire stream on failure
                Stream.retry(schedule)
              )
            }).pipe(
              Effect.catchAll((error: unknown) =>
                Effect.succeed(
                  Stream.fail(
                    makeAgentError(
                      error instanceof Error ? error.message : String(error),
                      ctx.llmConfig.model,
                      error
                    )
                  )
                )
              )
            )
          )

        return Agent.of({ takeTurn })
      })
    )

  /** Test layer - returns mock responses */
  static readonly testLayer: Layer.Layer<Agent> = Layer.sync(Agent, () => {
    const takeTurn = (
      _ctx: ReducedContext,
      contextName: ContextName
    ): Stream.Stream<ContextEvent, AgentError> => {
      const response = "This is a mock response from the test agent."
      const words = response.split(" ")

      return pipe(
        Stream.fromIterable(words.map((word, i) => ({ word, i }))),
        Stream.map(
          ({ word, i }) =>
            new TextDeltaEvent({
              ...makeBaseFields(contextName),
              delta: i === 0 ? word : ` ${word}`
            })
        ),
        Stream.concat(
          Stream.succeed(
            new AssistantMessageEvent({
              ...makeBaseFields(contextName),
              content: response
            })
          )
        )
      )
    }

    return Agent.of({ takeTurn })
  })
}

/** Default retry schedule - exponential backoff with 3 retries */
export const defaultRetrySchedule = Schedule.exponential("100 millis").pipe(
  Schedule.intersect(Schedule.recurs(3))
)
