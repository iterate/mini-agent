/**
 * EventReducer Service (Layer 2)
 *
 * Pure functional reducer that folds events into a ReducedContext.
 * Takes (current state, new events) and returns updated state.
 *
 * Responsibilities:
 * - Apply events to accumulator (pure function)
 * - Build Prompt.Message array from content events
 * - Update config from configuration events
 * - Validate reduced state
 *
 * Does NOT know about:
 * - Where events are stored
 * - How agent turns are executed
 * - Session lifecycle
 */
import { type Error as PlatformError, FileSystem } from "@effect/platform"
import { Prompt } from "@effect/ai"
import { Context, Effect, Layer, Option } from "effect"
import {
  AssistantMessageEvent,
  type ContextEvent,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TIMEOUT_MS,
  FileAttachmentEvent,
  type ReducedContext,
  SetLlmConfigEvent,
  SetTimeoutEvent,
  SystemPromptEvent,
  UserMessageEvent
} from "./context.model.ts"
import { makeReducerError, ReducerError } from "./errors.ts"
import { DEFAULT_LLM, getLlmConfig, type LlmConfig } from "./llm-config.ts"

/** Internal accumulator state during reduction */
interface ReducerState {
  readonly messages: Array<Prompt.Message>
  readonly llmConfig: LlmConfig
  readonly timeoutMs: number
  readonly pendingUserParts: Array<Prompt.UserMessagePart>
}

/** Flush any pending user parts into a user message */
const flushUserParts = (state: ReducerState): ReducerState => {
  if (state.pendingUserParts.length === 0) return state
  return {
    ...state,
    messages: [
      ...state.messages,
      Prompt.makeMessage("user", { content: state.pendingUserParts })
    ],
    pendingUserParts: []
  }
}

/**
 * EventReducer service - Layer 2 of the architecture.
 * Pure functional reducer for event-sourced state.
 */
export class EventReducer extends Context.Tag("@app/EventReducer")<
  EventReducer,
  {
    /**
     * Reduce events into a ReducedContext.
     * @param current - Current reduced state
     * @param newEvents - New events to apply
     * @returns Updated ReducedContext
     */
    readonly reduce: (
      current: ReducedContext,
      newEvents: ReadonlyArray<ContextEvent>
    ) => Effect.Effect<ReducedContext, ReducerError, FileSystem.FileSystem>

    /** Initial empty reduced context */
    readonly initialReducedContext: ReducedContext
  }
>() {
  /** Default reducer - keeps all messages */
  static readonly layer: Layer.Layer<EventReducer> = Layer.succeed(
    EventReducer,
    EventReducer.of({
      reduce: (current, newEvents) =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem

          // Start with current state converted to internal format
          let state: ReducerState = {
            messages: [...current.messages],
            llmConfig: current.llmConfig,
            timeoutMs: current.timeoutMs,
            pendingUserParts: []
          }

          for (const event of newEvents) {
            state = yield* applyEvent(state, event, fs)
          }

          // Flush any remaining user parts
          state = flushUserParts(state)

          return {
            messages: state.messages,
            llmConfig: state.llmConfig,
            timeoutMs: state.timeoutMs
          }
        }),

      initialReducedContext: {
        messages: [
          Prompt.makeMessage("system", { content: DEFAULT_SYSTEM_PROMPT })
        ],
        llmConfig: getLlmConfig(DEFAULT_LLM),
        timeoutMs: DEFAULT_TIMEOUT_MS
      }
    })
  )

  /** Test layer with mock implementation */
  static readonly testLayer: Layer.Layer<EventReducer> = Layer.succeed(
    EventReducer,
    EventReducer.of({
      reduce: (current, _newEvents) => Effect.succeed(current),
      initialReducedContext: {
        messages: [],
        llmConfig: getLlmConfig(DEFAULT_LLM),
        timeoutMs: DEFAULT_TIMEOUT_MS
      }
    })
  )
}

/** Apply a single event to the reducer state */
const applyEvent = (
  state: ReducerState,
  event: ContextEvent,
  fs: FileSystem.FileSystem
): Effect.Effect<ReducerState, ReducerError, never> =>
  Effect.gen(function*() {
    switch (event._tag) {
      case "SystemPrompt": {
        // System prompts replace any existing system message
        const e = event as SystemPromptEvent
        const filtered = state.messages.filter((m) => m.role !== "system")
        return flushUserParts({
          ...state,
          messages: [
            Prompt.makeMessage("system", { content: e.content }),
            ...filtered
          ]
        })
      }

      case "UserMessage": {
        // User messages accumulate in pending parts
        const e = event as UserMessageEvent
        return {
          ...state,
          pendingUserParts: [
            ...state.pendingUserParts,
            Prompt.makePart("text", { text: e.content })
          ]
        }
      }

      case "FileAttachment": {
        // File attachments accumulate in pending parts
        const e = event as FileAttachmentEvent
        const part = yield* makeFilePart(e, fs)
        return {
          ...state,
          pendingUserParts: [...state.pendingUserParts, part]
        }
      }

      case "AssistantMessage": {
        // Assistant messages flush pending user parts first
        const e = event as AssistantMessageEvent
        const flushed = flushUserParts(state)
        return {
          ...flushed,
          messages: [
            ...flushed.messages,
            Prompt.makeMessage("assistant", {
              content: [Prompt.makePart("text", { text: e.content })]
            })
          ]
        }
      }

      case "SetLlmConfig": {
        // Update LLM config
        const e = event as SetLlmConfigEvent
        return {
          ...state,
          llmConfig: {
            apiFormat: e.apiFormat as "openai-responses" | "anthropic" | "gemini",
            model: e.model,
            baseUrl: e.baseUrl,
            apiKeyEnvVar: e.apiKeyEnvVar
          }
        }
      }

      case "SetTimeout": {
        // Update timeout
        const e = event as SetTimeoutEvent
        return {
          ...state,
          timeoutMs: e.timeoutMs
        }
      }

      // Lifecycle events don't affect reduced state
      case "SessionStarted":
      case "SessionEnded":
      case "AgentTurnStarted":
      case "AgentTurnCompleted":
      case "AgentTurnInterrupted":
      case "AgentTurnFailed":
      case "TextDelta":
        return state

      default: {
        // Unknown event type - this should never happen with proper typing
        const _exhaustive: never = event
        return state
      }
    }
  }).pipe(
    Effect.catchAll((error: unknown) =>
      Effect.fail(
        makeReducerError(
          `Failed to apply event ${event._tag}: ${error instanceof Error ? error.message : String(error)}`,
          event
        )
      )
    )
  )

/** Create a file part from a FileAttachmentEvent */
const makeFilePart = (
  event: FileAttachmentEvent,
  fs: FileSystem.FileSystem
): Effect.Effect<Prompt.UserMessagePart, PlatformError.PlatformError> =>
  Effect.gen(function*() {
    if (event.source.type === "file") {
      const bytes = yield* fs.readFile(event.source.path)
      return Prompt.makePart("file", {
        mediaType: event.mediaType,
        data: bytes,
        fileName: Option.getOrUndefined(Option.fromNullable(event.fileName))
      })
    } else {
      return Prompt.makePart("file", {
        mediaType: event.mediaType,
        data: new URL(event.source.url),
        fileName: Option.getOrUndefined(Option.fromNullable(event.fileName))
      })
    }
  })
