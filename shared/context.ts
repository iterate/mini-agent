import { FileSystem, Path, Error as PlatformError } from "@effect/platform"
import { Effect, Stream, pipe } from "effect"
import { AiError, LanguageModel } from "@effect/ai"
import * as YAML from "yaml"
import {
  PersistedEvent,
  SystemPromptEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  isPersisted
} from "./schema.ts"
import type { ContextEvent } from "./schema.ts"
import { makeLLMRequest } from "./llm-request.ts"

// =============================================================================
// Configuration
// =============================================================================

const CONTEXTS_DIR = ".contexts"

const DEFAULT_SYSTEM_PROMPT = `You are a helpful, friendly assistant. 
Keep your responses concise but informative. 
Use markdown formatting when helpful.`

// =============================================================================
// Context File Operations
// =============================================================================

/** Get the file path for a context */
const getContextPath = (contextName: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(CONTEXTS_DIR, `${contextName}.yaml`)
  })

/** Options for loading a context */
interface LoadContextOptions {
  /** If true, creates context with default system prompt when it doesn't exist */
  readonly createIfMissing?: boolean
}

/** Load events from a context file */
export const loadContext = (
  contextName: string,
  options: LoadContextOptions = {}
): Effect.Effect<
  PersistedEvent[],
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const filePath = yield* getContextPath(contextName)

    const exists = yield* fs.exists(filePath)
    if (!exists) {
      if (options.createIfMissing) {
        const initialEvents = [SystemPromptEvent.make({ content: DEFAULT_SYSTEM_PROMPT })]
        yield* saveContext(contextName, initialEvents)
        return initialEvents
      }
      return []
    }

    const content = yield* fs.readFileString(filePath).pipe(
      Effect.map((yaml) => {
        const parsed = YAML.parse(yaml) as { events?: unknown[] }
        return (parsed?.events ?? []) as PersistedEvent[]
      }),
      Effect.catchAll(() => Effect.succeed([] as PersistedEvent[]))
    )
    return content
  })

/** Save events to a context file (internal) */
const saveContext = (
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

/**
 * Appends events to a context, filtering to only persistable events.
 * Creates the context with a default system prompt if it doesn't exist.
 * 
 * @returns The full list of events after appending
 */
export const appendEvents = (
  contextName: string,
  events: ReadonlyArray<ContextEvent>
): Effect.Effect<PersistedEvent[], PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  pipe(
    loadContext(contextName, { createIfMissing: true }),
    Effect.flatMap((existingEvents) => {
      const newPersistedEvents = events.filter(isPersisted)
      if (newPersistedEvents.length === 0) {
        return Effect.succeed(existingEvents)
      }
      const allEvents = [...existingEvents, ...newPersistedEvents]
      return pipe(
        saveContext(contextName, allEvents),
        Effect.as(allEvents)
      )
    })
  )

// =============================================================================
// Context-Aware LLM Request
// =============================================================================

/**
 * Adds events to a context and runs an LLM request.
 * 
 * @param contextName - Name of the context (determines YAML file)
 * @param inputEvents - Events to add (typically UserMessageEvent)
 * @returns Stream of all events (ephemeral TextDelta + persisted AssistantMessage)
 */
export const addEvents = (
  contextName: string,
  inputEvents: ReadonlyArray<UserMessageEvent>
): Stream.Stream<ContextEvent, AiError.AiError | PlatformError.PlatformError, LanguageModel.LanguageModel | FileSystem.FileSystem | Path.Path> =>
  pipe(
    appendEvents(contextName, inputEvents),
    Effect.andThen(makeLLMRequest),
    Stream.unwrap,
    Stream.tap((event) => appendEvents(contextName, [event]))
  )

// =============================================================================
// History Display Helpers
// =============================================================================

/** Get displayable events (user and assistant messages only) */
export const getDisplayableEvents = (events: ReadonlyArray<PersistedEvent>): ReadonlyArray<UserMessageEvent | AssistantMessageEvent> =>
  events.filter((e): e is UserMessageEvent | AssistantMessageEvent =>
    e._tag === "UserMessage" || e._tag === "AssistantMessage"
  )
