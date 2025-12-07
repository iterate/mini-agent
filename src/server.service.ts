/**
 * Generic HTTP Server Service
 *
 * Provides the same abstraction level as the CLI for handling agent requests.
 * Accepts JSONL events (like script mode) and streams back ContextEvents.
 */
import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { AgentRegistry } from "./agent-registry.ts"
import {
  type AgentName,
  type ContextEvent,
  type ContextSaveError,
  DEFAULT_SYSTEM_PROMPT,
  EventBuilder,
  type ReducerError
} from "./domain.ts"

/** Script mode input events - schema for HTTP parsing */
export const ScriptInputEvent = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("UserMessage"), content: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("SystemPrompt"), content: Schema.String })
)
export type ScriptInputEvent = typeof ScriptInputEvent.Type

/** Input event type for handleRequest */
export type InputEvent = ScriptInputEvent

export class AgentServer extends Context.Tag("@app/AgentServer")<
  AgentServer,
  {
    /**
     * Handle a request with input events, streaming back ContextEvents.
     * Same semantics as CLI script mode.
     */
    readonly handleRequest: (
      contextName: string,
      events: ReadonlyArray<InputEvent>
    ) => Stream.Stream<ContextEvent, ReducerError | ContextSaveError, never>
  }
>() {
  static readonly layer = Layer.effect(
    AgentServer,
    Effect.gen(function*() {
      const registry = yield* AgentRegistry

      const handleRequest = (
        contextName: string,
        inputEvents: ReadonlyArray<InputEvent>
      ): Stream.Stream<ContextEvent, ReducerError | ContextSaveError, never> =>
        Stream.asyncScoped<ContextEvent, ReducerError | ContextSaveError>((emit) =>
          Effect.gen(function*() {
            const agentName = contextName as AgentName
            const agent = yield* registry.getOrCreate(agentName)

            // Check if context needs initialization
            const ctx = yield* agent.getReducedContext
            if (ctx.messages.length === 0) {
              // Check if input events contain a system prompt
              const hasSystemPrompt = inputEvents.some((e) => e._tag === "SystemPrompt")
              if (!hasSystemPrompt) {
                const systemEvent = EventBuilder.systemPrompt(
                  agentName,
                  agent.contextName,
                  ctx.nextEventNumber,
                  DEFAULT_SYSTEM_PROMPT
                )
                yield* agent.addEvent(systemEvent)
              }
            }

            // Subscribe to agent events BEFORE adding input events
            const streamFiber = yield* agent.events.pipe(
              Stream.takeUntil((e) => e._tag === "AgentTurnCompletedEvent" || e._tag === "AgentTurnFailedEvent"),
              Stream.tap((event) => Effect.sync(() => emit.single(event))),
              Stream.runDrain,
              Effect.ensuring(Effect.sync(() => emit.end())),
              Effect.fork
            )

            // Add input events to agent
            for (const event of inputEvents) {
              const currentCtx = yield* agent.getReducedContext
              if (event._tag === "UserMessage") {
                const userEvent = EventBuilder.userMessage(
                  agentName,
                  agent.contextName,
                  currentCtx.nextEventNumber,
                  event.content
                )
                yield* agent.addEvent(userEvent)
              } else if (event._tag === "SystemPrompt") {
                const systemEvent = EventBuilder.systemPrompt(
                  agentName,
                  agent.contextName,
                  currentCtx.nextEventNumber,
                  event.content
                )
                yield* agent.addEvent(systemEvent)
              }
            }

            // Wait for stream to complete
            yield* Fiber.join(streamFiber)
          })
        )

      return AgentServer.of({ handleRequest })
    })
  )

  static readonly testLayer = Layer.sync(AgentServer, () =>
    AgentServer.of({
      handleRequest: (_contextName, _events) => Stream.empty
    }))
}
