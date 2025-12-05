/**
 * Context Service
 *
 * The main domain service for working with Contexts.
 *
 * A Context is a named, ordered list of events representing a conversation.
 * The only supported operation is `addEvents`:
 * 1. Appends input events (typically UserMessage) to the context
 * 2. Triggers an LLM request with the full event history
 * 3. Streams back new events (TextDelta ephemeral, AssistantMessage persisted)
 * 4. Persists the new events to the context file
 */
import type { AiError, LanguageModel } from "@effect/ai"
import type { Error as PlatformError, FileSystem } from "@effect/platform"
import { Context, Effect, Layer, Option, pipe, Schema, Stream } from "effect"
import { parseCodeBlock } from "./codemode.model.ts"
import type { CodemodeStreamEvent } from "./codemode.service.ts"
import { CodemodeService } from "./codemode.service.ts"
import {
  AssistantMessageEvent,
  CODEMODE_SYSTEM_PROMPT,
  CodemodeResultEvent,
  type ContextEvent,
  DEFAULT_SYSTEM_PROMPT,
  type InputEvent,
  PersistedEvent,
  type PersistedEvent as PersistedEventType,
  SetLlmConfigEvent,
  SystemPromptEvent,
  TextDeltaEvent
} from "./context.model.ts"
import { ContextRepository } from "./context.repository.ts"
import type { CodeStorageError, ContextLoadError, ContextSaveError } from "./errors.ts"
import { CurrentLlmConfig, LlmConfig } from "./llm-config.ts"
import { streamLLMResponse } from "./llm.ts"

/** Options for addEvents */
export interface AddEventsOptions {
  readonly codemode?: boolean
}

/** Union of context events and codemode streaming events */
export type ContextOrCodemodeEvent = ContextEvent | CodemodeStreamEvent

/** Maximum number of agent loop iterations before forcing endTurn */
const MAX_AGENT_LOOP_ITERATIONS = 3

export class ContextService extends Context.Tag("@app/ContextService")<
  ContextService,
  {
    /**
     * Add events to a context, triggering LLM processing if UserMessage present.
     *
     * This is the core operation on a Context:
     * 1. Loads existing events (or creates context with system prompt)
     * 2. Appends the input events (UserMessage and/or FileAttachment)
     * 3. Runs LLM with full history (only if UserMessage present)
     * 4. Streams back TextDelta (ephemeral) and AssistantMessage (persisted)
     * 5. If codemode enabled, executes code blocks and streams codemode events
     * 6. Persists new events as they complete (including CodemodeResult)
     */
    readonly addEvents: (
      contextName: string,
      inputEvents: ReadonlyArray<InputEvent>,
      options?: AddEventsOptions
    ) => Stream.Stream<
      ContextOrCodemodeEvent,
      AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError | CodeStorageError,
      LanguageModel.LanguageModel | FileSystem.FileSystem | CurrentLlmConfig
    >

    /** Load all events from a context. */
    readonly load: (contextName: string) => Effect.Effect<Array<PersistedEventType>, ContextLoadError>

    /** List all context names. */
    readonly list: () => Effect.Effect<Array<string>, ContextLoadError>

    /** Persist an event directly (e.g., LLMRequestInterruptedEvent on cancel). */
    readonly persistEvent: (
      contextName: string,
      event: PersistedEventType
    ) => Effect.Effect<void, ContextLoadError | ContextSaveError>
  }
