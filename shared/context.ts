import { Schema } from "effect"
import { FileSystem, Path, Error as PlatformError } from "@effect/platform"
import { Effect, Stream, Ref } from "effect"
import { LanguageModel, AiError } from "@effect/ai"
import * as YAML from "yaml"

// =============================================================================
// Configuration
// =============================================================================

const CONTEXTS_DIR = ".contexts"

const DEFAULT_SYSTEM_PROMPT = `You are a helpful, friendly assistant. 
Keep your responses concise but informative. 
Use markdown formatting when helpful.`

// =============================================================================
// Event Schemas (using TaggedStruct for idiomatic tagged unions)
// =============================================================================

/** System prompt event - sets the AI's behavior */
export const SystemPromptEvent = Schema.TaggedStruct("SystemPrompt", {
  content: Schema.String
})
export type SystemPromptEvent = typeof SystemPromptEvent.Type

/** User message event - input from the user */
export const UserMessageEvent = Schema.TaggedStruct("UserMessage", {
  content: Schema.String
})
export type UserMessageEvent = typeof UserMessageEvent.Type

/** Assistant message event - complete response from the AI */
export const AssistantMessageEvent = Schema.TaggedStruct("AssistantMessage", {
  content: Schema.String
})
export type AssistantMessageEvent = typeof AssistantMessageEvent.Type

/** Text delta event - streaming chunk (ephemeral, never persisted) */
export const TextDeltaEvent = Schema.TaggedStruct("TextDelta", {
  delta: Schema.String
})
export type TextDeltaEvent = typeof TextDeltaEvent.Type

// =============================================================================
// Union Types
// =============================================================================

/** Schema for persisted events (non-ephemeral) */
export const PersistedEvent = Schema.Union(
  SystemPromptEvent,
  UserMessageEvent,
  AssistantMessageEvent
)
export type PersistedEvent = typeof PersistedEvent.Type

/** All possible context events */
export type ContextEvent = PersistedEvent | TextDeltaEvent

// =============================================================================
// Type Guards (using Schema.is for type-safe schema-based checking)
// =============================================================================

export const isTextDelta = Schema.is(TextDeltaEvent)
export const isAssistantMessage = Schema.is(AssistantMessageEvent)
export const isPersisted = Schema.is(PersistedEvent)

// =============================================================================
// Context File Operations
// =============================================================================

/** Get the file path for a context */
const getContextPath = (contextName: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(CONTEXTS_DIR, `${contextName}.yaml`)
  })

/** Load events from a context file, returns empty array if file doesn't exist */
export const loadContext = (contextName: string): Effect.Effect<
  PersistedEvent[],
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const filePath = yield* getContextPath(contextName)

    const exists = yield* fs.exists(filePath)
    if (!exists) return []

    const content = yield* fs.readFileString(filePath).pipe(
      Effect.map((yaml) => {
        const parsed = YAML.parse(yaml) as { events?: unknown[] }
        return (parsed?.events ?? []) as PersistedEvent[]
      }),
      Effect.catchAll(() => Effect.succeed([] as PersistedEvent[]))
    )
    return content
  })

/** Save events to a context file */
export const saveContext = (
  contextName: string,
  events: ReadonlyArray<PersistedEvent>
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const filePath = yield* getContextPath(contextName)

    // Ensure directory exists
    yield* fs.makeDirectory(CONTEXTS_DIR, { recursive: true }).pipe(
      Effect.catchAll(() => Effect.void)
    )

    // Convert to plain objects for YAML serialization
    const plainEvents = events.map((e) => ({
      _tag: e._tag,
      content: e.content
    }))

    const yaml = YAML.stringify({ events: plainEvents })
    yield* fs.writeFileString(filePath, yaml)
  })

/** Append a single event to a context file */
const appendEvent = (
  contextName: string,
  event: PersistedEvent,
  currentEvents: Ref.Ref<PersistedEvent[]>
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    yield* Ref.update(currentEvents, (events) => [...events, event])
    const events = yield* Ref.get(currentEvents)
    yield* saveContext(contextName, events)
  })

