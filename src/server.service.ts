/**
 * Generic HTTP Server Service
 *
 * Provides the same abstraction level as the CLI for handling agent requests.
 * Accepts JSONL events (like script mode) and streams back ContextEvents.
 */
import type { AiError, LanguageModel } from "@effect/ai"
import type { Error as PlatformError, FileSystem } from "@effect/platform"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import type { InputEvent } from "./context.model.ts"
import { SystemPromptEvent, UserMessageEvent } from "./context.model.ts"
import { type ContextOrCodemodeEvent, ContextService } from "./context.service.ts"
import type { CodeStorageError, ContextLoadError, ContextSaveError } from "./errors.ts"
import type { CurrentLlmConfig } from "./llm-config.ts"

/** Script mode input events - schema for HTTP parsing */
export const ScriptInputEvent = Schema.Union(UserMessageEvent, SystemPromptEvent)
export type ScriptInputEvent = typeof ScriptInputEvent.Type

export class AgentServer extends Context.Tag("@app/AgentServer")<
  AgentServer,
  {
    /**
     * Handle a request with input events, streaming back ContextEvents.
     * Same semantics as CLI script mode.
     *
     * Note: The returned stream requires LanguageModel, FileSystem, and CurrentLlmConfig
     * to be provided before running.
     */
    readonly handleRequest: (
      contextName: string,
      events: ReadonlyArray<InputEvent>
    ) => Stream.Stream<
      ContextOrCodemodeEvent,
      AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError | CodeStorageError,
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
        events: ReadonlyArray<InputEvent>
      ) => contextService.addEvents(contextName, events, { codemode: true })

      return AgentServer.of({ handleRequest })
    })
  )

  static readonly testLayer = Layer.sync(AgentServer, () =>
    AgentServer.of({
      handleRequest: (_contextName, _events) => Stream.empty
    }))
}