>() {
  /**
   * Production layer with file system persistence and LLM integration.
   */
  static readonly layer = Layer.effect(
    ContextService,
    Effect.gen(function*() {
      const repo = yield* ContextRepository
      const codemodeService = yield* CodemodeService

      // Service methods wrapped with Effect.fn for call-site tracing
      // See: https://www.effect.solutions/services-and-layers

      const addEvents = (
        contextName: string,
        inputEvents: ReadonlyArray<InputEvent>,
        options?: AddEventsOptions
      ): Stream.Stream<
        ContextOrCodemodeEvent,
        AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError | CodeStorageError,
        LanguageModel.LanguageModel | FileSystem.FileSystem | CurrentLlmConfig
      > => {
        // Check if any event should trigger an agent turn
        const shouldTriggerAgent = inputEvents.some(
          (e) => "triggerAgentTurn" in e && e.triggerAgentTurn === "after-current-turn"
        )
        const codemodeEnabled = options?.codemode ?? false

        /** Persist a single event to the context */
        const persistEvent = (event: PersistedEventType) =>
          Effect.gen(function*() {
            const current = yield* repo.load(contextName)
            yield* repo.save(contextName, [...current, event])
          })

        /** Check if stdout has non-whitespace output (determines agent loop continuation) */
        const hasNonWhitespaceOutput = (stdout: string): boolean => stdout.trim().length > 0

        /** Process codemode if enabled and assistant has code blocks */
        const processCodemodeIfNeeded = (
          assistantContent: string
        ): Stream.Stream<
          ContextOrCodemodeEvent,
          PlatformError.PlatformError | CodeStorageError | ContextLoadError | ContextSaveError,
          never
        > => {
          if (!codemodeEnabled) {
            return Stream.empty
          }

          return Stream.unwrap(
            Effect.gen(function*() {
              // Check if there's a code block
              const codeOpt = yield* parseCodeBlock(assistantContent)
              if (Option.isNone(codeOpt)) {
                return Stream.empty
              }

              // Get the codemode stream
              const streamOpt = yield* codemodeService.processResponse(contextName, assistantContent)
              if (Option.isNone(streamOpt)) {
                return Stream.empty
              }

              // Track stdout/stderr/exitCode for CodemodeResult
              let stdout = ""
              let stderr = ""
              let exitCode = 0
              let typecheckFailed = false
              let typecheckErrors = ""

              // Process codemode events and collect output
              return pipe(
                streamOpt.value,
                Stream.tap((event) =>
                  Effect.sync(() => {
                    switch (event._tag) {
                      case "ExecutionOutput":
                        if (event.stream === "stdout") {
                          stdout += event.data
                        } else {
                          stderr += event.data
                        }
                        break
                      case "ExecutionComplete":
                        exitCode = event.exitCode
                        break
                      case "TypecheckFail":
                        typecheckFailed = true
                        typecheckErrors = event.errors
                        break
                    }
                  })
                ),
                // After codemode stream completes, emit CodemodeResult
                Stream.concat(
                  Stream.fromEffect(
                    Effect.gen(function*() {
                      if (typecheckFailed) {
                        // Typecheck failed - create result with errors so LLM can retry
                        const result = new CodemodeResultEvent({
                          stdout: "",
                          stderr: `TypeScript errors:\n${typecheckErrors}`,
                          exitCode: 1,
                          triggerAgentTurn: "after-current-turn" // Continue loop so LLM can fix
                        })
                        yield* persistEvent(result)
                        return result as ContextOrCodemodeEvent
                      }

                      const result = new CodemodeResultEvent({
                        stdout,
                        stderr,
                        exitCode,
                        triggerAgentTurn: hasNonWhitespaceOutput(stdout) ? "after-current-turn" : "never"
                      })
                      yield* persistEvent(result)
                      return result as ContextOrCodemodeEvent
                    })
                  )
                )
              )
            })
          )
        }

        /** Agent loop: process LLM response, execute codemode, and loop if endTurn=false */
        const agentLoopStream = (
          currentEvents: ReadonlyArray<PersistedEventType>,
          iteration: number = 1
        ): Stream.Stream<
          ContextOrCodemodeEvent,
          AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError | CodeStorageError,
          LanguageModel.LanguageModel | FileSystem.FileSystem | CurrentLlmConfig
        > =>
          pipe(
            streamLLMResponse(currentEvents),
            Stream.tap((event) =>
              Schema.is(PersistedEvent)(event) ? persistEvent(event as PersistedEventType) : Effect.void
            ),
            // After AssistantMessage, process codemode if enabled
            Stream.flatMap((event) =>
              Schema.is(AssistantMessageEvent)(event)
                ? pipe(
                  Stream.make(event as ContextOrCodemodeEvent),
                  Stream.concat(processCodemodeIfNeeded(event.content))
                )
                : Stream.make(event as ContextOrCodemodeEvent)
            ),
            // Check if we need to continue the loop (triggerAgentTurn=after-current-turn)
            Stream.flatMap((event) => {
              if (Schema.is(CodemodeResultEvent)(event) && event.triggerAgentTurn === "after-current-turn") {
                // Check max iterations
                if (iteration >= MAX_AGENT_LOOP_ITERATIONS) {
                  return pipe(
                    Stream.make(event as ContextOrCodemodeEvent),
                    Stream.concat(
                      Stream.fromEffect(
                        Effect.gen(function*() {
                          yield* Effect.logWarning(
                            `Agent loop reached max iterations (${MAX_AGENT_LOOP_ITERATIONS}), forcing end`
                          )
                          // Persist a final result indicating forced stop
                          const forcedResult = new CodemodeResultEvent({
                            stdout: event.stdout,
                            stderr: event.stderr + "\n[Agent loop reached maximum iterations]",
                            exitCode: event.exitCode,
                            triggerAgentTurn: "never"
                          })
                          yield* persistEvent(forcedResult)
                          return forcedResult as ContextOrCodemodeEvent
                        })
                      )
                    )
                  )
                }

                // Continue agent loop: reload context and stream new LLM response
                return pipe(
                  Stream.make(event as ContextOrCodemodeEvent),
                  Stream.concat(
                    Stream.unwrap(
                      Effect.gen(function*() {
                        yield* Effect.logDebug(`Agent loop continuing (iteration ${iteration + 1})`)
                        const reloadedEvents = yield* repo.load(contextName)
                        return agentLoopStream(reloadedEvents, iteration + 1)
                      })
                    )
                  )
                )
              }
              return Stream.make(event)
            })
          )

        /** Replace the system prompt with codemode prompt if codemode is enabled */
        const ensureCodemodePrompt = (events: Array<PersistedEventType>): Array<PersistedEventType> => {
          if (!codemodeEnabled) return events
          if (events.length === 0) return events

          // If first event is a SystemPrompt, replace it with codemode prompt
          const first = events[0]
          if (first && Schema.is(SystemPromptEvent)(first)) {
            return [
              new SystemPromptEvent({ content: CODEMODE_SYSTEM_PROMPT }),
              ...events.slice(1)
            ]
          }
          return events
        }

        return pipe(
          // Load or create context, append input events
          Effect.fn("ContextService.addEvents.prepare")(function*() {
            const llmConfig = yield* CurrentLlmConfig

            // Check if context exists before loading/creating
            const existingEvents = yield* repo.load(contextName)
            const isNewContext = existingEvents.length === 0

            // If new context, create with system prompt and LLM config
            const baseEvents = isNewContext
              ? [
                new SystemPromptEvent({ content: DEFAULT_SYSTEM_PROMPT }),
                new SetLlmConfigEvent({ config: llmConfig })
              ]
              : existingEvents

            const newPersistedInputs = inputEvents.filter(Schema.is(PersistedEvent)) as Array<PersistedEventType>

            // Apply codemode system prompt if needed
            const eventsWithPrompt = ensureCodemodePrompt(baseEvents)

            if (isNewContext || newPersistedInputs.length > 0) {
              const allEvents = [...eventsWithPrompt, ...newPersistedInputs]
              yield* repo.save(contextName, allEvents)
              return allEvents
            }
            return eventsWithPrompt
          })(),
          // Only stream LLM response if an event triggers agent turn
          Effect.andThen((events) => shouldTriggerAgent ? agentLoopStream(events) : Stream.empty),
          Stream.unwrap
        )
      }

      const load = Effect.fn("ContextService.load")(
        function*(contextName: string) {
          return yield* repo.load(contextName)
        }
      )

      const list = Effect.fn("ContextService.list")(
        function*() {
          return yield* repo.list()
        }
      )

      const persistEvent = Effect.fn("ContextService.persistEvent")(
        function*(contextName: string, event: PersistedEventType) {
          const current = yield* repo.load(contextName)
          yield* repo.save(contextName, [...current, event])
        }
      )

      return ContextService.of({
        addEvents,
        load,
        list,
        persistEvent
      })
    })
  )

  /**
   * Test layer with mock LLM responses for unit tests.
   * See: https://www.effect.solutions/testing
   */
  static readonly testLayer = Layer.sync(ContextService, () => {
    // In-memory store for test contexts
    const store = new Map<string, Array<PersistedEventType>>()

    // Mock LLM config for tests
    const mockLlmConfig = new LlmConfig({
      apiFormat: "openai-responses",
      model: "test-model",
      baseUrl: "https://api.test.com",
      apiKeyEnvVar: "TEST_API_KEY"
    })

    return ContextService.of({
      addEvents: (
        contextName: string,
        inputEvents: ReadonlyArray<InputEvent>,
        _options?: AddEventsOptions
      ): Stream.Stream<ContextOrCodemodeEvent, never, never> => {
        // Load or create context
        let events = store.get(contextName)
        if (!events) {
          events = [
            new SystemPromptEvent({ content: "Test system prompt" }),
            new SetLlmConfigEvent({ config: mockLlmConfig })
          ]
          store.set(contextName, events)
        }

        // Add input events
        const newPersistedInputs = inputEvents.filter(Schema.is(PersistedEvent)) as Array<PersistedEventType>
        if (newPersistedInputs.length > 0) {
          events = [...events, ...newPersistedInputs]
          store.set(contextName, events)
        }

        // Check if any event should trigger an agent turn
        const shouldTriggerAgent = inputEvents.some(
          (e) => "triggerAgentTurn" in e && e.triggerAgentTurn === "after-current-turn"
        )

        // Only generate mock LLM response if an event triggers agent turn
        if (!shouldTriggerAgent) {
          return Stream.empty
        }

        // Mock LLM response stream (codemode not implemented in test layer)
        const mockResponse = "This is a mock response for testing."
        const assistantEvent = new AssistantMessageEvent({ content: mockResponse })

        return pipe(
          Stream.make(
            new TextDeltaEvent({ delta: mockResponse }) as ContextOrCodemodeEvent,
            assistantEvent as ContextOrCodemodeEvent
          ),
          Stream.tap((event) =>
            Schema.is(PersistedEvent)(event)
              ? Effect.sync(() => {
                const current = store.get(contextName) ?? []
                store.set(contextName, [...current, event as PersistedEventType])
              })
              : Effect.void
          )
        )
      },

      load: (contextName: string) => Effect.succeed(store.get(contextName) ?? []),

      list: () => Effect.sync(() => Array.from(store.keys()).sort()),

      persistEvent: (contextName: string, event: PersistedEventType) =>
        Effect.sync(() => {
          const current = store.get(contextName) ?? []
          store.set(contextName, [...current, event])
        })
    })
  })
}