// =============================================================================
// Pure LLM Request (Inner Effect)
// =============================================================================

/**
 * Makes an LLM request with the given events.
 * This is a pure function with no file system dependency.
 * 
 * @param events - Array of persisted events to use as conversation history
 * @returns Stream of context events (TextDelta for streaming, AssistantMessage at end)
 */
export const makeLLMRequest = (
  events: ReadonlyArray<PersistedEvent>
): Stream.Stream<ContextEvent, AiError.AiError, LanguageModel.LanguageModel> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel

      // Build messages array for the LLM
      const messages = events.map((event) => {
        switch (event._tag) {
          case "SystemPrompt":
            return { role: "system" as const, content: event.content }
          case "UserMessage":
            return { role: "user" as const, content: event.content }
          case "AssistantMessage":
            return { role: "assistant" as const, content: event.content }
        }
      })

      // Create the streaming response
      const responseStream = model.streamText({ prompt: messages })

      // Collect full response while emitting deltas
      const fullResponseRef = yield* Ref.make("")

      // Transform the stream to emit TextDelta events and collect full response
      const deltaStream = responseStream.pipe(
        Stream.mapEffect((part) => {
          if (part.type === "text-delta") {
            return Ref.update(fullResponseRef, (text) => text + part.delta).pipe(
              Effect.map(() => TextDeltaEvent.make({ delta: part.delta }))
            )
          }
          // Skip non-text-delta parts, return null to filter out
          return Effect.succeed(null as ContextEvent | null)
        }),
        Stream.filter((event): event is ContextEvent => event !== null)
      )

      // After all deltas, emit the final AssistantMessage
      const finalStream = Stream.fromEffect(
        Ref.get(fullResponseRef).pipe(
          Effect.map((content) => AssistantMessageEvent.make({ content }) as ContextEvent)
        )
      )

      return Stream.concat(deltaStream, finalStream)
    })
  )

// =============================================================================
// Context-Aware LLM Request (Outer Effect)
// =============================================================================

/**
 * Runs an LLM request within a context.
 * Handles loading, creating, and persisting the context.
 * 
 * @param contextName - Name of the context (determines YAML file)
 * @param inputEvents - Events to add (typically UserMessageEvent)
 * @returns Stream of all events (ephemeral TextDelta + persisted AssistantMessage)
 */
export const runWithContext = (
  contextName: string,
  inputEvents: ReadonlyArray<UserMessageEvent>
): Stream.Stream<ContextEvent, AiError.AiError | PlatformError.PlatformError, LanguageModel.LanguageModel | FileSystem.FileSystem | Path.Path> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Load existing events or start with empty
      let events = yield* loadContext(contextName)

      // If context is empty, add the default system prompt
      if (events.length === 0) {
        events = [SystemPromptEvent.make({ content: DEFAULT_SYSTEM_PROMPT })]
      }

      // Add input events to the context
      const allEvents = [...events, ...inputEvents] as PersistedEvent[]

      // Persist the input events immediately
      yield* saveContext(contextName, allEvents)

      // Create a ref to track current events for appending
      const eventsRef = yield* Ref.make(allEvents)

      // Make the LLM request
      const llmStream = makeLLMRequest(allEvents)

      // Wrap the stream to persist non-ephemeral events as they're emitted
      return llmStream.pipe(
        Stream.mapEffect((event): Effect.Effect<ContextEvent, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> => {
          if (isPersisted(event)) {
            // Persist non-ephemeral events
            return appendEvent(contextName, event, eventsRef).pipe(
              Effect.map(() => event as ContextEvent)
            )
          }
          return Effect.succeed(event as ContextEvent)
        })
      )
    })
  )

// =============================================================================
// History Display Helpers
// =============================================================================

/** Get displayable events (user and assistant messages only) */
export const getDisplayableEvents = (events: ReadonlyArray<PersistedEvent>): ReadonlyArray<UserMessageEvent | AssistantMessageEvent> =>
  events.filter((e): e is UserMessageEvent | AssistantMessageEvent =>
    e._tag === "UserMessage" || e._tag === "AssistantMessage"
  )
