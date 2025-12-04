/**
 * Generic HTTP Server Service
 *
 * Provides the same abstraction level as the CLI for handling agent requests.
 * Accepts JSONL events (like script mode) and streams back ContextEvents.
 */
import type { AiError, LanguageModel } from "@effect/ai"
import type { Error as PlatformError, FileSystem } from "@effect/platform"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import type { ContextEvent, InputEvent } from "../context.model.ts"
import { SystemPromptEvent, UserMessageEvent } from "../context.model.ts"
import { ContextService } from "../context.service.ts"
import type { ContextLoadError, ContextSaveError } from "../errors.ts"
import type { CurrentLlmConfig } from "../llm-config.ts"

/** Script mode input events - same as CLI script mode */
export const ScriptInputEvent = Schema.Union(UserMessageEvent, SystemPromptEvent)
export type ScriptInputEvent = typeof ScriptInputEvent.Type

export class AgentServer extends Context.Tag("@app/AgentServer")<
  AgentServer,
  {
    /**
     * Handle a request with JSONL events, streaming back ContextEvents.
     * Same semantics as CLI script mode.
     *
     * Note: The returned stream requires LanguageModel, FileSystem, and CurrentLlmConfig
     * to be provided before running.
     */
    readonly handleRequest: (
      contextName: string,
      events: ReadonlyArray<ScriptInputEvent>
    ) => Stream.Stream<
      ContextEvent,
      AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError,
      LanguageModel.LanguageModel | FileSystem.FileSystem | CurrentLlmConfig
    >
  }
>() {
  static readonly layer = Layer.effect(
    AgentServer,
    Effect.gen(function*() {
      const contextService = yield* ContextService

      const handleRequest = (
        contextName: string,
        events: ReadonlyArray<ScriptInputEvent>
      ) => {
        // Filter to InputEvents (UserMessage only - SystemPrompt not supported as input)
        const inputEvents = events.filter(Schema.is(UserMessageEvent)) as ReadonlyArray<InputEvent>

        return contextService.addEvents(contextName, inputEvents)
      }

      return AgentServer.of({ handleRequest })
    })
  )

  static readonly testLayer = Layer.sync(AgentServer, () =>
    AgentServer.of({
      handleRequest: (_contextName, _events) => Stream.empty
    }))
}
